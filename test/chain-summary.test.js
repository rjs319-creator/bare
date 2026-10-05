'use strict';
// op=chainsummary — the per-night chains record the GitHub Actions matrix POSTs so the app
// knows what happened to the nightly chains without reading the Actions UI.
//   • pure: payload validation + normalisation, health view derivation, lookback dates
//   • route: bearer auth, POST-only, 400 on a bad payload, CAS-merged into chains/<date>.json
//     (a full run replaces the night, a partial run folds in per chain)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CS = require('../lib/chain-summary');
const R = require('../lib/chain-summary-routes');

const NOW = Date.parse('2026-10-02T22:40:00Z');
const okChain = { ok: true, status: 'ok', httpStatus: 200, attempts: 1, complete: true, failed: [], skipped: [], elapsedMs: 1200 };
const badChain = { ok: false, status: 'failed', httpStatus: 200, attempts: 1, complete: true, failed: ['op=track'], skipped: [], elapsedMs: 900, error: 'op=track http:503' };
const payload = (over = {}) => ({
  date: '2026-10-02', source: 'github-matrix', runId: '42', runUrl: 'https://github.com/x/y/actions/runs/42',
  startedAt: '2026-10-02T22:05:00Z', finishedAt: '2026-10-02T22:39:00Z',
  chains: { ledger: okChain, capture: badChain },
  ...over,
});

// ── normalizeChainSummary ────────────────────────────────────────────────────
test('normalizeChainSummary: accepts a well-formed payload and derives ok/failed', () => {
  const r = CS.normalizeChainSummary(payload(), { now: NOW });
  assert.equal(r.error, null);
  assert.equal(r.value.date, '2026-10-02');
  assert.equal(r.value.source, 'github-matrix');
  assert.equal(r.value.ok, false);
  assert.deepEqual(r.value.failed, ['capture']);
  assert.equal(r.value.chainCount, 2);
  assert.equal(r.value.chains.capture.error, 'op=track http:503');
  assert.deepEqual(r.value.chains.capture.failed, ['op=track']);
  assert.equal(r.value.runId, '42');
});

test('normalizeChainSummary: rejects a bad date, an out-of-window date, an unknown source and non-object chains', () => {
  assert.match(CS.normalizeChainSummary(payload({ date: '2026/10/02' }), { now: NOW }).error, /date/);
  assert.match(CS.normalizeChainSummary(payload({ date: '2025-01-01' }), { now: NOW }).error, /date/);
  assert.match(CS.normalizeChainSummary(payload({ source: 'elsewhere' }), { now: NOW }).error, /source/);
  assert.match(CS.normalizeChainSummary(payload({ chains: [] }), { now: NOW }).error, /chains/);
  assert.match(CS.normalizeChainSummary(payload({ chains: {} }), { now: NOW }).error, /chains/);
  assert.match(CS.normalizeChainSummary(null, { now: NOW }).error, /object/);
});

test('normalizeChainSummary: drops unknown fields, bounds arrays and strings, rejects bad chain names', () => {
  const longName = 'x'.repeat(200);
  const p = payload({ chains: { ledger: { ...okChain, junk: 1, failed: Array.from({ length: 80 }, (_, i) => `op=${i}${longName}`) } } });
  const r = CS.normalizeChainSummary(p, { now: NOW });
  assert.equal(r.error, null);
  assert.equal('junk' in r.value.chains.ledger, false);
  assert.equal(r.value.chains.ledger.failed.length, CS.MAX_STEPS_PER_CHAIN);
  assert.ok(r.value.chains.ledger.failed[0].length <= CS.MAX_TEXT);
  assert.match(CS.normalizeChainSummary(payload({ chains: { 'Bad Name!': okChain } }), { now: NOW }).error, /chain name/);
  const tooMany = Object.fromEntries(Array.from({ length: CS.MAX_CHAINS + 1 }, (_, i) => [`c${i}`, okChain]));
  assert.match(CS.normalizeChainSummary(payload({ chains: tooMany }), { now: NOW }).error, /chains/);
});

test('normalizeChainSummary: a chain without an explicit ok is graded from status/failed', () => {
  const r = CS.normalizeChainSummary(payload({ chains: { a: { status: 'no-report' }, b: { failed: ['op=x'] }, c: { status: 'ok' } } }), { now: NOW });
  assert.deepEqual(r.value.failed, ['a', 'b']);
  assert.equal(r.value.chains.c.ok, true);
});

