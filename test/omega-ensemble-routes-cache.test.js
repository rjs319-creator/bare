'use strict';
// op=ensemble cache posture (2026-10-02 site audit): a DEGRADED view — op=today did not
// answer — is an empty state and must be `no-store`; prod had CDN-cached an "engine
// unavailable" board for the full s-maxage/SWR window after one timed-out pull. A healthy
// view keeps op=today's cache posture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runEnsemble } = require('../lib/omega-ensemble-routes');

function mockRes() {
  return { _status: 200, _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}

async function withFetch(stub, fn) {
  const orig = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = orig; }
}

const TODAY = { ok: true, regime: { label: 'Risk-on', riskOn: true }, counts: { signals: 0 }, actionableByHorizon: {}, horizons: { intraday: [], swing: [], position: [], portfolio: [] }, portfolio: null, redundancy: null };

test('degraded view (op=today unreachable) is served no-store — never CDN-cached', async () => {
  const res = mockRes();
  await withFetch(async () => { throw new Error('The operation was aborted due to timeout'); }, () => runEnsemble({ query: {} }, res));
  assert.equal(res._json.ok, false);
  assert.equal(res._json.degraded, true);
  assert.equal(res._headers['Cache-Control'], 'no-store');
});

test('healthy view keeps the op=today cache posture', async () => {
  const res = mockRes();
  const stub = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('op=today') ? TODAY : { dsr: null }) });
  await withFetch(stub, () => runEnsemble({ query: {} }, res));
  assert.equal(res._json.sources.today.ok, true);
  if (res._json.ok) assert.equal(res._headers['Cache-Control'], 's-maxage=300, stale-while-revalidate=3600');
  else assert.equal(res._headers['Cache-Control'], 'no-store');
});
