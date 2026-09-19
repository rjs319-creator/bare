'use strict';
// op=orbitresolve fetch discipline — pins the 2026-09-18 nightly failure.
//
// The resolver fetched a ticker's 2y history once PER OPEN PREDICTION: with ~60 names
// and a 63-session horizon that was thousands of sequential fetches a night (AVB alone
// refetched every ~2s for the whole run on 09-17 and 09-18), and on 09-18 the invocation
// died at 63s with resolved.json unwritten — the map was written only at the end, so a
// killed run lost the entire night and the backlog only grew. These tests pin: one fetch
// per ticker (misses included), a checkpoint that keeps progress when the budget runs
// out, and that the input map is never mutated.
const test = require('node:test');
const assert = require('node:assert');
const { resolveOpenPredictions, memoHistory } = require('../lib/orbit-routes');

function mkCandles(n, driftPct) {
  const out = [];
  let close = 100;
  const d0 = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    close = close * (1 + driftPct);
    const date = new Date(d0.getTime() + i * 86400e3).toISOString().slice(0, 10);
    out.push({ date, open: close, high: close * 1.004, low: close * 0.996, close, volume: 1e6 });
  }
  return out;
}

const CANDLES = mkCandles(400, 0.001);
const MARKET = mkCandles(400, 0);
const DATES = [CANDLES[100].date, CANDLES[120].date, CANDLES[140].date];

function feed(calls) {
  return async (ticker, range) => {
    calls.push(`${ticker}|${range}`);
    if (ticker === 'NODATA') return null;
    if (ticker === 'BOOM') throw new Error('provider down');
    return { candles: ticker === 'SPY' || ticker === 'IWM' || ticker === '^VIX' ? MARKET : CANDLES };
  };
}

function days(tickers) {
  return DATES.map((decisionTs) => ({
    date: decisionTs,
    predictions: tickers.map((ticker) => ({ ticker, decisionTs, classification: 'WATCH', horizonProbabilities: null, exposures: { market: 1 } })),
  }));
}

test('each ticker is fetched exactly once per run, however many predictions are open', async () => {
  // Arrange
  const calls = [];
  // Act
  const r = await resolveOpenPredictions({ days: days(['AAA', 'BBB']), resolved: {}, fetchHistory: feed(calls), today: '2026-09-18' });
  // Assert
  const perTicker = (t) => calls.filter((c) => c.startsWith(`${t}|`)).length;
  assert.equal(perTicker('AAA'), 1, 'three open AAA predictions must cost one fetch');
  assert.equal(perTicker('BBB'), 1);
  assert.equal(r.newlyResolved, 6, 'every prediction still resolves');
  assert.equal(r.stats.tickers, 2);
  assert.equal(r.stats.fetches, 2 + 3, 'two names + SPY/IWM/^VIX');
  assert.equal(r.truncated, false);
  for (const d of DATES) assert.ok(r.resolved[`AAA:${d}`].done, `AAA:${d} fully resolved`);
});

test('a dataless or failing name is fetched once, not once per prediction, and resolves nothing', async () => {
  const calls = [];
  const r = await resolveOpenPredictions({ days: days(['NODATA', 'BOOM', 'AAA']), resolved: {}, fetchHistory: feed(calls), today: '2026-09-18' });
  assert.equal(calls.filter((c) => c.startsWith('NODATA|')).length, 1, 'the AVB storm: a miss must be cached');
  assert.equal(calls.filter((c) => c.startsWith('BOOM|')).length, 1, 'a throwing provider is a cached miss too');
  assert.equal(r.stats.misses, 2);
  assert.equal(r.newlyResolved, 3, 'only AAA resolves');
  assert.equal(Object.keys(r.resolved).length, 3);
});

test('already-done predictions are skipped without a fetch', async () => {
  const calls = [];
  const done = {};
  for (const d of DATES) done[`AAA:${d}`] = { done: true, probs: null, horizons: { days5: { resolved: true, positiveResidual: 1 } } };
  const r = await resolveOpenPredictions({ days: days(['AAA', 'BBB']), resolved: done, fetchHistory: feed(calls), today: '2026-09-18' });
  assert.equal(calls.filter((c) => c.startsWith('AAA|')).length, 0, 'nothing open for AAA — no fetch');
  assert.equal(r.stats.openPredictions, 3);
  assert.equal(r.newlyResolved, 3);
});

test('when the budget runs out the run checkpoints its progress instead of losing it', async () => {
  // Clock: 0 at start, 0 for the first ticker's gate, then past the budget.
  const ticks = [0, 0, 1000, 1000, 1000, 1000];
  const now = () => (ticks.length > 1 ? ticks.shift() : ticks[0]);
  const calls = [];
  const input = {};
  const r = await resolveOpenPredictions({ days: days(['AAA', 'BBB']), resolved: input, fetchHistory: feed(calls), today: '2026-09-18', now, budgetMs: 500 });
  assert.equal(r.truncated, true);
  assert.equal(r.stats.tickersDone, 1, 'one ticker landed before the budget gate closed');
  assert.equal(r.newlyResolved, 3, 'its three predictions are in the map to be written');
  assert.equal(calls.filter((c) => c.startsWith('BBB|')).length, 0, 'the second ticker was never started');
  assert.deepStrictEqual(input, {}, 'the input map is never mutated — the caller writes the returned one');
});

test('memoHistory shares in-flight fetches and never rejects', async () => {
  let n = 0;
  const { fetchOnce, stats } = memoHistory(async (t) => { n++; if (t === 'X') throw new Error('nope'); return { candles: [1] }; });
  const [a, b] = await Promise.all([fetchOnce('AAA', '2y'), fetchOnce('AAA', '2y')]);
  assert.strictEqual(a, b);
  assert.equal(n, 1, 'concurrent callers share one fetch');
  assert.equal(await fetchOnce('X', '2y'), null);
  assert.equal(await fetchOnce('X', '2y'), null);
  assert.deepStrictEqual(stats, { fetches: 2, misses: 1 });
});
