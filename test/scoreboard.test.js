'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forwardReturn, forwardPath, summarizeReturns, cernPicksFrom, fadeRowsFrom } = require('../lib/apex-routes');

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

// ── forwardPath: close-to-close return + Maximum Favorable Excursion ──────────

const PATH = [
  { date: '2026-01-01', close: 100, high: 100, low: 100 },
  { date: '2026-01-02', close: 105, high: 115, low: 99 },  // ran to +15% intrabar
  { date: '2026-01-03', close: 108, high: 122, low: 104 }, // ran to +22% intrabar
];

test('forwardPath: a long captures the best run-up (MFE), not just the close', () => {
  const r = forwardPath(PATH, { date: '2026-01-01', tier: 'X' }, 2);
  assert.equal(r.ret, 8);    // closes at 108 → +8%
  assert.equal(r.mfe, 22);   // best high 122 → +22%
});

test('forwardPath: a short measures favorable excursion to the downside', () => {
  // entry 100, short: favorable = price falling; lowest low is 99 → MFE 1%
  const r = forwardPath(PATH, { date: '2026-01-01', short: true }, 2);
  assert.ok(Math.abs(r.mfe - 1) < 1e-9);
  assert.equal(r.ret, -8); // long would be +8 → short inverts to -8
});

test('forwardPath: returns null when the horizon has not elapsed yet', () => {
  assert.equal(forwardPath(PATH, { date: '2026-01-01' }, 5), null);
});

// ── summarizeReturns: expectancy + big-winner reach ──────────────────────────

test('summarizeReturns: reports big-winner rates from the MFE distribution', () => {
  const s = summarizeReturns([
    { ret: 5, mfe: 12 }, { ret: -3, mfe: 4 },
    { ret: 8, mfe: 25 }, { ret: -1, mfe: 9 },
  ]);
  assert.equal(s.n, 4);
  assert.equal(s.winRate, 50);
  assert.equal(s.big10, 50);   // 12 and 25 cross +10%
  assert.equal(s.big20, 25);   // only 25 crosses +20%
  assert.equal(s.avgMfe, 12.5); // (12+4+25+9)/4
  assert.equal(summarizeReturns([]), null);
});

// ── fadeRowsFrom: flatten the fade ledger into Scoreboard short rows ──────────
const FADE_DAYS = [
  { date: '2026-06-20', signals: [
    { ticker: 'ARE', date: '2026-06-20', entry: 53.29, action: 'SHORT', tier: 'EMERGING' },
    { ticker: 'AMT', date: '2026-06-20', entry: 168.7, action: 'SHORT_LIGHT', tier: 'CONFIRMED' },
    { ticker: 'XYZ', date: '2026-06-20', entry: 10, action: 'WATCH', tier: 'WATCH' },
    { ticker: 'ZZZ', date: '2026-06-20', entry: 10, action: 'SKIP', tier: 'WATCH' },
  ] },
];

test('fadeRowsFrom: keeps only actionable shorts and tags them short', () => {
  const rows = fadeRowsFrom(FADE_DAYS);
  assert.equal(rows.length, 2);                       // WATCH + SKIP dropped
  assert.deepEqual(rows.map(r => r.ticker).sort(), ['AMT', 'ARE']);
  assert.ok(rows.every(r => r.short === true));        // shorts → forwardReturn inverts
});

test('fadeRowsFrom: tier carries the action (conviction split)', () => {
  const rows = fadeRowsFrom(FADE_DAYS);
  assert.equal(rows.find(r => r.ticker === 'ARE').tier, 'SHORT');
  assert.equal(rows.find(r => r.ticker === 'AMT').tier, 'SHORT_LIGHT');
});

test('fadeRowsFrom: tolerates empty / malformed input', () => {
  assert.deepEqual(fadeRowsFrom([]), []);
  assert.deepEqual(fadeRowsFrom(null), []);
  assert.deepEqual(fadeRowsFrom([{ date: '2026-06-20' }]), []);   // no signals array
});

test('fadeRowsFrom: a fade short row is profitable when the name falls', () => {
  // End-to-end with forwardReturn: entry above the future close → short gains.
  const row = fadeRowsFrom(FADE_DAYS)[0];
  const candles = [
    { date: '2026-06-20', close: 100 },
    { date: '2026-06-21', close: 90 },                 // fell 10% → a winning short
  ];
  const r = forwardReturn(candles, { ...row, date: '2026-06-20', entry: 100 }, 1);
  assert.ok(r > 0);
});
