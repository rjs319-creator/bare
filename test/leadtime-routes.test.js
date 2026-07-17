'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runLeadTime } = require('../lib/leadtime-routes');

// Minimal res double capturing status/json/headers.
function fakeRes() {
  return {
    _status: 200, _json: null, _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}

test('op=leadtime degrades gracefully with no store configured (never throws, no fabricated data)', async () => {
  // In the test env there is no BLOB token → hasStore() is false → the route must answer
  // honestly with an empty, unconfigured payload rather than crashing or inventing rows.
  const res = fakeRes();
  await runLeadTime({ query: {} }, res);
  assert.ok(res._json);
  assert.equal(res._json.ok, true);
  assert.equal(res._json.configured, false);
  assert.deepEqual(res._json.algorithms, []);
  assert.equal(res._headers['Cache-Control'], 'no-store');
});
