'use strict';
// DYNAMIC WEIGHTING and the 0-100 OPPORTUNITY SCORE: maturity gating, weight bounds and
// shrinkage, fallbacks, score range/determinism, ranking ties and eligibility reasons.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/forecast/ensemble');
const S = require('../lib/forecast/score');
const SB = require('../lib/forecast/scoreboard');
const U = require('../lib/forecast/universe');
const FX = require('./forecast-fixtures');

const cfg = FX.testConfig();

function observations({ model, horizon = 5, n = 400, rankIC = 0.02, labelEndOffsetDays = 0, failed = false }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2024, 0, 2) + i * 86400000);
    const d = day.toISOString().slice(0, 10);
    const end = new Date(day.getTime() + labelEndOffsetDays * 86400000).toISOString().slice(0, 10);
    out.push({ model, horizon, decisionDate: d, labelEnd: end, rankIC, netReturn: rankIC * 0.02, failed });
  }
  return out;
}

test('computeWeights REFUSES to run without a maturity cutoff', () => {
  assert.throws(
    () => E.computeWeights({ observations: [], models: ['ridge'], horizon: 5, asOf: null, cfg }),
    /requires an asOf date/,
  );
});

test('ONLY matured observations count — an unmatured label is invisible', () => {
  const obs = observations({ model: 'ridge', n: 400 });
  const early = E.computeWeights({ observations: obs, models: ['ridge', 'chronos2'], horizon: 5, asOf: '2024-01-05', cfg });
  assert.ok(early.observations < 10, `expected almost nothing matured by 2024-01-05, saw ${early.observations}`);
  assert.equal(early.status, 'fallback');

  const late = E.computeWeights({ observations: obs, models: ['ridge', 'chronos2'], horizon: 5, asOf: '2026-01-01', cfg });
  assert.equal(late.observations, 400);
});

test('an observation whose label closes ON the as-of date is still excluded', () => {
  const obs = [{ model: 'ridge', horizon: 5, decisionDate: '2024-05-01', labelEnd: '2024-06-01', rankIC: 0.05 }];
  const w = E.computeWeights({ observations: obs, models: ['ridge'], horizon: 5, asOf: '2024-06-01', cfg });
  assert.equal(w.observations, 0, 'maturity is STRICTLY before the as-of date');
});

