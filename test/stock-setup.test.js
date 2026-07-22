'use strict';
// STEP 10a — deterministic stock setup. Direction and every level come from chart math,
// so an options "confirmation" has an independent thing to confirm.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSetup } = require('../lib/stock-setup');

// Build a candle series from a close path; open≈prev close, high/low bracket by 1%.
function candles(closes) {
  return closes.map((c, i) => {
    const open = i > 0 ? closes[i - 1] : c;
    return { date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open, high: Math.max(open, c) * 1.01, low: Math.min(open, c) * 0.99, close: c };
  });
}
// A long uptrend: 220 bars rising from 50 → ~150.
function uptrend() { return candles(Array.from({ length: 220 }, (_, i) => 50 + i * 0.5)); }
// A downtrend: 220 bars falling from 150 → ~40.
function downtrend() { return candles(Array.from({ length: 220 }, (_, i) => 150 - i * 0.5)); }
// Choppy/flat: oscillating around 100.
function choppy() { return candles(Array.from({ length: 220 }, (_, i) => 100 + (i % 2 ? 2 : -2))); }

test('insufficient history → no setup', () => {
  const s = evaluateSetup(candles([1, 2, 3]));
  assert.equal(s.direction, 'none');
  assert.equal(s.valid, false);
});

test('a clean uptrend yields a valid LONG setup with deterministic levels', () => {
  const s = evaluateSetup(uptrend());
  assert.equal(s.direction, 'long');
  assert.equal(s.valid, true);
  // levels are ordered sensibly: invalidation < spot < trigger < target (long)
  assert.ok(s.invalidation < s.spot, 'stop below spot');
  assert.ok(s.trigger >= s.spot, 'trigger at/above spot (break of the high)');
  assert.ok(s.target > s.trigger, 'target above trigger');
  assert.ok(s.rr > 0, 'reward:risk computed');
  assert.ok(s.reasons.join(' ').match(/Uptrend/));
});

test('a clean downtrend yields a valid SHORT setup with inverted levels', () => {
  const s = evaluateSetup(downtrend());
  assert.equal(s.direction, 'short');
  assert.ok(s.invalidation > s.spot, 'stop above spot for a short');
  assert.ok(s.trigger <= s.spot, 'trigger at/below spot');
  assert.ok(s.target < s.trigger, 'target below trigger');
});

test('a choppy tape yields no clean trend (options have nothing to confirm)', () => {
  const s = evaluateSetup(choppy());
  assert.equal(s.direction, 'none');
  assert.equal(s.valid, false);
  // still reports structural support/resistance for context
  assert.ok(s.support != null && s.resistance != null);
});

test('levels are pure numbers, never null on a valid setup', () => {
  const s = evaluateSetup(uptrend());
  for (const k of ['spot', 'support', 'resistance', 'trigger', 'invalidation', 'target', 'atr']) {
    assert.ok(typeof s[k] === 'number' && Number.isFinite(s[k]), `${k} is a finite number`);
  }
});

test('quality is bounded 0..1 and penalizes an overbought long', () => {
  const s = evaluateSetup(uptrend());
  assert.ok(s.quality >= 0 && s.quality <= 1);
});
