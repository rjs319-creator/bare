'use strict';
// DISCOVERY-HEALTH CONTRACT — regression tests for the explicit scan-outcome taxonomy, the
// five-state health verdict, and the false-success defect where a market-closed no-op
// stamped lastSuccessAt so a scanner that only ever fired off-hours read healthy forever.
// Pure-function driven (classifyScanOutcome / nextHealth / healthStateOf) plus the in-memory
// store fake for the storage-touching paths, matching test/daytrade-learning-loop.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SR = require('../lib/daytrade-scan-runner');

// In-memory store fake honoring the { readJSON, writeJSON, hasStore } surface.
function memStore(seed = {}) {
  const docs = { ...seed };
  return {
    docs,
    hasStore: () => true,
    readJSON: async (k, fallback) => (k in docs ? docs[k] : fallback),
    writeJSON: async (k, v) => { docs[k] = JSON.parse(JSON.stringify(v)); },
  };
}

const IN_SESSION = new Date('2026-07-29T18:00:00Z');    // Wed 14:00 ET — regular session
const OFF_SESSION = new Date('2026-07-26T18:00:00Z');   // Sunday — market closed
const FULL_COV = { requested: 100, returned: 100, provider: 'fmp-batch', volumeAvailable: true };
const okScan = over => ({ ok: true, session: 'regular', date: '2026-07-29', scanned: 100, universe: 100, eligible: 98, anomalies: [], coverage: FULL_COV, note: null, ...over });

// ── classifyScanOutcome: every taxonomy branch ──────────────────────────────────

test('classifyScanOutcome covers every taxonomy branch with exactly one outcome each', () => {
  assert.equal(SR.classifyScanOutcome(null), 'error', 'a thrown scan (no result) is an error');
  assert.equal(SR.classifyScanOutcome(okScan({ marketClosed: true })), 'market-closed');
  assert.equal(SR.classifyScanOutcome({ ok: false, noBaselines: true, note: 'no baselines' }), 'no-baselines');
  assert.equal(SR.classifyScanOutcome({ ok: false, note: 'something broke' }), 'error');
  assert.equal(SR.classifyScanOutcome(okScan({ coverage: { ...FULL_COV, returned: 0 } })), 'provider-outage');
  assert.equal(SR.classifyScanOutcome(okScan({ coverage: { ...FULL_COV, returned: 79 } })), 'insufficient-coverage');
  assert.equal(SR.classifyScanOutcome(okScan({ warming: true })), 'warming');
  assert.equal(SR.classifyScanOutcome(okScan()), 'ok-zero-anomalies');
  assert.equal(SR.classifyScanOutcome(okScan({ anomalies: [{ ticker: 'AAA' }] })), 'ok');
});

test('coverage boundary sits exactly at COVERAGE_MIN_PCT and severity outranks warming', () => {
  // 80.0% is acceptable; 79.9% is not — the threshold is a named constant, not folklore.
  assert.equal(SR.classifyScanOutcome(okScan({ coverage: { ...FULL_COV, requested: 1000, returned: 800 } })), 'ok-zero-anomalies');
  assert.equal(SR.classifyScanOutcome(okScan({ coverage: { ...FULL_COV, requested: 1000, returned: 799 } })), 'insufficient-coverage');
  // A provider outage during warmup is an OUTAGE — the more severe truth wins.
  assert.equal(SR.classifyScanOutcome(okScan({ warming: true, coverage: { ...FULL_COV, returned: 0 } })), 'provider-outage');
  // A scan without coverage info (e.g. injected test scans) is judged on ok/warming/anomalies only.
  assert.equal(SR.classifyScanOutcome({ ok: true, session: 'regular', anomalies: [] }), 'ok-zero-anomalies');
});

test('coveragePctOf is null-safe: no coverage or nothing requested → null, never a fake number', () => {
  assert.equal(SR.coveragePctOf(null), null);
  assert.equal(SR.coveragePctOf({ requested: 0, returned: 0 }), null);
  assert.equal(SR.coveragePctOf({ requested: 3, returned: 2 }), 66.7, 'one-decimal rounding');
});

// ── nextHealth: the health-doc reducer ──────────────────────────────────────────

