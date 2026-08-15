'use strict';
// SNAPSHOT APPENDS MUST BE RACE-FREE (audit 2026-08-14).
//
// lib/lifecycle-store.js appendSnapshots was an unguarded Blob read-modify-write on the
// single day doc lifecycle/<s>/snapshots/<date>.json: two appends inside the 10-30s Blob
// overwrite read-back window lost the earlier batch (even sequentially), and concurrent
// intraday captures interleaved. The fix follows the apex/fundshard/* precedent: every
// append batch writes its OWN shard key (never overwritten → no RMW → no lost updates)
// and the reader merges legacy day-doc + shards in order. Exercised here with a stubbed
// @vercel/blob (no network), following the test/store-read-completeness.test.js pattern.

// Env BEFORE require — hasStore() reads BLOB_READ_WRITE_TOKEN per call.
process.env.BLOB_READ_WRITE_TOKEN = 'test-token';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub @vercel/blob BEFORE the store lazily requires it. CI runs the suite
// DEPENDENCY-FREE (no npm install), so skip the battery when it cannot resolve.
let blobId = null;
try { blobId = require.resolve('@vercel/blob'); } catch { /* dependency-free CI */ }
if (!blobId) {
  test('lifecycle snapshot-shard battery (skipped: @vercel/blob not installed — dependency-free CI)', (t) => t.skip());
  return;
}
const state = { blobs: [] };
const urlFor = (pathname) => `https://blob.test/${pathname}`;
require.cache[blobId] = {
  id: blobId, filename: blobId, loaded: true,
  exports: {
    list: async ({ prefix, limit }) => ({
      blobs: state.blobs
        .filter((b) => b.pathname.startsWith(prefix))
        .slice(0, typeof limit === 'number' ? limit : 1000),
      cursor: undefined,
    }),
    put: async (pathname, body) => {
      // Model Blob semantics: same key overwrites, new key is a new blob.
      state.blobs = state.blobs.filter((b) => b.pathname !== pathname)
        .concat([{ pathname, url: urlFor(pathname), body }]);
      return { pathname, url: urlFor(pathname) };
    },
  },
};
const LS = require('../lib/lifecycle-store');

// Serve stored blob bodies back through the reader's fetch path.
global.fetch = async (url) => {
  const clean = String(url).split('?')[0];
  const hit = state.blobs.find((b) => b.url === clean);
  if (!hit) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(hit.body) };
};

const DATE = '2026-08-14';
const legacyDoc = (snapshots) => JSON.stringify({ strategy: 'daytrade', date: DATE, snapshots });

test('appendSnapshots writes each batch to its OWN shard key — no read-modify-write of a shared doc', async () => {
  state.blobs = [];
  const a1 = await LS.appendSnapshots('daytrade', DATE, [{ ticker: 'AAA', at: 't1' }]);
  const a2 = await LS.appendSnapshots('daytrade', DATE, [{ ticker: 'BBB', at: 't2' }]);
  assert.equal(a1.persisted, true);
  assert.equal(a2.persisted, true);
  assert.equal(a1.appended, 1);

  const shardDir = `lifecycle/daytrade/snapshots/${DATE}/`;
  const shards = state.blobs.filter((b) => b.pathname.startsWith(shardDir));
  assert.equal(shards.length, 2, 'two appends → two distinct shard blobs (neither overwrote the other)');
  assert.notEqual(shards[0].pathname, shards[1].pathname, 'shard keys are unique');
  assert.equal(state.blobs.some((b) => b.pathname === LS.snapKey('daytrade', DATE)), false,
    'the legacy shared day doc is never written by an append');
});

test('loadSnapshots merges shards back in append order (round-trip)', async () => {
  state.blobs = [];
  await LS.appendSnapshots('daytrade', DATE, [{ ticker: 'AAA', at: 't1' }, { ticker: 'BBB', at: 't2' }]);
  await LS.appendSnapshots('daytrade', DATE, [{ ticker: 'CCC', at: 't3' }]);
  const merged = await LS.loadSnapshots('daytrade', DATE);
  assert.deepEqual(merged.map((s) => s.ticker), ['AAA', 'BBB', 'CCC']);
});

test('loadSnapshots keeps reading a pre-existing single-doc day file (backward compat) and orders it before shards', async () => {
  state.blobs = [
    { pathname: LS.snapKey('daytrade', DATE), url: urlFor(LS.snapKey('daytrade', DATE)),
      body: legacyDoc([{ ticker: 'OLD1', at: 't0' }, { ticker: 'OLD2', at: 't0b' }]) },
  ];
  await LS.appendSnapshots('daytrade', DATE, [{ ticker: 'NEW1', at: 't1' }]);
  const merged = await LS.loadSnapshots('daytrade', DATE);
  assert.deepEqual(merged.map((s) => s.ticker), ['OLD1', 'OLD2', 'NEW1'],
    'legacy day-doc snapshots come first, then shard batches');
});

test('loadSnapshots skips an unreadable shard without throwing (reader stays best-effort)', async () => {
  state.blobs = [];
  await LS.appendSnapshots('daytrade', DATE, [{ ticker: 'GOOD', at: 't1' }]);
  await LS.appendSnapshots('daytrade', DATE, [{ ticker: 'BAD', at: 't2' }]);
  const badShard = state.blobs.filter((b) => b.pathname.includes(`${DATE}/`))[1];
  badShard.body = 'not json{{{';
  const merged = await LS.loadSnapshots('daytrade', DATE);
  assert.deepEqual(merged.map((s) => s.ticker), ['GOOD']);
});
