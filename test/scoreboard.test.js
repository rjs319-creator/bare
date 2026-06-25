'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forwardReturn, cernPicksFrom } = require('../lib/apex-routes');

// ── cernPicksFrom: map a CERN engine state into Scoreboard picks ─────────────

test('cernPicksFrom: null / non-object state yields no picks', () => {
  assert.deepEqual(cernPicksFrom(null), []);
  assert.deepEqual(cernPicksFrom(undefined), []);
  assert.deepEqual(cernPicksFrom('nope'), []);
  assert.deepEqual(cernPicksFrom({}), []);
});

test('cernPicksFrom: a buy-reversion event (direction -1) is a long row', () => {
  // Arrange
  const state = { ledger: [{ type: 'LOCKUP_EXPIRY', symbol: 'BLLN', dateMs: Date.UTC(2026, 0, 15), direction: -1 }] };
  // Act
  const [pick] = cernPicksFrom(state);
  // Assert
  assert.equal(pick.section, 'CERN');
  assert.equal(pick.tier, 'LOCKUP_EXPIRY');
  assert.equal(pick.ticker, 'BLLN');
  assert.equal(pick.date, '2026-01-15');
  assert.equal(pick.short, false); // direction -1 = buy the reversion = long
});

test('cernPicksFrom: a fade event (direction +1) is a short row', () => {
  const state = { ledger: [{ type: 'INDEX_ADD_FADE', symbol: 'MRVL', dateMs: Date.UTC(2026, 1, 1), direction: 1 }] };
  const [pick] = cernPicksFrom(state);
  assert.equal(pick.short, true); // direction +1 = fade the forced buying = short
});

test('cernPicksFrom: uses signal.entryPrice when present, else null', () => {
  const state = { ledger: [
    { type: 'FIRE_SALE', symbol: 'FSLR', dateMs: Date.UTC(2026, 0, 5), direction: -1, signal: { entryPrice: 142.5 } },
    { type: 'FIRE_SALE', symbol: 'ENPH', dateMs: Date.UTC(2026, 0, 5), direction: -1 },
  ] };
  const picks = cernPicksFrom(state);
  assert.equal(picks.find(p => p.ticker === 'FSLR').entry, 142.5);
  assert.equal(picks.find(p => p.ticker === 'ENPH').entry, null);
});

test('cernPicksFrom: first-appearance dedup per event-type:symbol keeps the earliest', () => {
  const state = { ledger: [
    { type: 'FORCED_DOWNGRADE', symbol: 'RIVN', dateMs: Date.UTC(2026, 2, 10), direction: -1 },
    { type: 'FORCED_DOWNGRADE', symbol: 'RIVN', dateMs: Date.UTC(2026, 0, 2), direction: -1 }, // earlier
  ] };
  const picks = cernPicksFrom(state);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].date, '2026-01-02'); // the earliest appearance wins
});

test('cernPicksFrom: includes the resolved archive, not just the open ledger', () => {
  const state = {
    ledger: [{ type: 'INDEX_DELETE', symbol: 'POOL', dateMs: Date.UTC(2026, 0, 9), direction: -1 }],
    archive: [{ type: 'TAX_LOSS', symbol: 'CPB', dateMs: Date.UTC(2025, 11, 1), direction: -1 }],
  };
  const tiers = cernPicksFrom(state).map(p => p.tier).sort();
  assert.deepEqual(tiers, ['INDEX_DELETE', 'TAX_LOSS']);
});

test('cernPicksFrom: drops malformed entries (missing type / symbol / dateMs)', () => {
  const state = { ledger: [
    { symbol: 'X', dateMs: 1 },                    // no type
    { type: 'FIRE_SALE', dateMs: 1 },              // no symbol
    { type: 'FIRE_SALE', symbol: 'Y' },            // no dateMs
    { type: 'FIRE_SALE', symbol: 'Z', dateMs: Date.UTC(2026, 0, 1), direction: -1 }, // valid
  ] };
  const picks = cernPicksFrom(state);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].ticker, 'Z');
});

// ── forwardReturn: direction-aware forward return ────────────────────────────

const CANDLES = [
  { date: '2026-01-01', close: 100 },
  { date: '2026-01-02', close: 110 },
  { date: '2026-01-03', close: 90 },
];

test('forwardReturn: a long pick is positive when price rises', () => {
  const r = forwardReturn(CANDLES, { date: '2026-01-01', tier: 'X' }, 1);
  assert.equal(r, 10); // 100 → 110
});

test('forwardReturn: a short pick inverts — positive when price falls', () => {
  const r = forwardReturn(CANDLES, { date: '2026-01-02', short: true }, 1);
  assert.ok(r > 0); // 110 → 90 is a loss for a long, a gain for a short
  assert.ok(Math.abs(r - 18.18) < 0.1);
});

test('forwardReturn: null entry falls back to the close at the pick date', () => {
  const r = forwardReturn(CANDLES, { date: '2026-01-01', entry: null }, 1);
  assert.equal(r, 10); // uses candles[0].close = 100 as entry
});

test('forwardReturn: returns null when the horizon has not elapsed yet', () => {
  assert.equal(forwardReturn(CANDLES, { date: '2026-01-01' }, 5), null);
});