test('a scan that actually scanned stamps lastSuccessAt and reports coverage/duration/universe', () => {
  const nowMs = IN_SESSION.getTime();
  const { health, outcome, missedThisGap } = SR.nextHealth(null, okScan({ anomalies: [{ ticker: 'AAA' }] }), { nowMs, durationMs: 1234 });
  assert.equal(outcome, 'ok');
  assert.equal(health.lastSuccessAt, IN_SESSION.toISOString());
  assert.equal(health.consecutiveErrors, 0);
  assert.equal(health.lastDurationMs, 1234);
  assert.deepEqual(health.lastCoverage, { requested: 100, returned: 100, provider: 'fmp-batch', volumeAvailable: true });
  assert.equal(health.lastCoveragePct, 100);
  assert.equal(health.lastUniverse, 100);
  assert.equal(health.lastEligible, 98);
  assert.equal(health.lastOutcome, 'ok');
  assert.equal(health.nextExpectedAt, new Date(nowMs + health.targetIntervalMs).toISOString());
  assert.equal(missedThisGap, 0, 'first-ever success has no prior gap to judge');
});

test('FALSE-SUCCESS FIX: market-closed updates lastIdleAt only — never lastSuccessAt', () => {
  const prev = { lastSuccessAt: '2026-07-29T17:55:00Z', lastError: 'old error', consecutiveErrors: 2, missedScanDate: '2026-07-29', missedScanEstimate: 3 };
  const closed = { ok: true, marketClosed: true, session: 'closed', date: '2026-07-29', scanned: 0, anomalies: [], note: 'closed' };
  const { health, outcome } = SR.nextHealth(prev, closed, { nowMs: Date.parse('2026-07-29T23:00:00Z') });
  assert.equal(outcome, 'market-closed');
  assert.equal(health.lastSuccessAt, '2026-07-29T17:55:00Z', 'the off-hours no-op must NOT read as a scan success');
  assert.equal(health.lastIdleAt, '2026-07-29T23:00:00.000Z');
  assert.equal(health.consecutiveErrors, 2, 'an off-hours tick says nothing about scan health — no reset, no increment');
  assert.equal(health.lastError, 'old error', 'idle neither clears nor overwrites the last real error');
  // A scanner that has ONLY ever fired off-hours therefore never acquires a lastSuccessAt.
  const virgin = SR.nextHealth(null, closed, { nowMs: Date.parse('2026-07-29T23:00:00Z') });
  assert.equal(virgin.health.lastSuccessAt, null);
});

test('zero anomalies is a SUCCESS; a scanner failure is not — the two are never conflated', () => {
  const nowMs = IN_SESSION.getTime();
  const zero = SR.nextHealth(null, okScan(), { nowMs });
  assert.equal(zero.outcome, 'ok-zero-anomalies');
  assert.equal(zero.health.lastSuccessAt, IN_SESSION.toISOString(), 'a genuine quiet tape still counts as a working scanner');

  const failed = SR.nextHealth(null, { ok: false, session: 'regular', anomalies: [], note: 'provider exploded' }, { nowMs });
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.health.lastSuccessAt, null);
  assert.equal(failed.health.consecutiveErrors, 1);
  assert.equal(failed.health.lastError, 'provider exploded');

  const thrown = SR.nextHealth(failed.health, null, { nowMs: nowMs + 60000, error: 'boom' });
  assert.equal(thrown.outcome, 'error');
  assert.equal(thrown.health.consecutiveErrors, 2, 'error streak accumulates');
  assert.equal(thrown.health.lastError, 'boom');
});

test('provider-outage and no-baselines do not stamp success; insufficient-coverage does (degradation is a state, not a failure)', () => {
  const nowMs = IN_SESSION.getTime();
  const outage = SR.nextHealth(null, okScan({ coverage: { ...FULL_COV, returned: 0 } }), { nowMs });
  assert.equal(outage.outcome, 'provider-outage');
  assert.equal(outage.health.lastSuccessAt, null, 'zero quotes back means nothing was actually scanned');
  assert.equal(outage.health.consecutiveErrors, 1);

  const noBase = SR.nextHealth(null, { ok: false, noBaselines: true, session: 'regular', anomalies: [], note: 'no baselines' }, { nowMs });
  assert.equal(noBase.outcome, 'no-baselines');
  assert.equal(noBase.health.lastSuccessAt, null);

  const thin = SR.nextHealth(null, okScan({ coverage: { ...FULL_COV, returned: 50 } }), { nowMs, durationMs: 900 });
  assert.equal(thin.outcome, 'insufficient-coverage');
  assert.equal(thin.health.lastSuccessAt, IN_SESSION.toISOString(), 'a thin scan DID scan — healthStateOf downgrades it to degraded instead');
  assert.equal(thin.health.lastCoveragePct, 50);
});