test('weights favour the component with the better matured trailing rank IC', () => {
  const obs = [...observations({ model: 'ridge', rankIC: 0.03 }), ...observations({ model: 'chronos2', rankIC: 0.005 })];
  const w = E.computeWeights({ observations: obs, models: ['ridge', 'chronos2'], horizon: 5, asOf: '2026-01-01', cfg });
  assert.equal(w.status, 'dynamic');
  assert.ok(w.weights.ridge > w.weights.chronos2);
  assert.ok(Math.abs(Object.values(w.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6, 'weights sum to 1');
});

test('weights respect BOTH bounds after normalization', () => {
  const obs = [...observations({ model: 'ridge', rankIC: 0.10 }), ...observations({ model: 'chronos2', rankIC: -0.05 })];
  const w = E.computeWeights({ observations: obs, models: ['ridge', 'chronos2'], horizon: 5, asOf: '2026-01-01', cfg });
  for (const [m, v] of Object.entries(w.weights)) {
    assert.ok(v >= cfg.ensemble.minWeight - 1e-9, `${m} below the floor: ${v}`);
    assert.ok(v <= cfg.ensemble.maxWeight + 1e-9, `${m} above the cap: ${v}`);
  }
  assert.ok(Math.abs(Object.values(w.weights).reduce((a, b) => a + b, 0) - 1) < 1e-6);
});

test('projectToBounds is a real projection, not clamp-then-renormalize', () => {
  const w = E.projectToBounds({ a: 0.95, b: 0.03, c: 0.02 }, ['a', 'b', 'c'], 0.05, 0.7);
  assert.ok(w.a <= 0.7 + 1e-9, `cap violated after renormalization: ${w.a}`);
  assert.ok(w.b >= 0.05 - 1e-9 && w.c >= 0.05 - 1e-9);
  assert.ok(Math.abs(w.a + w.b + w.c - 1) < 1e-6);
});

test('impossible bounds fall back to equal weights instead of violating them silently', () => {
  const w = E.projectToBounds({ a: 0.5, b: 0.5 }, ['a', 'b'], 0.6, 0.9);   // 0.6*2 > 1
  assert.equal(w.a, w.b);
  assert.ok(Math.abs(w.a + w.b - 1) < 1e-6);
});

test('shrinkage moves weights toward equal', () => {
  const obs = [...observations({ model: 'ridge', rankIC: 0.10 }), ...observations({ model: 'chronos2', rankIC: 0.001 })];
  const hard = FX.testConfig({ ensemble: { shrinkToEqual: 0, minWeight: 0, maxWeight: 1, minObservations: 10, minDates: 5 } });
  const soft = FX.testConfig({ ensemble: { shrinkToEqual: 0.9, minWeight: 0, maxWeight: 1, minObservations: 10, minDates: 5 } });
  const a = E.computeWeights({ observations: obs, models: ['ridge', 'chronos2'], horizon: 5, asOf: '2026-01-01', cfg: hard });
  const b = E.computeWeights({ observations: obs, models: ['ridge', 'chronos2'], horizon: 5, asOf: '2026-01-01', cfg: soft });
  assert.ok(Math.abs(b.weights.ridge - 0.5) < Math.abs(a.weights.ridge - 0.5), 'more shrinkage means closer to equal');
});

test('a thin matured sample falls back, and the fallback is NAMED', () => {
  const obs = observations({ model: 'ridge', n: 5 });
  const w = E.computeWeights({ observations: obs, models: ['ridge', 'chronos2'], horizon: 5, asOf: '2026-01-01', cfg });
  assert.equal(w.status, 'fallback');
  assert.equal(w.fallback, E.FALLBACK.BASELINE_ONLY);
  assert.equal(w.weights.ridge, 1);
  assert.match(w.reason, /matured sample too small/);
});

test('the last valid weights are preferred over a static fallback when available', () => {
  const lastValid = { status: 'dynamic', weights: { ridge: 0.6, chronos2: 0.4 } };
  const w = E.computeWeights({ observations: [], models: ['ridge', 'chronos2'], horizon: 5, asOf: '2026-01-01', cfg, lastValid });
  assert.equal(w.fallback, E.FALLBACK.LAST_VALID);
  assert.deepEqual(w.weights, lastValid.weights);
});

test('a persistently failing component is penalized', () => {
  const clean = observations({ model: 'ridge', rankIC: 0.02 });
  const flaky = observations({ model: 'chronos2', rankIC: 0.02, failed: true });
  const w = E.computeWeights({ observations: [...clean, ...flaky], models: ['ridge', 'chronos2'], horizon: 5, asOf: '2026-01-01', cfg });
  assert.ok(w.weights.ridge > w.weights.chronos2, 'equal IC but a 100% failure rate must lose weight');
});

test('weightedPoint renormalizes over usable components and never treats missing as zero', () => {
  const frame = { base: { ridge: { availability: 'ok', point: 0.02 }, chronos2: { availability: 'package-missing', point: null } } };
  const wp = E.weightedPoint(frame, { ridge: 0.5, chronos2: 0.5 });
  assert.equal(wp.point, 0.02, 'a missing component must not drag the estimate toward zero');
  assert.deepEqual(wp.usedModels, ['ridge']);

  const none = E.weightedPoint({ base: { ridge: { availability: 'inference-failed', point: null } } }, { ridge: 1 });
  assert.equal(none.point, null, 'no usable component means NO estimate');
});

test('agreement needs at least two usable components', () => {
  assert.equal(E.agreement({ base: { ridge: { availability: 'ok', point: 0.01 } } }).agreement, null);
  const two = E.agreement({ base: { a: { availability: 'ok', point: 0.01 }, b: { availability: 'ok', point: 0.011 } } });
  const far = E.agreement({ base: { a: { availability: 'ok', point: 0.01 }, b: { availability: 'ok', point: 0.09 } } });
  assert.ok(two.agreement > far.agreement, 'closer forecasts agree more');
});

test('only matured walk-forward OOS rows reach the weighting inputs', () => {
  const mk = (evaluationType, maxLabelEnd) => ({
    schema: 'ForecastScoreboardRow', model: 'ridge', horizon: 5, fold: 'f0', evaluationType,
    maxLabelEnd, period: { first: '2024-01-01', last: '2024-02-01' },
    ic: { meanRankIC: 0.02 }, backtest: null, probability: {}, quantileCoverage: null,
    latencyMsMean: null, failureRate: 0, n: 100, dates: 20,
  });
  const board = SB.makeScoreboard([
    mk('walk-forward-oos', '2024-03-01'),
    mk('cross-fitted', '2024-03-01'),
    mk('in-sample', '2024-03-01'),
    mk('final-holdout', '2024-03-01'),
    mk('walk-forward-oos', '2025-01-01'),   // not matured as of 2024-06-01
  ]);
  const inputs = SB.productionEligibleInputs(board, '2024-06-01');
  assert.equal(inputs.length, 1, 'only the matured walk-forward OOS row is eligible');
  assert.equal(inputs[0].labelEnd, '2024-03-01');
});

// ── opportunity score ────────────────────────────────────────────────────────

const scoreRows = (n, seed = 3) => {
  const rnd = FX.rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    rowKey: `r${i}`, rankerScore: rnd(), expectedResidualReturn: (rnd() - 0.5) * 0.05,
    probabilities: { 0: rnd(), drawdown: rnd() * 0.5 },
    intervalWidth80: 0.02 + rnd() * 0.05, agreement: rnd(), reliability: 0.5,
    estimatedCostFraction: 0.001 + rnd() * 0.002,
    quality: { featureCoverage: 0.9 + rnd() * 0.1, staleSessions: 0 },
  }));
};

