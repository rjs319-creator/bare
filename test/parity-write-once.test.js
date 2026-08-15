'use strict';
// WRITE-ONCE PARITY RECORD — FAIL-CLOSED EXISTENCE (review finding #8, 2026-08-15).
//
// THE DEFECT: the daily parity record (the boardHash proving the graded set = the served
// set) was guarded by fail-open read-then-write: `readJSON(ppath, null).catch(() => null)`.
// A transient Blob failure folded into "absent", so a later call could silently OVERWRITE
// the day's record of record with a different boardHash — the exact tamper the record
// exists to prevent.
//
// THE CONTRACT (same as store.writeOmegaFunnelDay): only "definitely absent" — the
// existence probe SUCCEEDED and found no exact pathname — permits a write. Unverifiable
// existence SKIPS the write and says so; the day's first record always survives.
//
// Stubbing seam: identical to test/portfolio-shadow-lane.test.js — decision-routes holds
// the store as a module object (STORE.*) and never destructures it, so the suite stubs
// STORE.blobExists / STORE.readJSON / STORE.writeJSON and restores them after each run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const STORE = require('../lib/store');
const { recordParityOnce, PARITY_PREFIX } = require('../lib/decision-routes');

const DATE = '2026-08-15';
const PPATH = `${PARITY_PREFIX}${DATE}.json`;
const DOC = { version: 'test', date: DATE, boardHash: 'a'.repeat(64), rows: 3, ids: [] };

// Async-safe store stub: originals restored only after the run completes.
const withStoreStubbed = async (stubs, run) => {
  const orig = {};
  for (const k of Object.keys(stubs)) { orig[k] = STORE[k]; STORE[k] = stubs[k]; }
  try { return await run(); }
  finally { for (const k of Object.keys(stubs)) STORE[k] = orig[k]; }
};

test('definitely absent: the first record of the day is written exactly once', async () => {
  // Arrange
  const writes = [];
  const parity = await withStoreStubbed({
    blobExists: async (p) => { assert.equal(p, PPATH); return false; },
    writeJSON: async (p, obj, maxAge) => { writes.push({ p, obj, maxAge }); return { pathname: p }; },
  }, () => recordParityOnce(DATE, DOC.boardHash, DOC));

  // Assert
  assert.equal(parity.recorded, true);
  assert.equal(parity.hash, DOC.boardHash);
  assert.equal(parity.matchesServed, true);
  assert.equal(writes.length, 1, 'exactly one write');
  assert.equal(writes[0].p, PPATH);
  assert.deepEqual(writes[0].obj, DOC);
  assert.equal(writes[0].maxAge, 0, 'the record must not be CDN-stale-served');
});

test('already recorded: later boards report the standing record and NEVER write', async () => {
  // Arrange — the standing record has a DIFFERENT hash than the currently-served board.
  const writes = [];
  const parity = await withStoreStubbed({
    blobExists: async () => true,
    readJSON: async () => ({ ...DOC, boardHash: 'b'.repeat(64) }),
    writeJSON: async (p) => { writes.push(p); },
  }, () => recordParityOnce(DATE, DOC.boardHash, DOC));

  // Assert
  assert.equal(parity.recorded, false);
  assert.match(parity.reason, /already-recorded/);
  assert.equal(parity.hash, 'b'.repeat(64), 'reports the RECORDED hash, not the served one');
  assert.equal(parity.matchesServed, false);
  assert.equal(writes.length, 0, 'write-once means write-never-again');
});

test('FAIL-CLOSED: unverifiable existence SKIPS the write instead of clobbering the day record', async () => {
  // Arrange — the existence probe throws (transient Blob/list failure).
  const writes = [];
  const parity = await withStoreStubbed({
    blobExists: async () => { throw new Error('blob list transient failure'); },
    // A fail-open implementation would fall through readJSON's fallback and write:
    readJSON: async () => { throw new Error('reads must not gate the write'); },
    writeJSON: async (p) => { writes.push(p); },
  }, () => recordParityOnce(DATE, DOC.boardHash, DOC));

  // Assert — the one behavior this finding is about.
  assert.equal(writes.length, 0, 'unknown existence must NEVER overwrite the record of record');
  assert.equal(parity.recorded, false);
  assert.equal(parity.reason, 'skipped-existence-unverifiable');
  assert.equal(parity.matchesServed, null, 'unknown, honestly reported');
});

test('a failed read of an EXISTING record degrades the report, not the record', async () => {
  // Arrange — existence is verified true, but the content read fails. The old code
  // treated exactly this as "absent" and overwrote.
  const writes = [];
  const parity = await withStoreStubbed({
    blobExists: async () => true,
    readJSON: async () => { throw new Error('transient read failure'); },
    writeJSON: async (p) => { writes.push(p); },
  }, () => recordParityOnce(DATE, DOC.boardHash, DOC));

  // Assert
  assert.equal(writes.length, 0, 'an unreadable existing record still blocks the write');
  assert.equal(parity.recorded, false);
  assert.match(parity.reason, /already-recorded/);
  assert.equal(parity.hash, null, 'content unknown — no hash is invented');
  assert.equal(parity.matchesServed, null);
});

test('the fail-closed helper exists on the store and decision-routes reaches it via the module object', () => {
  // The seam the whole suite relies on: STORE.blobExists must be exported, and
  // decision-routes must call it late-bound (STORE.blobExists(...)), never destructured.
  assert.equal(typeof STORE.blobExists, 'function');
  const src = require('node:fs').readFileSync(require.resolve('../lib/decision-routes.js'), 'utf8');
  assert.match(src, /STORE\.blobExists\(/, 'parity gating must use the fail-closed existence probe');
  assert.match(src, /skipped-existence-unverifiable/,
    'the unverifiable-existence skip (and its audit reason) must be present');
});
