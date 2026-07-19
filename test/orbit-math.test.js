'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../lib/orbit-math');

test('mean/variance/std ignore nulls and non-finite', () => {
  assert.strictEqual(M.mean([1, 2, 3, null, NaN]), 2);
  assert.ok(Math.abs(M.std([1, 2, 3, 4, 5]) - Math.sqrt(2.5)) < 1e-9);
  assert.strictEqual(M.mean([]), null);
  assert.strictEqual(M.variance([1]), null);
});

test('median and MAD are robust to a single outlier', () => {
  const base = [1, 2, 3, 4, 5];
  assert.strictEqual(M.median(base), 3);
  const withOutlier = [1, 2, 3, 4, 1000];
  assert.strictEqual(M.median(withOutlier), 3, 'median unmoved by outlier');
  assert.ok(M.std(withOutlier) > 100, 'std blows up');
  assert.ok(M.mad(withOutlier) < 5, 'MAD stays small');
});

test('quantile interpolates', () => {
  assert.strictEqual(M.quantile([0, 10], 0.5), 5);
  assert.strictEqual(M.quantile([1, 2, 3, 4], 0), 1);
  assert.strictEqual(M.quantile([1, 2, 3, 4], 1), 4);
});

test('fit/apply winsor clamps to training limits only', () => {
  const train = Array.from({ length: 100 }, (_, i) => i);   // 0..99
  const lim = M.fitWinsor(train, 0.05, 0.95);
  assert.ok(M.applyWinsor(1000, lim) <= lim.hi);
  assert.ok(M.applyWinsor(-1000, lim) >= lim.lo);
  assert.strictEqual(M.applyWinsor(50, lim), 50, 'in-range untouched');
});

test('ridgeSolve recovers a known linear relation', () => {
  // y = 3 + 2*x1 - 1*x2 exactly; ridge with tiny lambda ≈ OLS.
  const rows = [];
  for (let x1 = 0; x1 < 6; x1++) for (let x2 = 0; x2 < 6; x2++) rows.push([1, x1, x2]);
  const y = rows.map(r => 3 + 2 * r[1] - 1 * r[2]);
  const beta = M.ridgeSolve(rows, y, 1e-8, [0, 1e-8, 1e-8]);
  assert.ok(Math.abs(beta[0] - 3) < 1e-3, `intercept ${beta[0]}`);
  assert.ok(Math.abs(beta[1] - 2) < 1e-3, `b1 ${beta[1]}`);
  assert.ok(Math.abs(beta[2] + 1) < 1e-3, `b2 ${beta[2]}`);
});

test('ridge shrinks coefficients toward zero as lambda grows', () => {
  const rows = Array.from({ length: 20 }, (_, i) => [1, i]);
  const y = rows.map(r => 5 * r[1]);
  const small = M.ridgeSolve(rows, y, 1e-6, [0, 1e-6]);
  const big = M.ridgeSolve(rows, y, 1e4, [0, 1e4]);
  assert.ok(Math.abs(big[1]) < Math.abs(small[1]), 'larger lambda → smaller slope');
});

test('sigmoid/logit are inverse; normCdf is monotone and centred', () => {
  assert.ok(Math.abs(M.sigmoid(M.logit(0.7)) - 0.7) < 1e-9);
  assert.ok(Math.abs(M.normCdf(0) - 0.5) < 1e-6);
  assert.ok(M.normCdf(2) > M.normCdf(1) && M.normCdf(1) > M.normCdf(0));
  assert.ok(Math.abs(M.normCdf(1.96) - 0.975) < 1e-3);
});

test('brier and logLoss reward calibrated probabilities', () => {
  const labels = [1, 0, 1, 0];
  const good = M.brier([0.9, 0.1, 0.8, 0.2], labels);
  const bad = M.brier([0.1, 0.9, 0.2, 0.8], labels);
  assert.ok(good < bad);
  assert.ok(M.logLoss([0.9, 0.1, 0.8, 0.2], labels) < M.logLoss([0.1, 0.9, 0.2, 0.8], labels));
});

test('slope of a rising line is positive; flat is ~0', () => {
  assert.ok(M.slope([1, 2, 3, 4, 5]) > 0.99 && M.slope([1, 2, 3, 4, 5]) < 1.01);
  assert.ok(Math.abs(M.slope([5, 5, 5, 5])) < 1e-9);
});