// ── health view ──────────────────────────────────────────────────────────────
test('chainsHealthView: a GitHub summary becomes the compact banner block', () => {
  const { value } = CS.normalizeChainSummary(payload({ partial: false }), { now: NOW });
  const v = CS.chainsHealthView({ summary: value, roots: ['ledger', 'capture'], now: NOW });
  assert.deepEqual(v, { session: '2026-10-02', date: '2026-10-02', ok: false, full: true, partial: false, covered: ['ledger', 'capture'], failed: ['capture'], skipped: [], crashedWithPeers: [], source: 'github-matrix',
    runUrl: 'https://github.com/x/y/actions/runs/42', at: '2026-10-02T22:39:00.000Z', missing: false, noMatrixRun: null });
});

test('chainsHealthView: falls back to the in-process run record when no summary exists', () => {
  const run = { at: '2026-10-01T22:04:00Z', chainDispatchFails: ['atlasx'], lateChainFails: ['atlasx', 'swing'], chains: { atlasx: {}, swing: {}, ledger: {} } };
  const v = CS.chainsHealthView({ summary: null, run, inProcess: true });
  assert.equal(v.source, 'in-process');
  assert.equal(v.date, '2026-10-01'); assert.equal(v.session, '2026-10-01', 'a 22:04 UTC warm on a Thursday targets that day\'s session');
  assert.deepEqual(v.failed, ['atlasx', 'swing']);
  assert.equal(v.ok, false);
});

test('chainsHealthView: in-process disabled and no summary = the dead-man tripped', () => {
  const v = CS.chainsHealthView({ summary: null, run: { at: 'x', chains: {} }, inProcess: false });
  assert.equal(v.source, 'none');
  assert.equal(v.ok, false);
  assert.equal(v.missing, true);
});

test('chainsHealthView: nothing known at all (fresh deploy, in-process on) is null, not an alarm', () => {
  assert.equal(CS.chainsHealthView({ summary: null, run: null, inProcess: true }), null);
});

test('recentSummaryDates: today first, then back over the lookback (covers a weekend)', () => {
  assert.deepEqual(CS.recentSummaryDates(Date.parse('2026-10-05T14:00:00Z')), ['2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
  assert.equal(CS.summaryPath('2026-10-02'), 'chains/2026-10-02.json');
});

// ── route ────────────────────────────────────────────────────────────────────
function fakeRes() {
  return { headers: {}, body: null, code: 200,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; return o; } };
}
function memStore() {
  const docs = new Map();
  return {
    docs, writes: 0,
    hasStore: () => true,
    readJSON: async (k, fb) => (docs.has(k) ? docs.get(k) : fb),
    // The CAS primitive the route uses (lib/store-cas.js contract): mutate(current|initial) → new doc.
    updateJSON: async function (k, mutate, { initial = null } = {}) {
      const next = await mutate(docs.has(k) ? docs.get(k) : initial);
      docs.set(k, next); this.writes += 1;
      return { written: true, value: next, etag: null, attempts: 1 };
    },
  };
}
const withSecret = async (secret, fn) => {
  const prev = process.env.CRON_SECRET, prevEnv = process.env.VERCEL_ENV;
  process.env.CRON_SECRET = secret; process.env.VERCEL_ENV = 'production';
  try { return await fn(); } finally {
    if (prev == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    if (prevEnv == null) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = prevEnv;
  }
};
const req = (over = {}) => ({ method: 'POST', query: { op: 'chainsummary' }, headers: { authorization: 'Bearer s3cret' }, body: payload(), ...over });

test('runChainSummary: rejects a missing/wrong bearer with 401 and never writes', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ headers: {} }), res, { store, now: () => NOW });
  assert.equal(res.code, 401); assert.equal(store.docs.size, 0);
  const res2 = fakeRes();
  await R.runChainSummary(req({ headers: { authorization: 'Bearer nope' } }), res2, { store, now: () => NOW });
  assert.equal(res2.code, 401);
}));

test('runChainSummary: GET is 405 (the record is a POSTed body, never a query string)', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ method: 'GET' }), res, { store, now: () => NOW });
  assert.equal(res.code, 405); assert.equal(store.docs.size, 0);
}));

test('runChainSummary: a bad payload is 400 with the reason, and nothing is written', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ body: payload({ date: 'nope' }) }), res, { store, now: () => NOW });
  assert.equal(res.code, 400); assert.match(res.body.error, /date/); assert.equal(store.docs.size, 0);
}));

