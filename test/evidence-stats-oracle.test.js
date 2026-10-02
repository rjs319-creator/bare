'use strict';
// ORACLE TESTS against stdlib-js (Apache-2.0, devDependencies only — runtime deps stay
// at three). The repo's own p-value path (regularized incomplete beta → Student-t) and
// its Benjamini-Hochberg step-up are compared against independent reference
// implementations across a dense grid, not a handful of textbook points.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tcdf = require('@stdlib/stats-base-dists-t-cdf');
const padjust = require('@stdlib/stats-padjust');
const ttest = require('@stdlib/stats-ttest');
const S3 = require('../lib/research/stats-v3');
const ES = require('../lib/evidence-stats');

const P_TOL = 1e-10;
const Q_TOL = 1e-12;

test('pFromT matches the stdlib Student-t CDF to 1e-10 for df 2..500 and |t| ≤ 8', () => {
  let checked = 0, worst = 0;
  for (let df = 2; df <= 500; df++) {
    for (let t = -8; t <= 8 + 1e-9; t += 0.25) {
      const ours = S3.pFromT(t, df);
      const ref = 2 * (1 - tcdf(Math.abs(t), df));
      const err = Math.abs(ours - ref);
      if (err > worst) worst = err;
      assert.ok(err <= P_TOL, `df=${df} t=${t}: ours ${ours} ref ${ref} (|Δ| ${err})`);
      checked++;
    }
  }
  assert.ok(checked > 30000, `grid actually ran (${checked})`);
  assert.ok(worst <= P_TOL, `worst |Δ| ${worst}`);
});

test('pFromT at fractional df (effective sample sizes are not integers) still matches stdlib', () => {
  for (const df of [2.5, 7.3, 11.9, 33.4, 120.6]) {
    for (const t of [0.3, 1.1, 2.2, 3.7, 6.5]) {
      assert.ok(Math.abs(S3.pFromT(t, df) - 2 * (1 - tcdf(t, df))) <= P_TOL, `df=${df} t=${t}`);
    }
  }
});

test('fdrAdjust (Benjamini-Hochberg) matches stdlib padjust("bh") to 1e-12 on random p vectors', () => {
  const rnd = S3.lcg(20261002);
  let vectors = 0;
  for (let n = 1; n <= 60; n++) {
    for (let rep = 0; rep < 8; rep++) {
      // Mix of uniform noise, a few small "real" p's, ties, and the 0/1 edges.
      const ps = Array.from({ length: n }, (_, i) => {
        const u = rnd();
        if (i % 7 === 0) return +u.toFixed(2);           // ties on a 2dp grid
        if (i % 11 === 0) return u * 0.01;               // small, discovery-shaped
        if (i === 3 && n > 3) return rep % 2 ? 0 : 1;    // edges
        return u;
      });
      const items = ps.map((p, i) => ({ id: `h${i}`, p }));
      const ours = ES.fdrAdjust(items, { alpha: 0.05 });
      const ref = padjust(ps, 'bh');
      for (let i = 0; i < n; i++) {
        const row = ours.find(r => r.id === `h${i}`);
        assert.ok(Math.abs(row.q - ref[i]) <= Q_TOL, `n=${n} rep=${rep} i=${i}: q ${row.q} ref ${ref[i]}`);
        assert.equal(row.survives, ref[i] <= 0.05, `n=${n} i=${i}: survives flag`);
      }
      vectors++;
    }
  }
  assert.equal(vectors, 480);
});

test('fdrAdjust excludes a null p from the denominator exactly as padjust would on the valid subset', () => {
  const items = [{ id: 'a', p: 0.01 }, { id: 'nil', p: null }, { id: 'b', p: 0.04 }, { id: 'c', p: 0.5 }];
  const ours = ES.fdrAdjust(items);
  const ref = padjust([0.01, 0.04, 0.5], 'bh');
  assert.equal(ours.find(r => r.id === 'nil').q, null);
  assert.ok(Math.abs(ours.find(r => r.id === 'a').q - ref[0]) <= Q_TOL);
  assert.ok(Math.abs(ours.find(r => r.id === 'b').q - ref[1]) <= Q_TOL);
  assert.ok(Math.abs(ours.find(r => r.id === 'c').q - ref[2]) <= Q_TOL);
});

test('summarizeDateSeries exact block agrees with stdlib ttest on mean/sd, and its HAC se never understates the IID one', () => {
  const rnd = S3.lcg(777);
  for (let rep = 0; rep < 25; rep++) {
    const n = 8 + Math.floor(rnd() * 60);
    const xs = Array.from({ length: n }, () => (rnd() - 0.45) * 0.02);   // small-scale, sign-mixed
    const s = ES.summarizeDateSeries(xs, { horizonBars: 1 + Math.floor(rnd() * 10) });
    const ref = ttest(xs);
    assert.ok(Math.abs(s.exact.avg - ref.mean) <= 1e-12, `rep ${rep}: mean`);
    const refSd = Math.abs(ref.mean / ref.statistic) * Math.sqrt(n);
    assert.ok(Math.abs(s.exact.sd - refSd) <= 1e-9, `rep ${rep}: sd ${s.exact.sd} vs ${refSd}`);
    const refSe = refSd / Math.sqrt(n);
    assert.ok(s.exact.se >= refSe - 1e-12, `rep ${rep}: HAC se ${s.exact.se} must be ≥ IID se ${refSe}`);
    // With the HAC floor and the Student-t at the (≤ n) effective sample size, the p-value
    // this module reports can only be MORE conservative than the plain IID t-test.
    const p = ES.pValueOf(s);
    assert.ok(p >= ref.pValue - 1e-9, `rep ${rep}: p ${p} must be ≥ IID t-test p ${ref.pValue}`);
  }
});

test('when the series is IID-like and ess = n ≤ 31, the exact t interval reproduces the t-test interval', () => {
  // Alternating ±: lag-1 autocorrelation is negative → ESS truncates at n, HAC floors at IID.
  // n ≤ 31 keeps df inside the repo's tabulated Student-t region (beyond df 30 the module
  // uses the normal 1.96, which understates the true t quantile by ≤3% — a documented
  // limitation of tCritical95, not of the exact schema).
  const xs = Array.from({ length: 24 }, (_, i) => 0.5 + (i % 2 ? 0.3 : -0.3) + ((i * 7919) % 13) / 100);
  const s = ES.summarizeDateSeries(xs, { horizonBars: 1 });
  const ref = ttest(xs);
  const refSe = Math.abs(ref.mean / ref.statistic);
  assert.equal(s.exact.ess, xs.length, 'ESS = n for this series');
  assert.ok(Math.abs(s.exact.se - refSe) < 1e-12, 'HAC se floored at the IID se');
  // The repo's t critical value is a 3dp table; agreement to 1e-3·se is the honest bar.
  const tol = 1e-3 * s.exact.se;
  assert.ok(Math.abs(s.exact.tCI.lo - ref.ci[0]) <= tol, `lo ${s.exact.tCI.lo} vs ${ref.ci[0]}`);
  assert.ok(Math.abs(s.exact.tCI.hi - ref.ci[1]) <= tol, `hi ${s.exact.tCI.hi} vs ${ref.ci[1]}`);
  // And the display interval is exactly the 2dp rounding of it.
  assert.equal(s.tCI.lo, +s.exact.tCI.lo.toFixed(2));
});
