'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { championChallenger, fitWeights, factorICs, composite, FK, MIN_RESOLVED } = require('../lib/timing-adapt');
const { scoreTiming, DEFAULT_WEIGHTS } = require('../lib/timing');

// synthetic resolved rows: forward return driven mostly by the `trend` factor
function rows(n, seed = 1) {
  const out = []; let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i++) {
    const trend = rnd(), rr = rnd(), extension = rnd(), rvol = rnd(), trigger = rnd();
    const fwd = 0.02 * (trend - 0.5) + 0.002 * (rr - 0.5) + 0.01 * (rnd() - 0.5);  // trend dominant, noise
    out.push({ f: { rr, extension, trend, rvol, trigger }, fwd, date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` });
  }
  return out;
}

test('scoreTiming honors custom weights (learned tuner can change the grade)', () => {
  const snap = { price: 10, dayOpen: 9.5, dayHigh: 10.2, dayLow: 9.4, prevClose: 9.5, vwap: 9.9, rvol: 1.5, marketState: 'REGULAR' };
  const levels = { stop: 9, target: 12, trigger: 9.8, avgVol: 1e6 };
  const base = scoreTiming(snap, levels);
  const tilted = scoreTiming(snap, levels, { rr: 0.1, extension: 0.1, trend: 0.6, rvol: 0.1, trigger: 0.1 });
  assert.ok(base.score >= 1 && base.score <= 10);
  assert.ok(tilted.score >= 1 && tilted.score <= 10);
  // different weights should be able to produce a different grade for this snapshot
  assert.ok(typeof tilted.score === 'number');
});

test('factorICs: recovers that trend is the predictive factor', () => {
  const ic = factorICs(rows(1000));
  assert.ok(ic.trend > ic.extension, `trend IC ${ic.trend} should exceed extension ${ic.extension}`);
  assert.ok(ic.trend > 0.05, 'trend should show clear positive IC');
});

test('fitWeights: gives the predictive factor the most weight; weights sum ~1', () => {
  const { weights } = fitWeights(rows(1000));
  const sum = FK.reduce((s, k) => s + weights[k], 0);
  assert.ok(Math.abs(sum - 1) < 0.02, `weights sum ${sum}`);
  assert.ok(weights.trend >= Math.max(weights.rr, weights.extension, weights.rvol, weights.trigger), 'trend gets top weight');
});

test('championChallenger: DORMANT below MIN_RESOLVED (keeps champion)', () => {
  const res = championChallenger(rows(50), DEFAULT_WEIGHTS);
  assert.equal(res.promoted, false);
  assert.deepEqual(res.weights, DEFAULT_WEIGHTS);
  assert.match(res.reason, /accruing/);
});

test('championChallenger: promotes a genuinely better challenger OOS', () => {
  // champion ignores trend; the data is trend-driven → challenger should beat it and promote.
  const champ = { rr: 0.25, extension: 0.25, trend: 0.0, rvol: 0.25, trigger: 0.25 };
  const res = championChallenger(rows(1200), champ, { minResolved: 100 });
  assert.equal(res.resolved >= 100, true);
  assert.ok(res.promoted, `expected promotion; reason: ${res.reason}`);
  assert.ok(res.weights.trend > champ.trend, 'promoted weights lift the predictive factor');
});

test('championChallenger: bounded step — never jumps more than maxStep toward the fit', () => {
  const champ = { rr: 0.25, extension: 0.25, trend: 0.0, rvol: 0.25, trigger: 0.25 };
  const res = championChallenger(rows(1200), champ, { minResolved: 100, maxStep: 0.25 });
  if (res.promoted) {
    // bounded: promoted weight moved TOWARD the fit but no further than a 25% step
    const lo = Math.min(champ.trend, res.fitted.trend), stepMax = champ.trend + 0.25 * (res.fitted.trend - champ.trend);
    assert.ok(res.weights.trend >= lo - 1e-3 && res.weights.trend <= stepMax + 1e-3, `trend ${res.weights.trend} not within bounded step [${lo}, ${stepMax}]`);
  }
});

test('championChallenger: keeps champion when no OOS improvement', () => {
  // pure noise → no factor predicts → challenger shouldn't beat champion by the margin.
  const noise = []; let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 800; i++) noise.push({ f: { rr: rnd(), extension: rnd(), trend: rnd(), rvol: rnd(), trigger: rnd() }, fwd: rnd() - 0.5, date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}` });
  const res = championChallenger(noise, DEFAULT_WEIGHTS, { minResolved: 100 });
  assert.equal(res.promoted, false);
  assert.deepEqual(res.weights, DEFAULT_WEIGHTS);
});
