'use strict';
// PARTIAL READS MUST BE COUNTED, NOT DROPPED (audit 2026-08-14).
//
// lib/store.js readAllByPrefix dropped a non-ok HTTP shard response WITHOUT
// incrementing `unreadable`, so withReadStats reported `complete: true` on a partial
// read — bypassing the "refuse to rewrite evidence on an incomplete read" guard in
// apex-routes. readFundamentals had the sibling defect one path over: its catch block
// counted nothing on a THROWN fetch. Both are exercised here with a stubbed Blob list
// + fetch (no network, no store), following the global-fetch stub pattern of
// test/news-rich-fetch.test.js.

// Env BEFORE require — hasStore() reads BLOB_READ_WRITE_TOKEN per call, but set it up
// front so every reader takes the real code path.
process.env.BLOB_READ_WRITE_TOKEN = 'test-token';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @vercel/blob's list() BEFORE lib/store.js lazily requires it. CI runs the
// suite DEPENDENCY-FREE (no npm install step), so when the module cannot resolve the
// whole battery skips — there is no store code path to exercise without the package.
let blobId = null;
try { blobId = require.resolve('@vercel/blob'); } catch { /* dependency-free CI */ }
if (!blobId) {
  test('store read-completeness battery (skipped: @vercel/blob not installed — dependency-free CI)', (t) => t.skip());
  return;
}
const state = { blobs: [] };
require.cache[blobId] = {
  id: blobId, filename: blobId, loaded: true,
  exports: {
    list: async ({ prefix }) => ({
      blobs: state.blobs.filter((b) => b.pathname.startsWith(prefix)),
      cursor: undefined,
    }),
  },
};
const STORE = require('../lib/store');

const resp = (ok, body) => ({ ok, status: ok ? 200 : 502, json: async () => body });
const revBlobs = () => [
  { pathname: 'revarchive/2026-08-01.json', url: 'https://blob.test/rev1' },
  { pathname: 'revarchive/2026-08-02.json', url: 'https://blob.test/rev2' },
  { pathname: 'revarchive/2026-08-03.json', url: 'https://blob.test/rev3' },
];

test('readAllByPrefix counts a non-ok shard as unreadable — a partial read is not complete', async () => {
  state.blobs = revBlobs();
  global.fetch = async (url) => String(url).includes('rev2')
    ? resp(false, {})
    : resp(true, { date: String(url).includes('rev1') ? '2026-08-01' : '2026-08-03' });
  const days = await STORE.readAllRevArchiveDays();
  assert.equal(days.length, 2, 'the readable shards still come back');
  assert.equal(days.requested, 3);
  assert.equal(days.unreadable, 1, 'the non-ok shard must be COUNTED, not silently dropped');
  assert.equal(days.complete, false, 'a partial read must never claim completeness');
});

test('readAllByPrefix counts a THROWN shard fetch as unreadable (existing behavior preserved)', async () => {
  state.blobs = revBlobs();
  global.fetch = async (url) => {
    if (String(url).includes('rev3')) throw new Error('network down');
    return resp(true, { date: '2026-08-01' });
  };
  const days = await STORE.readAllRevArchiveDays();
  assert.equal(days.length, 2);
  assert.equal(days.unreadable, 1);
  assert.equal(days.complete, false);
});

test('readAllByPrefix on a fully readable prefix reports complete:true', async () => {
  state.blobs = revBlobs();
  global.fetch = async () => resp(true, { date: '2026-08-01' });
  const days = await STORE.readAllRevArchiveDays();
  assert.equal(days.length, 3);
  assert.equal(days.unreadable, 0);
  assert.equal(days.complete, true);
});

test('readFundamentals counts a THROWN shard fetch as unreadable', async () => {
  state.blobs = [
    { pathname: 'apex/fundshard/a.json', url: 'https://blob.test/fund-a' },
    { pathname: 'apex/fundshard/b.json', url: 'https://blob.test/fund-b' },
  ];
  global.fetch = async (url) => {
    if (String(url).includes('fund-b')) throw new Error('network down');
    return resp(true, { tickers: { AAPL: { pe: 30 } }, updatedAt: '2026-08-14T00:00:00Z' });
  };
  const out = await STORE.readFundamentals();
  assert.ok(out.tickers.AAPL, 'readable shards still aggregate');
  assert.equal(out.requested, 2);
  assert.equal(out.unreadable, 1, 'a thrown fetch must be COUNTED, not swallowed');
  assert.equal(out.complete, false);
});

test('readFundamentals still counts a non-ok shard as unreadable', async () => {
  state.blobs = [
    { pathname: 'apex/fundshard/a.json', url: 'https://blob.test/fund-a' },
    { pathname: 'apex/fundshard/b.json', url: 'https://blob.test/fund-b' },
  ];
  global.fetch = async (url) => String(url).includes('fund-b')
    ? resp(false, {})
    : resp(true, { tickers: { MSFT: { pe: 34 } }, updatedAt: '2026-08-14T00:00:00Z' });
  const out = await STORE.readFundamentals();
  assert.ok(out.tickers.MSFT);
  assert.equal(out.unreadable, 1);
  assert.equal(out.complete, false);
});
