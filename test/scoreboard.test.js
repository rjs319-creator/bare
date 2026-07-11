'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forwardReturn, forwardPath, nextOpenReturn, spyForwardReturn, summarizeReturns, cernPicksFrom, fadeRowsFrom, regimeBucketOf } = require('../lib/apex-routes');

// ── regimeBucketOf: map a macro state into a Scoreboard regime bucket ─────────
test('regimeBucketOf: null / missing state yields no bucket', () => {
  assert.equal(regimeBucketOf(null), null);
  assert.equal(regimeBucketOf(undefined), null);
});
test('regimeBucketOf: riskOn flag → risk-on bucket', () => {
  assert.equal(regimeBucketOf({ riskOn: true, riskOff: false, regime: 'risk-on' }), 'risk-on');
});
test('regimeBucketOf: riskOff flag → risk-off bucket', () => {
  assert.equal(regimeBucketOf({ riskOn: false, riskOff: true, regime: 'risk-off' }), 'risk-off');
});
test('regimeBucketOf: neutral state → no bucket (counts only in All)', () => {
  assert.equal(regimeBucketOf({ riskOn: false, riskOff: false, regime: 'neutral' }), null);
});

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

// ── spyForwardReturn: the market benchmark over the same window ───────────────

const SPY = [
  { date: '2026-01-01', close: 500 },
  { date: '2026-01-02', close: 505 },  // +1%
  { date: '2026-01-03', close: 490 },  // -3% from anchor
];

test('spyForwardReturn: SPY return over the window from the pick date', () => {
  const r = spyForwardReturn(SPY, { date: '2026-01-01' }, 1);
  assert.equal(r, 1); // 500 → 505 = +1%
});

test('spyForwardReturn: null when the window has not elapsed or no data', () => {
  assert.equal(spyForwardReturn(SPY, { date: '2026-01-01' }, 9), null);
  assert.equal(spyForwardReturn(null, { date: '2026-01-01' }, 1), null);
  assert.equal(spyForwardReturn([], { date: '2026-01-01' }, 1), null);
});

// ── summarizeReturns: expectancy + big-winner reach + market-beating ─────────

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

test('summarizeReturns: excess vs market — avg excess + beat rate over records that have it', () => {
  const s = summarizeReturns([
    { ret: 5, mfe: 6, exc: 3 },   // beat market
    { ret: 2, mfe: 3, exc: -1 },  // lagged market
    { ret: 4, mfe: 5, exc: 2 },   // beat market
    { ret: 1, mfe: 2 },           // no benchmark yet → excluded from excess stats
  ]);
  assert.equal(s.n, 4);          // raw stats still count every record
  assert.equal(s.excessN, 3);    // only 3 have a benchmark
  assert.equal(s.avgExcess, 1.33); // (3 - 1 + 2) / 3
  assert.equal(s.beatMktRate, 67); // 2 of 3 beat the market
});

test('summarizeReturns: null excess fields when no record carries a benchmark', () => {
  const s = summarizeReturns([{ ret: 5, mfe: 6 }, { ret: -2, mfe: 1 }]);
  assert.equal(s.excessN, 0);
  assert.equal(s.avgExcess, null);
  assert.equal(s.beatMktRate, null);
});

test('summarizeReturns: net-of-cost fields aggregate the per-record net/netExc', () => {
  const s = summarizeReturns([
    { ret: 5, mfe: 6, exc: 3, net: 4.84, netExc: 2.84 },  // net winner, still beats mkt net
    { ret: 2, mfe: 3, exc: -1, net: 1.84, netExc: -1.16 },
    { ret: 0.1, mfe: 1, exc: 0.2, net: -0.06, netExc: 0.04 }, // costs flip it to a net loser
    { ret: 1, mfe: 2 },                                    // no net (predates cost wiring) → excluded
  ]);
  assert.equal(s.n, 4);
  assert.equal(s.netN, 3);            // only 3 carry a net field
  assert.equal(s.avgNet, 2.21);       // (4.84 + 1.84 − 0.06) / 3
  assert.equal(s.netWinRate, 67);     // 2 of 3 positive net
  assert.equal(s.avgNetExcess, 0.57); // (2.84 − 1.16 + 0.04) / 3
  assert.equal(s.netBeatMktRate, 67); // 2 of 3 beat the market net
  assert.equal(s.costModel, 'cost-v1');
});

