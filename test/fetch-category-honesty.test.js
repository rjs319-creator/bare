'use strict';
// CATEGORY HONESTY — a permanently dead ticker must be distinguishable from a bad night.
//
// Every failure below used to log `category: 'empty'`:
//   • HTTP 404 — the provider saying the symbol no longer exists (BK, post-rebrand)
//   • a 200 whose payload has no result object
//   • a 200 with real, CURRENT bars but fewer than the 60 the indicators need
//     (EA, GREE, GRTX, OLPX — newest bar 2026-08-18, i.e. live names)
//
// One label for all three is why 13 delisted biotechs sat in the universe being
// refetched nightly: nothing in the logs could say "this one is never coming back",
// and nothing could say "this one is fine, just young".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyStatus } = require('../lib/http');

// The 'no daily data' line specifically — not merely the last thing logged.
const noData = (logged) => logged.filter(e => e.msg === 'no daily data').at(-1);

const resp = (status) => ({ ok: status >= 200 && status < 300, status });

test('classifyStatus distinguishes a retired symbol from an empty result', () => {
  assert.equal(classifyStatus(resp(404)), 'not_found');
});

test('classifyStatus leaves the other categories untouched', () => {
  assert.equal(classifyStatus(resp(200)), 'ok');
  assert.equal(classifyStatus(resp(429)), 'rate_limited');
  assert.equal(classifyStatus(resp(401)), 'auth');
  assert.equal(classifyStatus(resp(403)), 'auth');
  assert.equal(classifyStatus(resp(503)), 'unavailable');
  assert.equal(classifyStatus(resp(418)), 'bad_response');
  assert.equal(classifyStatus(null), 'unavailable');
});

test('fetchDailyHistory labels a SHORT but current series as insufficient_history', async () => {
  // Arrange — 30 valid bars: below the 60-bar floor, but real and current.
  const bars = 30;
  const now = Math.floor(Date.parse('2026-08-18T20:00:00Z') / 1000);
  const body = { chart: { result: [{
    timestamp: Array.from({ length: bars }, (_, i) => now - (bars - i) * 86400),
    indicators: { quote: [{
      open: Array(bars).fill(10), high: Array(bars).fill(11),
      low: Array(bars).fill(9), close: Array(bars).fill(10), volume: Array(bars).fill(1000),
    }], adjclose: [{ adjclose: Array(bars).fill(10) }] },
    meta: {}, events: {},
  }] } };

  const logged = [];
  const { fetchDailyHistory } = freshScreener(async () => okJson(body), logged);

  // Act
  const out = await fetchDailyHistory('GREE', '1y');

  // Assert
  assert.equal(out, null, 'still dropped — 30 bars cannot feed the indicators');
  assert.equal(noData(logged).ctx.category, 'insufficient_history',
    'but the log must say WHY, so a young name is not mistaken for a dead one');
  assert.equal(noData(logged).ctx.bars, bars, 'and how short it actually was');
});

test('fetchDailyHistory labels a 404 as not_found so the universe can be pruned', async () => {
  const logged = [];
  const { fetchDailyHistory } = freshScreener(async () => ({ ok: false, status: 404, json: async () => ({}) }), logged);

  const out = await fetchDailyHistory('AKRO', '1y');

  assert.equal(out, null);
  assert.equal(noData(logged).ctx.category, 'not_found');
});

test('fetchDailyHistory labels a resultless 200 as empty (a genuine provider blank)', async () => {
  const logged = [];
  const { fetchDailyHistory } = freshScreener(async () => okJson({ chart: { result: null } }), logged);

  const out = await fetchDailyHistory('ZZZZ', '1y');

  assert.equal(out, null);
  assert.equal(noData(logged).ctx.category, 'empty');
});

test('a transient timeout still reads as timeout, not as a dead symbol', async () => {
  const logged = [];
  const { fetchDailyHistory } = freshScreener(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, logged);

  await fetchDailyHistory('AAPL', '1y');

  assert.equal(noData(logged).ctx.category, 'timeout');
});

// Load lib/screener.js with its fetch + logger stubbed, without touching global state.
function freshScreener(fetchImpl, logged) {
  const Module = require('node:module');
  const path = require('node:path');
  const httpPath = require.resolve('../lib/http');
  const logPath = require.resolve('../lib/log');
  const screenerPath = require.resolve('../lib/screener');

  const realHttp = require('../lib/http');
  const origLoad = Module._load;
  const origFallback = process.env.DAILY_FALLBACK;
  process.env.DAILY_FALLBACK = 'off';   // read at module load, below
  for (const p of [httpPath, logPath, screenerPath]) delete require.cache[p];

  Module._load = function (request, parent, isMain) {
    const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return null; } })();
    if (resolved === httpPath) {
      return { ...realHttp, fetchWithTimeout: fetchImpl };
    }
    if (resolved === logPath) {
      return { logWarn: (ctxName, msg, ctx) => logged.push({ ctxName, msg, ctx }), logInfo() {}, logError() {} };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return require('../lib/screener');
  } finally {
    Module._load = origLoad;
    if (origFallback === undefined) delete process.env.DAILY_FALLBACK;
    else process.env.DAILY_FALLBACK = origFallback;
    for (const p of [httpPath, logPath, screenerPath]) delete require.cache[p];
  }
}

function okJson(body) { return { ok: true, status: 200, json: async () => body }; }
