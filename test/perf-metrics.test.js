'use strict';
// lib/perf-metrics — empyrical-reloaded definitions ported at exact precision. Every
// expected value below is derived BY HAND in the comment next to it (sums of squares,
// drawdown path, omega numerator/denominator, beta covariance terms), never by calling
// the function under test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PM = require('../lib/perf-metrics');

const R = [0.01, -0.02, 0.03, -0.01];          // n = 4, mean = 0.0025
const F = [0.02, -0.01, 0.01, 0.00];           // benchmark, mean = 0.005
const ANN = Math.sqrt(252);
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} !== ${b}`);

test('simpleReturns: close-to-close fractional returns, null-safe', () => {
  const r = PM.simpleReturns([100, 101, 99.98]);
  close(r[0], 0.01);
  close(r[1], (99.98 - 101) / 101);
  assert.deepEqual(PM.simpleReturns([100]), []);
  assert.deepEqual(PM.simpleReturns([]), []);
  const skipped = PM.simpleReturns([100, null, 102]);
  assert.equal(skipped.length, 1, 'a missing price is skipped, not zeroed');
  close(skipped[0], 0.02);
});

test('cumReturnsFinal: product of (1+r) minus one — 1.01·0.98·1.03·0.99 − 1', () => {
  close(PM.cumReturnsFinal(R), 1.00929906 - 1);
  assert.equal(PM.cumReturnsFinal([]), null);
});

test('annualReturn: geometric, periods/n exponent — constant 1% over 252 periods is 1.01^252 − 1', () => {
  const r = new Array(252).fill(0.01);
  close(PM.annualReturn(r), Math.pow(1.01, 252) - 1, 1e-9);
  // 4 periods: (1.00929906)^(252/4) − 1
  close(PM.annualReturn(R), Math.pow(1.00929906, 63) - 1, 1e-9);
  assert.equal(PM.annualReturn([]), null);
});

test('annualVolatility: sample std (ddof=1) × √252 — Σ dev² = 0.001475 by hand', () => {
  // deviations from 0.0025: 0.0075, −0.0225, 0.0275, −0.0125 → squares sum 0.001475
  close(PM.annualVolatility(R), Math.sqrt(0.001475 / 3) * ANN);
  assert.equal(PM.annualVolatility([0.01]), null, 'one observation has no sample variance');
});

test('downsideRisk: RMS of min(r − req, 0) over ALL n, annualized √252 — (0.0004 + 0.0001)/4', () => {
  close(PM.downsideRisk(R), Math.sqrt(5e-4 / 4) * ANN);
  assert.equal(PM.downsideRisk([0.01, 0.02]), 0, 'no downside → 0');
});

test('sortinoRatio: annualized mean excess / downside risk — 0.0025·252 / (√1.25e-4·√252)', () => {
  close(PM.sortinoRatio(R), (0.0025 * 252) / (Math.sqrt(1.25e-4) * ANN));
  assert.equal(PM.sortinoRatio([0.01, 0.02]), null, 'zero downside is reported null, never Infinity');
});

test('maxDrawdown: worst peak-to-trough on the cumulative curve — the 0.98 step is −2%', () => {
  // cum: 1.01, 0.9898, 1.019494, 1.00929906 → dd: 0, −0.02, 0, −0.01
  close(PM.maxDrawdown(R), -0.02);
  assert.equal(PM.maxDrawdown([0.01, 0.02]), 0);
  assert.equal(PM.maxDrawdown([]), null);
});

test('calmarRatio: annual return / |max drawdown|; null when there is no drawdown', () => {
  close(PM.calmarRatio(R), (Math.pow(1.00929906, 63) - 1) / 0.02, 1e-9);
  assert.equal(PM.calmarRatio([0.01, 0.02]), null);
});

test('omegaRatio: Σ gains / Σ losses above a threshold — 0.04 / 0.03 at threshold 0', () => {
  close(PM.omegaRatio(R), 0.04 / 0.03);
  // required annual return of 2% → per-period threshold (1.02)^(1/252) − 1 ≈ 7.86e-5
  const thr = Math.pow(1.02, 1 / 252) - 1;
  const less = R.map((x) => x - thr);
  const num = less.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const den = -less.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  close(PM.omegaRatio(R, { requiredReturn: 0.02 }), num / den);
  assert.equal(PM.omegaRatio([0.01, 0.02]), null, 'no losses → undefined, reported null');
});

test('beta: Σ(f_dev·r_dev) / Σ f_dev² — 6.5e-4 / 5e-4 = 1.3 by hand', () => {
  close(PM.beta(R, F), 1.3);
  assert.equal(PM.beta(R, [0.01, 0.01, 0.01, 0.01]), null, 'a flat factor has no beta');
  assert.equal(PM.beta(R, F.slice(0, 3)), null, 'misaligned lengths refuse, never silently truncate');
});

test('rollingBeta: one beta per trailing window — window 2 over R,F is 1, 2.5, 4', () => {
  const out = PM.rollingBeta(R, F, { window: 2 });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.endIndex), [1, 2, 3]);
  close(out[0].beta, 1);
  close(out[1].beta, 2.5);
  close(out[2].beta, 4);
  assert.deepEqual(PM.rollingBeta(R, F, { window: 5 }), [], 'window longer than the series → empty');
});

test('summarize: every metric at full precision from one series, plus n and the citation', () => {
  const s = PM.summarize(R, { benchmarkReturns: F, rollingWindow: 2 });
  assert.equal(s.n, 4);
  close(s.totalReturn, 0.00929906);
  close(s.sortino, (0.0025 * 252) / (Math.sqrt(1.25e-4) * ANN));
  close(s.maxDrawdown, -0.02);
  close(s.omega, 4 / 3);
  close(s.beta, 1.3);
  close(s.latestRollingBeta, 4);
  assert.equal(s.version, PM.VERSION);
  assert.match(s.definitions, /empyrical/i);
  // Nothing in the summary is rounded: 1.3 exactly, and the volatility carries full digits.
  assert.equal(s.annualVolatility, Math.sqrt(0.001475 / 3) * ANN);
  const empty = PM.summarize([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.sortino, null);
});
