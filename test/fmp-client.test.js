'use strict';
// Central FMP provider: category mapping, retry policy, Retry-After, redaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fmpRequest, CATEGORY, categorizeStatus, retryDelayMs, buildUrl } = require('../lib/fmp-client');

const FAKE_KEY = 'testkey_1234567890abcdef';

const resp = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const deps = (fetchImpl) => ({
  apiKey: FAKE_KEY, fetchImpl,
  sleep: async () => {}, jitter: () => 0,
});

test('2xx with array body is ok with row count', async () => {
  const r = await fmpRequest('/earnings', { symbol: 'AAPL' }, deps(async () => resp(200, [{ a: 1 }, { a: 2 }])));
  assert.equal(r.ok, true);
  assert.equal(r.category, CATEGORY.OK);
  assert.equal(r.rows, 2);
  assert.equal(r.attempts, 1);
  assert.equal(r.error, null);
});

test('402 is plan-gated and NEVER retried', async () => {
  let calls = 0;
  const r = await fmpRequest('/batch-quote', {}, deps(async () => { calls++; return resp(402, 'Payment Required'); }));
  assert.equal(r.category, CATEGORY.PLAN_GATED);
  assert.equal(calls, 1);
  assert.equal(r.ok, false);
});

test('400 is invalid-request and never retried; 404 is not-found', async () => {
  let calls = 0;
  const r400 = await fmpRequest('/x', {}, deps(async () => { calls++; return resp(400, 'bad'); }));
  assert.equal(r400.category, CATEGORY.INVALID_REQUEST);
  assert.equal(calls, 1);
  const r404 = await fmpRequest('/x', {}, deps(async () => resp(404, 'nope')));
  assert.equal(r404.category, CATEGORY.NOT_FOUND);
});

test('429 retries through backoff and honors Retry-After seconds', async () => {
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls < 3 ? resp(429, 'slow down', { 'retry-after': '2' }) : resp(200, [{ ok: 1 }]);
  };
  const r = await fmpRequest('/grades', {}, {
    apiKey: FAKE_KEY, fetchImpl, jitter: () => 0,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(sleeps, [2000, 2000]);       // Retry-After wins over backoff
});

test('5xx and network errors retry then surface the terminal category', async () => {
  let calls = 0;
  const r5xx = await fmpRequest('/x', {}, { ...deps(async () => { calls++; return resp(503, 'down'); }), attempts: 3 });
  assert.equal(r5xx.category, CATEGORY.UPSTREAM_ERROR);
  assert.equal(calls, 3);
  const rNet = await fmpRequest('/x', {}, { ...deps(async () => { throw new TypeError('fetch failed'); }), attempts: 2 });
  assert.equal(rNet.category, CATEGORY.NETWORK);
  assert.equal(rNet.attempts, 2);
});

test('unparseable body is invalid-json, not retried', async () => {
  let calls = 0;
  const r = await fmpRequest('/x', {}, deps(async () => { calls++; return resp(200, '<html>error</html>'); }));
  assert.equal(r.category, CATEGORY.INVALID_JSON);
  assert.equal(calls, 1);
});

test('missing key fails closed with no-key and zero fetches', async () => {
  let calls = 0;
  const r = await fmpRequest('/x', {}, { apiKey: '', fetchImpl: async () => { calls++; return resp(200, []); } });
  assert.equal(r.category, CATEGORY.NO_KEY);
  assert.equal(calls, 0);
});

test('error strings never contain the key or an apikey param value', async () => {
  // Vendor error body that echoes the request URL (the worst case).
  const echo = `Invalid request: https://financialmodelingprep.com/stable/x?apikey=${FAKE_KEY}`;
  const r = await fmpRequest('/x', {}, deps(async () => resp(400, echo)));
  assert.ok(r.error);
  assert.ok(!r.error.includes(FAKE_KEY), 'key leaked into error');
  const rNet = await fmpRequest('/x', {}, deps(async () => { throw new Error(`connect failed for ?apikey=${FAKE_KEY}`); }));
  assert.ok(!String(rNet.error).includes(FAKE_KEY), 'key leaked into network error');
});

test('categorizeStatus covers the full policy table', () => {
  assert.equal(categorizeStatus(200), CATEGORY.OK);
  assert.equal(categorizeStatus(400), CATEGORY.INVALID_REQUEST);
  for (const s of [401, 402, 403]) assert.equal(categorizeStatus(s), CATEGORY.PLAN_GATED);
  assert.equal(categorizeStatus(404), CATEGORY.NOT_FOUND);
  assert.equal(categorizeStatus(429), CATEGORY.RATE_LIMITED);
  assert.equal(categorizeStatus(500), CATEGORY.UPSTREAM_ERROR);
});

test('retryDelayMs caps hostile Retry-After and bounds backoff', () => {
  assert.equal(retryDelayMs(1, 9999, () => 0), 15_000);   // capped
  assert.equal(retryDelayMs(1, null, () => 0), 500);      // base
  assert.equal(retryDelayMs(10, null, () => 0), 8_000);   // backoff cap
});

test('buildUrl targets /stable and carries params', () => {
  const u = buildUrl('/analyst-estimates', { symbol: 'AAPL', period: 'annual' }, FAKE_KEY);
  assert.ok(u.startsWith('https://financialmodelingprep.com/stable/analyst-estimates?'));
  assert.ok(u.includes('symbol=AAPL') && u.includes('period=annual'));
});