test('runChainSummary: writes chains/<date>.json under CAS and reports the verdict; a string body is parsed', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ body: JSON.stringify(payload({ partial: false })) }), res, { store, now: () => NOW });
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.written, true); assert.equal(res.body.partial, false); assert.equal(res.body.merged, false);
  assert.equal(res.body.chainsOk, false); assert.deepEqual(res.body.failed, ['capture']);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const doc = store.docs.get('chains/2026-10-02.json');
  assert.equal(doc.runId, '42'); assert.equal(doc.receivedAt, new Date(NOW).toISOString()); assert.equal(doc.partial, false);
}));

test('runChainSummary: idempotent — the same full run posted twice yields the same record; a newer full run replaces it', () => withSecret('s3cret', async () => {
  const store = memStore();
  await R.runChainSummary(req({ body: payload({ partial: false }) }), fakeRes(), { store, now: () => NOW });
  const first = store.docs.get('chains/2026-10-02.json');
  await R.runChainSummary(req({ body: payload({ partial: false }) }), fakeRes(), { store, now: () => NOW });
  const { priorRuns, ...second } = store.docs.get('chains/2026-10-02.json');
  assert.deepEqual(second, first);
  assert.deepEqual(priorRuns.map((p) => p.runId), ['42'], 'the earlier post is kept as provenance');
  await R.runChainSummary(req({ body: payload({ partial: false, runId: '43', chains: { ledger: okChain } }) }), fakeRes(), { store, now: () => NOW });
  assert.equal(store.docs.get('chains/2026-10-02.json').runId, '43');
  assert.equal(store.docs.size, 1, 'one key per date — never a shared RMW doc');
}));

test('runChainSummary: a partial (only=) post merges into the night instead of replacing it', () => withSecret('s3cret', async () => {
  const store = memStore();
  await R.runChainSummary(req({ body: payload({ partial: false }) }), fakeRes(), { store, now: () => NOW });
  const res = fakeRes();
  await R.runChainSummary(req({ body: payload({ partial: true, runId: '44', chains: { capture: okChain } }) }), res, { store, now: () => NOW + 1000 });
  assert.equal(res.body.merged, true); assert.equal(res.body.partial, true);
  const doc = store.docs.get('chains/2026-10-02.json');
  assert.equal(doc.runId, '42', 'the night keeps the full run\'s identity'); assert.equal(doc.partial, false);
  assert.equal(doc.chains.capture.ok, true); assert.equal(doc.ok, true); assert.deepEqual(doc.failed, []);
  assert.deepEqual(doc.patches.map((p) => p.runId), ['44']);
  // A partial post onto an empty night is stored as partial — it can never cover the night.
  const store2 = memStore();
  await R.runChainSummary(req({ body: payload({ partial: true, chains: { maturity: okChain } }) }), fakeRes(), { store: store2, now: () => NOW });
  assert.equal(store2.docs.get('chains/2026-10-02.json').partial, true);
}));

test('runChainSummary: a CAS failure is an honest 500 (the summary job goes red and says why)', () => withSecret('s3cret', async () => {
  const store = { ...memStore(), updateJSON: async () => { throw new Error('CAS conflict on chains/x: 6 attempt(s)'); } }; const res = fakeRes();
  await R.runChainSummary(req({ body: payload({ partial: false }) }), res, { store, now: () => NOW });
  assert.equal(res.code, 500); assert.equal(res.body.ok, false); assert.equal(res.body.written, false); assert.match(res.body.error, /CAS conflict/);
}));

test('runChainSummary: no store = honest 200 written:false (never a 500 that fails the dead-man job for a config gap)', () => withSecret('s3cret', async () => {
  const store = { ...memStore(), hasStore: () => false }; const res = fakeRes();
  await R.runChainSummary(req(), res, { store, now: () => NOW });
  assert.equal(res.code, 200); assert.equal(res.body.written, false); assert.match(res.body.note, /Blob/);
}));

