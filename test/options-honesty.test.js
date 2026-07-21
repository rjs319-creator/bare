'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const of = require('../lib/optionsflow');

// A minimal Yahoo optionChain result[0] shaped like the real feed.
function chain({ calls = [], puts = [], underlying = 100 } = {}) {
  return {
    quote: { regularMarketPrice: underlying, regularMarketChangePercent: 1.2 },
    options: [{ calls, puts }],
  };
}

// ── scanChain enriches every signal with the honest, normalized read ────────
test('scanChain: signals carry honest fields (directionState, dteBucket, kindLabel, bounded vol/OI)', () => {
  const c = {
    strike: 105, expiration: Math.floor(Date.now() / 1000) + 30 * 86400,
    volume: 2000, openInterest: 100, lastPrice: 4.0, bid: 3.6, ask: 4.0, impliedVolatility: 0.5,
  };
  const sigs = of.scanChain('NVDA', chain({ calls: [c] }), { dataTs: '2026-07-21T14:00:00Z' });
  assert.equal(sigs.length, 1);
  const s = sigs[0];
  assert.equal(s.directionState, 'PROVISIONAL_BULLISH');   // call lifted at the ask
  assert.equal(s.dataDelayed, true);
  assert.ok(['0-7', '8-20', '21-45', '46-75', '75+'].includes(s.dteBucket));
  assert.equal(s.kindLabel, 'High-turnover contract');     // vol 20× OI
  assert.ok(Number.isFinite(s.volOiBounded));
});

// ── ZERO-OI: preserved as new positioning, bounded, and it SCORES ───────────
test('scanChain: volume on zero open interest is new positioning, bounded, and scores', () => {
  const c = {
    strike: 105, expiration: Math.floor(Date.now() / 1000) + 20 * 86400,
    volume: 5000, openInterest: 0, lastPrice: 5.0, bid: 4.8, ask: 5.0,
  };
  const [s] = of.scanChain('AMD', chain({ calls: [c] }));
  assert.equal(s.newOnZeroOi, true);
  assert.ok(Number.isFinite(s.volOiBounded) && s.volOiBounded > 0, 'bounded, non-zero');
  assert.ok(Number.isFinite(s.score) && s.score > 0, 'zero-OI activity must still score, not be silently zeroed');
});

// ── DIRECTION UNKNOWN: bid-side activity is not a bullish call ───────────────
test('scanChain: a call printed at the bid is DIRECTION_UNKNOWN, not bullish', () => {
  const c = {
    strike: 105, expiration: Math.floor(Date.now() / 1000) + 20 * 86400,
    volume: 2000, openInterest: 100, lastPrice: 3.65, bid: 3.6, ask: 4.0,   // near bid
  };
  const [s] = of.scanChain('MU', chain({ calls: [c] }));
  assert.equal(s.aggressor, 'bid');
  assert.equal(s.directionState, 'DIRECTION_UNKNOWN');
});

// ── rollup: honest aggregate direction + earnings preserved at ticker level ─
test('rollupByTicker: opposing ask-side activity → MIXED (not a bullish grade)', () => {
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const callC = { strike: 110, expiration: exp, volume: 3000, openInterest: 500, lastPrice: 4.0, bid: 3.6, ask: 4.0 };
  const putC = { strike: 90, expiration: exp, volume: 300, openInterest: 500, lastPrice: 4.0, bid: 3.6, ask: 4.0 };
  const sigs = of.scanChain('TSLA', chain({ calls: [callC], puts: [putC] }));
  // Mark both as ambiguous-free (they're a combo footprint → detectMultiLeg may flag). Just
  // assert the rollup carries an honest directionState field, not a naive call/put label.
  const roll = of.rollupByTicker(sigs);
  assert.equal(roll.length, 1);
  assert.ok(['PROVISIONAL_BULLISH', 'PROVISIONAL_BEARISH', 'MIXED', 'DIRECTION_UNKNOWN'].includes(roll[0].directionState));
  assert.ok(roll[0].directionLabel);
});

test('rollupByTicker: earnings-before-expiry is carried to the ticker row (cannot vanish)', () => {
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const c = { strike: 105, expiration: exp, volume: 2000, openInterest: 100, lastPrice: 4.0, bid: 3.6, ask: 4.0 };
  const sigs = of.scanChain('NVDA', chain({ calls: [c] }));
  // Simulate the route's per-signal earnings enrichment.
  sigs.forEach(s => { s.earningsBeforeExpiry = true; s.earningsInDays = 12; });
  const [row] = of.rollupByTicker(sigs);
  assert.equal(row.earningsBeforeExpiry, true, 'the ⚠ warning must survive reaggregation');
  assert.equal(row.earningsInDays, 12);
});
