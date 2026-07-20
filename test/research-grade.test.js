'use strict';
// GRADING tests. The rules that matter here are the ones that stop a grader from
// flattering the model: never grade an unelapsed horizon, never enter at the decision
// close, never drop an unfillable name, never skip a rejected candidate, and never
// price a short as if borrow were free.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const G = require('../lib/research/grade');
const S = require('../lib/research/schemas');
const B = require('../lib/research/live-bridge');

// Deterministic candle series: close rises 1/day from `start`, flat OHLC band.
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

const AXIS = series('2026-01-05', 40).map(c => c.date);
function pred(over = {}) {
  return B.predictionFromSignal({
    ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected',
    actionable: true, scope: 'liquid', ...over,
  }, {
    decisionTs: over.decisionTs || '2026-01-05', sessionAxis: AXIS,
    modelVersion: 'decision-v1', sessionAxisKind: 'exact',
  });
}

// ── rule 1: never grade early ────────────────────────────────────────────────
test('THE RULE: a horizon that has not elapsed returns pending, not a smaller number', () => {
  const candles = series('2026-01-05', 40);
  // swing = 5 sessions. Grading as-of 2 sessions later must NOT produce an outcome.
  const early = G.gradePrediction(pred(), { candles, asOf: '2026-01-07' });
  assert.ok(early.pending, 'must refuse to grade a partially-elapsed horizon');
  assert.match(early.pending, /horizon-not-elapsed/);
  assert.equal(early.outcome, undefined);
});

test('once the horizon elapses, the same prediction grades', () => {
  const candles = series('2026-01-05', 40);
  const late = G.gradePrediction(pred(), { candles, asOf: '2026-03-01' });
  assert.ok(late.outcome, `expected an outcome, got pending: ${late.pending}`);
  assert.equal(S.validateExecutableOutcome(late.outcome).valid, true);
});

test('a horizon longer than the available data stays pending rather than truncating', () => {
  const short = series('2026-01-05', 3);   // fewer bars than a swing needs
  const r = G.gradePrediction(pred(), { candles: short, asOf: '2026-03-01' });
  assert.ok(r.pending, 'must not grade against a truncated window');
});

// ── rule 2: entry is a real fill ─────────────────────────────────────────────
test('entry is the NEXT session, never the decision-day close', () => {
  const candles = series('2026-01-05', 40);
  const { outcome } = G.gradePrediction(pred(), { candles, asOf: '2026-03-01' });
  assert.ok(outcome.fillTs > '2026-01-05', 'fill must be strictly after the decision');
  assert.equal(outcome.fillStatus, 'filled');
  assert.ok(outcome.fillPrice > 0);
});

test('an unfillable prediction is RECORDED as unfilled, not dropped', () => {
  // No candles at all → cannot fill. Dropping it would be survivorship bias in the grader.
  const r = G.gradePrediction(pred(), { candles: [{ date: '2026-01-05', open: 1, high: 1, low: 1, close: 1 }], asOf: '2026-03-01' });
  assert.ok(r.outcome, 'unfillable must still yield a record');
  assert.equal(r.outcome.fillStatus, 'unfilled');
  assert.ok(r.outcome.exitReason, 'must say WHY it could not fill');
  assert.equal(S.validateExecutableOutcome(r.outcome).valid, true);
});

test('labelEndTs is recorded on every filled outcome (exact purge needs it)', () => {
  const candles = series('2026-01-05', 40);
  const { outcome } = G.gradePrediction(pred(), { candles, asOf: '2026-03-01' });
  assert.equal(outcome.labelEndTs, outcome.exitTs);
  assert.ok(outcome.labelEndTs > outcome.fillTs);
});

// ── returns, sides, costs ────────────────────────────────────────────────────
test('a rising series is a winning long and a losing short', () => {
  const candles = series('2026-01-05', 40);          // +1/session
  const long = G.gradePrediction(pred({ side: 'long' }), { candles, asOf: '2026-03-01' }).outcome;
  const short = G.gradePrediction(pred({ side: 'short' }), { candles, asOf: '2026-03-01' }).outcome;
  assert.ok(long.grossReturn > 0, 'long profits as price rises');
  assert.ok(short.grossReturn < 0, 'short loses as price rises');
  assert.equal(Math.sign(long.grossReturn), -Math.sign(short.grossReturn));
});

