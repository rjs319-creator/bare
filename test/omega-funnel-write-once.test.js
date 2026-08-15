'use strict';
// WRITE-ONCE MUST FAIL CLOSED ON AN UNVERIFIABLE EXISTENCE CHECK (audit 2026-08-14).
//
// lib/store.js writeOmegaFunnelDay guarded its write-once contract with readJSON(), which
// folds EVERY failure (thrown list, non-ok fetch, bad JSON, read-back lag) into null — so a
// transient read failure made the "immutable" funnel snapshot overwritable. The honest fix
// distinguishes "definitely absent" (list succeeded, no exact pathname) from "read failed"
// (refuse to write: { written:false, reason:'existence-unverifiable' }). Stubbed @vercel/blob,
// following the test/store-read-completeness.test.js pattern.

process.env.BLOB_READ_WRITE_TOKEN = 'test-token';

const { test } = require('node:test');
const assert = require('node:assert/strict');

let blobId = null;
try { blobId = require.resolve('@vercel/blob'); } catch { /* dependency-free CI */ }
if (!blobId) {
  test('omega funnel write-once battery (skipped: @vercel/blob not installed — dependency-free CI)', (t) => t.skip());
  return;
}
const state = { blobs: [], puts: [], listError: null };
require.cache[blobId] = {
  id: blobId, filename: blobId, loaded: true,
  exports: {
    list: async ({ prefix, limit }) => {
      if (state.listError) throw state.listError;
      return {
        blobs: state.blobs
          .filter((b) => b.pathname.startsWith(prefix))
          .slice(0, typeof limit === 'number' ? limit : 1000),
        cursor: undefined,
      };
    },
    put: async (pathname, body) => {
      state.puts.push({ pathname, body });
      return { pathname, url: `https://blob.test/${pathname}` };
    },
  },
};
const STORE = require('../lib/store');

const DATE = '2026-08-14';
const PATH = `omega/funnel/${DATE}.json`;

test('refuses to write when the existence check cannot complete (fail closed, not "unknown = absent")', async () => {
  state.blobs = []; state.puts = []; state.listError = new Error('blob list transient failure');
  const w = await STORE.writeOmegaFunnelDay(DATE, { snapshotId: 'x' });
  assert.equal(w.written, false);
  assert.equal(w.reason, 'existence-unverifiable');
  assert.equal(state.puts.length, 0, 'the immutable snapshot must NOT be overwritten on an unverifiable read');
});

test('happy path unchanged: definitely absent → writes once', async () => {
  state.blobs = []; state.puts = []; state.listError = null;
  const w = await STORE.writeOmegaFunnelDay(DATE, { snapshotId: 'x' });
  assert.equal(w.written, true);
  assert.equal(state.puts.length, 1);
  assert.equal(state.puts[0].pathname, PATH);
});

test('happy path unchanged: already captured → no rewrite', async () => {
  state.blobs = [{ pathname: PATH, url: `https://blob.test/${PATH}` }];
  state.puts = []; state.listError = null;
  const w = await STORE.writeOmegaFunnelDay(DATE, { snapshotId: 'y' });
  assert.equal(w.written, false);
  assert.equal(w.reason, 'already-captured');
  assert.equal(state.puts.length, 0);
});

test('a path-EXTENDING blob does not mask absence of the exact doc', async () => {
  state.blobs = [{ pathname: `${PATH}.bak`, url: `https://blob.test/${PATH}.bak` }];
  state.puts = []; state.listError = null;
  const w = await STORE.writeOmegaFunnelDay(DATE, { snapshotId: 'z' });
  assert.equal(w.written, true, 'only an EXACT pathname match counts as "already captured"');
});

test('force:true still bypasses the existence check entirely', async () => {
  state.blobs = []; state.puts = []; state.listError = new Error('blob list transient failure');
  const w = await STORE.writeOmegaFunnelDay(DATE, { snapshotId: 'f' }, { force: true });
  assert.equal(w.written, true);
  assert.equal(state.puts.length, 1);
});
