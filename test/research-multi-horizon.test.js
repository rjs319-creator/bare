'use strict';
// MULTI-HORIZON GRADING tests. The invariants that matter: the vector is a strict SUPERSET
// of the single-horizon grade (the same-horizon rung must reproduce grade.js exactly), each
// rung is gated for elapse INDEPENDENTLY (near rungs resolve while far ones stay pending),
// costs accrue over each rung's own bars, the six target types are null until resolved, and
// nothing here can mutate a prediction or reach a live rank.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const G = require('../lib/research/grade');
const MH = require('../lib/research/multi-horizon');
const S = require('../lib/research/schemas');
const B = require('../lib/research/live-bridge');
const { horizonBatchHasPending } = require('../lib/research-grade-routes');

// Deterministic candle series: close moves by `step`/day from `start`, flat OHLC band.
function series(from, n, start = 100, step = 1) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const close = start + i * step;
    out.push({ date: d.toISOString().slice(0, 10), open: close, high: close + 0.5, low: close - 0.5, close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const AXIS = series('2026-01-05', 90).map(c => c.date);
function pred(over = {}) {
  return B.predictionFromSignal({
    ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected',
    actionable: true, scope: 'liquid', ...over,
  }, {
    decisionTs: over.decisionTs || '2026-01-05', sessionAxis: AXIS,
    modelVersion: 'decision-v1', sessionAxisKind: 'exact',
  });
}
const rung = (v, bars) => v.horizons.find(h => h.bars === bars);

// ── superset consistency: the vector reproduces grade.js at the shared horizon ──
test('the swing (5-bar) rung reproduces grade.js exactly for the same prediction', () => {
  const candles = series('2026-01-05', 90);
  const bench = series('2026-01-05', 90, 100, 0.5);
  const ctx = { candles, benchCandles: bench, asOf: '2026-12-31' };
  const single = G.gradePrediction(pred({ horizon: 'swing' }), ctx).outcome;
  const vec = MH.gradePredictionHorizons(pred({ horizon: 'swing' }), ctx);
  const r5 = rung(vec, 5);
  assert.equal(r5.status, 'resolved');
  for (const f of ['grossReturn', 'costs', 'netReturn', 'benchmarkReturn', 'sectorReturn', 'residualReturn', 'mfe', 'mae']) {
    assert.equal(r5[f], single[f], `rung field ${f} must match grade.js`);
  }
  assert.equal(vec.fillTs, single.fillTs);
  assert.equal(vec.fillPrice, single.fillPrice);
});

test('the ladder is the full 1/3/5/10/21/63 term structure', () => {
  const vec = MH.gradePredictionHorizons(pred(), { candles: series('2026-01-05', 90), asOf: '2026-12-31' });
  assert.deepEqual(vec.horizons.map(h => h.bars), [1, 3, 5, 10, 21, 63]);
});

// ── rule 1, per horizon: near rungs resolve, far rungs stay pending ─────────────
test('THE RULE per horizon: an as-of that only clears the near rungs leaves the far ones pending', () => {
  const candles = series('2026-01-05', 90);
  // Fill is at bar index 1 (2026-01-06). 3 bars later ≈ 2026-01-09; 10 bars ≈ 2026-01-20.
  const vec = MH.gradePredictionHorizons(pred(), { candles, asOf: '2026-01-12' });
  assert.equal(rung(vec, 1).status, 'resolved');
  assert.equal(rung(vec, 3).status, 'resolved');
  assert.equal(rung(vec, 21).status, 'pending', 'a horizon whose label has not elapsed must be pending');
  assert.equal(rung(vec, 63).status, 'pending');
  assert.match(rung(vec, 63).reason, /horizon-not-elapsed/);
  // A pending rung carries NO decided numbers — never a smaller number.
  assert.equal(rung(vec, 63).netReturn, null);
  assert.equal(rung(vec, 63).beatBenchmark, null);
  assert.equal(rung(vec, 63).positiveNet, null);
  assert.equal(rung(vec, 63).severeLoss, null);
});

test('a rung longer than the available data stays pending rather than truncating', () => {
  const short = series('2026-01-05', 8);   // enough for 1/3/5, not for 10/21/63
  const vec = MH.gradePredictionHorizons(pred(), { candles: short, asOf: '2026-12-31' });
  assert.equal(rung(vec, 5).status, 'resolved');
  assert.equal(rung(vec, 10).status, 'pending');
  assert.equal(rung(vec, 63).status, 'pending');
});

// ── costs accrue over EACH rung's own bars ──────────────────────────────────────
test('a short is charged more borrow at 63 sessions than at 5 (cost accrues per rung)', () => {
  const candles = series('2026-01-05', 90);
  const vec = MH.gradePredictionHorizons(pred({ side: 'short', scope: 'micro' }), { candles, asOf: '2026-12-31' });
  assert.ok(rung(vec, 63).costs > rung(vec, 5).costs, 'longer hold = more borrow');
  assert.ok(rung(vec, 5).costs > 0);
});

test('net return equals gross minus costs on every resolved rung', () => {
  const candles = series('2026-01-05', 90);
  const vec = MH.gradePredictionHorizons(pred(), { candles, asOf: '2026-12-31' });
  for (const h of vec.horizons.filter(x => x.status === 'resolved')) {
    assert.equal(h.netReturn, +(h.grossReturn - h.costs).toFixed(3));
  }
});

// ── the six target types ────────────────────────────────────────────────────────
test('targets are consistent with the underlying numbers', () => {
  const candles = series('2026-01-05', 90);       // +1/session rising
  const bench = series('2026-01-05', 90, 100, 0.2); // slower market ⇒ positive residual
  const vec = MH.gradePredictionHorizons(pred(), { candles, benchCandles: bench, asOf: '2026-12-31' });
  for (const h of vec.horizons.filter(x => x.status === 'resolved')) {
    assert.equal(h.beatBenchmark, h.residualReturn > 0);
    assert.equal(h.positiveNet, h.netReturn > 0);
    assert.equal(h.severeLoss, h.netReturn <= -MH.SEVERE_LOSS_PCT);
  }
});

test('severe-loss target fires on a sharp drawdown', () => {
  const crash = series('2026-01-05', 20, 100, -4);  // ~ -4/day → a long loses >15% within 5 bars
  const vec = MH.gradePredictionHorizons(pred({ side: 'long' }), { candles: crash, asOf: '2026-12-31' });
  assert.equal(rung(vec, 5).severeLoss, true);
  assert.ok(rung(vec, 5).netReturn <= -MH.SEVERE_LOSS_PCT);
  // and NOT on a benign gentle series
  const calm = MH.gradePredictionHorizons(pred(), { candles: series('2026-01-05', 90), asOf: '2026-12-31' });
  assert.equal(rung(calm, 5).severeLoss, false);
});

// ── rule 2: a single real fill shared by every rung; unfilled is recorded ───────
test('an unfillable prediction sets the no-fill target and marks every rung unfilled', () => {
  const vec = MH.gradePredictionHorizons(pred(), { candles: [{ date: '2026-01-05', open: 1, high: 1, low: 1, close: 1 }], asOf: '2026-12-31' });
  assert.equal(vec.fillStatus, 'unfilled');
  assert.equal(vec.noFill, true);
  assert.ok(vec.horizons.every(h => h.status === 'unfilled'));
  assert.equal(S.validateMultiHorizonOutcome(vec).valid, true);
});

test('no candles at all still yields a valid recorded vector, not a crash', () => {
  const vec = MH.gradePredictionHorizons(pred(), { candles: null, asOf: '2026-12-31' });
  assert.equal(vec.fillStatus, 'unfilled');
  assert.equal(vec.noFill, true);
  assert.equal(S.validateMultiHorizonOutcome(vec).valid, true);
});

// ── immutability ────────────────────────────────────────────────────────────────
test('the returned vector and its rungs are frozen', () => {
  const vec = MH.gradePredictionHorizons(pred(), { candles: series('2026-01-05', 90), asOf: '2026-12-31' });
  assert.ok(Object.isFrozen(vec));
  assert.ok(Object.isFrozen(vec.horizons));
  assert.ok(vec.horizons.every(Object.isFrozen));
});

// ── batch grading ───────────────────────────────────────────────────────────────
test('gradeSnapshotHorizons grades rejects too, counts fills, and reports per-rung resolution', () => {
  const candles = series('2026-01-05', 90);
  const snap = B.buildDecisionSnapshot([
    { ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected', actionable: true, scope: 'liquid' },
    { ticker: 'BBB', horizon: 'swing', side: 'long', score: 40, state: 'expired', actionable: false, scope: 'liquid' },
  ], { decisionTs: '2026-01-05', sessionAxis: AXIS, modelVersion: 'decision-v1', sessionAxisKind: 'exact' });

  const batch = MH.gradeSnapshotHorizons(snap, () => candles, { asOf: '2026-12-31' });
  assert.equal(batch.nPredictions, 2);
  assert.equal(batch.nFilled, 2, 'the rejected candidate is graded exactly like the selected one');
  assert.deepEqual(batch.ladder, [1, 3, 5, 10, 21, 63]);
  assert.equal(batch.resolvedByBar[63], 2, 'both names resolved at the deepest rung with 90 bars');
  assert.deepEqual(batch.invalid, []);
  assert.equal(batch.mutatesPredictions, false);
});

test('grading the term structure never mutates the predictions it reads', () => {
  const candles = series('2026-01-05', 90);
  const snap = B.buildDecisionSnapshot([
    { ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected', actionable: true, scope: 'liquid' },
  ], { decisionTs: '2026-01-05', sessionAxis: AXIS, modelVersion: 'decision-v1' });
  const before = JSON.stringify(snap);
  MH.gradeSnapshotHorizons(snap, () => candles, { asOf: '2026-12-31' });
  assert.equal(JSON.stringify(snap), before);
});

test('idempotent — same inputs, same term structure', () => {
  const candles = series('2026-01-05', 90);
  const p = pred();
  const a = MH.gradePredictionHorizons(p, { candles, asOf: '2026-12-31' });
  const b = MH.gradePredictionHorizons(p, { candles, asOf: '2026-12-31' });
  assert.deepEqual(a, b);
});

// ── route helper: a day stays in scope until the whole term structure comes due ──
test('horizonBatchHasPending keeps a day in scope while any deep rung is still open', () => {
  const candles = series('2026-01-05', 90);
  const snap = B.buildDecisionSnapshot([
    { ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected', actionable: true, scope: 'liquid' },
  ], { decisionTs: '2026-01-05', sessionAxis: AXIS, modelVersion: 'decision-v1' });
  // As-of clears only the near rungs → the 63-bar rung is pending → day must stay in scope.
  const partial = MH.gradeSnapshotHorizons(snap, () => candles, { asOf: '2026-01-12' });
  assert.equal(horizonBatchHasPending(partial), true);
  // Once everything has elapsed, the day is done.
  const full = MH.gradeSnapshotHorizons(snap, () => candles, { asOf: '2026-12-31' });
  assert.equal(horizonBatchHasPending(full), false);
});
