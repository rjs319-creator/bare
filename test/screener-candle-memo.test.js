'use strict';
// The daily-candle path (lib/screener fetchYahooDaily) through lib/http-memo.
//
// Pins: a settled series is fetched ONCE per ticker no matter how many chains ask (the
// op=swingsearchgrade ~2,800-fetch pattern), a series that does not reach the due
// session is served but never remembered, and the TTL policy follows the exchange clock
// (short while today's bar is still in flux, long once it has settled / on weekends).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resetHttpMemo, getHttpMemoStats } = require('../lib/http-memo');
const S = require('../lib/screener');

const MON_EVENING = new Date('2026-08-17T22:05:00Z');     // 18:05 ET Monday — the cron hour, bar settled
const TUE_REGULAR = new Date('2026-08-18T15:00:00Z');     // 11:00 ET Tuesday — bar in flux
const TUE_JUST_CLOSED = new Date('2026-08-18T20:30:00Z'); // 16:30 ET Tuesday — closed, not yet settled
const SAT = new Date('2026-08-22T16:00:00Z');             // Saturday

function yahooPayload(endDate, n) {
  const ts = [], open = [], high = [], low = [], close = [], volume = [];
  const end = Date.parse(endDate + 'T13:30:00Z');
  for (let i = n - 1; i >= 0; i--) {
    ts.push(Math.floor((end - i * 86400000) / 1000));
    open.push(10); high.push(11); low.push(9); close.push(10); volume.push(1000);
  }
  return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose: close }] }, meta: {} }] } };
}

// Stub the network: every Yahoo chart call is counted; Stooq is 404 (never needed here).
function withStubbedFetch(body, fn) {
  const real = global.fetch;
  const calls = { yahoo: 0, other: 0 };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('finance.yahoo.com')) {
      calls.yahoo++;
      return { ok: true, status: 200, text: async () => JSON.stringify(typeof body === 'function' ? body(calls.yahoo) : body) };
    }
    calls.other++;
    return { ok: false, status: 404, text: async () => '' };
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = real; });
}

test.beforeEach(() => resetHttpMemo());

test('a settled series is fetched once per ticker across many "chains" (concurrent + sequential)', async () => {
  const names = ['AAPL', 'MSFT', 'NVDA'];
  await withStubbedFetch(yahooPayload('2026-08-17', 90), async (calls) => {
    // 12 chains, each asking for the same 3 names — 6 concurrently, then 6 one after another.
    await Promise.all(Array.from({ length: 6 }, () => Promise.all(names.map(t => S.fetchDailyHistory(t, '2y', { now: MON_EVENING })))));
    for (let i = 0; i < 6; i++) for (const t of names) await S.fetchDailyHistory(t, '2y', { now: MON_EVENING });
    assert.equal(calls.yahoo, names.length, 'one network fetch per distinct ticker');
    const s = getHttpMemoStats();
    assert.equal(s.misses, names.length);
    assert.equal(s.inflightDedupes + s.hits, 12 * names.length - names.length);
  });
});

test('every caller gets a complete, independent series from the memo', async () => {
  await withStubbedFetch(yahooPayload('2026-08-17', 90), async () => {
    const a = await S.fetchDailyHistory('SPY', '1y', { now: MON_EVENING });
    a.candles.pop();   // a careless consumer mutating its copy
    const b = await S.fetchDailyHistory('SPY', '1y', { now: MON_EVENING });
    assert.equal(b.candles.length, 90, 'the cached body is re-parsed per hit, never shared');
    assert.equal(b.provider, 'yahoo');
    assert.equal(b.candles[b.candles.length - 1].date, '2026-08-17');
  });
});

test('a series BEHIND the due session is served but never remembered (backfill is picked up next call)', async () => {
  // Monday evening: Monday's bar is due. The provider is still missing it (the 2026-08-18
  // incident shape) on the first two calls and backfills on the third.
  const stale = yahooPayload('2026-08-14', 90), fixed = yahooPayload('2026-08-17', 90);
  await withStubbedFetch((n) => (n <= 2 ? stale : fixed), async (calls) => {
    const r1 = await S.fetchDailyHistory('SPY', '1y', { now: MON_EVENING });
    assert.equal(r1.candles[r1.candles.length - 1].date, '2026-08-14', 'stale series still served (fallback 404s here)');
    await S.fetchDailyHistory('SPY', '1y', { now: MON_EVENING });
    const r3 = await S.fetchDailyHistory('SPY', '1y', { now: MON_EVENING });
    assert.equal(calls.yahoo, 3, 'nothing was cached while the series was behind');
    assert.equal(r3.candles[r3.candles.length - 1].date, '2026-08-17', 'backfill picked up immediately');
    await S.fetchDailyHistory('SPY', '1y', { now: MON_EVENING });
    assert.equal(calls.yahoo, 3, 'the current series IS remembered');
  });
});

test('yahooChartCacheable: needs ≥60 bars and a last bar at/after the due session', () => {
  assert.equal(S.yahooChartCacheable(yahooPayload('2026-08-17', 90), '2026-08-17'), true);
  assert.equal(S.yahooChartCacheable(yahooPayload('2026-08-18', 90), '2026-08-17'), true, 'a partial bar past due is fine');
  assert.equal(S.yahooChartCacheable(yahooPayload('2026-08-14', 90), '2026-08-17'), false);
  assert.equal(S.yahooChartCacheable(yahooPayload('2026-08-17', 30), '2026-08-17'), false, 'short series');
  assert.equal(S.yahooChartCacheable({ chart: { result: null } }, '2026-08-17'), false);
  assert.equal(S.yahooChartCacheable(yahooPayload('2026-08-14', 90), null), true, 'no calendar → no staleness test possible');
});

test('candleMemoTtlMs follows the exchange clock', () => {
  assert.equal(S.candleMemoTtlMs(TUE_REGULAR), S.CANDLE_MEMO_TTL_OPEN_MS, 'regular session: bar in flux');
  assert.equal(S.candleMemoTtlMs(TUE_JUST_CLOSED), S.CANDLE_MEMO_TTL_OPEN_MS, 'closed but inside the settle window');
  assert.equal(S.candleMemoTtlMs(MON_EVENING), S.CANDLE_MEMO_TTL_SETTLED_MS, 'the 22:00 UTC burst sees a settled bar');
  assert.equal(S.candleMemoTtlMs(SAT), S.CANDLE_MEMO_TTL_SETTLED_MS, 'weekend');
  assert.ok(S.CANDLE_MEMO_TTL_OPEN_MS < S.CANDLE_MEMO_TTL_SETTLED_MS);
});

test('a non-ok Yahoo answer is not remembered: the next call tries the network again', async () => {
  const real = global.fetch;
  let n = 0;
  global.fetch = async () => { n++; return { ok: false, status: 429, text: async () => '' }; };
  try {
    assert.equal(await S.fetchDailyHistory('SPY', '1y', { now: MON_EVENING }), null);
    assert.equal(await S.fetchDailyHistory('SPY', '1y', { now: MON_EVENING }), null);
    // 2 hosts × 2 calls for Yahoo, plus the Stooq fallback attempt per call.
    assert.ok(n >= 4, `expected every attempt to reach the network, saw ${n}`);
    assert.equal(getHttpMemoStats().size, 0);
  } finally { global.fetch = real; }
});
