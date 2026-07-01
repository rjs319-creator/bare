'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreTiming } = require('../lib/timing');

// A healthy intraday snapshot: green day, holding just above VWAP, mid-range, real volume.
const ideal = { price: 10.05, dayOpen: 9.8, dayHigh: 10.2, dayLow: 9.7, prevClose: 9.5, vwap: 10.0, rvol: 1.5, marketState: 'REGULAR' };
const idealLevels = { stop: 9.5, target: 11.0, trigger: 10.0 };

test('an ideal entry (just above VWAP, good R:R, fresh trigger, real volume) is a GREEN light ≥7', () => {
  const t = scoreTiming(ideal, idealLevels);
  assert.ok(t.score >= 7, `expected ≥7, got ${t.score}`);
  assert.equal(t.light, 'green');
  assert.equal(t.emoji, '🟢');
});

test('an extended chase (far above VWAP, at day high, near target) is NOT green', () => {
  const t = scoreTiming(
    { price: 10.95, dayOpen: 9.8, dayHigh: 10.98, dayLow: 9.7, prevClose: 9.5, vwap: 10.2, rvol: 4, marketState: 'REGULAR' },
    { stop: 9.5, target: 11.0, trigger: 10.0 });
  assert.ok(t.score <= 6, `chasing should not be green, got ${t.score}`);
  assert.ok(t.pctVsVwap > 3, 'should register as extended above VWAP');
});

test('price below the stop is an AVOID (≤2, red)', () => {
  const t = scoreTiming({ ...ideal, price: 9.4 }, idealLevels);
  assert.ok(t.score <= 2, `below stop should be ≤2, got ${t.score}`);
  assert.equal(t.light, 'red');
});

test('below VWAP on a red day is gated out of green (≤4)', () => {
  const t = scoreTiming(
    { price: 9.6, dayOpen: 10.1, dayHigh: 10.2, dayLow: 9.5, prevClose: 10.0, vwap: 9.9, rvol: 0.8, marketState: 'REGULAR' },
    idealLevels);
  assert.ok(t.score <= 4, `below-VWAP red day should be ≤4, got ${t.score}`);
});

test('above VWAP scores higher than below VWAP, all else equal', () => {
  const base = { dayOpen: 9.8, dayHigh: 10.2, dayLow: 9.6, prevClose: 9.9, rvol: 1.3, marketState: 'REGULAR' };
  const above = scoreTiming({ ...base, price: 10.02, vwap: 9.98 }, idealLevels);
  const below = scoreTiming({ ...base, price: 9.7, vwap: 10.0 }, idealLevels);
  assert.ok(above.score > below.score, `above VWAP (${above.score}) should beat below (${below.score})`);
});

test('market closed → null score, grey light, not a number', () => {
  const t = scoreTiming({ ...ideal, marketState: 'CLOSED' }, idealLevels);
  assert.equal(t.score, null);
  assert.equal(t.light, 'grey');
});

test('works with no levels (uses extension/trend/volume only) and returns 1..10', () => {
  const t = scoreTiming(ideal, {});
  assert.ok(t.score >= 1 && t.score <= 10);
  assert.equal(t.factors.rr, null, 'no R:R factor without levels');
  assert.ok(Array.isArray(t.reasons) && t.reasons.length > 0);
});

test('a missing snapshot degrades gracefully (grey, no throw)', () => {
  const t = scoreTiming(null, idealLevels);
  assert.equal(t.score, null);
  assert.equal(t.light, 'grey');
});
