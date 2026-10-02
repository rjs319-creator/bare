'use strict';
// ARK holdings diff → trades → net per ticker → ADV-scaled CERN events. Pure module.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/ark-diff');

const h = (ticker, shares, price) => ({ ticker, cusip: 'x', company: ticker, shares, marketValue: shares * price, weight: 1 });
const snap = (fund, asOf, holdings) => ({ fund, asOf, holdings });

test('threshold constants are named and carry the registered values', () => {
  assert.equal(D.ADV_LOOKBACK_SESSIONS, 20);
  assert.equal(D.EVENT_MIN_PCT_OF_ADV, 0.10);
  assert.equal(D.EVENT_MAX_ADV_USD, 50_000_000);
  assert.equal(D.EVENT_TYPE_BUY, 'ARK_NET_BUY');
  assert.equal(D.EVENT_TYPE_SELL, 'ARK_NET_SELL');
});

test('diffFundHoldings: added / trimmed / new / exited positions, priced at the current (or last known) holding price', () => {
  const prev = snap('ARKK', '2026-09-30', [h('AAA', 1000, 10), h('BBB', 500, 20), h('CCC', 300, 5)]);
  const cur = snap('ARKK', '2026-10-01', [h('AAA', 1200, 11), h('BBB', 400, 19), h('DDD', 50, 100)]);
  const trades = D.diffFundHoldings(prev, cur);
  const by = Object.fromEntries(trades.map((t) => [t.ticker, t]));
  assert.deepEqual(by.AAA, { fund: 'ARKK', ticker: 'AAA', prevShares: 1000, curShares: 1200, deltaShares: 200, price: 11, deltaUsd: 2200, kind: 'added' });
  assert.deepEqual(by.BBB, { fund: 'ARKK', ticker: 'BBB', prevShares: 500, curShares: 400, deltaShares: -100, price: 19, deltaUsd: -1900, kind: 'trimmed' });
  assert.deepEqual(by.DDD, { fund: 'ARKK', ticker: 'DDD', prevShares: 0, curShares: 50, deltaShares: 50, price: 100, deltaUsd: 5000, kind: 'new' });
  // Exited: no current price exists, so the prior snapshot's implied price is used.
  assert.deepEqual(by.CCC, { fund: 'ARKK', ticker: 'CCC', prevShares: 300, curShares: 0, deltaShares: -300, price: 5, deltaUsd: -1500, kind: 'exited' });
  assert.equal(trades.length, 4, 'unchanged positions produce no trade');
});

test('diffFundHoldings: inputs are not mutated and duplicate ticker rows (dual listings) are summed before diffing', () => {
  const prev = snap('ARKK', '2026-09-30', [h('AAA', 100, 10), h('AAA', 50, 10)]);
  const cur = snap('ARKK', '2026-10-01', [h('AAA', 200, 10)]);
  const before = JSON.stringify([prev, cur]);
  const trades = D.diffFundHoldings(prev, cur);
  assert.equal(JSON.stringify([prev, cur]), before);
  assert.deepEqual(trades.map((t) => [t.ticker, t.deltaShares]), [['AAA', 50]]);
});

test('diffFundHoldings refuses mismatched funds or a non-advancing as-of date (a stale republish is not a trade)', () => {
  const a = snap('ARKK', '2026-10-01', [h('AAA', 1, 1)]);
  assert.throws(() => D.diffFundHoldings(snap('ARKW', '2026-09-30', []), a), /fund/i);
  assert.throws(() => D.diffFundHoldings(a, snap('ARKK', '2026-10-01', [h('AAA', 2, 1)])), /as-of/i);
  assert.throws(() => D.diffFundHoldings(snap('ARKK', '2026-10-02', []), a), /as-of/i);
});

test('netTradesByTicker: legs across funds net out, funds listed, sorted by |deltaUsd| desc', () => {
  const trades = [
    { fund: 'ARKK', ticker: 'AAA', deltaShares: 200, deltaUsd: 2200, price: 11 },
    { fund: 'ARKW', ticker: 'AAA', deltaShares: -50, deltaUsd: -550, price: 11 },
    { fund: 'ARKG', ticker: 'BBB', deltaShares: -1000, deltaUsd: -19000, price: 19 },
  ];
  const net = D.netTradesByTicker(trades);
  assert.deepEqual(net, [
    { ticker: 'BBB', deltaShares: -1000, deltaUsd: -19000, funds: ['ARKG'], legs: 1 },
    { ticker: 'AAA', deltaShares: 150, deltaUsd: 1650, funds: ['ARKK', 'ARKW'], legs: 2 },
  ]);
});

