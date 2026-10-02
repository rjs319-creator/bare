'use strict';
// HAC (Newey-West) sandwich covariance for regression coefficients — pinned against
// fixtures worked BY HAND below, independent of the implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const HAC = require('../lib/factors/hac');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);

test('bartlett weights: 1 - l/(L+1), zero beyond L', () => {
  close(HAC.bartlett(1, 1), 0.5);
  close(HAC.bartlett(1, 3), 0.75);
  close(HAC.bartlett(2, 3), 0.5);
  close(HAC.bartlett(4, 3), 0);
});

test('intercept-only model, L=1: hand-computed sandwich', () => {
  // X = column of ones, e = [1, -1, 2, -2].
  //   Q = X'X = 4
  //   S = Σe² + 2·w1·Σ e_t e_{t-1} = 10 + 2·0.5·(−1 −2 −4) = 10 − 7 = 3
  //   V = Q⁻¹ S Q⁻¹ = 3/16  →  se = √3 / 4
  const X = [[1], [1], [1], [1]];
  const e = [1, -1, 2, -2];
  const V = HAC.hacCovariance(X, e, { lags: 1 });
  close(V[0][0], 3 / 16);
  const { se, t } = HAC.hacTStats([0.5], X, e, { lags: 1 });
  close(se[0], Math.sqrt(3) / 4);
  close(t[0], 0.5 / (Math.sqrt(3) / 4));
});

test('two-regressor model, L=0 (White): hand-computed sandwich', () => {
  // X = [[1,0],[1,1],[1,2]], e = [1,-2,1]
  //   Q = [[3,3],[3,5]],  Q⁻¹ = (1/6)[[5,-3],[-3,3]]
  //   g_t = x_t e_t = [1,0], [-2,-2], [1,2]  →  S = Σ g g' = [[6,6],[6,8]]
  //   V = Q⁻¹ S Q⁻¹ = (1/6)[[7,-3],[-3,3]]
  const X = [[1, 0], [1, 1], [1, 2]];
  const e = [1, -2, 1];
  const V = HAC.hacCovariance(X, e, { lags: 0 });
  close(V[0][0], 7 / 6); close(V[0][1], -3 / 6); close(V[1][0], -3 / 6); close(V[1][1], 3 / 6);
  const { se } = HAC.hacTStats([0, 0], X, e, { lags: 0 });
  close(se[0], Math.sqrt(7 / 6)); close(se[1], Math.sqrt(0.5));
});

test('intercept-only HAC se agrees with stats-v3 neweyWest when residuals are mean-zero', () => {
  const S3 = require('../lib/research/stats-v3');
  const e = [0.4, -0.2, 0.9, -1.1, 0.3, -0.3, 0.7, -0.7];   // sums to 0 → autocovariance about 0
  const X = e.map(() => [1]);
  const nw = S3.neweyWest(e, { lags: 2 });
  const { se } = HAC.hacTStats([0], X, e, { lags: 2 });
  close(se[0], nw.se, 1e-9);
});

test('defaultLags: horizonBars − 1 when supplied, else the Andrews rule of thumb', () => {
  assert.equal(HAC.defaultLags(100, 21), 20);
  assert.equal(HAC.defaultLags(100, 1), 1);
  assert.equal(HAC.defaultLags(64, null), Math.max(1, Math.floor(1.5 * Math.cbrt(64))));
});

test('singular design → null covariance (no NaN leak)', () => {
  const X = [[1, 1], [1, 1], [1, 1]];
  assert.equal(HAC.hacCovariance(X, [0.1, -0.1, 0], { lags: 0 }), null);
  const r = HAC.hacTStats([0, 0], X, [0.1, -0.1, 0], { lags: 0 });
  assert.deepEqual(r.se, [null, null]);
  assert.deepEqual(r.t, [null, null]);
});