// ── healthStateOf: all five states ──────────────────────────────────────────────

test('unavailable: no health doc, or never succeeded — including the market-closed-only scanner', () => {
  const never = SR.healthStateOf(null, IN_SESSION.getTime());
  assert.equal(never.status, 'unavailable');
  assert.ok(/CRON_SECRET/.test(never.reason), 'reason keeps naming the silent scheduler/secret/storage failure modes');
  // A scanner that only ever fired off-hours has lastRunAt/lastIdleAt but NO lastSuccessAt:
  // it must read unavailable, not healthy (the exact defect this contract closes).
  const offHoursOnly = { lastRunAt: '2026-07-29T23:00:00.000Z', lastIdleAt: '2026-07-29T23:00:00.000Z', lastSuccessAt: null, lastOutcome: 'market-closed', consecutiveErrors: 0, targetIntervalMs: SR.DEFAULT_TARGET_INTERVAL_MS };
  assert.equal(SR.healthStateOf(offHoursOnly, IN_SESSION.getTime()).status, 'unavailable');
});

test('idle: off-session an aged success implies nothing — never stale, never healthy', () => {
  const health = { lastSuccessAt: '2026-07-24T19:00:00Z', lastOutcome: 'ok', consecutiveErrors: 0, targetIntervalMs: SR.DEFAULT_TARGET_INTERVAL_MS };
  const verdict = SR.healthStateOf(health, OFF_SESSION.getTime());
  assert.equal(verdict.status, 'idle');
});

test('stale: in-session with a success older than STALE_AFTER_INTERVALS × target', () => {
  const health = { lastSuccessAt: '2026-07-29T16:00:00Z', lastOutcome: 'ok', consecutiveErrors: 0, targetIntervalMs: SR.DEFAULT_TARGET_INTERVAL_MS };
  const verdict = SR.healthStateOf(health, IN_SESSION.getTime());   // 120 min > 3 × 5 min
  assert.equal(verdict.status, 'stale');
  assert.ok(/scheduler/.test(verdict.reason));
});

test('degraded: recent success but thin coverage, price-only fallback, or an error streak', () => {
  const base = { lastSuccessAt: '2026-07-29T17:58:00Z', consecutiveErrors: 0, targetIntervalMs: SR.DEFAULT_TARGET_INTERVAL_MS };
  const nowMs = IN_SESSION.getTime();
  assert.equal(SR.healthStateOf({ ...base, lastOutcome: 'insufficient-coverage' }, nowMs).status, 'degraded');
  assert.equal(SR.healthStateOf({ ...base, lastOutcome: 'provider-outage' }, nowMs).status, 'degraded');
  assert.equal(SR.healthStateOf({ ...base, lastOutcome: 'ok', lastCoverage: { ...FULL_COV, volumeAvailable: false } }, nowMs).status, 'degraded', 'price-only fallback blinds participation signals — say so');
  assert.equal(SR.healthStateOf({ ...base, lastOutcome: 'ok', consecutiveErrors: 1 }, nowMs).status, 'degraded');
});

test('healthy: in-session, recent, full-quality scan — and zero anomalies stays healthy', () => {
  const health = { lastSuccessAt: '2026-07-29T17:58:00Z', lastOutcome: 'ok-zero-anomalies', lastCoverage: FULL_COV, consecutiveErrors: 0, targetIntervalMs: SR.DEFAULT_TARGET_INTERVAL_MS };
  const verdict = SR.healthStateOf(health, IN_SESSION.getTime());
  assert.equal(verdict.status, 'healthy');
  assert.equal(verdict.reason, null);
  assert.equal(SR.STATE_EXPLAIN.healthy, 'Live discovery is healthy.');
});

