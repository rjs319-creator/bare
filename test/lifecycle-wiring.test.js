'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sessionOf, buildEvaluation, absentEvaluation } = require('../lib/lifecycle-eval');
const { loadLifecycleDay, saveLifecycleDay, hasDurableStore, keyFor, appendSnapshots, loadSnapshots, saveGrades, loadGrades, snapKey, gradeKey } = require('../lib/lifecycle-store');
const { advanceBoard, slim } = require('../lib/lifecycle-routes');
const { STATES } = require('../lib/opportunity-lifecycle');

// ── lifecycle-eval ───────────────────────────────────────────────────────────
test('sessionOf: classifies the ET session windows', () => {
  assert.equal(sessionOf(new Date('2026-07-08T13:00:00Z')), 'premarket');   // 09:00 ET
  assert.equal(sessionOf(new Date('2026-07-08T14:00:00Z')), 'regular');     // 10:00 ET
  assert.equal(sessionOf(new Date('2026-07-08T21:00:00Z')), 'afterhours');  // 17:00 ET
  assert.equal(sessionOf(new Date('2026-07-08T03:00:00Z')), 'closed');      // 23:00 ET (prev day)
  assert.equal(sessionOf(new Date('2026-07-11T14:00:00Z')), 'closed');      // Saturday
});

test('buildEvaluation: maps a fresh green pick to constructive daily evidence, no intraday signals', () => {
  const pick = {
    ticker: 'ABC', last: 12.3, pctChange: 6.1, relVol: 3.2, excessPct: 2.4, gapPct: 4.0,
    freshness: { freshnessStatus: 'FRESH_TODAY', barIsToday: true },
  };
  const ev = buildEvaluation(pick, { now: '2026-07-08T14:00:00Z' });
  assert.equal(ev.ticker, 'ABC');
  assert.equal(ev.session, 'regular');
  assert.equal(ev.momentumOk, true);       // pctChange > 0
  assert.equal(ev.residualOk, true);        // excessPct >= 0
  assert.equal(ev.nearTrigger, true);       // fresh + up
  // Intraday-only signals must be UNSET so the actionable gate cannot pass on daily data.
  assert.equal(ev.aboveVwap, undefined);
  assert.equal(ev.triggerConfirmed, undefined);
  assert.equal(ev.relVolOk, undefined);
  assert.equal(ev.metrics.residualVsSpy, 2.4);
});

test('buildEvaluation: a stale pick is not fresh and not near-trigger', () => {
  const pick = { ticker: 'STALE', pctChange: 5, freshness: { freshnessStatus: 'PRIOR_SESSION', barIsToday: false } };
  const ev = buildEvaluation(pick, { now: '2026-07-08T14:00:00Z' });
  assert.equal(ev.nearTrigger, false);
});

test('absentEvaluation: marks a dropped name stale with lost momentum', () => {
  const ev = absentEvaluation('GONE', { now: '2026-07-08T14:00:00Z' });
  assert.equal(ev.momentumOk, false);
  assert.equal(ev.freshness.barIsToday, false);
});

// ── lifecycle-store (graceful fallback — no BLOB token in the test env) ───────
test('lifecycle-store: degrades gracefully with no Blob configured', async () => {
  assert.equal(hasDurableStore(), false, 'no BLOB_READ_WRITE_TOKEN in tests');
  const loaded = await loadLifecycleDay('daytrade', '2026-07-08');
  assert.deepEqual(loaded.records, {});
  assert.equal(loaded.durable, false);
  const saved = await saveLifecycleDay('daytrade', '2026-07-08', { ABC: { state: 'WATCHING' } });
  assert.equal(saved.persisted, false);      // no-op, but never throws
  assert.equal(saved.reason, 'no-store');
  assert.equal(keyFor('daytrade', '2026-07-08'), 'lifecycle/daytrade/2026-07-08.json');
});

test('lifecycle-store: snapshot log + grades degrade gracefully with no Blob configured', async () => {
  assert.equal(snapKey('daytrade', '2026-07-08'), 'lifecycle/daytrade/snapshots/2026-07-08.json');
  assert.equal(gradeKey('daytrade', '2026-07-08'), 'lifecycle/daytrade/grades/2026-07-08.json');
  assert.deepEqual(await loadSnapshots('daytrade', '2026-07-08'), []);
  const ap = await appendSnapshots('daytrade', '2026-07-08', [{ ticker: 'ABC', at: 't' }]);
  assert.equal(ap.persisted, false);          // no-op, never throws
  assert.equal(ap.reason, 'no-store');
  assert.deepEqual(await loadGrades('daytrade', '2026-07-08'), {});
  const gr = await saveGrades('daytrade', '2026-07-08', { 'ABC|t': {} });
  assert.equal(gr.persisted, false);
});

