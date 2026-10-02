'use strict';
// lib/cboe-chain — OCC symbol parser, payload normalization (Yahoo shape + vendor greeks),
// field validation at the boundary, symbol mapping, TTL by session, memoized fetch.
// Fixture: a real 2026-10-01 XLU response trimmed to two expiries within ±10% of spot.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/cboe-chain');
const { createHttpMemo } = require('../lib/http-memo');
const FIXTURE = require('./fixtures/cboe-xlu-trimmed.json');

const NOW = Date.UTC(2026, 9, 1, 15);   // Thu 2026-10-01 11:00 ET — regular session
const bigMemo = () => createHttpMemo({ maxItemBytes: 16 * 1024 * 1024 });
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

test('parseOccSymbol: root / YYMMDD / C|P / strike×1000, including weeklies and fractional strikes', () => {
  assert.deepEqual(C.parseOccSymbol('XLU261002C00025000'), { root: 'XLU', expiry: '2026-10-02', expirationSec: Date.UTC(2026, 9, 2) / 1000, type: 'call', strike: 25 });
  assert.deepEqual(C.parseOccSymbol('SPXW270930P09800000'), { root: 'SPXW', expiry: '2027-09-30', expirationSec: Date.UTC(2027, 8, 30) / 1000, type: 'put', strike: 9800 });
  assert.equal(C.parseOccSymbol('AAPL261219C00182500').strike, 182.5);
});

test('parseOccSymbol: malformed symbols and impossible dates are rejected (null), never guessed', () => {
  for (const bad of ['', null, 'xlu261002c00025000', 'XLU2610A2C00025000', 'XLU261002X00025000', 'XLU261332C00025000', 'XLU260230C00025000', 'XLU261002C00000000', 'TOOLONGROOT261002C00025000']) {
    assert.equal(C.parseOccSymbol(bad), null, `should reject ${bad}`);
  }
});

test('cboeSymbolFor / cboeUrlFor: indexes take the underscore prefix; malformed tickers are refused', () => {
  assert.equal(C.cboeSymbolFor('spx'), '_SPX'); assert.equal(C.cboeSymbolFor('^VIX'), '_VIX'); assert.equal(C.cboeSymbolFor('_SPX'), '_SPX');
  assert.equal(C.cboeSymbolFor('aapl'), 'AAPL'); assert.equal(C.cboeSymbolFor('BRK.B'), 'BRK.B');
  assert.equal(C.cboeSymbolFor('bad ticker!'), null); assert.equal(C.cboeSymbolFor(''), null);
  assert.equal(C.cboeUrlFor('SPX'), 'https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json');
  assert.equal(C.cboeUrlFor('??'), null);
});

test('etWallToEpochSec: CBOE ET wall-clock → UTC seconds across DST', () => {
  assert.equal(C.etWallToEpochSec('2026-10-01T15:59:59'), Date.UTC(2026, 9, 1, 19, 59, 59) / 1000, 'EDT = UTC-4');
  assert.equal(C.etWallToEpochSec('2026-01-15T16:00:00'), Date.UTC(2026, 0, 15, 21, 0, 0) / 1000, 'EST = UTC-5');
  assert.equal(C.etWallToEpochSec(null), null); assert.equal(C.etWallToEpochSec('garbage'), null);
});

test('normalizeCboeChain: real XLU payload → Yahoo-shaped result with vendor greeks on every contract', () => {
  const r = C.normalizeCboeChain(FIXTURE, { fetchedAt: NOW });
  assert.equal(r.source, 'cboe-delayed'); assert.equal(r.provider, 'cboe'); assert.equal(r.greeksSource, 'vendor'); assert.equal(r.chainComplete, true);
  assert.equal(r.underlyingSymbol, 'XLU');
  assert.equal(r.quote.regularMarketPrice, 39.68); assert.equal(r.quote.exchangeDataDelayedBy, 15); assert.equal(r.quote.quoteType, 'EQUITY');
  assert.equal(r.quote.regularMarketTime, Date.UTC(2026, 9, 1, 19, 59, 59) / 1000);
  assert.equal(r.options.length, 2);
  assert.deepEqual(r.expirationDates, r.options.map((ch) => ch.expirationDate));
  assert.ok(r.expirationDates[0] < r.expirationDates[1], 'expiries ascending');
  assert.equal(r.diagnostics.contracts, 60); assert.equal(r.diagnostics.rejected, 0); assert.equal(r.diagnostics.expiries, 2);
  const all = r.options.flatMap((ch) => [...ch.calls, ...ch.puts]);
  assert.equal(all.length, 60);
  for (const c of all) {
    assert.match(c.contractSymbol, /^XLU\d{6}[CP]\d{8}$/);
    for (const k of ['strike', 'expiration', 'openInterest', 'volume', 'impliedVolatility', 'delta', 'gamma', 'vega', 'theta', 'rho']) assert.equal(typeof c[k], 'number', `${c.contractSymbol}.${k}`);
    assert.equal(c.greeksSource, 'vendor');
    assert.equal(typeof c.inTheMoney, 'boolean');
  }
  const call = r.options[0].calls.find((c) => c.strike === 39);
  assert.ok(call.delta > 0.5 && call.inTheMoney === true, 'ITM call delta > 0.5');
  const put = r.options[0].puts.find((c) => c.strike === 39);
  assert.ok(put.delta < 0 && put.inTheMoney === false);
  assert.ok(r.options[0].calls.every((c, i, a) => i === 0 || a[i - 1].strike <= c.strike), 'strikes sorted');
});