// ── runScanCycle end-to-end (in-memory store): health doc + per-scan history ────

test('a market-closed cycle records idle + history but never lastSuccessAt', async () => {
  const now = new Date('2026-07-29T23:00:00Z');   // 19:00 ET — after hours
  const store = memStore();
  const closedScan = async () => ({ ok: true, marketClosed: true, session: 'afterhours', date: '2026-07-29', scanned: 0, anomalies: [], note: 'closed' });
  const out = await SR.runScanCycle({ now, scan: closedScan, store });
  assert.equal(out.ok, true, 'the scheduler tick itself did its job — op-level ok stays true');
  assert.equal(out.outcome, 'market-closed');
  assert.equal(out.health.lastSuccessAt, null);
  assert.equal(out.health.lastIdleAt, now.toISOString());
  const hist = store.docs[SR.historyKey('2026-07-29')];
  assert.equal(hist.scans.length, 1);
  assert.equal(hist.scans[0].outcome, 'market-closed');
  assert.equal(hist.scans[0].source, 'scheduler');
});

test('a real scan cycle persists the extended health fields and appends a history record', async () => {
  const now = IN_SESSION;
  const store = memStore();
  const out = await SR.runScanCycle({ now, scan: async () => okScan({ anomalies: [{ ticker: 'AAA' }], note: null }), store });
  assert.equal(out.ok, true);
  assert.equal(out.outcome, 'ok');
  const doc = store.docs[SR.HEALTH_KEY];
  assert.equal(doc.lastSuccessAt, now.toISOString());
  assert.ok(Number.isFinite(doc.lastDurationMs), 'duration is measured, not guessed');
  assert.equal(doc.lastCoveragePct, 100);
  assert.equal(doc.lastEligible, 98);
  assert.equal(doc.lastOutcome, 'ok');
  assert.equal(doc.nextExpectedAt, new Date(now.getTime() + doc.targetIntervalMs).toISOString());
  const hist = store.docs[SR.historyKey('2026-07-29')];
  assert.equal(hist.scans.length, 1);
  assert.equal(hist.scans[0].provider, 'fmp-batch');
  assert.equal(hist.scans[0].anomalies, 1);
});

// ── Page-driven observations: same history, never the scheduled-path state ──────

test('recordScanObservation appends source:page history without touching lastSuccessAt or the lease', async () => {
  const seededHealth = { lastSuccessAt: '2026-07-29T17:55:00Z', consecutiveErrors: 0 };
  const store = memStore({ [SR.HEALTH_KEY]: seededHealth });
  const rec = await SR.recordScanObservation(okScan(), { source: 'page', now: IN_SESSION, durationMs: 800, store });
  assert.equal(rec.source, 'page');
  assert.equal(rec.outcome, 'ok-zero-anomalies');
  assert.equal(rec.coveragePct, 100);
  const hist = store.docs[SR.historyKey('2026-07-29')];
  assert.equal(hist.scans.length, 1);
  assert.deepEqual(store.docs[SR.HEALTH_KEY], seededHealth, 'health doc untouched — lastSuccessAt belongs to the scheduled path');
  assert.ok(!(SR.LOCK_KEY in store.docs), 'lease untouched');
});

test('history is capped at the newest HISTORY_MAX_ENTRIES and loads back per date', async () => {
  const store = memStore();
  const date = '2026-07-29';
  for (let i = 0; i < SR.HISTORY_MAX_ENTRIES + 5; i++) {
    const at = new Date(Date.parse('2026-07-29T13:30:00Z') + i * 1000);
    await SR.recordScanObservation(okScan({ scanned: i }), { source: 'page', now: at, store });
  }
  const hist = await SR.loadScanHealthHistory(date, store);
  assert.equal(hist.scans.length, SR.HISTORY_MAX_ENTRIES, 'cap holds');
  assert.equal(hist.scans[hist.scans.length - 1].scanned, SR.HISTORY_MAX_ENTRIES + 4, 'newest entries survive the cap');
  const empty = await SR.loadScanHealthHistory('not-a-date', store);
  assert.deepEqual(empty.scans, [], 'malformed date input fails safe with an empty history');
});
