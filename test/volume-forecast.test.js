'use strict';
// VOLUME FORECAST tests. The invariants that matter:
//   1. NO LEAKAGE: the forecast at asOfIdx is byte-identical when every future
//      bar is mutated — nothing after the cutoff can enter.
//   2. NO DIRECTION: the module reads close & volume only — mutating open/high/
//      low (the path/direction fields) changes nothing, structurally enforcing
//      "a volume forecast is never a bullish signal".
//   3. Weekday seasonality is learned from history (2× Fridays → positive
//      Friday offset), abnormal probability is an EMPIRICAL frequency in [0,1]
//      with a fail-closed minObs fallback chain, and every forecast is labeled
//      known:false (modeled, not quoted).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/volume-forecast');

function tradingDates(n) {
  const out = [];
  const d = new Date('2025-01-06T00:00:00Z');   // a Monday
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function candles(n, { fridayMult = 1, seed = 5 } = {}) {
  const rnd = lcg(seed);
  return tradingDates(n).map(date => {
    const isFri = V.weekdayOf(date) === 4;
    const vol = Math.round(1_000_000 * (0.8 + rnd() * 0.4) * (isFri ? fridayMult : 1));
    const close = 40 + rnd() * 2;
    return { date, open: close * 0.99, high: close * 1.01, low: close * 0.98, close, volume: vol };
  });
}

test('no leakage: mutating every future bar leaves the forecast byte-identical', () => {
  const cs = candles(160);
  const idx = 119;
  const base = V.forecastNextSession(cs, { asOfIdx: idx, nextDate: cs[idx + 1].date });
  const mutated = cs.map((c, i) => (i > idx ? { ...c, close: c.close * 10, volume: c.volume * 100 } : c));
  const after = V.forecastNextSession(mutated, { asOfIdx: idx, nextDate: cs[idx + 1].date });
  assert.equal(JSON.stringify(base), JSON.stringify(after));
});

test('no direction: open/high/low (the path fields) are structurally invisible', () => {
  const cs = candles(160);
  const base = V.forecastNextSession(cs, {});
  const flipped = cs.map(c => ({ ...c, open: c.close * 2, high: c.close * 3, low: c.close * 0.1 }));
  const after = V.forecastNextSession(flipped, {});
  assert.equal(JSON.stringify(base), JSON.stringify(after));
});

test('weekday seasonality: 2× Fridays → positive Friday offset, higher Friday forecast', () => {
  const cs = candles(200, { fridayMult: 2 });
  const dts = tradingDates(210);
  const nextFriday = dts.find(d => d > cs[cs.length - 1].date && V.weekdayOf(d) === 4);
  const nextMonday = dts.find(d => d > cs[cs.length - 1].date && V.weekdayOf(d) === 0);
  const fri = V.forecastNextSession(cs, { nextDate: nextFriday });
  const mon = V.forecastNextSession(cs, { nextDate: nextMonday });
  assert.ok(fri.seasonalLogOffset > 0.3, `Friday offset should be strongly positive, got ${fri.seasonalLogOffset}`);
  assert.ok(fri.expectedDollarVol > mon.expectedDollarVol);
});

test('abnormal probability is empirical, bounded, and fail-closed under thin history', () => {
  const full = V.forecastNextSession(candles(200), {});
  assert.ok(full.pAbnormal == null || (full.pAbnormal >= 0 && full.pAbnormal <= 1));
  assert.ok(/conditional|unconditional|insufficient/.test(full.pAbnormalBasis));
  const thin = V.forecastNextSession(candles(10), {});
  assert.equal(thin.available, false);
  assert.match(thin.reason, /insufficient-history/);
});

test('every forecast is labeled modeled (known:false) and maps a real cost tier', () => {
  const f = V.forecastNextSession(candles(160), {});
  assert.equal(f.known, false);
  assert.equal(f.basis, 'forecast');
  assert.ok(['liquid', 'small', 'micro'].includes(f.forecastTier));
  assert.ok(f.expectedDollarVol > 0);
  assert.ok(f.band.lo < f.expectedDollarVol && f.band.hi > f.expectedDollarVol);
});

test('scanPriority: zero opportunity stays zero — volume alone can never promote a name', () => {
  const f = V.forecastNextSession(candles(160), {});
  assert.equal(V.scanPriority({ opportunity: 0, forecast: f }), 0);
  const withVol = V.scanPriority({ opportunity: 0.8, forecast: f });
  const unknown = V.scanPriority({ opportunity: 0.8, forecast: null });
  assert.ok(withVol > 0 && unknown > 0);
  assert.ok(unknown < withVol, 'unknown liquidity dampens, never zeroes');
});
