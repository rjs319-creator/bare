'use strict';
// STUDENT-t QUANTILE + tCritical95 beyond df 30 (follow-up to GitHub scan proposal #5).
//
// tCritical95 tabulated df 1..30 and then used the NORMAL 1.96 for every larger df, while
// the true t(0.975, df) is 2.042 at df 30, 2.021 at df 40 and 2.009 at df 50 — every
// date-level interval in the df 31..60 band most governed strategies live in was ~1-3% too
// narrow, i.e. the promotion gate was anti-conservative exactly where it matters. stats-v3
// now carries an exact inverse-t (root of its own regularized-incomplete-beta CDF) and
// tCritical95 reads it for df > 30. Oracle: @stdlib/stats-base-dists-t-quantile (devDep).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tQuantileRef = require('@stdlib/stats-base-dists-t-quantile');
const tCdfRef = require('@stdlib/stats-base-dists-t-cdf');
const S3 = require('../lib/research/stats-v3');
const ES = require('../lib/evidence-stats');

const Q_TOL = 1e-6;
const P_TOL = 1e-10;

test('tQuantile(0.975, df) matches stdlib to 1e-6 for every df 2..1000', () => {
  let worst = 0;
  for (let df = 2; df <= 1000; df++) {
    const ours = S3.tQuantile(0.975, df);
    const ref = tQuantileRef(0.975, df);
    const err = Math.abs(ours - ref);
    if (err > worst) worst = err;
    assert.ok(err <= Q_TOL, `df=${df}: ours ${ours} ref ${ref} (|Δ| ${err})`);
  }
  assert.ok(worst <= Q_TOL, `worst |Δ| ${worst}`);
});

test('tQuantile matches stdlib across other tail probabilities, fractional df, and df = 1', () => {
  for (const p of [0.6, 0.75, 0.9, 0.95, 0.99, 0.995, 0.9995]) {
    for (const df of [1, 1.5, 2, 3.7, 7, 12.4, 29, 31, 64.2, 200, 999]) {
      const ours = S3.tQuantile(p, df);
      const ref = tQuantileRef(p, df);
      assert.ok(Math.abs(ours - ref) <= Q_TOL * Math.max(1, Math.abs(ref)), `p=${p} df=${df}: ${ours} vs ${ref}`);
    }
  }
});

test('tQuantile is symmetric about the median and exact at it', () => {
  assert.equal(S3.tQuantile(0.5, 7), 0);
  for (const [p, df] of [[0.9, 5], [0.975, 40], [0.999, 3]]) {
    assert.ok(Math.abs(S3.tQuantile(p, df) + S3.tQuantile(1 - p, df)) <= 1e-12, `p=${p} df=${df}`);
  }
});

test('tQuantile fails closed on bad input instead of returning a number', () => {
  assert.equal(S3.tQuantile(0.975, 0), null);
  assert.equal(S3.tQuantile(0.975, NaN), null);
  assert.equal(S3.tQuantile(1, 10), null);
  assert.equal(S3.tQuantile(0, 10), null);
  assert.equal(S3.tQuantile(NaN, 10), null);
});

test('tQuantile inverts pFromT: the two-sided tail at the 97.5% quantile is 0.05', () => {
  for (const df of [2, 11, 30, 31, 45, 120, 1000]) {
    const t = S3.tQuantile(0.975, df);
    assert.ok(Math.abs(S3.pFromT(t, df) - 0.05) <= 1e-9, `df=${df}: p ${S3.pFromT(t, df)}`);
  }
});

test('pFromT keeps matching the stdlib t-CDF to 1e-10 out to df 1000 (|t| ≤ 8)', () => {
  for (let df = 2; df <= 1000; df += df < 60 ? 1 : 7) {
    for (let t = 0; t <= 8 + 1e-9; t += 0.5) {
      const ref = 2 * (1 - tCdfRef(t, df));
      assert.ok(Math.abs(S3.pFromT(t, df) - ref) <= P_TOL, `df=${df} t=${t}`);
    }
  }
});

// ── tCritical95 ──────────────────────────────────────────────────────────────
test('tCritical95 beyond df 30 is the real t(0.975, df) quantile, not the normal 1.96', () => {
  for (const df of [31, 35, 40, 50, 64, 100, 250, 1000, 5000]) {
    const ours = ES.tCritical95(df);
    const ref = tQuantileRef(0.975, df);
    assert.ok(Math.abs(ours - ref) <= Q_TOL, `df=${df}: ${ours} vs ${ref}`);
    assert.ok(ours > 1.96, `df=${df}: must exceed the normal critical value`);
  }
  // The band every governed strategy sits in was the one being understated.
  assert.ok(ES.tCritical95(31) > 2.039 && ES.tCritical95(31) < 2.040);
  assert.ok(ES.tCritical95(40) > 2.021 && ES.tCritical95(40) < 2.0211);
});

test('tCritical95 is monotone non-increasing in df across the table/quantile boundary', () => {
  let prev = Infinity;
  for (let df = 1; df <= 400; df++) {
    const v = ES.tCritical95(df);
    assert.ok(v <= prev + 1e-12, `df=${df}: ${v} > ${prev}`);
    prev = v;
  }
  assert.ok(ES.tCritical95(30) - ES.tCritical95(31) < 0.004, 'no jump at the table edge');
});

test('tCritical95 keeps the tabulated values for df ≤ 30 and still fails conservative', () => {
  assert.equal(ES.tCritical95(1), 12.706);
  assert.equal(ES.tCritical95(30), 2.042);
  assert.ok(Math.abs(ES.tCritical95(30.9) - tQuantileRef(0.975, 30.9)) <= Q_TOL, 'a fractional df past the table edge gets the exact quantile');
  assert.equal(ES.tCritical95(29.9), 2.045, 'a fractional df inside the table floors');
  assert.equal(ES.tCritical95(0), 12.706);
  assert.equal(ES.tCritical95(NaN), 12.706);
  assert.equal(ES.tCritical95(Infinity), 12.706, 'an infinite df is not a sample — fail conservative');
});

test('a 40-date series gets a WIDER interval than the old normal approximation gave it', () => {
  const vals = Array.from({ length: 40 }, (_, i) => 0.5 + (i % 2 ? 0.3 : -0.3) + ((i * 7919) % 13) / 100);
  const s = ES.summarizeDateSeries(vals, { horizonBars: 1 });
  const ess = Number.isFinite(s.exact && s.exact.ess) ? s.exact.ess : s.effectiveN;
  const se = Number.isFinite(s.seExact) ? s.seExact : s.se;
  const avg = Number.isFinite(s.avgExact) ? s.avgExact : s.avg;
  assert.ok(ess > 31, `needs df > 30 to exercise the fix (ess ${ess})`);
  assert.ok(Math.abs(s.tCritical - tQuantileRef(0.975, ess - 1)) <= Q_TOL);
  const normalHalf = 1.96 * se;
  assert.ok((avg - s.tCritical * se) < avg - normalHalf + 1e-12, 'lower bound moved down');
});