test('scores are integers within 0-100 and deterministic', () => {
  const rows = scoreRows(60);
  const a = S.scoreDate(rows, cfg);
  const b = S.scoreDate(rows, cfg);
  for (const r of a) {
    assert.ok(r.opportunityScore >= 0 && r.opportunityScore <= 100, `out of range: ${r.opportunityScore}`);
    assert.equal(r.opportunityScore, Math.round(r.opportunityScore));
  }
  assert.deepEqual(a.map((r) => r.opportunityScore), b.map((r) => r.opportunityScore), 'the score must be reproducible');
});

test('an uncalibrated score is BUCKETED and says so; a calibrated one is finer-grained', () => {
  const rows = scoreRows(80, 11);
  const un = S.scoreDate(rows, cfg);
  assert.equal(un[0].scoreStatus, S.STATUS.UNCALIBRATED);
  assert.equal(un[0].scoreBucket, 5, 'without calibration the score is coarsened to avoid false precision');
  for (const r of un) assert.equal(r.opportunityScore % 5, 0);

  const mapping = S.fitScoreMapping(Array.from({ length: 3000 }, (_, i) => i / 3000));
  const cal = S.scoreDate(rows, cfg, { mapping });
  assert.equal(cal[0].scoreStatus, S.STATUS.CALIBRATED);
  assert.equal(cal[0].scoreBucket, 1);
});

test('the score mapping refuses to be fitted on a thin history', () => {
  assert.equal(S.fitScoreMapping([0.1, 0.2, 0.3]), null);
  assert.ok(S.fitScoreMapping(Array.from({ length: 3000 }, (_, i) => i / 3000)));
});

test('the score is monotone in the ranker when everything else is held constant', () => {
  const base = { probabilities: { 0: 0.5, drawdown: 0.3 }, intervalWidth80: 0.03, agreement: 0.7, reliability: 0.5, estimatedCostFraction: 0.001, quality: { featureCoverage: 1, staleSessions: 0 }, expectedResidualReturn: 0.01 };
  const rows = Array.from({ length: 30 }, (_, i) => ({ rowKey: `r${i}`, rankerScore: i / 30, ...base }));
  const out = S.scoreDate(rows, cfg);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].opportunityScore >= out[i - 1].opportunityScore, 'a better rank must never score lower, all else equal');
  }
});

