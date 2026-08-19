// A LAGGING PRIMARY MUST NOT STALL THE APP (2026-08-18).
// The primary daily feed had no 2026-08-17 bar for SPY or ~512 of 514 large caps, so
// every scan anchored itself to 2026-08-14 and the app published a four-day-old
// cross-section. These tests execute the REAL fetchDailyHistory path with the network
// stubbed — the repo's own lesson is that node --check and pure-helper tests both miss
// bugs that only appear when the path actually runs.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseStooqCsv } = require('../lib/daily-fallback');
const { sessionDue } = require('../lib/market-session');

const TUE_PREMARKET = new Date('2026-08-18T13:22:00Z');   // 09:22 ET Tuesday

// ── Session-due arithmetic ─────────────────────────────────────────────────
test('sessionDue asks for the session a feed should already have published', () => {
  assert.strictEqual(sessionDue(TUE_PREMARKET), '2026-08-17');
  // Minutes after Monday's bell the day's bar is not yet owed — that is not staleness.
  assert.strictEqual(sessionDue(new Date('2026-08-17T20:05:00Z')), '2026-08-14');
  // By the nightly cron it very much is.
  assert.strictEqual(sessionDue(new Date('2026-08-17T22:00:00Z')), '2026-08-17');
});

// ── CSV parsing ────────────────────────────────────────────────────────────
test('parseStooqCsv reads a daily series and never fabricates an adjusted close', () => {
  const csv = ['Date,Open,High,Low,Close,Volume',
    '2026-08-13,770,772,769,772.49,1000',
    '2026-08-14,772,778,771,777.88,1200',
    '2026-08-17,777,778,775,776.34,1100'].join('\n');
  const rows = parseStooqCsv(csv);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[2].date, '2026-08-17');
  assert.strictEqual(rows[2].close, 776.34);
  assert.strictEqual(rows[2].adjClose, null, 'the feed supplies no adjusted leg — stays null');
});

test('parseStooqCsv drops malformed rows instead of emitting NaN bars', () => {
  const csv = ['Date,Open,High,Low,Close,Volume',
    '2026-08-13,770,772,769,772.49,1000',
    'N/D,N/D,N/D,N/D,N/D,N/D',
    '2026-08-14,772,778,771,0,1200',
    'garbage'].join('\n');
  const rows = parseStooqCsv(csv);
  assert.deepStrictEqual(rows.map(r => r.date), ['2026-08-13'], 'zero close and junk rows rejected');
});

// ── The real fetchDailyHistory path, network stubbed ───────────────────────
function seriesCsv(endDate, n) {
  const out = ['Date,Open,High,Low,Close,Volume'];
  const end = Date.parse(endDate + 'T00:00:00Z');
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end - i * 86400000).toISOString().slice(0, 10);
    out.push(`${d},10,11,9,10,1000`);
  }
  return out.join('\n');
}
function yahooPayload(endDate, n) {
  const ts = [], open = [], high = [], low = [], close = [], volume = [];
  const end = Date.parse(endDate + 'T13:30:00Z');
  for (let i = n - 1; i >= 0; i--) {
    ts.push(Math.floor((end - i * 86400000) / 1000));
    open.push(10); high.push(11); low.push(9); close.push(10); volume.push(1000);
  }
  return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose: close }] }, meta: {} }] } };
}

// Route stubbed responses by host so the test exercises the real branching.
function withStubbedFetch(routes, fn) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [needle, make] of routes) {
      if (u.includes(needle)) return make();
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = real; });
}
const jsonRes = (body) => () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const textRes = (body) => () => ({ ok: true, status: 200, text: async () => body, json: async () => ({}) });

test('primary already current → fallback provider is never contacted', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  await withStubbedFetch([['finance.yahoo.com', jsonRes(yahooPayload('2026-08-17', 90))]], async (calls) => {
    const d = await fetchDailyHistory('SPY', '1y', { now: TUE_PREMARKET });
    assert.strictEqual(d.provider, 'yahoo');
    assert.strictEqual(d.candles[d.candles.length - 1].date, '2026-08-17');
    assert.ok(!calls.some(u => u.includes('stooq')), 'no fallback request on the healthy path');
  });
});