test('readChainSummaries: every doc inside the lookback, newest first; empty past the lookback or without a store', async () => {
  const store = memStore();
  store.docs.set('chains/2026-10-02.json', { date: '2026-10-02', ok: true, failed: [], source: 'github-matrix', chains: {} });
  store.docs.set('chains/2026-10-01.json', { date: '2026-10-01', ok: true, failed: [], source: 'manual', chains: {} });
  store.docs.set('chains/2026-09-30.json', { date: 'wrong', chains: {} });
  const hits = await R.readChainSummaries({ store, now: () => Date.parse('2026-10-04T12:00:00Z') });
  assert.deepEqual(hits.map((d) => d.date), ['2026-10-02', '2026-10-01'], 'a doc whose date does not match its key is ignored');
  assert.deepEqual(await R.readChainSummaries({ store, now: () => Date.parse('2026-10-09T12:00:00Z') }), []);
  assert.deepEqual(await R.readChainSummaries({ store: { ...store, hasStore: () => false }, now: () => NOW }), []);
});

// ── full vs partial summaries (the dead-man that a filtered run cannot satisfy) ─────────
const ROOTS = ['ledger', 'capture', 'maturity'];
const fullChains = Object.fromEntries(ROOTS.map((c) => [c, okChain]));

test('isFullSummary: an explicit partial:false (or true) is believed; a legacy doc without the flag is full only when it covers every root', () => {
  assert.equal(CS.isFullSummary({ source: 'github-matrix', partial: false, chains: { ledger: okChain } }, ROOTS), true);
  assert.equal(CS.isFullSummary({ source: 'manual', partial: false, chains: fullChains }, ROOTS), true);
  assert.equal(CS.isFullSummary({ source: 'manual', partial: true, chains: fullChains }, ROOTS), false);
  assert.equal(CS.isFullSummary({ source: 'manual', chains: { maturity: okChain } }, ROOTS), false, 'this morning\'s only= doc');
  assert.equal(CS.isFullSummary({ source: 'manual', chains: fullChains }, ROOTS), true);
  assert.equal(CS.isFullSummary({ source: 'in-process', partial: false, chains: fullChains }, ROOTS), false, 'only a matrix/manual run covers a night');
  assert.equal(CS.isFullSummary(null, ROOTS), false);
});

test('normalizeChainSummary: records partial (explicit, else inferred from root coverage) and the covered chain list', () => {
  const a = CS.normalizeChainSummary(payload({ partial: true, chains: { maturity: okChain } }), { now: NOW, roots: ROOTS });
  assert.equal(a.value.partial, true); assert.deepEqual(a.value.covered, ['maturity']);
  const b = CS.normalizeChainSummary(payload({ chains: { maturity: okChain } }), { now: NOW, roots: ROOTS });
  assert.equal(b.value.partial, true, 'a legacy poster that covers one root is partial');
  const c = CS.normalizeChainSummary(payload({ chains: fullChains }), { now: NOW, roots: ROOTS });
  assert.equal(c.value.partial, false); assert.deepEqual(c.value.covered, ROOTS);
});

test('chainsHealthView: a partial summary contributes statuses but never ok for the night', () => {
  const partial = { date: '2026-10-02', source: 'manual', partial: true, ok: true, failed: [], finishedAt: '2026-10-02T14:00:00Z', chains: { maturity: okChain, capture: badChain } };
  const v = CS.chainsHealthView({ summaries: [partial], roots: ROOTS, now: NOW });
  assert.equal(v.full, false); assert.equal(v.partial, true); assert.equal(v.ok, false);
  assert.deepEqual(v.covered, ['maturity', 'capture']);
  assert.deepEqual(v.failed, ['capture'], 'uncovered roots are not failures of a partial run');
  assert.equal(v.missing, false);
});

test('chainsHealthView: a full summary missing a root lists that root as failed', () => {
  const full = { date: '2026-10-02', source: 'github-matrix', partial: false, ok: true, failed: [], chains: { ledger: okChain, capture: okChain } };
  const v = CS.chainsHealthView({ summaries: [full], roots: ROOTS, now: NOW });
  assert.equal(v.full, true); assert.equal(v.ok, false); assert.deepEqual(v.failed, ['maturity']);
});

test('chainsHealthView: the newest date wins; the legacy single `summary` option still works', () => {
  const older = { date: '2026-10-01', source: 'github-matrix', partial: false, ok: true, failed: [], chains: fullChains };
  const newer = { date: '2026-10-02', source: 'manual', partial: true, ok: true, failed: [], chains: { maturity: okChain } };
  assert.equal(CS.chainsHealthView({ summaries: [newer, older], roots: ROOTS, now: NOW }).date, '2026-10-02');
  assert.equal(CS.chainsHealthView({ summary: older, roots: ROOTS, now: NOW }).full, true);
});

