'use strict';
// NULL-CALIBRATED CONCENTRATION — the prosecutor's raw thresholds convicted on
// dispersion, twice, and both times the conviction dissolved under calibration.
//
//   screener  n=18  post-excision mean at the 49.6th percentile of its own null,
//                   skew -0.16 (37th pctile). Nothing there. It is WEAK, not
//                   fragile — 0.14 Sharpe/date, and removing the top decile of a
//                   near-zero-mean series flips it negative by arithmetic.
//   events    n=27  post-excision mean at the 34.9th percentile — ALSO not
//                   extreme, and 83% of matched null draws fail excision too.
//                   But skew +0.94 sits at the 98.5th percentile: a right tail a
//                   symmetric draw essentially never produces. THAT is real.
//
// A fixed threshold cannot tell those apart, because what it actually measures
// is n and sd. The calibrated form asks the question directly: is this series
// more tail-carried than a SYMMETRIC distribution with the same mean, sd and n?
//
// Null choice: seeded Gaussian, moments matched to the observation. Not a
// bootstrap of the observed values — resampling the data makes the observed
// statistic the centre of its own null by construction, which cannot detect
// anything. Seeded because the repo grades on reproducible statistics
// (dateNet's moving-block bootstrap pins seed 20260805); an adversarial verdict
// that changes between runs is not a verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const NC = require('../lib/cfl/null-calibration');

// The two real production series this method was derived on.
const SCREENER = [10.36, 10.27, 9.74, 5, 4.2, 3.75, 3.16, 2.37, 0.98,
  -0.06, -0.15, -1.14, -1.47, -2.2, -3.4, -6.75, -8.3, -11.45];
const EVENTS = [52.5, 38.51, 31.26, 27.37, 18.26, 11.37, 9.61, 3.96, 3.19, 2.83, 2.13, 0.86, 0.44, 0.22,
  -0.22, -0.5, -1.78, -4.67, -5.16, -6.78, -9.18, -11.58, -14.07, -20.31, -21.77, -22.93, -23.5];

// ── determinism ────────────────────────────────────────────────────────────
test('the same series always yields the identical verdict', () => {
  const a = NC.calibrateConcentration(EVENTS);
  const b = NC.calibrateConcentration(EVENTS);
  assert.deepEqual(a, b, 'a verdict that moves between runs is not a verdict');
});

test('the null is seeded, not drawn from the ambient clock', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/cfl/null-calibration'), 'utf8');
  assert.doesNotMatch(src, /Math\.random|Date\.now/, 'the null must be reproducible');
});

// ── it clears what it should clear ─────────────────────────────────────────
test('the screener is NOT concentrated — it is merely weak', () => {
  const r = NC.calibrateConcentration(SCREENER);
  assert.equal(r.concentrated, false);
  // Sits mid-distribution on the tail statistic rather than out in the tail.
  assert.ok(r.skew.percentile > 10 && r.skew.percentile < 90,
    `skew percentile ${r.skew.percentile} should be unremarkable`);
});

test('a symmetric positive series is never convicted', () => {
  const sym = [3, 2.5, 2, 1.5, 1, 0.5, 0.2, -0.2, -0.5, -1, -1.5, -2, -2.5, 2.2, -1.2, 0.8, 1.1, -0.9];
  assert.equal(NC.calibrateConcentration(sym).concentrated, false);
});

// ── it convicts what it should convict ─────────────────────────────────────
test('events IS tail-carried, and the skew statistic is what shows it', () => {
  const r = NC.calibrateConcentration(EVENTS);
  assert.equal(r.concentrated, true);
  assert.ok(r.skew.percentile >= 95, `expected an extreme right tail, got ${r.skew.percentile}`);
  assert.ok(r.skew.observed > 0.5);
});

test('a single monster observation is convicted even at small n', () => {
  const monster = [40, 0.2, -0.3, 0.1, -0.4, 0.3, -0.2, 0.15, -0.35, 0.05, -0.25, 0.2];
  assert.equal(NC.calibrateConcentration(monster).concentrated, true);
});

// ── calibration is what makes small n safe ─────────────────────────────────
test('a small but ordinary sample is not convicted for being small', () => {
  // The whole failure mode of the fixed thresholds. A short, unremarkable
  // series must come back clean rather than convicted on its length.
  const short = [2.1, 1.4, 0.6, -0.3, -1.1, -1.8, 0.9, -0.5, 1.2, -0.9, 0.4, -0.2];
  const r = NC.calibrateConcentration(short);
  assert.equal(r.concentrated, false);
  assert.equal(r.ran, true, 'calibration handles small n directly — no arbitrary floor needed');
});

// ── degenerate input fails closed ──────────────────────────────────────────
test('too few points to characterise a distribution does not run', () => {
  for (const v of [[], [1], [1, 2], [1, 2, 3]]) {
    const r = NC.calibrateConcentration(v);
    assert.equal(r.ran, false);
    assert.equal(r.concentrated, false, 'never convict on an uncharacterisable sample');
  }
});

test('a zero-variance series does not run', () => {
  const r = NC.calibrateConcentration([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  assert.equal(r.ran, false);
  assert.match(r.reason, /variance|degenerate/i);
});

test('non-finite values are dropped, not propagated', () => {
  const r = NC.calibrateConcentration([...EVENTS, NaN, null, undefined, Infinity]);
  assert.equal(r.n, EVENTS.length);
  assert.equal(r.ran, true);
});

// ── the report is legible ──────────────────────────────────────────────────
test('the verdict shows its working', () => {
  const r = NC.calibrateConcentration(EVENTS);
  for (const k of ['observed', 'nullMedian', 'percentile']) {
    assert.ok(k in r.skew, `skew.${k} missing`);
    assert.ok(k in r.postExcision, `postExcision.${k} missing`);
  }
  assert.ok(r.alpha > 0 && r.alpha < 0.5);
  assert.ok(typeof r.basis === 'string' && r.basis.length > 20);
});