test('normalizeCboeChain: non-numeric vendor fields become null (volume/OI → 0); bad symbols are counted as rejected', () => {
  const good = FIXTURE.data.options[0];
  const payload = {
    timestamp: 'x', symbol: 'XLU',
    data: { ...FIXTURE.data, options: [
      { ...good, bid: 'n/a', iv: null, delta: undefined, open_interest: 'many', volume: -3 },
      { ...good, option: 'BROKEN' },
      { option: 42 },
    ] },
  };
  const r = C.normalizeCboeChain(payload, { fetchedAt: NOW });
  assert.equal(r.diagnostics.rejected, 2); assert.equal(r.diagnostics.contracts, 1);
  const c = [...r.options[0].calls, ...r.options[0].puts][0];
  assert.equal(c.bid, null); assert.equal(c.impliedVolatility, null); assert.equal(c.delta, null);
  assert.equal(c.openInterest, 0); assert.equal(c.volume, 0);
  assert.equal(typeof c.gamma, 'number', 'untouched numeric fields survive');
});

test('normalizeCboeChain: no options array, no price, or only malformed rows → null', () => {
  assert.equal(C.normalizeCboeChain({ data: {} }), null);
  assert.equal(C.normalizeCboeChain({ data: { ...FIXTURE.data, current_price: null } }), null);
  assert.equal(C.normalizeCboeChain({ data: { ...FIXTURE.data, options: [{ option: 'nope' }] } }), null);
  assert.equal(C.normalizeCboeChain(null), null);
});

test('chainTtlMs: ~10 min while a session is open, 6 h when the market is closed', () => {
  assert.equal(C.chainTtlMs(new Date(NOW)), C.TTL_OPEN_MS);
  assert.equal(C.chainTtlMs(new Date(Date.UTC(2026, 9, 3, 12))), C.TTL_CLOSED_MS, 'Saturday');
  assert.equal(C.chainTtlMs(new Date(Date.UTC(2026, 9, 1, 3))), C.TTL_CLOSED_MS, 'overnight');
});

test('fetchCboeChain: maps the ticker to the CBOE URL, memoizes the body (one fetch for two calls), normalizes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonResponse(200, FIXTURE); };
  const memo = bigMemo();
  const a = await C.fetchCboeChain('xlu', { nowMs: NOW, fetchImpl, memo });
  const b = await C.fetchCboeChain('XLU', { nowMs: NOW, fetchImpl, memo });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cdn.cboe.com/api/global/delayed_quotes/options/XLU.json');
  assert.equal(calls[0].init.timeoutMs, C.FETCH_TIMEOUT_MS);
  assert.equal(a.options.length, 2); assert.equal(b.quote.regularMarketPrice, 39.68);
  await C.fetchCboeChain('SPX', { nowMs: NOW, fetchImpl, memo });
  assert.ok(calls[1].url.endsWith('/_SPX.json'));
});

test('fetchCboeChain: 403 (unknown symbol), empty body and malformed ticker → null; a network throw propagates', async () => {
  const memo = bigMemo();
  assert.equal(await C.fetchCboeChain('ZZZZNOPE', { nowMs: NOW, memo, fetchImpl: async () => jsonResponse(403, {}) }), null);
  assert.equal(await C.fetchCboeChain('XLU', { nowMs: NOW, memo, fetchImpl: async () => jsonResponse(200, { data: { options: [] } }) }), null);
  assert.equal(await C.fetchCboeChain('bad ticker', { nowMs: NOW, memo, fetchImpl: async () => { throw new Error('must not be called'); } }), null);
  await assert.rejects(C.fetchCboeChain('XLU', { nowMs: NOW, memo: bigMemo(), fetchImpl: async () => { throw new Error('ECONNRESET'); } }), /ECONNRESET/);
});