// ── matrixRunOverdue: warm handed the chains to GitHub and nothing full came back ──────
const warmRun = { at: '2026-10-02T22:00:40Z', chainsInProcess: false, chains: {} };
const fullDoc = (date) => ({ date, source: 'github-matrix', partial: false, ok: true, failed: [], chains: fullChains });
const partialDoc = (date) => ({ date, source: 'manual', partial: true, ok: true, failed: [], chains: { maturity: okChain } });

test('matrixRunOverdue: fires 90 min after a chainsInProcess:false warm with no FULL summary for that ET session date', () => {
  const at = Date.parse(warmRun.at);
  assert.equal(CS.NO_MATRIX_RUN_GRACE_MS, 90 * 60 * 1000);
  assert.equal(CS.matrixRunOverdue({ run: warmRun, summaries: [], now: at + CS.NO_MATRIX_RUN_GRACE_MS - 1, roots: ROOTS }), null, 'inside the grace window');
  const tripped = CS.matrixRunOverdue({ run: warmRun, summaries: [], now: at + CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS });
  assert.deepEqual(tripped, { session: '2026-10-02', warmAt: warmRun.at, graceMs: CS.NO_MATRIX_RUN_GRACE_MS });
  // A partial (only=) doc for the night does NOT satisfy it — that is exactly what fooled op=health on 2026-10-02.
  assert.ok(CS.matrixRunOverdue({ run: warmRun, summaries: [partialDoc('2026-10-02')], now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }));
  // A legacy only= doc (no partial flag, one root) does not either.
  assert.ok(CS.matrixRunOverdue({ run: warmRun, summaries: [{ date: '2026-10-02', source: 'manual', chains: { maturity: okChain } }], now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }));
  // A full summary for the night clears it — even one whose chains failed (it RAN; failures are reported as chain:<name>).
  assert.equal(CS.matrixRunOverdue({ run: warmRun, summaries: [{ ...fullDoc('2026-10-02'), ok: false, failed: ['capture'] }], now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }), null);
  // Yesterday's full run is not tonight's.
  assert.ok(CS.matrixRunOverdue({ run: warmRun, summaries: [fullDoc('2026-10-01')], now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }));
});

test('matrixRunOverdue: a 01:00 UTC run still belongs to the same ET session date (summary dates are ET dates)', () => {
  // 22:00 UTC = 18:00 EDT on 2026-10-02; 01:30 UTC next day = 21:30 EDT, still 2026-10-02 in ET.
  const late = Date.parse('2026-10-03T01:30:00Z');
  assert.equal(CS.etDate(late), '2026-10-02');
  assert.equal(CS.matrixRunOverdue({ run: warmRun, summaries: [fullDoc('2026-10-02')], now: late, roots: ROOTS }), null);
  // The morning after (ET) the night is still judged — last night's warm had no full run.
  assert.ok(CS.matrixRunOverdue({ run: warmRun, summaries: [partialDoc('2026-10-02')], now: Date.parse('2026-10-03T13:00:00Z'), roots: ROOTS }));
});

test('matrixRunOverdue: silent when warm ran in-process, when there is no warm record, or when the warm is older than the lookback', () => {
  const at = Date.parse(warmRun.at);
  assert.equal(CS.matrixRunOverdue({ run: { ...warmRun, chainsInProcess: true }, summaries: [], now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }), null);
  assert.equal(CS.matrixRunOverdue({ run: null, summaries: [], now: at, roots: ROOTS }), null);
  assert.equal(CS.matrixRunOverdue({ run: warmRun, summaries: [], now: at + (CS.LOOKBACK_DAYS + 2) * 86400000, roots: ROOTS }), null, 'cannot judge a night older than the summaries we read');
});

test('chainsHealthView: carries noMatrixRun so the banner can say the night has not run', () => {
  const at = Date.parse(warmRun.at);
  const v = CS.chainsHealthView({ summaries: [partialDoc('2026-10-02')], run: warmRun, inProcess: false, now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS });
  assert.equal(v.noMatrixRun && v.noMatrixRun.session, '2026-10-02');
  const dead = CS.chainsHealthView({ summaries: [], run: warmRun, inProcess: false, now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS });
  assert.equal(dead.missing, true); assert.equal(dead.noMatrixRun && dead.noMatrixRun.session, '2026-10-02');
});

