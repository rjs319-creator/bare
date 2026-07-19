'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../lib/orbit-labels');

// Build candles from per-bar OHLC specs starting at `from`.
function series(from, bars) {
  let d = new Date(from + 'T00:00:00Z');
  return bars.map(b => {
    const date = d.toISOString().slice(0, 10);
    d = new Date(d.getTime() + 86400000);
    const close = b.c;
    return { date, open: b.o ?? close, high: b.h ?? close, low: b.l ?? close, close, volume: b.v ?? 1e6 };
  });
}

test('fills at the NEXT session open plus slippage (never same bar)', () => {
  const bars = series('2023-01-02', Array.from({ length: 12 }, () => ({ o: 100, h: 100.5, l: 99.5, c: 100 })));
  const out = L.orbitLabels(bars, bars[3].date, { tier: 'liquid' });
  assert.ok(out.fill.filled);
  assert.strictEqual(out.fill.fillDate, bars[4].date, 'entry is the next session');
  // liquid slippage = (3+5)bps = 0.0008 → long fill = 100 * 1.0008
  assert.ok(Math.abs(out.fill.fillPrice - 100.08) < 0.02, `fillPrice ${out.fill.fillPrice}`);
});

test('upper barrier → WIN with the actual label-end date', () => {
  // Flat, then a big up bar that tags the +6% target on day fillIdx+3.
  const flat = Array.from({ length: 5 }, () => ({ o: 100, h: 100.5, l: 99.5, c: 100 }));
  const bars = series('2023-02-01', [...flat, { o: 101, h: 108, l: 101, c: 107 }, { c: 107 }, { c: 107 }]);
  const out = L.orbitLabels(bars, bars[3].date, { tier: 'liquid' });
  const h5 = out.horizons.days5;
  assert.strictEqual(h5.barrier, 'upper');
  assert.strictEqual(h5.outcome, 'WIN');
  assert.ok(h5.grossReturn > 0.05);
  assert.strictEqual(h5.exitDate, bars[5].date, 'label ends on the barrier-touch bar');
  assert.ok(h5.mfe >= h5.grossReturn - 1e-6);
});

test('same-bar target+stop ambiguity resolves to the STOP (conservative)', () => {
  // Entry ~100; a bar whose HIGH tags +6% AND LOW tags −4% → must be LOSS.
  const flat = Array.from({ length: 5 }, () => ({ o: 100, h: 100.2, l: 99.8, c: 100 }));
  const bars = series('2023-03-01', [...flat, { o: 100, h: 108, l: 95, c: 100 }, { c: 100 }, { c: 100 }]);
  const out = L.orbitLabels(bars, bars[3].date, { tier: 'liquid' });
  assert.strictEqual(out.horizons.days5.outcome, 'LOSS');
  assert.strictEqual(out.horizons.days5.barrier, 'lower');
});

test('gap-through down bar is a LOSS at the stop level', () => {
  const flat = Array.from({ length: 5 }, () => ({ o: 100, h: 100.2, l: 99.8, c: 100 }));
  const bars = series('2023-04-03', [...flat, { o: 90, h: 91, l: 88, c: 89 }, { c: 89 }, { c: 89 }]);
  const out = L.orbitLabels(bars, bars[3].date, { tier: 'liquid' });
  assert.strictEqual(out.horizons.days5.outcome, 'LOSS');
});

test('PROFITABLE timeout is EXPIRED, not a loss', () => {
  // Drifts up ~5% over 5 sessions without tagging the +6% barrier.
  const flat = Array.from({ length: 4 }, () => ({ o: 100, h: 100.2, l: 99.8, c: 100 }));
  const drift = [{ c: 101 }, { c: 102 }, { c: 103 }, { c: 104 }, { c: 105 }, { c: 105 }];
  const bars = series('2023-05-01', [...flat, ...drift]);
  const out = L.orbitLabels(bars, bars[3].date, { tier: 'liquid' });
  const h5 = out.horizons.days5;
  assert.strictEqual(h5.outcome, 'EXPIRED');
  assert.strictEqual(h5.barrier, 'timeout');
  assert.ok(h5.grossReturn > 0, `gross ${h5.grossReturn}`);
  assert.strictEqual(h5.severeLoss, 0);
  assert.strictEqual(h5.positiveRaw, 1, 'net positive after costs');
});

test('no future bar → horizon resolved:false', () => {
  const bars = series('2023-06-01', Array.from({ length: 8 }, () => ({ o: 100, h: 100.2, l: 99.8, c: 100 })));
  const out = L.orbitLabels(bars, bars[6].date, { tier: 'liquid' });
  assert.strictEqual(out.horizons.days63.resolved, false, '63d cannot resolve near the tail');
  assert.ok(/insufficient/.test(out.horizons.days63.reason));
});

test('market/sector-relative and residual returns use the fill→exit window', () => {
  const flat = Array.from({ length: 4 }, () => ({ o: 100, h: 100.2, l: 99.8, c: 100 }));
  const drift = [{ c: 103 }, { c: 106 }, { c: 108, h: 108 }, { c: 108 }, { c: 108 }, { c: 108 }];
  const bars = series('2023-07-03', [...flat, ...drift]);
  // Market rises 2% over the same window; sector flat.
  const mkt = bars.map((b, i) => ({ date: b.date, close: 400 * (1 + 0.002 * i) }));
  const sec = bars.map((b) => ({ date: b.date, close: 50 }));
  const out = L.orbitLabels(bars, bars[3].date, { tier: 'liquid', marketCandles: mkt, sectorCandles: sec, exposures: { market: 1, sector: 0.5 } });
  const h5 = out.horizons.days5;
  assert.ok(h5.marketRelReturn != null && h5.marketRelReturn < h5.grossReturn, 'market-relative subtracts market');
  assert.ok(h5.sectorRelReturn != null);
  assert.ok(h5.residualReturn != null, 'residual computed from exposures');
});

test('unfillable signal (date past data) → resolvable false', () => {
  const bars = series('2023-08-01', Array.from({ length: 5 }, () => ({ c: 100 })));
  const out = L.orbitLabels(bars, '2024-01-01', { tier: 'liquid' });
  assert.strictEqual(out.resolvable, false);
  assert.strictEqual(out.horizons, null);
});
