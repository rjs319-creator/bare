'use strict';
// REGRESSION (audit 2026-08-14): pFromT used the NORMAL CDF unconditionally — at small
// effective N that is anti-conservative (at effN≈12, t=2.2 → normal p≈0.028 vs the true
// Student-t p≈0.05), and these p-values feed Benjamini-Hochberg demote-gating. pFromT now
// accepts an optional df and returns the two-sided Student-t p via the regularized
// incomplete beta function; with df absent it keeps the old normal behaviour exactly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pFromT, normalCdf, regularizedIncompleteBeta } = require('../lib/research/stats-v3');

// ── the regularized incomplete beta itself (small, well-tested) ─────────────
test('regularizedIncompleteBeta: boundary values', () => {
  assert.equal(regularizedIncompleteBeta(0, 2, 3), 0);
  assert.equal(regularizedIncompleteBeta(1, 2, 3), 1);
});

test('regularizedIncompleteBeta: I_x(1,1) is the identity (uniform CDF)', () => {
  for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    assert.ok(Math.abs(regularizedIncompleteBeta(x, 1, 1) - x) < 1e-9, `I_${x}(1,1)`);
  }
});

test('regularizedIncompleteBeta: matches the closed-form Beta(2,3) CDF 6x²−8x³+3x⁴', () => {
  const cdf = (x) => 6 * x * x - 8 * x ** 3 + 3 * x ** 4;
  for (const x of [0.1, 0.25, 0.5, 0.8]) {
    assert.ok(Math.abs(regularizedIncompleteBeta(x, 2, 3) - cdf(x)) < 1e-9, `x=${x}`);
  }
});

test('regularizedIncompleteBeta: symmetry I_x(a,b) = 1 − I_{1−x}(b,a) (both continued-fraction branches)', () => {
  for (const [x, a, b] of [[0.2, 3, 5], [0.9, 0.5, 0.5], [0.5, 6, 0.5], [0.05, 2.5, 7.5]]) {
    const lhs = regularizedIncompleteBeta(x, a, b);
    const rhs = 1 - regularizedIncompleteBeta(1 - x, b, a);
    assert.ok(Math.abs(lhs - rhs) < 1e-9, `x=${x} a=${a} b=${b}: ${lhs} vs ${rhs}`);
  }
});

test('regularizedIncompleteBeta: arcsine distribution midpoint I_0.5(0.5,0.5) = 0.5', () => {
  assert.ok(Math.abs(regularizedIncompleteBeta(0.5, 0.5, 0.5) - 0.5) < 1e-9);
});

// ── pFromT with df: Student-t two-sided p ───────────────────────────────────
test('pFromT(2.2, 11): the true small-sample p is ~0.050, not the normal ~0.028', () => {
  const p = pFromT(2.2, 11);
  assert.ok(Math.abs(p - 0.050) <= 0.005, `expected ≈0.050 ±0.005, got ${p}`);
  // And it must be materially LARGER (more conservative) than the normal answer.
  assert.ok(p > pFromT(2.2) + 0.015, 'Student-t p at df=11 must exceed the normal p');
});

test('pFromT without df keeps the OLD normal-CDF value exactly (backward compat)', () => {
  for (const t of [0, 0.5, 1.0, 1.96, 2.2, 3.5, -2.2]) {
    const legacy = Math.min(1, 2 * (1 - normalCdf(Math.abs(t))));
    assert.equal(pFromT(t), legacy, `t=${t}`);
  }
  assert.equal(pFromT(NaN), null);
  assert.equal(pFromT(Infinity, 11), null);
});

test('pFromT: for df ≥ 200 the t and normal answers agree within 0.002', () => {
  for (const df of [200, 500, 5000]) {
    for (const t of [0.5, 1.0, 1.96, 2.2, 3.0]) {
      assert.ok(Math.abs(pFromT(t, df) - pFromT(t)) < 0.002, `t=${t} df=${df}: ${pFromT(t, df)} vs ${pFromT(t)}`);
    }
  }
});

test('pFromT with df: sane shape — p(0)=1, monotone decreasing in |t|, symmetric in sign', () => {
  assert.ok(Math.abs(pFromT(0, 10) - 1) < 1e-9);
  assert.ok(pFromT(1, 10) > pFromT(2, 10));
  assert.ok(pFromT(2, 10) > pFromT(4, 10));
  assert.equal(pFromT(-2.2, 11), pFromT(2.2, 11));
  // Known textbook value: t=2.228 at df=10 is the 97.5th percentile → two-sided p ≈ 0.05.
  assert.ok(Math.abs(pFromT(2.228, 10) - 0.05) < 0.001);
  // An invalid df falls back to the normal p rather than guessing.
  assert.equal(pFromT(2.2, 0), pFromT(2.2));
});