test('recentSummaryDates: ET dates, so a 01:00 UTC health probe still looks at the ET session it belongs to', () => {
  assert.deepEqual(CS.recentSummaryDates(Date.parse('2026-10-03T01:00:00Z')), ['2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29']);
});

// ── merge (route): a partial post folds INTO the night's doc instead of replacing it ─────
test('mergeChainSummary: a full post replaces (keeping prior runs as provenance); a partial post merges per chain', () => {
  const full = { ...fullDoc('2026-10-02'), runId: '1', runUrl: 'u1', receivedAt: 'r1', ok: false, failed: ['capture'], chains: { ...fullChains, capture: badChain }, covered: ROOTS };
  const partial = { ...partialDoc('2026-10-02'), runId: '2', runUrl: 'u2', receivedAt: 'r2', chains: { capture: okChain }, covered: ['capture'] };
  const merged = CS.mergeChainSummary(full, partial);
  assert.equal(merged.partial, false, 'the night stays full'); assert.equal(merged.runId, '1');
  assert.equal(merged.chains.capture.ok, true); assert.equal(merged.ok, true); assert.deepEqual(merged.failed, []);
  assert.deepEqual(merged.covered, ROOTS);
  assert.deepEqual(merged.patches.map((p) => p.runId), ['2']);
  const replaced = CS.mergeChainSummary(merged, { ...fullDoc('2026-10-02'), runId: '3', runUrl: 'u3', receivedAt: 'r3', covered: ROOTS });
  assert.equal(replaced.runId, '3'); assert.deepEqual(replaced.priorRuns.map((p) => p.runId), ['1']);
  assert.equal('patches' in replaced, false);
  // partial onto partial stays partial, union of coverage; partial onto nothing is itself.
  const pp = CS.mergeChainSummary(partialDoc('2026-10-02'), { ...partialDoc('2026-10-02'), chains: { ledger: okChain }, covered: ['ledger'] });
  assert.equal(pp.partial, true); assert.deepEqual(pp.covered.sort(), ['ledger', 'maturity']);
  assert.deepEqual(CS.mergeChainSummary(null, partial), partial);
  // Inputs are not mutated.
  assert.equal(full.chains.capture.ok, false);
});

// ── TARGET SESSION keying (2026-10-02/03 defect) ─────────────────────────────────────────
// GitHub ran the `0 1 * * *` retry cron 5 h late, at 06:14 UTC = 02:14 ET Friday 10-02 — BEFORE
// Friday's session. Keyed by the ET calendar date, that pre-market run (which processed
// Thursday's already-done data) became the full record for "2026-10-02", so Friday's real
// post-close runs skipped almost every chain as already-ok. Everything is now keyed by the
// TARGET SESSION = the last completed NYSE session at run start (lib/market-session.js).
const SIX14_FRI = Date.parse('2026-10-02T06:14:00Z');     // 02:14 ET Fri — pre-market
const POSTCLOSE_FRI = Date.parse('2026-10-03T00:28:00Z'); // 20:28 ET Fri — after the close
const SIX41_SAT = Date.parse('2026-10-03T06:41:00Z');     // 02:41 ET Sat

test('targetSession: a pre-market run targets the PREVIOUS session; post-close and weekend runs target the day that closed', () => {
  assert.equal(CS.etDate(SIX14_FRI), '2026-10-02', 'the ET calendar date — what the old key was');
  assert.equal(CS.targetSession(SIX14_FRI), '2026-10-01', '02:14 ET Friday → Thursday');
  assert.equal(CS.targetSession(POSTCLOSE_FRI), '2026-10-02', '20:28 ET Friday → Friday');
  assert.equal(CS.targetSession(SIX41_SAT), '2026-10-02', '02:41 ET Saturday → Friday');
  assert.equal(CS.targetSession(Date.parse('2026-10-05T22:00:00Z')), '2026-10-05', 'the 22:00 UTC Vercel cron on a weekday is after the close');
  assert.equal(CS.targetSession(Date.parse('2026-10-02T19:59:00Z')), '2026-10-01', '15:59 ET — the session is not complete yet');
  assert.equal(CS.targetSession(Date.parse('2026-10-02T20:00:00Z')), '2026-10-02', '16:00 ET — the bell');
});

