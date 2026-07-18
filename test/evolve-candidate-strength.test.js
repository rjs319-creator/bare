'use strict';
// audit #9: the context ensemble P is a pooled base rate, so equal-context candidates get an
// identical P regardless of their own setup strength. candidateStrengthTilt (SHADOW) differentiates
// them by their within-context percentile, in log-odds space (stays a valid probability).

const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/evolve');

test('candidateStrengthTilt: k=0 is identity (default-off is byte-identical)', () => {
  const out = E.candidateStrengthTilt(0.5, 0.9, { k: 0 });
  assert.equal(out.p, 0.5);
  assert.equal(out.delta, 0);
});

test('candidateStrengthTilt: monotone — a stronger candidate gets a higher adjusted P', () => {
  const weak = E.candidateStrengthTilt(0.5, 0.2);
  const strong = E.candidateStrengthTilt(0.5, 0.9);
  assert.ok(strong.p > 0.5, 'above-median strength lifts P');
  assert.ok(weak.p < 0.5, 'below-median strength lowers P');
  assert.ok(strong.p > weak.p);
});

test('candidateStrengthTilt: symmetric around the median and bounded to a valid probability', () => {
  const mid = E.candidateStrengthTilt(0.5, 0.5);
  assert.equal(mid.delta, 0);                                   // median candidate → no tilt
  const hi = E.candidateStrengthTilt(0.5, 1.0), lo = E.candidateStrengthTilt(0.5, 0.0);
  assert.ok(Math.abs((hi.p - 0.5) + (lo.p - 0.5)) < 1e-9, 'symmetric shift about 0.5');
  assert.ok(hi.p < 1 && lo.p > 0, 'stays a valid probability');
});

test('candidateStrengthTilt: two equal-base candidates now DIFFER by their strength (the #9 fix)', () => {
  const base = 0.62;                                            // identical context base rate
  const a = E.candidateStrengthTilt(base, 0.95);               // strong setup
  const b = E.candidateStrengthTilt(base, 0.30);               // weak setup
  assert.notEqual(a.p, b.p);
  assert.ok(a.p > base && b.p < base);
});
