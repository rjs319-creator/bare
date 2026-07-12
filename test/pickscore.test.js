'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pointInTimeStrength, toPercentiles, idxAsOf, momentum, smaSide } = require('../lib/pickscore');

// Build a candle series with a constant daily growth rate (compounding).
function ramp(n, startDate, dailyPct) {
  const out = [];
  let px = 100;
  const base = new Date(startDate + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: d, close: +px.toFixed(4), high: +px.toFixed(4), low: +px.toFixed(4) });
    px *= (1 + dailyPct / 100);
  }
  return out;
}

test('idxAsOf: last bar at/or before the date (no look-ahead)', () => {
  const c = ramp(5, '2026-01-01', 0);
  assert.equal(idxAsOf(c, c[3].date), 3);
  assert.equal(idxAsOf(c, '2025-12-31'), -1);
});

test('momentum: trailing return over N sessions; null without enough history', () => {
  const c = ramp(30, '2026-01-01', 1); // +1%/day compounding
  const m = momentum(c, 21, 21);
  assert.ok(m > 20 && m < 24); // ~ (1.01^21 - 1) ≈ 23%
  assert.equal(momentum(c, 5, 21), null);
});

test('smaSide: +1 above its SMA in an uptrend, −1 below in a downtrend', () => {
  const up = ramp(60, '2026-01-01', 1);
  const down = ramp(60, '2026-01-01', -1);
  assert.equal(smaSide(up, 55, 50), 1);
  assert.equal(smaSide(down, 55, 50), -1);
  assert.equal(smaSide(up, 10, 50), null); // not enough history
});

test('pointInTimeStrength: a strong uptrend scores higher than a downtrend', () => {
  const up = ramp(80, '2026-01-01', 1);
  const down = ramp(80, '2026-01-01', -1);
  const spy = ramp(80, '2026-01-01', 0.02); // ~flat market
  const asOf = up[79].date;
  const sUp = pointInTimeStrength(up, spy, asOf);
  const sDown = pointInTimeStrength(down, spy, down[79].date);
  assert.ok(sUp > sDown, `up ${sUp} should beat down ${sDown}`);
  assert.ok(sUp > 0 && sDown < 0);
});

test('pointInTimeStrength: direction-aware — a SHORT on a falling stock scores high', () => {
  const down = ramp(80, '2026-01-01', -1);
  const spy = ramp(80, '2026-01-01', 0.02);
  const asOf = down[79].date;
  const longConv = pointInTimeStrength(down, spy, asOf, { isShort: false });
  const shortConv = pointInTimeStrength(down, spy, asOf, { isShort: true });
  assert.ok(longConv < 0);          // weak long
  assert.equal(shortConv, +(-longConv).toFixed(3)); // strong short = the sign flip
  assert.ok(shortConv > 0);
});

test('pointInTimeStrength: null when there is not enough history to score fairly', () => {
  assert.equal(pointInTimeStrength(ramp(10, '2026-01-01', 1), null, '2026-01-10'), null);
  assert.equal(pointInTimeStrength([], null, '2026-01-10'), null);
});

test('pointInTimeStrength: regime-normalized — beating a hot market scores above matching it', () => {
  const stock = ramp(80, '2026-01-01', 1);
  const hotMkt = ramp(80, '2026-01-01', 1);    // market ran just as hard
  const flatMkt = ramp(80, '2026-01-01', 0);   // market went nowhere
  const asOf = stock[79].date;
  const vsHot = pointInTimeStrength(stock, hotMkt, asOf);
  const vsFlat = pointInTimeStrength(stock, flatMkt, asOf);
  assert.ok(vsFlat > vsHot, `beating a flat market (${vsFlat}) should score above matching a hot one (${vsHot})`);
});

test('toPercentiles: 0-100 average-rank percentiles; ties share a rank', () => {
  const p = toPercentiles([10, 20, 30, 40, 50]);
  assert.deepEqual(p, [0, 25, 50, 75, 100]);
  assert.deepEqual(toPercentiles([5]), [50]);          // single value → mid
  assert.deepEqual(toPercentiles([]), []);
  const ties = toPercentiles([1, 1, 3]);               // first two tie at avg-rank 0.5 → 25
  assert.equal(ties[0], ties[1]);
  assert.equal(ties[2], 100);
});
