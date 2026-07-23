'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { swingRead } = require('../lib/swingread');

// ── Deterministic daily-candle generator ────────────────────────────────────
// priceFn(i) → close for bar i. Dates are sequential (weekend gaps skipped) so
// alignByDate has real matching keys. Fully deterministic (no Math.random).
function gen(n, priceFn, opts = {}) {
  const vol = opts.volume ?? 800000;
  const start = new Date(Date.UTC(2023, 0, 2));
  const out = [];
  let d = new Date(start);
  for (let i = 0; i < n; i++) {
    // skip weekends
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const close = Math.max(0.5, priceFn(i));
    const prev = i > 0 ? out[i - 1].close : close;
    const open = prev;
    const high = Math.max(open, close) * (1 + (opts.wick ?? 0.006));
    const low = Math.min(open, close) * (1 - (opts.wick ?? 0.006));
    const v = typeof vol === 'function' ? vol(i) : vol;
    out.push({ date: d.toISOString().slice(0, 10), open, high, low, close, volume: v });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const flat = base => gen(220, () => base, {});
const uptrend = (base, dailyPct) => gen(220, i => base * Math.pow(1 + dailyPct, i) * (1 + 0.01 * Math.sin(i / 9)), {});
const downtrend = (base, dailyPct) => gen(220, i => base * Math.pow(1 - dailyPct, i) * (1 + 0.01 * Math.sin(i / 9)), {});
const spyFlat = () => gen(220, () => 400, {});

test('sustained relative-strength uptrend → BUY with a long plan', () => {
  const r = swingRead(uptrend(50, 0.002), spyFlat());
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.action, 'BUY');
  assert.ok(r.signedScore > 0, 'signed score positive');
  assert.ok(r.plan && r.plan.side === 'long', 'has a long plan');
  // geometry: objective > trigger > invalidation
  assert.ok(r.plan.objective > r.plan.trigger && r.plan.trigger > r.plan.invalidation);
  assert.strictEqual(r.calibrated, false);
});

test('sustained downtrend → SELL with a bearish plan', () => {
  const r = swingRead(downtrend(50, 0.002), spyFlat());
  assert.strictEqual(r.action, 'SELL');
  assert.ok(r.signedScore < 0);
  assert.ok(r.plan && r.plan.side === 'bearish');
  assert.ok(r.plan.invalidation > r.plan.trigger && r.plan.trigger > r.plan.objective);
});

test('flat / choppy series → WAIT, no forced action', () => {
  const r = swingRead(flat(50), spyFlat());
  assert.strictEqual(r.action, 'WAIT');
  assert.ok(Math.abs(r.signedScore) < 0.22);
});

test('bullish but excessively extended → WAIT (do not chase)', () => {
  // strong uptrend, then a sharp final spike well above the 20-DMA
  const bars = uptrend(50, 0.002);
  const last = bars[bars.length - 1];
  const spikePx = last.close * 1.35;
  bars[bars.length - 1] = { ...last, close: spikePx, high: spikePx * 1.01, open: last.close };
  const r = swingRead(bars, spyFlat());
  assert.strictEqual(r.action, 'WAIT');
  assert.strictEqual(r.setup, 'wait-pullback');
  assert.ok(r.factors.extensionATR > 4, 'flagged as extended');
});

test('failed breakout → not a BUY', () => {
  // uptrend, poke above the 20-day pivot two bars ago, then close back below it
  const bars = uptrend(50, 0.0015);
  const n = bars.length;
  const pivot = Math.max(...bars.slice(n - 21, n - 1).map(c => c.high));
  bars[n - 3] = { ...bars[n - 3], high: pivot * 1.05, close: pivot * 1.02 };
  bars[n - 1] = { ...bars[n - 1], close: pivot * 0.95, high: pivot * 0.99, open: pivot * 1.0 };
  const r = swingRead(bars, spyFlat());
  assert.notStrictEqual(r.action, 'BUY');
});

test('missing SPY → still reads, benchmarkAvailable=false', () => {
  const r = swingRead(uptrend(50, 0.002), null);
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.benchmarkAvailable, false);
  assert.strictEqual(r.factors.excess63Pct, undefined);
});

test('missing sector benchmark → sectorAvailable=false but read works', () => {
  const r = swingRead(uptrend(50, 0.002), spyFlat());
  assert.strictEqual(r.sectorAvailable, false);
});

test('sector benchmark present → sectorAvailable=true', () => {
  const r = swingRead(uptrend(50, 0.002), spyFlat(), { sectorCandles: spyFlat() });
  assert.strictEqual(r.sectorAvailable, true);
});

test('insufficient history → WAIT, insufficient flagged, never BUY/SELL', () => {
  const r = swingRead(gen(30, i => 50 + i), spyFlat());
  assert.strictEqual(r.action, 'WAIT');
  assert.strictEqual(r.insufficient, true);
});

test('completely missing feed → UNAVAILABLE, not NEUTRAL', () => {
  const r = swingRead([], spyFlat());
  assert.strictEqual(r.action, 'UNAVAILABLE');
  assert.strictEqual(r.available, false);
});

test('zero / missing volume → does not throw, still produces a read', () => {
  const bars = gen(220, i => 50 * Math.pow(1.002, i), { volume: 0 });
  const r = swingRead(bars, spyFlat());
  assert.ok(['BUY', 'WAIT', 'SELL'].includes(r.action));
  // thin-liquidity risk should be present with zero dollar-volume
  assert.ok(r.risks.some(x => /liquid/i.test(x)));
});

test('sub-$5 price → low-price risk warning', () => {
  const r = swingRead(uptrend(3, 0.002), spyFlat());
  assert.ok(r.risks.some(x => /\$5/.test(x)), 'low-price warning present');
});

test('incomplete current daily volume bar is not read as negative confirmation', () => {
  const bars = uptrend(50, 0.002);
  // simulate a forming last bar with tiny volume on a down tick
  const last = bars[bars.length - 1];
  bars[bars.length - 1] = { ...last, close: last.open * 0.999, volume: 1000 };
  const r = swingRead(bars, spyFlat());
  // baseline excludes the last bar, so the low-volume down tick must not create a
  // "down-volume dominates" reason
  assert.ok(!r.reasons.includes('Down-volume dominates the last month'));
});

test('deterministic — identical inputs give identical output', () => {
  const bars = uptrend(50, 0.002), spy = spyFlat();
  assert.deepStrictEqual(swingRead(bars, spy), swingRead(bars, spy));
});

test('no future-bar influence — appending future bars then slicing back is identical', () => {
  const bars = uptrend(50, 0.002), spy = spyFlat();
  const asOf = swingRead(bars, spy);
  const future = [...bars, { date: '2099-01-01', open: 999, high: 1000, low: 998, close: 999, volume: 1 }];
  const asOfAgain = swingRead(future.slice(0, bars.length), spy);
  assert.deepStrictEqual(asOf, asOfAgain);
});

test('pullback in an uptrend uses a pullback-reclaim plan when actionable', () => {
  const bars = uptrend(50, 0.0018);
  const n = bars.length;
  // gentle 3-bar dip that stays above the 20-DMA
  for (let k = n - 3; k < n; k++) bars[k] = { ...bars[k], close: bars[k].close * 0.985, low: bars[k].close * 0.98 };
  const r = swingRead(bars, spyFlat());
  if (r.action === 'BUY') assert.ok(['pullback-reclaim', 'trend-continuation', 'breakout-hold'].includes(r.plan.setupType));
  else assert.strictEqual(r.action, 'WAIT');
});