test('primary behind the calendar → fallback series is used whole, with its own provenance', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  await withStubbedFetch([
    ['finance.yahoo.com', jsonRes(yahooPayload('2026-08-14', 90))],   // missing Monday — the incident
    ['stooq.com', textRes(seriesCsv('2026-08-17', 90))],
  ], async () => {
    const d = await fetchDailyHistory('SPY', '1y', { now: TUE_PREMARKET });
    assert.strictEqual(d.provider, 'stooq');
    assert.strictEqual(d.candles[d.candles.length - 1].date, '2026-08-17', 'gap resolved');
    assert.strictEqual(d.priceBasis, 'stooq-adjusted');
    assert.strictEqual(d.adjustment, 'unknown', 'the fallback never claims an adjustment it cannot attest');
    // NEVER a splice: every bar comes from the one provider.
    assert.ok(d.candles.every(c => c.adjClose === null), 'no foreign tail stitched onto a primary series');
  });
});

test('fallback equally behind → primary is kept (its adjClose leg is not thrown away)', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  await withStubbedFetch([
    ['finance.yahoo.com', jsonRes(yahooPayload('2026-08-14', 90))],
    ['stooq.com', textRes(seriesCsv('2026-08-14', 90))],
  ], async () => {
    const d = await fetchDailyHistory('SPY', '1y', { now: TUE_PREMARKET });
    assert.strictEqual(d.provider, 'yahoo', 'a fallback that resolves nothing is not preferred');
    assert.ok(d.candles.every(c => c.adjClose != null));
  });
});

test('primary down entirely → fallback still yields a usable series', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  await withStubbedFetch([['stooq.com', textRes(seriesCsv('2026-08-17', 90))]], async () => {
    const d = await fetchDailyHistory('SPY', '1y', { now: TUE_PREMARKET });
    assert.strictEqual(d.provider, 'stooq');
    assert.strictEqual(d.candles.length, 90);
  });
});

test('both providers unusable → null, never a partial or fabricated series', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  await withStubbedFetch([['stooq.com', textRes(seriesCsv('2026-08-17', 10))]], async () => {
    // 10 bars is under the 60-bar minimum both legs enforce.
    const d = await fetchDailyHistory('SPY', '1y', { now: TUE_PREMARKET });
    assert.strictEqual(d, null);
  });
});

test('DAILY_FALLBACK=off restores single-provider behaviour exactly', async () => {
  const prev = process.env.DAILY_FALLBACK;
  process.env.DAILY_FALLBACK = 'off';
  delete require.cache[require.resolve('../lib/screener')];
  try {
    const { fetchDailyHistory } = require('../lib/screener');
    await withStubbedFetch([
      ['finance.yahoo.com', jsonRes(yahooPayload('2026-08-14', 90))],
      ['stooq.com', textRes(seriesCsv('2026-08-17', 90))],
    ], async (calls) => {
      const d = await fetchDailyHistory('SPY', '1y', { now: TUE_PREMARKET });
      assert.strictEqual(d.provider, 'yahoo');
      assert.ok(!calls.some(u => u.includes('stooq')), 'kill switch means no second request');
    });
  } finally {
    if (prev === undefined) delete process.env.DAILY_FALLBACK; else process.env.DAILY_FALLBACK = prev;
    delete require.cache[require.resolve('../lib/screener')];
  }
});

