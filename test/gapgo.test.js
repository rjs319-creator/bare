'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreGapGo, GAP_STRONG, GAP_MODERATE, MIN_DOLLAR_VOL } = require('../lib/gapgo');

// Build a flat, liquid base of `n` candles at price `p`, then a final GAP-UP day whose
// open is `gapPct`% above the prior close. Volume kept well above the liquidity floor.
function withGap(gapPct, { p = 20, n = 30, vol = 3_000_000 } = {}) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    candles.push({ date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}`, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: vol });
  }
  const prevClose = candles[candles.length - 1].close;
  const open = +(prevClose * (1 + gapPct / 100)).toFixed(2);
  const close = +(open * 1.02).toFixed(2);       // holds the gap, closes green
  candles.push({ date: '2026-03-01', open, high: +(close * 1.01).toFixed(2), low: +(open * 0.995).toFixed(2), close, volume: vol * 2 });
  return candles;
}

test('a ≥5% gap-up on a liquid name scores STRONG with an ORB plan', () => {
  const s = scoreGapGo(withGap(6));
  assert.ok(s, 'expected a signal');
  assert.equal(s.tier, 'STRONG');
  assert.ok(s.gapPct >= GAP_STRONG);
  assert.ok(s.plan && s.plan.trigger > 0 && s.plan.stop < s.plan.trigger && s.plan.target > s.plan.trigger,
    'ORB plan must have trigger > stop and target above trigger');
  assert.equal(s.plan.rr, 2, '1:2 reward:risk');
});

test('a 3–5% gap-up scores MODERATE', () => {
  const s = scoreGapGo(withGap(4));
  assert.ok(s);
  assert.equal(s.tier, 'MODERATE');
  assert.ok(s.gapPct >= GAP_MODERATE && s.gapPct < GAP_STRONG);
});

test('a sub-threshold gap (<3%) does not signal', () => {
  assert.equal(scoreGapGo(withGap(1.5)), null);
});

test('an illiquid name is rejected even with a big gap', () => {
  // Dollar volume = price(20) × volume must be below MIN_DOLLAR_VOL; use tiny volume.
  const thinVol = Math.floor(MIN_DOLLAR_VOL / 20 / 4);   // well under the floor
  assert.equal(scoreGapGo(withGap(8, { vol: thinVol })), null);
});

test('the stop is a ~2.5×ATR distance below the trigger (wide stop, the validated exit)', () => {
  const s = scoreGapGo(withGap(6));
  const risk = s.plan.trigger - s.plan.stop;
  assert.ok(risk >= 2 * s.plan.atr && risk <= 3 * s.plan.atr,
    `stop distance ${risk} should be ~2.5×ATR (${s.plan.atr})`);
});

test('excessPct is computed when SPY history is supplied', () => {
  const candles = withGap(6);
  const spyByDate = {};
  candles.forEach((c, i) => { spyByDate[c.date] = 400 + i * 0.1; });   // gently rising SPY
  const s = scoreGapGo(candles, spyByDate);
  assert.ok(s && typeof s.excessPct === 'number', 'excessPct should be a number vs SPY');
});
