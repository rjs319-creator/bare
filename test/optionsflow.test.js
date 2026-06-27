'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const of = require('../lib/optionsflow');
const { resolveAt, summarize } = require('../lib/optionsflow-routes');

const future = Math.floor(Date.now() / 1000) + 20 * 86400;  // ~20 days out

test('premiumUsd = volume × price × 100, with ask fallback', () => {
  assert.equal(of.premiumUsd({ volume: 1000, lastPrice: 2 }), 200000);
  assert.equal(of.premiumUsd({ volume: 500, lastPrice: null, ask: 1.5 }), 75000);
  assert.equal(of.premiumUsd({ volume: 0, lastPrice: 5 }), 0);
});

test('volOiRatio: ratio, or Infinity on zero OI with volume', () => {
  assert.equal(of.volOiRatio({ volume: 300, openInterest: 100 }), 3);
  assert.equal(of.volOiRatio({ volume: 50, openInterest: 0 }), Infinity);
  assert.equal(of.volOiRatio({ volume: 0, openInterest: 0 }), 0);
});

test('classify: block (huge premium) > sweep (high vol/OI) > large', () => {
  assert.equal(of.classify({ volume: 6000, lastPrice: 5, openInterest: 100 }), 'block'); // $3M
  assert.equal(of.classify({ volume: 1000, lastPrice: 1, openInterest: 100 }), 'sweep'); // $100k, vol/OI 10
  assert.equal(of.classify({ volume: 600, lastPrice: 1, openInterest: 1000 }), 'large'); // $60k, vol/OI 0.6
});

test('sentimentOf + moneyness', () => {
  assert.equal(of.sentimentOf('call'), 'bullish');
  assert.equal(of.sentimentOf('put'), 'bearish');
  assert.equal(of.moneyness({ strike: 110 }, 100, 'call'), 'OTM');
  assert.equal(of.moneyness({ strike: 90 }, 100, 'call'), 'ITM');
  assert.equal(of.moneyness({ strike: 100.5 }, 100, 'put'), 'ATM');
});

test('scoreSignal rewards bigger premium', () => {
  const big = of.scoreSignal({ premium: 1_000_000, volOi: 5, moneyness: 'OTM' });
  const small = of.scoreSignal({ premium: 60_000, volOi: 1, moneyness: 'ITM' });
  assert.ok(big > small);
});

function chain(underlying, calls, puts) {
  return { quote: { regularMarketPrice: underlying }, options: [{ calls, puts }] };
}

test('scanChain flags unusual contracts and filters small ones', () => {
  const result = chain(100, [
    { strike: 110, volume: 1000, openInterest: 100, lastPrice: 2, impliedVolatility: 0.5, expiration: future }, // $200k, vol/OI 10 → flagged
    { strike: 105, volume: 10, openInterest: 5000, lastPrice: 1, expiration: future },                          // $1k → filtered
  ], [
    { strike: 90, volume: 800, openInterest: 50, lastPrice: 3, impliedVolatility: 0.6, expiration: future },    // $240k put → flagged bearish
  ]);
  const sigs = of.scanChain('NVDA', result);
  assert.equal(sigs.length, 2);
  const call = sigs.find(s => s.side === 'call');
  assert.equal(call.sentiment, 'bullish');
  assert.equal(call.kind, 'sweep');
  assert.equal(call.moneyness, 'OTM');
  assert.equal(call.premium, 200000);
  assert.equal(sigs.find(s => s.side === 'put').sentiment, 'bearish');
});

test('scanChain requires NEW positioning (vol >= OI)', () => {
  // big premium but vol/OI 0.5 (legacy OI churn) → excluded
  const result = chain(100, [{ strike: 110, volume: 500, openInterest: 5000, lastPrice: 2, expiration: future }], []);
  assert.equal(of.scanChain('AAPL', result).length, 0);
});

test('scanOptionsFlow aggregates + sorts by score (mocked fetcher)', async () => {
  const fetchChain = async (t) => chain(100,
    [{ strike: 110, volume: t === 'NVDA' ? 5000 : 600, openInterest: 100, lastPrice: 3, expiration: future }], []);
  const sigs = await of.scanOptionsFlow(['NVDA', 'AAPL'], fetchChain, { cap: 10 });
  assert.equal(sigs.length, 2);
  assert.equal(sigs[0].ticker, 'NVDA');               // bigger premium ranks first
  assert.ok(sigs[0].score >= sigs[1].score);
});

test('flowOutcome: bullish wins on up move, bearish wins on down move', () => {
  assert.ok(of.flowOutcome(100, 110, 'bullish') > 0);
  assert.ok(of.flowOutcome(100, 110, 'bearish') < 0);
  assert.ok(of.flowOutcome(100, 90, 'bearish') > 0);
  assert.equal(of.flowOutcome(null, 110, 'bullish'), null);
});

test('resolveAt finds entry + forward close; null until horizon elapses', () => {
  const candles = [
    { date: '2026-06-01', close: 100 }, { date: '2026-06-02', close: 101 },
    { date: '2026-06-03', close: 105 }, { date: '2026-06-04', close: 110 },
  ];
  assert.ok(resolveAt(candles, '2026-06-01', 3, 'bullish') > 0);  // 100 → 110
  assert.equal(resolveAt(candles, '2026-06-01', 10, 'bullish'), null); // not enough bars
});

test('summarize computes win rate + avg return', () => {
  const s = summarize([0.05, -0.02, 0.03, -0.01]);
  assert.equal(s.n, 4);
  assert.equal(s.winRate, 50);
  assert.equal(s.avgReturnPct, 1.25);
  assert.deepEqual(summarize([]), { n: 0 });
});
