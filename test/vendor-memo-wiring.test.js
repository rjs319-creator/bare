'use strict';
// The vendor helpers routed through lib/http-memo: SEC EDGAR submissions (one fetch
// serves Form 4 and offering-filing readers), Finnhub fundamentals, and the opt-in
// fmpRequest memo (default OFF; the key never carries the apikey; non-ok never cached).
process.env.FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'test-fh';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resetHttpMemo, getHttpMemoStats } = require('../lib/http-memo');

test.beforeEach(() => resetHttpMemo());

function stubGlobalFetch(router) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url) => { calls.push(String(url)); return router(String(url), calls.length); };
  return { calls, restore: () => { global.fetch = real; } };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

test('EDGAR: Form 4 list and offering filings for one CIK share a single submissions fetch', async () => {
  const EDGAR = require('../lib/edgar');
  const recent = {
    form: ['4', '8-K', '424B5', '4'], filingDate: ['2026-09-10', '2026-09-09', '2026-09-08', '2026-09-01'],
    accessionNumber: ['a1', 'a2', 'a3', 'a4'], primaryDocument: ['x.xml', 'y.htm', 'z.htm', 'w.xml'], items: [null, '1.01', null, null],
  };
  const { calls, restore } = stubGlobalFetch((url) => (url.includes('/submissions/CIK0000001234.json') ? json(200, { filings: { recent } }) : json(404, {})));
  try {
    const [form4, offerings, again] = await Promise.all([
      EDGAR.fetchForm4List('0000001234', '2026-09-01'),
      EDGAR.fetchRecentFilings('0000001234', { forms: ['424B*', '8-K'] }),
      EDGAR.fetchForm4List('0000001234', null, 1),
    ]);
    assert.equal(form4.length, 2);
    assert.deepEqual(offerings.map(f => f.form), ['8-K', '424B5']);
    assert.equal(again.length, 1);
    assert.equal(calls.length, 1, 'one submissions fetch for three readers');
  } finally { restore(); }
});

test('EDGAR: a non-ok submissions answer yields [] and is retried on the next call', async () => {
  const EDGAR = require('../lib/edgar');
  const { calls, restore } = stubGlobalFetch((_, n) => (n === 1 ? json(503, {}) : json(200, { filings: { recent: { form: ['4'], filingDate: ['2026-09-10'], accessionNumber: ['a'], primaryDocument: ['p.xml'] } } })));
  try {
    assert.deepEqual(await EDGAR.fetchForm4List('0000009999', null), []);
    assert.equal((await EDGAR.fetchForm4List('0000009999', null)).length, 1);
    assert.equal(calls.length, 2);
  } finally { restore(); }
});

test('Finnhub: fetchRecommendation for one ticker is fetched once across repeated calls', async () => {
  const F = require('../lib/fundamentals');
  const rows = [{ period: '2026-09-01', strongBuy: 5, buy: 10, hold: 3, sell: 0, strongSell: 0 }, { period: '2026-08-01', strongBuy: 4, buy: 9, hold: 4, sell: 1, strongSell: 0 }];
  const { calls, restore } = stubGlobalFetch(() => json(200, rows));
  try {
    const a = await F.fetchRecommendation('AAPL');
    const b = await F.fetchRecommendation('AAPL');
    assert.equal(a.strongBuy, 5); assert.equal(b.prev.strongBuy, 4);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes('token='), true, 'the live request still carries the token');
    assert.equal(getHttpMemoStats().size, 1);
  } finally { restore(); }
});

test('fmpRequest: memo is OFF by default (every call live) and ON with memoTtlMs', async () => {
  const { fmpRequest, CATEGORY } = require('../lib/fmp-client');
  let n = 0;
  const fetchImpl = async () => { n++; return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ symbol: 'AAPL', price: 1 }]) }; };
  const base = { apiKey: 'k', fetchImpl, attempts: 1 };

  await fmpRequest('/quote', { symbol: 'AAPL' }, base);
  await fmpRequest('/quote', { symbol: 'AAPL' }, base);
  assert.equal(n, 2, 'default: no memo');

  const r1 = await fmpRequest('/quote', { symbol: 'AAPL' }, { ...base, memoTtlMs: 60_000 });
  const r2 = await fmpRequest('/quote', { symbol: 'AAPL' }, { ...base, memoTtlMs: 60_000 });
  assert.equal(n, 3, 'second memoized call served from cache');
  assert.equal(r1.cached, false); assert.equal(r1.category, CATEGORY.OK); assert.equal(r1.attempts, 1);
  assert.equal(r2.cached, 'l1'); assert.equal(r2.ok, true); assert.deepEqual(r2.body, r1.body); assert.equal(r2.rows, 1);
});

test('fmpRequest memo: a plan-gated answer keeps its category and is never cached', async () => {
  const { fmpRequest, CATEGORY } = require('../lib/fmp-client');
  let n = 0;
  const fetchImpl = async () => { n++; return { status: 402, headers: { get: () => null }, text: async () => 'Restricted Endpoint' }; };
  const opts = { apiKey: 'k', fetchImpl, attempts: 1, memoTtlMs: 60_000 };
  const r = await fmpRequest('/batch-quote', { symbols: 'AAPL' }, opts);
  assert.equal(r.ok, false); assert.equal(r.category, CATEGORY.PLAN_GATED); assert.equal(r.status, 402);
  assert.match(r.error, /HTTP 402/, 'the live error path is unchanged');
  await fmpRequest('/batch-quote', { symbols: 'AAPL' }, opts);
  assert.equal(n, 2);
  assert.equal(getHttpMemoStats().size, 0);
});

test('fmpRequest memo: an empty [] body is answered but not remembered', async () => {
  const { fmpRequest } = require('../lib/fmp-client');
  let n = 0;
  const fetchImpl = async () => { n++; return { status: 200, headers: { get: () => null }, text: async () => '[]' }; };
  const opts = { apiKey: 'k', fetchImpl, attempts: 1, memoTtlMs: 60_000 };
  const r = await fmpRequest('/profile', { symbol: 'ZZZZ' }, opts);
  assert.equal(r.ok, true); assert.equal(r.rows, 0);
  await fmpRequest('/profile', { symbol: 'ZZZZ' }, opts);
  assert.equal(n, 2);
});