test('adv20Usd: trailing mean of close×volume over the lookback; null when history is short', () => {
  const bars = Array.from({ length: 25 }, (_, i) => ({ date: `d${i}`, close: 10, volume: 100_000 + i }));
  const adv = D.adv20Usd(bars);
  assert.ok(Math.abs(adv - 10 * (100_000 + (5 + 24) / 2)) < 1e-6);
  assert.equal(D.adv20Usd(bars.slice(0, 19)), null);
  assert.equal(D.adv20Usd(null), null);
});

test('withAdv: pctOfAdv20 = |deltaUsd| / adv; missing ADV stays null (never 0)', () => {
  const net = [{ ticker: 'AAA', deltaShares: 1, deltaUsd: 1_000_000, funds: ['ARKK'], legs: 1 }, { ticker: 'ZZZ', deltaShares: 1, deltaUsd: 500, funds: ['ARKK'], legs: 1 }];
  const out = D.withAdv(net, new Map([['AAA', 8_000_000]]));
  assert.equal(out[0].adv20Usd, 8_000_000);
  assert.equal(out[0].pctOfAdv20, 0.125);
  assert.equal(out[1].adv20Usd, null);
  assert.equal(out[1].pctOfAdv20, null);
  assert.equal(net[0].pctOfAdv20, undefined, 'input not mutated');
});

test('selectCernEvents: only |net| ≥ 10% of ADV in names under $50M ADV; buys → ARK_NET_BUY long (dir −1), sells → ARK_NET_SELL avoid (dir +1)', () => {
  const rows = [
    { ticker: 'BUY', deltaShares: 20_000, deltaUsd: 1_000_000, funds: ['ARKK'], legs: 1, adv20Usd: 8_000_000, pctOfAdv20: 0.125 },
    { ticker: 'SELL', deltaShares: -30_000, deltaUsd: -3_000_000, funds: ['ARKK', 'ARKW'], legs: 2, adv20Usd: 20_000_000, pctOfAdv20: 0.15 },
    { ticker: 'SMALL', deltaShares: 100, deltaUsd: 100_000, funds: ['ARKK'], legs: 1, adv20Usd: 8_000_000, pctOfAdv20: 0.0125 },
    { ticker: 'LIQUID', deltaShares: 1e6, deltaUsd: 60_000_000, funds: ['ARKK'], legs: 1, adv20Usd: 400_000_000, pctOfAdv20: 0.15 },
    { ticker: 'EXACT', deltaShares: 1, deltaUsd: 5_000_000, funds: ['ARKK'], legs: 1, adv20Usd: 50_000_000, pctOfAdv20: 0.10 },
    { ticker: 'NOADV', deltaShares: 1, deltaUsd: 5_000_000, funds: ['ARKK'], legs: 1, adv20Usd: null, pctOfAdv20: null },
  ];
  const evs = D.selectCernEvents(rows, { asOf: '2026-10-01', sessionDate: '2026-10-02' });
  assert.deepEqual(evs.map((e) => [e.symbol, e.type, e.direction]), [['BUY', 'ARK_NET_BUY', -1], ['SELL', 'ARK_NET_SELL', 1]]);
  const buy = evs[0];
  assert.equal(buy.dateMs, Date.parse('2026-10-01T00:00:00Z'), 'event stamped on the trade session');
  assert.equal(buy.sessionDate, '2026-10-02', 'decision session = the day the app read the file');
  assert.equal(buy.estFlowShares, 20_000);
  assert.deepEqual(buy.meta, { source: 'ark', asOf: '2026-10-01', funds: ['ARKK'], legs: 1, deltaShares: 20_000, deltaUsd: 1_000_000, adv20Usd: 8_000_000, pctOfAdv20: 0.125 });
  // ADV exactly at the ceiling is NOT thin (strict <); pct exactly at the floor qualifies (≥).
  assert.ok(!evs.some((e) => e.symbol === 'EXACT'));
  const edge = D.selectCernEvents([{ ...rows[4], adv20Usd: 49_999_999 }], { asOf: '2026-10-01', sessionDate: '2026-10-02' });
  assert.equal(edge.length, 1);
});
