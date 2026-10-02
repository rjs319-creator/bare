'use strict';
// op=omega / op=omegafunnel cache posture (2026-10-02 site audit): when op=today does not
// answer the route returns an EMPTY board — that is an empty state and must be `no-store`
// (it was `s-maxage=60`, so one timed-out pull served an empty OMEGA board to every
// visitor for the cache window).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runOmega, runOmegaFunnel } = require('../lib/omega-swing-routes');

function mockRes() {
  return { _status: 200, _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}

async function withFailingFetch(fn) {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
  try { return await fn(); } finally { global.fetch = orig; }
}

test('op=omega: op=today unavailable → degraded empty board, no-store', async () => {
  const res = mockRes();
  await withFailingFetch(() => runOmega({ query: {} }, res));
  assert.equal(res._json.degraded, true);
  assert.deepEqual(res._json.cards, []);
  assert.equal(res._headers['Cache-Control'], 'no-store');
});

test('op=omegafunnel: op=today unavailable → ok:false, no-store', async () => {
  const res = mockRes();
  await withFailingFetch(() => runOmegaFunnel({ query: {} }, res));
  assert.equal(res._json.ok, false);
  assert.equal(res._headers['Cache-Control'], 'no-store');
});
