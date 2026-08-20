'use strict';
// NON-EQUITY SYMBOLS SCANNED NIGHTLY.
//
// The 2026-08-19 cron logs show op=scoreboard and op=alertsgrade asking the provider's
// US-EQUITY chart endpoint for things that can never be there — crypto (BTC.X, PEPE.X,
// SUI.X), foreign listings (BB.TSX, TATAPOWER.NSE), futures (RTY_F). Each costs two host
// attempts, every night, and comes back as a `no daily data` warning indistinguishable
// from a real equity failure. They arrive from tracked alert/pick ledgers, not the static
// universe, so pruning lib/universe.js never touched them.
//
// The guard is deliberately STRUCTURAL, not a name blacklist:
//   • a dotted suffix is an exchange/asset-class marker (.X crypto, .TSX, .NSE) — US
//     equities use a HYPHEN for class shares (BRK-B), never a dot
//   • `_F` is the futures marker
// Forex pairs (USDJPY) and bare index names (VIX, SPX) are NOT filtered: they are not
// structurally distinguishable from a real ticker, and guessing would risk dropping a
// live equity. They stay visible in the logs instead.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSupportedEquitySymbol } = require('../lib/screener');

test('rejects the crypto, foreign-listing and futures symbols seen in the cron logs', () => {
  for (const sym of ['BTC.X', 'ETH.X', 'PEPE.X', 'SUI.X', 'TRUMP.X', 'DOGE.X',
                     'BB.TSX', 'T.TSX', 'TATAPOWER.NSE', 'MASTER.NSE', 'OPEAZZX.P', 'RTY_F']) {
    assert.equal(isSupportedEquitySymbol(sym), false, `${sym} should not reach the equity endpoint`);
  }
});

test('accepts ordinary US equity tickers, including class shares and ETFs', () => {
  for (const sym of ['AAPL', 'SPY', 'BRK-B', 'BRK.B'.replace('.', '-'), 'F', 'T', 'GOOGL', 'XLK', 'GTLS']) {
    assert.equal(isSupportedEquitySymbol(sym), true, `${sym} is a real equity/ETF symbol`);
  }
});

test('does NOT filter forex pairs or bare index names — not structurally distinguishable', () => {
  // Guarding against over-reach: a name blacklist could drop a live ticker.
  for (const sym of ['USDJPY', 'GBPUSD', 'VIX', 'SPX', 'TNX']) {
    assert.equal(isSupportedEquitySymbol(sym), true, `${sym} must not be filtered by structure alone`);
  }
});

test('is total on junk input rather than throwing inside the fetch path', () => {
  for (const bad of [null, undefined, '', '   ', 123, {}]) {
    assert.equal(isSupportedEquitySymbol(bad), false);
  }
});

test('an unsupported symbol never reaches the network and is labelled honestly', async () => {
  // Arrange
  let fetches = 0;
  const logged = [];
  const { fetchDailyHistory } = loadScreener(async () => { fetches++; throw new Error('should not fetch'); }, logged);

  // Act
  const out = await fetchDailyHistory('BTC.X', '1y');

  // Assert
  assert.equal(out, null);
  assert.equal(fetches, 0, 'the whole point is to not pay two host attempts for it');
  const warn = logged.filter(e => e.msg === 'no daily data').at(-1);
  assert.equal(warn.ctx.category, 'unsupported_symbol',
    'must be distinguishable from a real equity that failed');
});

test('a supported symbol still goes to the network as before', async () => {
  let fetches = 0;
  const { fetchDailyHistory } = loadScreener(async () => { fetches++; return { ok: false, status: 404, json: async () => ({}) }; }, []);
  await fetchDailyHistory('AAPL', '1y');
  assert.ok(fetches > 0, 'the guard must not swallow real tickers');
});

function loadScreener(fetchImpl, logged) {
  const Module = require('node:module');
  const httpPath = require.resolve('../lib/http');
  const logPath = require.resolve('../lib/log');
  const screenerPath = require.resolve('../lib/screener');
  const realHttp = require('../lib/http');
  const origLoad = Module._load;
  const origFallback = process.env.DAILY_FALLBACK;
  process.env.DAILY_FALLBACK = 'off';
  for (const p of [httpPath, logPath, screenerPath]) delete require.cache[p];
  Module._load = function (request, parent, isMain) {
    const resolved = (() => { try { return Module._resolveFilename(request, parent, isMain); } catch { return null; } })();
    if (resolved === httpPath) return { ...realHttp, fetchWithTimeout: fetchImpl };
    if (resolved === logPath) return { logWarn: (ctxName, msg, ctx) => logged.push({ ctxName, msg, ctx }), logInfo() {}, logError() {} };
    return origLoad.apply(this, arguments);
  };
  try { return require('../lib/screener'); }
  finally {
    Module._load = origLoad;
    if (origFallback === undefined) delete process.env.DAILY_FALLBACK; else process.env.DAILY_FALLBACK = origFallback;
    for (const p of [httpPath, logPath, screenerPath]) delete require.cache[p];
  }
}
