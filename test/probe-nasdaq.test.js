'use strict';
// Nasdaq Data Link probe: offline contract tests — injected fetch, fake keys,
// NO real network. Pins the safety contract: distinct failure categories (an
// auth failure is never read as an empty dataset), and no secret ever survives
// into the returned/printed report.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProbe, probeAuth, probeTable } = require('../scripts/probe-nasdaq-data-link');

const FAKE_KEY = 'fake_secret_key_1234567890';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const fetchReturning = (status, body) => async () => jsonResponse(status, body);

test('successful auth probe reports ok with row count, never the key', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return jsonResponse(200, { datatable: { data: [[1]] } }); };
  const r = await probeAuth({ apiKey: FAKE_KEY, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.category, 'ok');
  assert.equal(r.httpStatus, 200);
  assert.equal(r.responseType, 'datatable');
  assert.equal(r.rowCount, 1);
  assert.ok(seen[0].includes(FAKE_KEY), 'request itself must carry the key');
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY), 'report must not contain the key');
});

test('missing key is its own category and skips the network entirely', async () => {
  const fetchImpl = async () => { throw new Error('network must not be touched'); };
  const r = await runProbe({ env: {}, fetchImpl });
  assert.equal(r.configured, false);
  assert.equal(r.auth.category, 'missing_key');
  assert.equal(r.auth.ok, false);
});

test('401/403 report auth_failed, not an empty dataset', async () => {
  for (const status of [401, 403]) {
    const r = await probeAuth({ apiKey: FAKE_KEY, fetchImpl: fetchReturning(status, {}) });
    assert.equal(r.category, 'auth_failed');
    assert.equal(r.ok, false);
    assert.equal(r.rowCount, null, 'must never look like an empty dataset');
  }
});

test('Nasdaq 400 + QEAx code (unrecognized key) is auth_failed, code echoed only if pattern-safe', async () => {
  const r = await probeAuth({ apiKey: FAKE_KEY, fetchImpl: fetchReturning(400, { quandl_error: { code: 'QEAx01', message: `bad key ${FAKE_KEY} for account ravi` } }) });
  assert.equal(r.category, 'auth_failed');
  assert.equal(r.providerCode, 'QEAx01');
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(r).includes('ravi'), 'provider message text must never be echoed');
});

test('429 reports rate_limited', async () => {
  const r = await probeAuth({ apiKey: FAKE_KEY, fetchImpl: fetchReturning(429, {}) });
  assert.equal(r.category, 'rate_limited');
});

test('timeout reports timeout, with any error text redacted', async () => {
  const fetchImpl = async () => { const e = new Error(`aborted fetching ?api_key=${FAKE_KEY}`); e.name = 'TimeoutError'; throw e; };
  const r = await probeAuth({ apiKey: FAKE_KEY, fetchImpl });
  assert.equal(r.category, 'timeout');
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
});

test('5xx reports provider_outage, network error reports network', async () => {
  const r5 = await probeAuth({ apiKey: FAKE_KEY, fetchImpl: fetchReturning(503, {}) });
  assert.equal(r5.category, 'provider_outage');
  const rn = await probeAuth({ apiKey: FAKE_KEY, fetchImpl: async () => { const e = new TypeError('fetch failed'); throw e; } });
  assert.equal(rn.category, 'network');
});

test('malformed JSON on a 200 reports malformed_response, not success', async () => {
  const r = await probeAuth({ apiKey: FAKE_KEY, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) });
  assert.equal(r.category, 'malformed_response');
  assert.equal(r.ok, false);
});

test('secret-bearing provider error never reaches the report (env-configured secret)', async () => {
  process.env.NASDAQ_DATA_LINK_API_KEY = FAKE_KEY;
  try {
    const fetchImpl = async () => { throw new Error(`ECONNRESET on https://data.nasdaq.com/x?api_key=${FAKE_KEY}`); };
    const r = await probeAuth({ apiKey: FAKE_KEY, fetchImpl });
    const out = JSON.stringify(r);
    assert.ok(!out.includes(FAKE_KEY), 'redaction must strip the secret from error text');
  } finally { delete process.env.NASDAQ_DATA_LINK_API_KEY; }
});

test('table probe without a code is skipped and explicitly NOT a key failure', async () => {
  const r = await probeTable({ apiKey: FAKE_KEY, tableCode: '' });
  assert.equal(r.category, 'skipped');
  assert.match(r.note, /NOT an API-key failure/);
});

test('table probe distinguishes entitled / not_entitled / invalid code / rate limit', async () => {
  const ok = await probeTable({ apiKey: FAKE_KEY, tableCode: 'VEND/TBL', fetchImpl: fetchReturning(200, { datatable: { columns: [{ name: 'ticker' }, { name: 'eps_est' }] } }) });
  assert.equal(ok.category, 'ok');
  assert.deepEqual(ok.columns, ['ticker', 'eps_est']);
  assert.equal(ok.rowCount, null, 'metadata probe must not report licensed rows');

  const denied = await probeTable({ apiKey: FAKE_KEY, tableCode: 'VEND/TBL', fetchImpl: fetchReturning(403, {}) });
  assert.equal(denied.category, 'not_entitled');

  const missing = await probeTable({ apiKey: FAKE_KEY, tableCode: 'VEND/TBL', fetchImpl: fetchReturning(404, {}) });
  assert.equal(missing.category, 'invalid_table_code');

  const malformedCode = await probeTable({ apiKey: FAKE_KEY, tableCode: 'not a table code' });
  assert.equal(malformedCode.category, 'invalid_table_code');

  const limited = await probeTable({ apiKey: FAKE_KEY, tableCode: 'VEND/TBL', fetchImpl: fetchReturning(429, {}) });
  assert.equal(limited.category, 'rate_limited');
});

test('runProbe skips the premium probe when auth fails (ambiguous 403s never reported as entitlement)', async () => {
  const r = await runProbe({
    env: { NASDAQ_DATA_LINK_API_KEY: FAKE_KEY, NASDAQ_ESTIMATES_TABLE_CODE: 'VEND/TBL' },
    fetchImpl: fetchReturning(401, {}),
  });
  assert.equal(r.auth.category, 'auth_failed');
  assert.equal(r.table.category, 'skipped');
});
