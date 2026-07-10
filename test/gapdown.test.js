const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreGapDown, orbLowLevels, continuationScore, GAP_STRONG } = require('../lib/gapdown');

// Build ~40 flat candles (~$50, ~1M shares → ~$50M ADV) then a gap-down last day.
function withGapDown(gapPct, { price = 50, vol = 1_000_000, lastVol = 3_000_000 } = {}) {
  const c = [];
  for (let i = 0; i < 40; i++) { const p = price + Math.sin(i / 3) * 0.4; c.push({ date: `2026-02-${String((i % 27) + 1).padStart(2, '0')}`, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: vol }); }
  const prevClose = c[c.length - 1].close;
  const open = prevClose * (1 + gapPct / 100);
  const low = open * 0.985, high = open * 1.005, close = open * 0.99;   // opens down, drifts lower
  c.push({ date: '2026-03-02', open, high, low, close, volume: lastVol });
  return c;
}

test('a ≥5% gap-down on a liquid name scores STRONG with an ORB-low SHORT plan', () => {
  const s = scoreGapDown(withGapDown(-6));
  assert.ok(s, 'should score');
  assert.equal(s.tier, 'STRONG');
  assert.equal(s.side, 'short');
  assert.ok(s.gapPct <= -GAP_STRONG);
  // short plan: trigger at the low, stop ABOVE, target BELOW
  assert.ok(s.plan.stop > s.plan.trigger, 'stop above trigger (short)');
  assert.ok(s.plan.target < s.plan.trigger, 'target below trigger (short)');
  assert.equal(s.plan.side, 'short');
  assert.equal(s.plan.rr, 2);
});

test('a −4% gap-down is MODERATE tier', () => {
  const s = scoreGapDown(withGapDown(-4));
  assert.ok(s);
  assert.equal(s.tier, 'MODERATE');
});

test('a small (−2%) gap-down does not qualify', () => {
  assert.equal(scoreGapDown(withGapDown(-2)), null);
});

test('a gap-UP does not qualify (this is the short lane)', () => {
  assert.equal(scoreGapDown(withGapDown(+6)), null);
});

test('thin $-volume is rejected by the liquidity floor', () => {
  assert.equal(scoreGapDown(withGapDown(-6, { price: 3, vol: 100, lastVol: 300 })), null);
});

test('continuationScore rises monotonically with gap-down size', () => {
  assert.ok(continuationScore(-7, 2) > continuationScore(-5, 2));
  assert.ok(continuationScore(-5, 2) > continuationScore(-3, 2));
});

test('orbLowLevels builds a valid short measured-move (1:2)', () => {
  const c = withGapDown(-6);
  const p = orbLowLevels(c);
  assert.ok(p.stop > p.trigger && p.target < p.trigger);
  const risk = p.stop - p.trigger, reward = p.trigger - p.target;
  assert.ok(Math.abs(reward / risk - 2) < 0.05, 'reward is ~2× risk');
});