test('summarizeReturns: net fields are null when no record carries a net', () => {
  const s = summarizeReturns([{ ret: 5, mfe: 6, exc: 2 }]);
  assert.equal(s.netN, 0);
  assert.equal(s.avgNet, null);
  assert.equal(s.avgNetExcess, null);
});

test('summarizeReturns: sector-relative excess aggregates the per-record secExc', () => {
  const s = summarizeReturns([
    { ret: 5, mfe: 6, exc: 3, secExc: 1.5 },   // beat its sector
    { ret: 2, mfe: 3, exc: -1, secExc: -0.5 }, // lagged its sector
    { ret: 4, mfe: 5, exc: 2, secExc: 2.5 },   // beat its sector
    { ret: 1, mfe: 2, exc: 0 },                // sector unknown → excluded from sector stats
  ]);
  assert.equal(s.n, 4);
  assert.equal(s.secExcN, 3);          // only 3 have a resolvable sector
  assert.equal(s.avgSecExcess, 1.17);  // (1.5 − 0.5 + 2.5) / 3
  assert.equal(s.beatSecRate, 67);     // 2 of 3 beat their sector
});

test('summarizeReturns: sector fields are null when no record carries a sector excess', () => {
  const s = summarizeReturns([{ ret: 5, mfe: 6, exc: 2 }]);
  assert.equal(s.secExcN, 0);
  assert.equal(s.avgSecExcess, null);
  assert.equal(s.beatSecRate, null);
});

// ── nextOpenReturn: realistic-entry forward return (entry-v1) ────────────────
const NO_CANDLES = [
  { date: '2026-01-01', open: 100, high: 101, low: 99, close: 100 },
  { date: '2026-01-02', open: 102, high: 105, low: 101, close: 104 },
  { date: '2026-01-03', open: 104, high: 108, low: 103, close: 107 },
];

test('nextOpenReturn: enters at the NEXT session open, exits at close[idx+bars]', () => {
  // signal 2026-01-01 (idx 0) → entry = open[1] = 102; bars 2 → exit close[2] = 107.
  assert.equal(nextOpenReturn(NO_CANDLES, { date: '2026-01-01' }, 2), 4.9); // (107−102)/102
});

test('nextOpenReturn: shorts are sign-flipped', () => {
  assert.equal(nextOpenReturn(NO_CANDLES, { date: '2026-01-01', short: true }, 2), -4.9);
});

test('nextOpenReturn: null when there is no next bar or the horizon has not elapsed', () => {
  assert.equal(nextOpenReturn(NO_CANDLES, { date: '2026-01-03' }, 1), null); // no bar after idx
  assert.equal(nextOpenReturn(NO_CANDLES, { date: '2026-01-01' }, 5), null); // horizon unfilled
});

test('nextOpenReturn: falls back to next close when the open is missing', () => {
  const c = [
    { date: '2026-01-01', close: 100 },
    { date: '2026-01-02', close: 110 }, // no open → use close as entry
    { date: '2026-01-03', close: 121 },
  ];
  assert.equal(nextOpenReturn(c, { date: '2026-01-01' }, 2), 10); // (121−110)/110
});

test('summarizeReturns: realistic-entry avg + entry drag aggregate real/gap records', () => {
  const s = summarizeReturns([
    { ret: 5, mfe: 6, real: 4.2, gap: -0.8 },  // next-open entry gave back 0.8%
    { ret: 2, mfe: 3, real: 2.3, gap: 0.3 },   // gapped down overnight → entry helped
    { ret: -1, mfe: 1, real: -1.6, gap: -0.6 },
    { ret: 3, mfe: 4, entry: 50 },             // logged entry → no real/gap → excluded
  ]);
  assert.equal(s.realN, 3);
  assert.equal(s.avgReal, 1.63);       // (4.2 + 2.3 − 1.6) / 3
  assert.equal(s.realWinRate, 67);     // 2 of 3 positive
  assert.equal(s.avgEntryDrag, -0.37); // (−0.8 + 0.3 − 0.6) / 3
  assert.equal(s.entryModel, 'entry-v1');
});

test('summarizeReturns: realistic-entry fields null when no record carries them', () => {
  const s = summarizeReturns([{ ret: 5, mfe: 6, exc: 2 }]);
  assert.equal(s.realN, 0);
  assert.equal(s.avgReal, null);
  assert.equal(s.avgEntryDrag, null);
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