test('tied inputs produce tied scores', () => {
  const same = { rankerScore: 0.5, expectedResidualReturn: 0.01, probabilities: { 0: 0.6, drawdown: 0.2 }, intervalWidth80: 0.03, agreement: 0.8, reliability: 0.5, estimatedCostFraction: 0.001, quality: { featureCoverage: 1, staleSessions: 0 } };
  const rows = [{ rowKey: 'a', ...same }, { rowKey: 'b', ...same }, { rowKey: 'c', ...same }];
  const out = S.scoreDate(rows, cfg);
  assert.equal(new Set(out.map((r) => r.opportunityScore)).size, 1, 'identical inputs must score identically');
});

test('a row with no usable components gets NO score and an explicit status', () => {
  const out = S.scoreDate([{ rowKey: 'x', rankerScore: null, expectedResidualReturn: null, probabilities: {}, intervalWidth80: null, agreement: null, reliability: null, estimatedCostFraction: null, quality: null }], cfg);
  assert.equal(out[0].opportunityScore, null);
  assert.equal(out[0].scoreStatus, S.STATUS.INSUFFICIENT);
});

test('missing components shift the mix rather than scoring zero', () => {
  const full = S.composite({ rank: 0.9, probUp: 0.9, magnitude: 0.9, drawdownRisk: 0.1, uncertainty: 0.1, agreement: 0.9, reliability: 0.9, liquidityCost: 0.1, freshness: 0.9 }, cfg.score.weights);
  const partial = S.composite({ rank: 0.9, probUp: null, magnitude: null, drawdownRisk: null, uncertainty: 0.1, agreement: null, reliability: null, liquidityCost: 0.1, freshness: 0.9 }, cfg.score.weights);
  assert.ok(partial.value > 0.8, `a mostly-missing but strong row should still score high, got ${partial.value}`);
  assert.ok(partial.coverage < full.coverage);
});

// ── eligibility reasons ──────────────────────────────────────────────────────

test('every excluded name carries a reason, and eligible ones carry the OK reason', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 12, seed: 61 });
  const snap = U.buildUniverseSnapshot(panel, panel.sessions[250], cfg, { recordExclusions: true });
  assert.ok(snap.size > 0);
  for (const e of snap.exclusions) assert.ok(Object.values(U.REASONS).includes(e.reason), `unknown reason ${e.reason}`);
  assert.equal(snap.survivorshipSafe, false, 'survivorship is never claimed safe');
  assert.ok(snap.limitations.length >= 2);
});

test('the liquidity floor and the price floor each produce their own reason', () => {
  const panel = FX.buildPanel({ sessions: 320, names: 6, seed: 63 });
  const entry = panel.dataset.get('SYN00');
  const date = panel.sessions[250];
  const illiquid = U.eligibilityAt(entry, date, FX.testConfig({ universe: { minAvgDollarVolume: 1e15, minHistorySessions: 110, advLookback: 20, minPrice: 1 } }), { sessionIndex: panel.sessionIndex });
  assert.equal(illiquid.reason, U.REASONS.ILLIQUID);
  const pricey = U.eligibilityAt(entry, date, FX.testConfig({ universe: { minPrice: 1e9, minHistorySessions: 110, advLookback: 20, minAvgDollarVolume: 1 } }), { sessionIndex: panel.sessionIndex });
  assert.equal(pricey.reason, U.REASONS.LOW_PRICE);
  const green = U.eligibilityAt(entry, date, FX.testConfig({ universe: { minHistorySessions: 1e6, advLookback: 20, minAvgDollarVolume: 1, minPrice: 1 } }), { sessionIndex: panel.sessionIndex });
  assert.equal(green.reason, U.REASONS.SHORT_HISTORY);
});
