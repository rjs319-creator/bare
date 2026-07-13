'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../lib/evolve-labels');

// Build a synthetic candle series starting at `from` (YYYY-MM-DD) with given closes.
// highs/lows default to close ± a small band unless overridden per bar.
function series(from, bars) {
  let d = new Date(from + 'T00:00:00Z');
  return bars.map(b => {
    const date = d.toISOString().slice(0, 10);
    d = new Date(d.getTime() + 86400000);
    const close = b.close ?? b;
    return { date, open: b.open ?? close, high: b.high ?? close, low: b.low ?? close, close, volume: b.volume ?? 1e6 };
  });
}

test('barriersFor returns fixed defaults when volAdjust off', () => {
  assert.deepStrictEqual(L.barriersFor('fast'), { up: 0.08, down: 0.04, window: 5, volAdjusted: false });
  assert.strictEqual(L.barriersFor('position').window, 63);
});

test('barriersFor vol-adjusts but preserves reward:risk ratio', () => {
  const fixed = L.HORIZON_META.swing;
  const b = L.barriersFor('swing', { atrPct: 0.05, volAdjust: true });
  assert.ok(b.volAdjusted);
  assert.ok(Math.abs(b.up / b.down - fixed.up / fixed.down) < 2e-3, 'RR preserved (pre-rounding)');
  assert.ok(b.up >= fixed.up * 0.5 && b.up <= fixed.up * 2, 'clamped within 2x');
});

test('sliceForward is point-in-time correct (strictly after predDate)', () => {
  const c = series('2026-01-01', [10, 11, 12, 13, 14]);
  const fwd = L.sliceForward(c, '2026-01-02', 10);
  assert.ok(fwd.every(x => x.date > '2026-01-02'));
  assert.strictEqual(fwd.length, 3);
});

test('tripleBarrier: upper barrier hit first → win', () => {
  // entry 100, up +8% => 108. Bar 2 highs to 109.
  const fwd = series('2026-01-02', [
    { close: 101, high: 102, low: 100 },
    { close: 107, high: 109, low: 104 },   // hits 108
    { close: 106, high: 107, low: 103 },
    { close: 105 }, { close: 104 },
  ]);
  const r = L.tripleBarrier(fwd, 100, { up: 0.08, down: 0.04, window: 5 });
  assert.strictEqual(r.barrier, 'upper');
  assert.strictEqual(r.won, true);
  assert.strictEqual(r.barsToBarrier, 2);
  assert.ok(r.mfe >= 0.08);
});

test('tripleBarrier: lower barrier hit first → loss', () => {
  const fwd = series('2026-01-02', [
    { close: 99, high: 100, low: 98 },
    { close: 95, high: 97, low: 95 },      // 100*(1-0.04)=96, low 95 hits
    { close: 94 }, { close: 93 }, { close: 92 },
  ]);
  const r = L.tripleBarrier(fwd, 100, { up: 0.08, down: 0.04, window: 5 });
  assert.strictEqual(r.barrier, 'lower');
  assert.strictEqual(r.won, false);
  assert.strictEqual(r.label, -1);
});

test('tripleBarrier: same-bar ambiguity resolves conservatively to loss', () => {
  const fwd = series('2026-01-02', [
    { close: 101, high: 109, low: 95 },    // hits BOTH 108 and 96 same bar
    { close: 100 }, { close: 100 }, { close: 100 }, { close: 100 },
  ]);
  const r = L.tripleBarrier(fwd, 100, { up: 0.08, down: 0.04, window: 5 });
  assert.strictEqual(r.barrier, 'lower');
  assert.strictEqual(r.sameBarAmbiguous, true);
});

test('tripleBarrier: neither barrier + window elapsed → timeout label 0', () => {
  const fwd = series('2026-01-02', [101, 102, 103, 102, 101]);
  const r = L.tripleBarrier(fwd, 100, { up: 0.08, down: 0.04, window: 5 });
  assert.strictEqual(r.barrier, 'time');
  assert.strictEqual(r.label, 0);
  assert.ok(r.resolved);
});

test('tripleBarrier: window NOT elapsed and no hit → pending (no fabricated outcome)', () => {
  const fwd = series('2026-01-02', [101, 102]);   // only 2 of 5 bars
  const r = L.tripleBarrier(fwd, 100, { up: 0.08, down: 0.04, window: 5 });
  assert.strictEqual(r.pending, true);
  assert.strictEqual(r.resolved, false);
});

test('labelEvent computes SPY-relative return and slippage; null benchmark when absent', () => {
  const c = series('2026-01-01', [100, 101, 107, 110, 109, 108, 107]);
  const spy = series('2026-01-01', [400, 401, 402, 403, 404, 405, 406]);
  const r = L.labelEvent({ entry: 100, candles: c, predDate: '2026-01-01', horizon: 'fast', spyCandles: spy, dollarVol: 5e7 });
  assert.strictEqual(r.won, true);
  assert.ok(typeof r.spyRelReturn === 'number');
  assert.ok(r.slippageEst > 0);
  const noBench = L.labelEvent({ entry: 100, candles: c, predDate: '2026-01-01', horizon: 'fast' });
  assert.strictEqual(noBench.spyRelReturn, null);   // never fabricated
});

test('toEvolveHorizon maps decision horizons', () => {
  assert.strictEqual(L.toEvolveHorizon('intraday'), 'fast');
  assert.strictEqual(L.toEvolveHorizon('position'), 'position');
  assert.strictEqual(L.toEvolveHorizon('portfolio'), 'position');
  assert.strictEqual(L.toEvolveHorizon('unknown'), 'swing');
});
