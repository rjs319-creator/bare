'use strict';
// EXACT-PATH READS MUST NOT DEPEND ON list() ROW ORDER (audit 2026-08-14).
//
// lib/store.js readJSON/readDayCount located a doc via list({ prefix: path, limit: 1 })
// then exact-matched the pathname. Blob list ordering is not a contract this code may
// lean on: when another blob's path EXTENDS the target (e.g. `<path>.bak`) and comes
// back first, the single returned row is not the target → silent miss (fallback / -1)
// despite the doc existing. Fix: request several rows, select the exact pathname.
// Stubbed @vercel/blob (test/store-read-completeness.test.js pattern); the stub honors
// `limit` and deliberately returns the extending path FIRST to simulate the hazard.

process.env.BLOB_READ_WRITE_TOKEN = 'test-token';

const { test } = require('node:test');
const assert = require('node:assert/strict');

let blobId = null;
try { blobId = require.resolve('@vercel/blob'); } catch { /* dependency-free CI */ }
if (!blobId) {
  test('store exact-match read battery (skipped: @vercel/blob not installed — dependency-free CI)', (t) => t.skip());
  return;
}
const state = { blobs: [] };
require.cache[blobId] = {
  id: blobId, filename: blobId, loaded: true,
  exports: {
    // Honors `limit` and preserves insertion order (NOT lexicographic) — the exact
    // hazard: a limit-1 request can return only a path-extending sibling.
    list: async ({ prefix, limit }) => ({
      blobs: state.blobs
        .filter((b) => b.pathname.startsWith(prefix))
        .slice(0, typeof limit === 'number' ? limit : 1000),
      cursor: undefined,
    }),
  },
};
const STORE = require('../lib/store');

const bodyByUrl = {};
global.fetch = async (url) => {
  const clean = String(url).split('?')[0];
  const body = bodyByUrl[clean];
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => body };
};

test('readJSON finds the exact doc even when an extending path is listed first', async () => {
  state.blobs = [
    { pathname: 'apex/insider.json.bak', url: 'https://blob.test/insider-bak' },
    { pathname: 'apex/insider.json', url: 'https://blob.test/insider' },
  ];
  bodyByUrl['https://blob.test/insider'] = { tickers: { AAPL: [] }, updatedAt: '2026-08-14' };
  bodyByUrl['https://blob.test/insider-bak'] = { stale: true };
  const doc = await STORE.readJSON('apex/insider.json', 'FALLBACK');
  assert.notEqual(doc, 'FALLBACK', 'the doc exists — a listing-order artifact must not read as absence');
  assert.ok(doc.tickers && doc.tickers.AAPL, 'the EXACT pathname doc is returned, not the .bak sibling');
});

test('readJSON still returns the fallback when the doc is genuinely absent', async () => {
  state.blobs = [{ pathname: 'apex/insider.json.bak', url: 'https://blob.test/insider-bak' }];
  const doc = await STORE.readJSON('apex/insider.json', 'FALLBACK');
  assert.equal(doc, 'FALLBACK');
});

test('readDayCount finds the exact day ledger even when an extending path is listed first', async () => {
  state.blobs = [
    { pathname: 'picks/2026-08-14.json.old', url: 'https://blob.test/day-old' },
    { pathname: 'picks/2026-08-14.json', url: 'https://blob.test/day' },
  ];
  bodyByUrl['https://blob.test/day'] = { picks: [{ t: 'A' }, { t: 'B' }, { t: 'C' }] };
  bodyByUrl['https://blob.test/day-old'] = { picks: [] };
  const n = await STORE.readDayCount('picks/', '2026-08-14');
  assert.equal(n, 3, 'counts the EXACT day file — a miss here would let a DEGRADED run overwrite a fuller snapshot');
});

test('readDayCount still returns -1 when the day file is genuinely absent', async () => {
  state.blobs = [{ pathname: 'picks/2026-08-14.json.old', url: 'https://blob.test/day-old' }];
  const n = await STORE.readDayCount('picks/', '2026-08-14');
  assert.equal(n, -1);
});
