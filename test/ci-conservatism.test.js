'use strict';
// THE PROMOTION CI TAKES THE WIDER OF TWO INTERVALS. KEEP IT THAT WAY.
//
// summarizeDateSeries reports `ci95` as the WIDER of a Student-t interval (df =
// effective sample size, HAC standard error) and a seeded moving-block
// bootstrap. The bootstrap is frequently the TIGHTER of the two, and it is
// exposed separately as `bootstrapCI`, which makes it a standing temptation:
// swapping the gate onto it looks like using the more modern, less
// assumption-laden statistic.
//
// It is not an improvement. A coverage study on the real `events` date series
// (n=27, skew +0.94 — the fattest-tailed record in the book), resampling from
// the empirical distribution so the shape is preserved exactly:
//
//     nominal 95%       coverage    mean width
//     Student-t           94.7%        14.32
//     moving-block boot   92.7%        13.38
//     widest (current)    94.9%        14.48
//
// The bootstrap is tighter BECAUSE IT UNDER-COVERS, not because it is better
// calibrated. Gating on it would make promotion easier on exactly the fat-tailed
// distributions that warrant more caution — a loosened gate wearing the costume
// of a refinement. The Student-t interval holds up on this shape, and the
// widest-of rule lands at nominal.
//
// These tests pin the direction of the rule, not the numbers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ES = require('../lib/evidence-stats');

// A series with a right tail — the shape where the two methods disagree most.
const SKEWED = [52.5, 38.51, 31.26, 27.37, 18.26, 11.37, 9.61, 3.96, 3.19, 2.83, 2.13, 0.86, 0.44, 0.22,
  -0.22, -0.5, -1.78, -4.67, -5.16, -6.78, -9.18, -11.58, -14.07, -20.31, -21.77, -22.93, -23.5];
const ORDINARY = Array.from({ length: 30 }, (_, i) => ((i % 7) - 3) * 1.4 + 0.5);

const width = (ci) => ci.hi - ci.lo;

test('the reported interval is never narrower than the Student-t one', () => {
  for (const series of [SKEWED, ORDINARY]) {
    const s = ES.summarizeDateSeries(series);
    assert.ok(s.ci95.lo <= s.tCI.lo + 1e-9, 'lower bound may only move down');
    assert.ok(s.ci95.hi >= s.tCI.hi - 1e-9, 'upper bound may only move up');
  }
});

test('the reported interval is never narrower than the bootstrap one either', () => {
  for (const series of [SKEWED, ORDINARY]) {
    const s = ES.summarizeDateSeries(series);
    if (!s.bootstrapCI) continue;
    assert.ok(s.ci95.lo <= s.bootstrapCI.lo + 1e-9);
    assert.ok(s.ci95.hi >= s.bootstrapCI.hi - 1e-9);
  }
});

test('on a fat-tailed series the gate does NOT adopt the tighter bootstrap', () => {
  // The specific swap this file exists to prevent. Guarded rather than asserted
  // blindly: if the bootstrap ever comes out wider here, there is nothing to
  // protect against and the test says so instead of failing spuriously.
  const s = ES.summarizeDateSeries(SKEWED);
  assert.ok(s.bootstrapCI, 'the bootstrap must still be computed and exposed');
  if (width(s.bootstrapCI) < width(s.tCI)) {
    assert.ok(width(s.ci95) >= width(s.tCI) - 1e-9,
      'ci95 must keep the WIDER Student-t width, not the flattering bootstrap');
    assert.ok(width(s.ci95) > width(s.bootstrapCI),
      'adopting the tighter interval would loosen a promotion gate');
  }
});

test('both inputs stay separately visible for inspection', () => {
  const s = ES.summarizeDateSeries(SKEWED);
  assert.ok(s.tCI && Number.isFinite(s.tCI.lo));
  assert.ok(s.bootstrapCI && Number.isFinite(s.bootstrapCI.lo));
  assert.notEqual(s.ci95, s.tCI, 'ci95 is its own object, not an alias');
});

test('the basis states which rule produced the interval', () => {
  const s = ES.summarizeDateSeries(SKEWED);
  assert.match(s.ciBasis, /widest|wider/i);
  assert.match(s.ciBasis, /only widen|may only/i, 'the one-directional rule must be stated');
});

test('the bootstrap is seeded, so the gate does not move between runs', () => {
  const a = ES.summarizeDateSeries(SKEWED);
  const b = ES.summarizeDateSeries(SKEWED);
  assert.deepEqual(a.ci95, b.ci95);
  assert.deepEqual(a.bootstrapCI, b.bootstrapCI);
});