test('RULE 4: a short is charged borrow, so it costs more than the same long', () => {
  const candles = series('2026-01-05', 40);
  const long = G.gradePrediction(pred({ side: 'long', scope: 'micro' }), { candles, asOf: '2026-03-01' }).outcome;
  const short = G.gradePrediction(pred({ side: 'short', scope: 'micro' }), { candles, asOf: '2026-03-01' }).outcome;
  assert.ok(short.costs > long.costs, `short costs ${short.costs} must exceed long ${long.costs}`);
});

test('net return is gross minus costs, and costs always hurt', () => {
  const candles = series('2026-01-05', 40);
  const o = G.gradePrediction(pred(), { candles, asOf: '2026-03-01' }).outcome;
  assert.equal(o.netReturn, +(o.grossReturn - o.costs).toFixed(3));
  assert.ok(o.netReturn < o.grossReturn, 'friction is a drag in both directions');
});

test('residual return subtracts the benchmark, side-correctly', () => {
  const candles = series('2026-01-05', 40);
  const bench = series('2026-01-05', 40);                     // identical market
  const o = G.gradePrediction(pred(), { candles, benchCandles: bench, asOf: '2026-03-01' }).outcome;
  assert.ok(o.benchmarkReturn > 0);
  // Matching the market exactly ⇒ residual is just the cost drag.
  assert.ok(Math.abs(o.residualReturn - (-o.costs)) < 0.05,
    `residual ${o.residualReturn} should be ~ -costs ${o.costs} when the name matches the market`);
});

test('THE REGRESSION: entry friction is charged exactly once, not twice', () => {
  // execution-policy's DEFAULT policy bakes entry slippage into the fill PRICE, while
  // costs.js separately charges 2 x (halfSpread + slippage). Using both silently
  // double-charges the entry leg and makes every strategy look worse than it is. The
  // grader must fill at the UNSLIPPED next open and let costs.js be the sole model.
  const candles = series('2026-01-05', 40);
  const { outcome } = G.gradePrediction(pred(), { candles, asOf: '2026-03-01' });
  const fillBar = candles.find(c => c.date === outcome.fillTs);
  assert.equal(outcome.fillPrice, fillBar.open,
    'fill must be the raw next open — slippage belongs to costs.js, not the price');
});

test('a name that exactly tracks its benchmark shows residual = -costs', () => {
  // The tightest statement of entry-timing alignment: identical series, so every bit of
  // underperformance must be friction. A close-to-close benchmark against an open-entry
  // position would leave a spurious one-bar drift here.
  const candles = series('2026-01-05', 40);
  const o = G.gradePrediction(pred(), { candles, benchCandles: series('2026-01-05', 40), asOf: '2026-03-01' }).outcome;
  assert.ok(Math.abs(o.residualReturn + o.costs) < 0.001,
    `residual ${o.residualReturn} must equal -costs ${o.costs} exactly when the name IS the benchmark`);
});

test('MFE/MAE are side-correct: a short profits when price falls', () => {
  const falling = series('2026-01-05', 40, 100, -1);
  const short = G.gradePrediction(pred({ side: 'short' }), { candles: falling, asOf: '2026-03-01' }).outcome;
  assert.ok(short.mfe > 0, 'falling price is FAVOURABLE excursion for a short');
  assert.ok(short.grossReturn > 0, 'and a profitable one');
});