test('targetSession: holidays resolve to the prior trading day (the market-session calendar, not a re-implementation)', () => {
  assert.equal(CS.targetSession(Date.parse('2026-11-26T22:00:00Z')), '2026-11-25', 'Thanksgiving Thursday → Wednesday');
  assert.equal(CS.targetSession(Date.parse('2026-09-07T22:00:00Z')), '2026-09-04', 'Labor Day Monday → the Friday before');
  assert.equal(CS.targetSession(Date.parse('2026-09-08T02:00:00Z')), '2026-09-04', '22:00 ET Labor Day → still the Friday before');
  assert.equal(CS.targetSession(Date.parse('2026-11-27T18:30:00Z')), '2026-11-27', 'the 13:00 ET early close counts as complete at 13:30 ET');
});

test('normalizeChainSummary: `session` is the key; `date` is the informational ET wall-clock date; a legacy body without session falls back to date', () => {
  const premarket = CS.normalizeChainSummary(payload({ session: '2026-10-01', date: '2026-10-02', startedAt: '2026-10-02T06:14:00Z' }), { now: SIX14_FRI });
  assert.equal(premarket.error, null);
  assert.equal(premarket.value.session, '2026-10-01'); assert.equal(premarket.value.date, '2026-10-02');
  const legacy = CS.normalizeChainSummary(payload({ date: '2026-10-01' }), { now: NOW });
  assert.equal(legacy.value.session, '2026-10-01', 'legacy posters (no session) are keyed by their date'); assert.equal(legacy.value.date, '2026-10-01');
  const noDate = CS.normalizeChainSummary(payload({ date: undefined, session: '2026-10-01' }), { now: NOW });
  assert.equal(noDate.error, null); assert.equal(noDate.value.date, '2026-10-01', 'date defaults to the session when the poster omits it');
  assert.equal(CS.sessionOf({ session: '2026-10-01', date: '2026-10-02' }), '2026-10-01');
  assert.equal(CS.sessionOf({ date: '2026-10-02' }), '2026-10-02');
  assert.equal(CS.sessionOf(null), null);
});

test('normalizeChainSummary: an explicit session must be a real trading session inside the window', () => {
  assert.match(CS.normalizeChainSummary(payload({ session: '2026-10-03' }), { now: SIX41_SAT }).error, /session/, 'a Saturday is not a session');
  assert.match(CS.normalizeChainSummary(payload({ session: '2026-11-26' }), { now: Date.parse('2026-11-27T00:00:00Z') }).error, /session/, 'Thanksgiving is not a session');
  assert.match(CS.normalizeChainSummary(payload({ session: '2026/10/02' }), { now: NOW }).error, /session/);
  assert.match(CS.normalizeChainSummary(payload({ session: '2026-09-01' }), { now: NOW }).error, /session/, 'outside the window');
  assert.match(CS.normalizeChainSummary(payload({ session: undefined, date: undefined }), { now: NOW }).error, /session/, 'one of session/date is required');
  assert.equal(CS.isTradingSessionDate('2026-10-01'), true); assert.equal(CS.isTradingSessionDate('2026-10-03'), false);
  assert.equal(CS.isTradingSessionDate('2026-07-03'), false, 'observed holiday'); assert.equal(CS.isTradingSessionDate('nope'), false);
});

test('mergeChainSummary + readChainSummaries: nights are identified by session, legacy docs by their date', async () => {
  const premarket = { session: '2026-10-01', date: '2026-10-02', source: 'github-matrix', partial: false, ok: true, failed: [], runId: 'pm', chains: fullChains, covered: ROOTS };
  const friday = { session: '2026-10-02', date: '2026-10-02', source: 'github-matrix', partial: false, ok: true, failed: [], runId: 'fri', chains: fullChains, covered: ROOTS };
  // Same calendar date, different sessions → the Friday record is a NEW night, not a replacement of Thursday's.
  assert.deepEqual(CS.mergeChainSummary(premarket, friday), friday);
  // A legacy doc keyed by date merges with a session-keyed post for the same session.
  const legacyThu = { date: '2026-10-01', source: 'manual', partial: true, ok: true, failed: [], runId: 'l', chains: { maturity: okChain }, covered: ['maturity'] };
  assert.deepEqual(CS.mergeChainSummary(legacyThu, premarket).priorRuns.map((p) => p.runId), ['l']);
  // The route reads back by session key and ignores a doc whose session does not match its key.
  const store = memStore();
  store.docs.set('chains/2026-10-01.json', premarket);
  store.docs.set('chains/2026-10-02.json', friday);
  store.docs.set('chains/2026-09-30.json', { ...friday, session: '2026-10-02' });
  const hits = await R.readChainSummaries({ store, now: () => SIX41_SAT });
  assert.deepEqual(hits.map((d) => d.session), ['2026-10-02', '2026-10-01']);
});