// ── advanceBoard orchestration (pure, no network/storage) ────────────────────
function pick(ticker, over = {}) {
  return { ticker, last: 10, pctChange: 5, relVol: 3, excessPct: 1.5, freshness: { freshnessStatus: 'FRESH_TODAY', barIsToday: true }, ...over };
}

test('advanceBoard: fresh daily movers become BUILDING (daily evidence tops out below ARMED)', () => {
  const next = advanceBoard({}, [pick('AAA'), pick('BBB')], '2026-07-08T14:00:00Z');
  assert.equal(next.AAA.state, STATES.BUILDING);
  assert.equal(next.BBB.state, STATES.BUILDING);
});

test('advanceBoard: a stale mover does not progress past WATCHING', () => {
  const next = advanceBoard({}, [pick('STL', { freshness: { freshnessStatus: 'PRIOR_SESSION', barIsToday: false } })], '2026-07-08T14:00:00Z');
  assert.equal(next.STL.state, STATES.WATCHING);
});

test('advanceBoard: a candidate that drops out of the scan is CARRIED FORWARD, never erased', () => {
  const t1 = advanceBoard({}, [pick('AAA'), pick('BBB')], '2026-07-08T14:00:00Z');
  assert.equal(t1.BBB.state, STATES.BUILDING);
  // Next cycle: BBB is gone from the scan. It must still exist in the board.
  const t2 = advanceBoard(t1, [pick('AAA')], '2026-07-08T14:05:00Z');
  assert.ok(t2.BBB, 'dropped candidate is retained, not deleted');
  assert.ok(t2.AAA, 'still-present candidate retained');
});

test('advanceBoard: post-entry records are locked to MANAGING/CLOSED even when absent from scan', () => {
  // Seed a MANAGING record, then run a cycle where it is absent from the scan.
  const managing = {
    ticker: 'MGR', strategy: 'daytrade', state: STATES.MANAGING, createdAt: '2026-07-08T13:30:00Z',
    updatedAt: '2026-07-08T13:30:00Z', strategyVersion: 'lifecycle-v1', cooldownUntil: null,
    entryAlertAt: '2026-07-08T13:30:00Z', falseRetirement: null,
    history: [{ from: 'ACTIONABLE_NOW', to: 'MANAGING', at: '2026-07-08T13:30:00Z', reasonCode: 'ENTRY_ALERT_FIRED', explanation: '', metrics: null, freshness: null, strategyVersion: 'lifecycle-v1' }],
  };
  const next = advanceBoard({ MGR: managing }, [], '2026-07-08T14:00:00Z');
  assert.equal(next.MGR.state, STATES.MANAGING, 'a fired alert is never demoted/erased by absence');
});

test('advanceBoard: a Stage-2 intraday ev override drives a candidate to ACTIONABLE_NOW', () => {
  // A fully-green intraday ev supplied via evByTicker beats the daily fallback for that name.
  const intradayEv = {
    ticker: 'AAA', now: '2026-07-08T14:30:00Z', session: 'regular',
    freshness: { freshnessStatus: 'FRESH_TODAY', barIsToday: true },
    aboveVwap: true, momentumOk: true, residualOk: true, relVolOk: true, triggerConfirmed: true,
    remainingRR: 2.0, extensionAtr: 0.7,
  };
  const next = advanceBoard({}, [pick('AAA'), pick('BBB')], '2026-07-08T14:30:00Z', { AAA: intradayEv });
  assert.equal(next.AAA.state, STATES.ACTIONABLE_NOW, 'intraday-validated name is actionable');
  assert.equal(next.BBB.state, STATES.BUILDING, 'name without a Stage-2 ev uses the daily fallback');
});

test('slim: strips heavy history but keeps the last transition + count', () => {
  const next = advanceBoard({}, [pick('AAA')], '2026-07-08T14:00:00Z');
  const [card] = slim(Object.values(next));
  assert.equal(card.ticker, 'AAA');
  assert.equal(card.state, STATES.BUILDING);
  assert.ok(card.explanation);
  assert.equal(typeof card.transitions, 'number');
  assert.equal(card.history, undefined, 'full history not shipped in the card');
});
