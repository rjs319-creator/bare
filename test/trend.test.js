'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshMoverCandidate, trendCandidate } = require('../lib/trend');

// Build `n` daily candles rising from p0 to p1, with a final `thrustPct` 5-day pop.
// Volume chosen so price*volume clears whatever $-vol we want. Returns { candles, spyByDate }.
function build({ n = 260, p0 = 40, p1 = 90, thrustPct = 0, vol = 4_000_000, spy = 500 } = {}) {
  const candles = [], spyByDate = {};
  for (let i = 0; i < n; i++) {
    const date = `2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}-${i}`;
    let close = p0 + (p1 - p0) * (i / (n - 1));
    if (i >= n - 5) close = close * (1 + thrustPct * ((i - (n - 6)) / 5)); // ramp the thrust over the last 5 bars
    candles.push({ date, open: close, high: close * 1.01, low: close * 0.99, close, volume: vol });
    spyByDate[date] = spy;
  }
  return { candles, spyByDate };
}

test('freshMoverCandidate: surfaces a liquid large-cap in an uptrend with a fresh 5d thrust', () => {
  const { candles, spyByDate } = build({ p0: 40, p1: 90, thrustPct: 0.15, vol: 4_000_000 }); // $vol ≈ $360M
  const m = freshMoverCandidate(candles, spyByDate);
  assert.ok(m, 'should qualify');
  assert.ok(m.ret5 >= 8 && m.ret5 <= 30, `ret5 in band, got ${m.ret5}`);
  assert.ok(m.rs > 0, 'RS positive vs flat SPY');
  assert.ok(m.score > 0 && m.score <= 100);
});

test('freshMoverCandidate: rejects below the $150M $-vol floor (low volume)', () => {
  const { candles, spyByDate } = build({ p0: 40, p1: 90, thrustPct: 0.15, vol: 200_000 }); // $vol ≈ $18M
  assert.equal(freshMoverCandidate(candles, spyByDate), null);
});

test('freshMoverCandidate: rejects when there is no fresh thrust (flat last 5 days)', () => {
  const { candles, spyByDate } = build({ p0: 40, p1: 90, thrustPct: 0, vol: 4_000_000 });
  assert.equal(freshMoverCandidate(candles, spyByDate), null);
});

test('freshMoverCandidate: rejects a parabolic move (>30% in 5 days)', () => {
  const { candles, spyByDate } = build({ p0: 40, p1: 90, thrustPct: 0.45, vol: 4_000_000 });
  assert.equal(freshMoverCandidate(candles, spyByDate), null);
});

test('freshMoverCandidate: rejects a downtrend (below the 200-DMA)', () => {
  // Falling series → price below its 200-DMA → not an established uptrend, even with a late pop.
  const { candles, spyByDate } = build({ p0: 120, p1: 40, thrustPct: 0.12, vol: 4_000_000 });
  assert.equal(freshMoverCandidate(candles, spyByDate), null);
});

test('freshMoverCandidate: rejects when not leading SPY (RS ≤ 0)', () => {
  // Qualifying stock (~9% thrust) but SPY surged ~30% over the trailing 21 bars → stock lags → RS < 0.
  const n = 260;
  const { candles } = build({ n, p0: 80, p1: 88, thrustPct: 0.09, vol: 4_000_000 });
  const spyByDate = {};
  candles.forEach((c, i) => { spyByDate[c.date] = i >= n - 21 ? 100 + 30 * ((i - (n - 21)) / 21) : 100; });
  assert.equal(freshMoverCandidate(candles, spyByDate), null);
});

test('freshMoverCandidate: null on too-short history', () => {
  const { candles, spyByDate } = build({ n: 120, thrustPct: 0.15 });
  assert.equal(freshMoverCandidate(candles, spyByDate), null);
});

test('trendCandidate still works (unchanged 12-1 momentum leader)', () => {
  const { candles } = build({ n: 300, p0: 40, p1: 90, thrustPct: 0 });
  const c = trendCandidate(candles);
  assert.ok(c && c.mom > 0, 'confirmed uptrend with positive 12-1 momentum');
});