test('runChainSummary: the doc is written under chains/<session>.json, never the wall-clock date', () => withSecret('s3cret', async () => {
  const store = memStore(); const res = fakeRes();
  await R.runChainSummary(req({ body: payload({ partial: false, session: '2026-10-01', date: '2026-10-02', startedAt: '2026-10-02T06:14:00Z' }) }), res, { store, now: () => SIX14_FRI });
  assert.equal(res.code, 200); assert.equal(res.body.session, '2026-10-01'); assert.equal(res.body.path, 'chains/2026-10-01.json');
  assert.ok(store.docs.has('chains/2026-10-01.json')); assert.equal(store.docs.has('chains/2026-10-02.json'), false);
}));

test('chainsHealthView: the newest SESSION wins and the block carries both session and date', () => {
  const premarket = { session: '2026-10-01', date: '2026-10-02', source: 'github-matrix', partial: false, ok: true, failed: [], finishedAt: '2026-10-02T07:00:00Z', chains: fullChains };
  const legacyFri = { date: '2026-10-02', source: 'github-matrix', partial: false, ok: true, failed: [], chains: fullChains };
  const v = CS.chainsHealthView({ summaries: [premarket], roots: ROOTS, now: SIX14_FRI });
  assert.equal(v.session, '2026-10-01'); assert.equal(v.date, '2026-10-02'); assert.equal(v.ok, true);
  const v2 = CS.chainsHealthView({ summaries: [premarket, legacyFri], roots: ROOTS, now: SIX41_SAT });
  assert.equal(v2.session, '2026-10-02', 'a legacy doc is its date'); assert.equal(v2.date, '2026-10-02');
});

test('matrixRunOverdue: THE 10-02 SEQUENCE — the pre-market full record does not satisfy the post-close night', () => {
  const warmFri = { at: '2026-10-02T22:00:40Z', chainsInProcess: false, chains: {} };  // 18:00 ET Friday, after the close
  const premarket = { session: '2026-10-01', date: '2026-10-02', source: 'github-matrix', partial: false, ok: true, failed: [], chains: fullChains };
  const at = Date.parse(warmFri.at);
  const tripped = CS.matrixRunOverdue({ run: warmFri, summaries: [premarket], now: at + CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS });
  assert.deepEqual(tripped, { session: '2026-10-02', warmAt: warmFri.at, graceMs: CS.NO_MATRIX_RUN_GRACE_MS }, 'Friday has not been covered — the 02:14 ET record is Thursday\'s');
  const friday = { session: '2026-10-02', date: '2026-10-02', source: 'github-matrix', partial: false, ok: true, failed: [], chains: fullChains };
  assert.equal(CS.matrixRunOverdue({ run: warmFri, summaries: [premarket, friday], now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }), null, 'the 20:28 ET full run covers it');
  // Legacy doc for the same night (date only) also covers it.
  assert.equal(CS.matrixRunOverdue({ run: warmFri, summaries: [{ ...friday, session: undefined }], now: at + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }), null);
});

test('matrixRunOverdue: a weekend or holiday warm targets the previous session, which Friday\'s record already covers', () => {
  const friday = { session: '2026-10-02', date: '2026-10-02', source: 'github-matrix', partial: false, ok: true, failed: [], chains: fullChains };
  const warmSat = { at: '2026-10-03T22:00:40Z', chainsInProcess: false, chains: {} };
  assert.equal(CS.matrixRunOverdue({ run: warmSat, summaries: [friday], now: Date.parse(warmSat.at) + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }), null, 'Saturday 10-03: a repeat full run is a no-op and the night reads covered');
  assert.deepEqual(CS.matrixRunOverdue({ run: warmSat, summaries: [], now: Date.parse(warmSat.at) + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }).session, '2026-10-02');
  const warmLabor = { at: '2026-09-07T22:00:40Z', chainsInProcess: false, chains: {} };
  const laborFri = { ...friday, session: '2026-09-04', date: '2026-09-04' };
  assert.equal(CS.matrixRunOverdue({ run: warmLabor, summaries: [laborFri], now: Date.parse(warmLabor.at) + 2 * CS.NO_MATRIX_RUN_GRACE_MS, roots: ROOTS }), null, 'Labor Day');
});
