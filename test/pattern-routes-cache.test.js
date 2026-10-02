'use strict';
// op=patterns cache posture (2026-10-02 site audit): the empty states (no store / radar not
// built yet) must not be CDN-cached — the s-maxage header used to be set BEFORE those early
// returns, so an empty radar could be pinned at the edge for 5 min + a 24h SWR window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { runPatterns } = require('../lib/pattern-routes');

function mockRes() {
  return { _status: 200, _json: null, _headers: {}, setHeader(k, v) { this._headers[k] = v; }, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
}

test('op=patterns without a store → ready:false served no-store', { skip: store.hasStore() ? 'Blob store configured in this environment' : false }, async () => {
  const res = mockRes();
  await runPatterns({ query: {} }, res);
  assert.equal(res._json.ready, false);
  assert.equal(res._headers['Cache-Control'], 'no-store');
});

test('the CDN header is set only on the ready-radar return path (source pin)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pattern-routes.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function runPatterns('), src.indexOf('// The radar\'s OWN evidence line'));
  const noStoreAt = fn.indexOf("res.setHeader('Cache-Control', 'no-store')");
  const cacheAt = fn.indexOf("res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400')");
  const notBuiltAt = fn.indexOf("reason: 'not-built-yet'");
  assert.ok(noStoreAt >= 0 && cacheAt >= 0 && notBuiltAt >= 0);
  assert.ok(noStoreAt < notBuiltAt && notBuiltAt < cacheAt, 'empty states return before the CDN header is set');
});