// ── rule 3: rejected candidates are graded too ───────────────────────────────
test('RULE 3: rejected predictions are graded exactly like selected ones', () => {
  const candles = series('2026-01-05', 40);
  const snap = B.buildDecisionSnapshot([
    { ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected', actionable: true, scope: 'liquid' },
    { ticker: 'BBB', horizon: 'swing', side: 'long', score: 40, state: 'expired', actionable: false, scope: 'liquid' },
  ], { decisionTs: '2026-01-05', sessionAxis: AXIS, modelVersion: 'decision-v1', sessionAxisKind: 'exact' });

  const batch = G.gradeSnapshot(snap, () => candles, { asOf: '2026-03-01' });
  assert.equal(batch.nPredictions, 2);
  assert.equal(batch.nGraded, 2, 'the rejected candidate must be graded, else the learner never sees it');
  assert.equal(batch.nFilled, 2);
  assert.deepEqual(batch.invalid, []);
});

test('grading never mutates the predictions it reads', () => {
  const candles = series('2026-01-05', 40);
  const snap = B.buildDecisionSnapshot([
    { ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected', actionable: true, scope: 'liquid' },
  ], { decisionTs: '2026-01-05', sessionAxis: AXIS, modelVersion: 'decision-v1' });
  const before = JSON.stringify(snap);
  G.gradeSnapshot(snap, () => candles, { asOf: '2026-03-01' });
  assert.equal(JSON.stringify(snap), before);
  assert.equal(G.gradeSnapshot(snap, () => candles, { asOf: '2026-03-01' }).mutatesPredictions, false);
});

test('a batch separates graded from pending instead of silently discarding', () => {
  const candles = series('2026-01-05', 40);
  const snap = B.buildDecisionSnapshot([
    { ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected', actionable: true, scope: 'liquid' },
    { ticker: 'CCC', horizon: 'portfolio', side: 'long', score: 70, state: 'detected', actionable: true, scope: 'liquid' },
  ], { decisionTs: '2026-01-05', sessionAxis: AXIS, modelVersion: 'decision-v1' });
  // 63-session portfolio horizon cannot have elapsed in a 40-bar series.
  const batch = G.gradeSnapshot(snap, () => candles, { asOf: '2026-03-01' });
  assert.equal(batch.nGraded, 1);
  assert.equal(batch.nPending, 1);
  assert.equal(batch.pending[0].ticker, 'CCC');
  assert.match(batch.pending[0].reason, /horizon-not-elapsed/);
});

test('grading is idempotent — same inputs, same outcomes', () => {
  const candles = series('2026-01-05', 40);
  const p = pred();
  const a = G.gradePrediction(p, { candles, asOf: '2026-03-01' }).outcome;
  const b = G.gradePrediction(p, { candles, asOf: '2026-03-01' }).outcome;
  assert.deepEqual(a, b);
});

// ── sector-relative residual (the #1 experiment) ─────────────────────────────
test('a per-ticker sectorLookup makes the residual SECTOR-relative, not market-relative', () => {
  const name = series('2026-01-05', 40, 100, 1);       // the name: +1/session
  const sector = series('2026-01-05', 40, 100, 1);     // its sector ETF: identical path
  const market = series('2026-01-05', 40, 100, 0.1);   // the broad market: much slower
  const snap = B.buildDecisionSnapshot([
    { ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected', actionable: true, scope: 'liquid' },
  ], { decisionTs: '2026-01-05', sessionAxis: AXIS, modelVersion: 'decision-v1', sessionAxisKind: 'exact' });

  const batch = G.gradeSnapshot(snap, () => name, {
    asOf: '2026-03-01', benchCandles: market, sectorLookup: () => sector,
  });
  const o = batch.outcomes[0];
  // The name exactly tracks its SECTOR, so the sector-relative residual is just the cost drag —
  // NOT the large positive number a market-relative residual would show against the slow market.
  assert.ok(Math.abs(o.residualReturn + o.costs) < 0.05,
    `residual ${o.residualReturn} must be ~ -costs ${o.costs} when the name tracks its sector`);
  assert.ok(o.sectorReturn > o.benchmarkReturn, 'sector rose faster than the broad market here');
});

test('sectorLookup falls back to the market benchmark when a name has no mapped sector', () => {
  const name = series('2026-01-05', 40, 100, 1);
  const market = series('2026-01-05', 40, 100, 1);     // identical market
  const snap = B.buildDecisionSnapshot([
    { ticker: 'AAA', horizon: 'swing', side: 'long', score: 80, state: 'detected', actionable: true, scope: 'liquid' },
  ], { decisionTs: '2026-01-05', sessionAxis: AXIS, modelVersion: 'decision-v1', sessionAxisKind: 'exact' });
  // sectorLookup returns null (unknown sector) → grader uses the market benchmark.
  const o = G.gradeSnapshot(snap, () => name, { asOf: '2026-03-01', benchCandles: market, sectorLookup: () => null }).outcomes[0];
  assert.equal(o.sectorReturn, null);
  assert.ok(Math.abs(o.residualReturn + o.costs) < 0.001, 'residual falls back to market = -costs when the name IS the market');
});

test('an empty snapshot grades to a terminal batch, not a crash', () => {
  const batch = G.gradeSnapshot({ decisionTs: '2026-01-05', predictions: [] }, () => null, { asOf: '2026-03-01' });
  assert.equal(batch.nPredictions, 0);
  assert.equal(batch.nGraded, 0);
  assert.deepEqual(batch.invalid, []);
});