// ── Circuit breaker ────────────────────────────────────────────────────────
// The trigger is market-wide, so a scan asks ~515 times. A fallback that is itself down
// must not convert a stale-data problem into a timeout problem and blow the cron budget.
test('the breaker opens after repeated failures and stops calling the fallback', async () => {
  const { fetchStooqDaily, _resetBreaker, FAILURE_LIMIT } = require('../lib/daily-fallback');
  _resetBreaker();
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 429, text: async () => '' }; };
  try {
    for (let i = 0; i < FAILURE_LIMIT; i++) await fetchStooqDaily('SPY');
    assert.strictEqual(calls, FAILURE_LIMIT, 'every attempt made until the limit');
    // Breaker now open: further calls short-circuit without touching the network.
    for (let i = 0; i < 20; i++) assert.strictEqual(await fetchStooqDaily('SPY'), null);
    assert.strictEqual(calls, FAILURE_LIMIT, 'no further requests while the breaker is open');
  } finally { global.fetch = real; _resetBreaker(); }
});

test('the breaker reopens for business after the cooldown', async () => {
  const { fetchStooqDaily, _resetBreaker, FAILURE_LIMIT } = require('../lib/daily-fallback');
  _resetBreaker();
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 500, text: async () => '' }; };
  try {
    const t0 = 1_000_000;
    for (let i = 0; i < FAILURE_LIMIT; i++) await fetchStooqDaily('SPY', { now: t0 });
    assert.strictEqual(await fetchStooqDaily('SPY', { now: t0 + 1000 }), null, 'open');
    assert.strictEqual(calls, FAILURE_LIMIT);
    await fetchStooqDaily('SPY', { now: t0 + 6 * 60 * 1000 });   // past the 5-min cooldown
    assert.strictEqual(calls, FAILURE_LIMIT + 1, 'tries again once the cooldown lapses');
  } finally { global.fetch = real; _resetBreaker(); }
});

test('a success resets the failure count so transient blips never open the breaker', async () => {
  const { fetchStooqDaily, _resetBreaker, FAILURE_LIMIT } = require('../lib/daily-fallback');
  _resetBreaker();
  const real = global.fetch;
  let calls = 0;
  const good = seriesCsv('2026-08-17', 90);
  global.fetch = async () => {
    calls++;
    // Fail just under the limit, then succeed, repeatedly.
    return (calls % FAILURE_LIMIT === 0)
      ? { ok: true, status: 200, text: async () => good }
      : { ok: false, status: 500, text: async () => '' };
  };
  try {
    for (let i = 0; i < FAILURE_LIMIT * 4; i++) await fetchStooqDaily('SPY');
    assert.strictEqual(calls, FAILURE_LIMIT * 4, 'breaker never opened — every call reached the network');
  } finally { global.fetch = real; _resetBreaker(); }
});

// ── A HOLE IN THE SERIES MUST TRIGGER THE FALLBACK ─────────────────────────
// Once the market opened on 2026-08-18 the SPY axis read ...08-13, 08-14, 08-18: Monday
// absent, today's partial bar present. A newest-bar test sees 08-18 >= the due 08-17 and
// concludes the feed is current — so the fallback never fires and every ranking keeps
// running on Friday. Only the last SETTLED bar distinguishes the two.
function yahooFromDates(dates) {
  const ts = [], open = [], high = [], low = [], close = [], volume = [];
  for (const d of dates) {
    ts.push(Math.floor(Date.parse(d + 'T13:30:00Z') / 1000));
    open.push(10); high.push(11); low.push(9); close.push(10); volume.push(1000);
  }
  return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose: close }] }, meta: {} }] } };
}
function tradingDates(endDate, n) {
  const out = [];
  let t = Date.parse(endDate + 'T00:00:00Z');
  while (out.length < n) {
    const d = new Date(t);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(d.toISOString().slice(0, 10));
    t -= 86400000;
  }
  return out;
}
const TUE_OPEN = new Date('2026-08-18T15:36:00Z');   // 11:36 ET, regular session; due = 08-17

