'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankScore, atr, ema, tradeLevels, orbLevels, dayMetrics, passesRunScan, runRankScore } = require('../lib/daytrade');

// ── Multi-day momentum-run scan (FCEL archetype) ─────────────────────────────
// Build a synthetic candle series: a flat low-volume base, then a multi-day run
// with two heavy-volume up-days, finishing near the run high — the FCEL shape.
function runUpSeries() {
  const candles = [];
  for (let k = 0; k < 30; k++) candles.push({ date: `2026-05-${String(k + 1).padStart(2, '0')}`, open: 10, high: 10.2, low: 9.8, close: 10, volume: 1_000_000 });
  const legs = [[10.8, 1.2e6], [12.1, 3.0e6], [12.5, 1.1e6], [14.3, 3.2e6], [15.2, 1.3e6]];
  legs.forEach(([c, v], j) => candles.push({ date: `2026-06-0${j + 1}`, open: c * 0.98, high: c * 1.02, low: c * 0.95, close: c, volume: v }));
  return candles;
}

test('dayMetrics: reports multi-day run fields', () => {
  const m = dayMetrics(runUpSeries());
  assert.ok(m, 'metrics computed');
  assert.ok(m.pct5d >= 25, `5-day move ${m.pct5d}% should clear 25%`);
  assert.ok(m.highVolDays5 >= 2, `should count >=2 unusual-volume days, got ${m.highVolDays5}`);
  assert.ok(m.nearHighFrac5 >= 0.92, `should be near the run high, got ${m.nearHighFrac5}`);
});

test('passesRunScan: a sustained multi-day run qualifies', () => {
  assert.equal(passesRunScan(dayMetrics(runUpSeries())), true);
});

test('passesRunScan: a single-day spike on a flat base does NOT qualify (not sustained)', () => {
  const candles = [];
  for (let k = 0; k < 35; k++) candles.push({ date: `d${k}`, open: 10, high: 10.1, low: 9.9, close: 10, volume: 1_000_000 });
  candles.push({ date: 'spike', open: 10, high: 13, low: 10, close: 12.8, volume: 5_000_000 });
  assert.equal(passesRunScan(dayMetrics(candles)), false); // only 1 high-vol day
});

test('passesRunScan: a faded run (closed well below the run high) does NOT qualify', () => {
  const c = runUpSeries();
  c[c.length - 1] = { ...c[c.length - 1], close: 11.0, high: 15.5 };
  assert.equal(passesRunScan(dayMetrics(c)), false);
});

test('runRankScore: rewards a bigger move, more high-vol days, and proximity to the high', () => {
  assert.ok(runRankScore({ pct5d: 60, highVolDays5: 4, nearHighFrac5: 0.99 }) > runRankScore({ pct5d: 26, highVolDays5: 2, nearHighFrac5: 0.92 }));
});

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
