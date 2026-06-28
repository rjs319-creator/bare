'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankScore, atr, ema, tradeLevels, orbLevels } = require('../lib/daytrade');

test('rankScore weights relVol heaviest and caps it at 10x', () => {
  assert.equal(rankScore({ relVol: 5, pctChange: 3, gapPct: 2 }), 54);     // 50 + 3 + 1
  assert.equal(rankScore({ relVol: 99, pctChange: 0, gapPct: 0 }), 100);   // relVol capped at 10
});

test('atr averages the true range; 0 for too-few bars', () => {
  const candles = Array.from({ length: 15 }, () => ({ high: 102, low: 100, close: 101 }));
  assert.equal(atr(candles, 14), 2);
  assert.equal(atr([{ high: 1, low: 0, close: 0.5 }]), 0);
});

test('ema of a flat series equals the constant', () => {
  assert.ok(Math.abs(ema(new Array(50).fill(7), 9) - 7) < 1e-9);
  assert.equal(ema([], 9), null);
});

test('tradeLevels: entry=close, stop below, 1:2 target, pullback present', () => {
  const candles = Array.from({ length: 20 }, () => ({ high: 102, low: 98, close: 100 }));
  const lv = tradeLevels(candles);
  assert.equal(lv.entry, 100);
  assert.equal(lv.stop, 97.6);                 // max(98-0.4, 100-6)
  assert.equal(lv.target, 104.8);              // entry + 2*risk
  assert.equal(lv.rr, 2);
  assert.ok(lv.pullback && lv.pullback.entry < lv.entry);
});

test('tradeLevels: returns null when ATR is zero', () => {
  const flat = Array.from({ length: 20 }, () => ({ high: 100, low: 100, close: 100 }));
  assert.equal(tradeLevels(flat), null);
});

test('tradeLevels: useLowFloor=false gives a pure (wider) ATR stop', () => {
  const candles = Array.from({ length: 20 }, () => ({ high: 102, low: 98, close: 100 }));
  const wide = tradeLevels(candles, { stopAtrMult: 2.5, useLowFloor: false });
  assert.equal(wide.entry, 100);
  assert.equal(wide.stop, 90);                 // 100 - 2.5*4 (no today's-low floor)
  assert.equal(wide.target, 120);             // entry + 2*risk
  assert.ok(wide.stop < tradeLevels(candles).stop);   // genuinely wider than the legacy stop
});

test('orbLevels: trigger=today high, 2.5xATR stop, 1:2 target', () => {
  const candles = Array.from({ length: 20 }, () => ({ high: 102, low: 98, close: 100 }));
  const o = orbLevels(candles);
  assert.equal(o.trigger, 102);                // must break today's high to confirm
  assert.equal(o.stop, 92);                    // 102 - 2.5*4
  assert.equal(o.target, 122);                 // trigger + 2*risk
  assert.equal(o.rr, 2);
});

test('orbLevels: returns null when ATR is zero', () => {
  const flat = Array.from({ length: 20 }, () => ({ high: 100, low: 100, close: 100 }));
  assert.equal(orbLevels(flat), null);
});