test('a missing due session triggers the fallback even when today\'s bar is present', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  const { _resetBreaker } = require('../lib/daily-fallback');
  _resetBreaker();
  const holed = [...tradingDates('2026-08-14', 90), '2026-08-18'];
  await withStubbedFetch([
    ['finance.yahoo.com', jsonRes(yahooFromDates(holed))],
    ['stooq.com', textRes(seriesCsv('2026-08-17', 90))],
  ], async (calls) => {
    const d = await fetchDailyHistory('SPY', '1y', { now: TUE_OPEN });
    assert.ok(calls.some(u => u.includes('stooq')), 'the hole must be noticed, not hidden by the partial bar');
    assert.strictEqual(d.provider, 'stooq');
    assert.ok(d.candles.some(c => c.date === '2026-08-17'), 'the due session is now present');
  });
});

test('a series that REACHES the due session never calls the fallback', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  const { _resetBreaker } = require('../lib/daily-fallback');
  _resetBreaker();
  const complete = [...tradingDates('2026-08-17', 90), '2026-08-18'];
  await withStubbedFetch([['finance.yahoo.com', jsonRes(yahooFromDates(complete))]], async (calls) => {
    const d = await fetchDailyHistory('SPY', '1y', { now: TUE_OPEN });
    assert.strictEqual(d.provider, 'yahoo');
    assert.ok(!calls.some(u => u.includes('stooq')), 'no cost on the healthy path');
  });
});

test('a fallback that is ALSO missing the due session is not preferred', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  const { _resetBreaker } = require('../lib/daily-fallback');
  _resetBreaker();
  const holed = [...tradingDates('2026-08-14', 90), '2026-08-18'];
  await withStubbedFetch([
    ['finance.yahoo.com', jsonRes(yahooFromDates(holed))],
    ['stooq.com', textRes(seriesCsv('2026-08-14', 90))],
  ], async () => {
    const d = await fetchDailyHistory('SPY', '1y', { now: TUE_OPEN });
    assert.strictEqual(d.provider, 'yahoo', 'keeps the primary and its adjClose leg');
  });
});

// ── THE INTERACTION THAT CAUSED THE REVERT ─────────────────────────────────
// This is the test that did not exist the first time. Recovering the benchmark's missing
// bar advances the decision session ahead of the constituents, which sit on the nightly
// candle cache — and the gate then excluded all 514 of them as `prior-session`, leaving
// the screener with ONE result. The fallback is only safe to re-land because the gate now
// resolves the session the COHORT can support. Pin the two together: if either side
// regresses, this fails.
const { gateCohort } = require('../lib/cohort-freshness');

test('a fallback-recovered benchmark running ahead of a stale cache does NOT empty the scan', async () => {
  delete require.cache[require.resolve('../lib/screener')];
  const { fetchDailyHistory } = require('../lib/screener');
  const { _resetBreaker } = require('../lib/daily-fallback');
  _resetBreaker();

  // 1. The benchmark recovers its missing 08-17 bar through the fallback.
  const holed = [...tradingDates('2026-08-14', 90), '2026-08-18'];
  let spy;
  await withStubbedFetch([
    ['finance.yahoo.com', jsonRes(yahooFromDates(holed))],
    ['stooq.com', textRes(seriesCsv('2026-08-17', 90))],
  ], async () => { spy = await fetchDailyHistory('SPY', '1y', { now: TUE_OPEN }); });
  assert.strictEqual(spy.provider, 'stooq');
  assert.ok(spy.candles.some(c => c.date === '2026-08-17'), 'benchmark advanced to the due session');

  // 2. The constituents are still on the nightly cache, a session behind.
  const rows = Array.from({ length: 514 }, (_, i) => ({ ticker: 'T' + i, lastBarDate: '2026-08-14' }));
  const gate = gateCohort(rows, { benchmarkDates: spy.candles.map(c => c.date), now: TUE_OPEN });

  // 3. The scan must survive. Before the gate fix this admitted 0 and the screener
  //    returned a single result on prod.
  assert.strictEqual(gate.admitted.length, 514, 'the cross-section survives a benchmark that ran ahead');
  assert.strictEqual(gate.decisionSession, '2026-08-14', 'dated at the session the rows support');
  assert.strictEqual(gate.sessionSource, 'cohort-supported');
  assert.strictEqual(gate.benchmarkStale, true, 'and still honestly reported as behind');
});
