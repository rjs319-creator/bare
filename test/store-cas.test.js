'use strict';
// Compare-and-swap Blob writes (lib/store-cas.js, re-exported by lib/store.js).
//
// The defect this closes: every read-modify-write on a shared Blob doc was last-writer-
// wins. Two appends inside the 10-60s read-back window silently lost the earlier one
// (tech-evidence rows 139 -> 34 on 2026-08-15). `updateJSON` reads the doc WITH its etag,
// applies a pure mutate function, and writes with `ifMatch`; a concurrent write makes the
// put fail a precondition, so the loop re-reads and re-applies instead of clobbering.

process.env.BLOB_READ_WRITE_TOKEN = 'test-token';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeBlob } = require('./helpers/fake-blob');

const fake = installFakeBlob();
if (!fake) {
  test('store CAS battery (skipped: @vercel/blob not installed — dependency-free CI)', (t) => t.skip());
  return;
}

const STORE = require('../lib/store');
const CAS = require('../lib/store-cas');

const PATH = 'cas/test-doc.json';
const noSleep = async () => {};

function resetAll() {
  fake.docs.clear();
  fake.putCalls.length = 0;
  fake.hooks.beforePut = null;
  CAS.resetStoreCasStats();
}

// ── readJSONWithEtag ─────────────────────────────────────────────────────────

test('readJSONWithEtag: absent doc → exists:false with null value and etag', async () => {
  resetAll();
  assert.deepEqual(await STORE.readJSONWithEtag(PATH), { value: null, etag: null, exists: false });
});

test('readJSONWithEtag: present doc → the body AND the etag list() reported for it', async () => {
  resetAll();
  const etag = fake.seed(PATH, { n: 1 });
  const r = await STORE.readJSONWithEtag(PATH);
  assert.deepEqual(r, { value: { n: 1 }, etag, exists: true });
});

test('readJSONWithEtag: a path that merely EXTENDS the target is not a match', async () => {
  resetAll();
  fake.seed(`${PATH}.bak`, { wrong: true });
  assert.equal((await STORE.readJSONWithEtag(PATH)).exists, false);
});

test('readJSONWithEtag: a list() failure THROWS — never a silent "absent" (that would turn CAS into an unconditional create)', async () => {
  resetAll();
  const origList = fake.exports.list;
  fake.exports.list = async () => { throw new Error('blob api down'); };
  try {
    await assert.rejects(() => STORE.readJSONWithEtag(PATH), /blob api down/);
  } finally { fake.exports.list = origList; }
});

// ── updateJSON: happy paths ──────────────────────────────────────────────────

test('updateJSON: creates an absent doc from `initial`, with a create-only put (no ifMatch, allowOverwrite:false)', async () => {
  resetAll();
  const r = await STORE.updateJSON(PATH, (cur) => ({ ...cur, items: [...cur.items, 'a'] }), { initial: { items: [] }, sleep: noSleep });
  assert.equal(r.written, true);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.value, { items: ['a'] });
  assert.deepEqual(fake.read(PATH), { items: ['a'] });
  assert.equal(fake.putCalls.length, 1);
  assert.equal(fake.putCalls[0].opts.ifMatch, undefined);
  assert.equal(fake.putCalls[0].opts.allowOverwrite, false);
  assert.equal(fake.putCalls[0].opts.contentType, 'application/json');
  assert.equal(fake.putCalls[0].opts.addRandomSuffix, false);
});

test('updateJSON: an existing doc is written with ifMatch = the etag it was read at', async () => {
  resetAll();
  const etag = fake.seed(PATH, { items: ['a'] });
  const r = await STORE.updateJSON(PATH, (cur) => ({ ...cur, items: [...cur.items, 'b'] }), { sleep: noSleep });
  assert.equal(r.written, true);
  assert.deepEqual(fake.read(PATH), { items: ['a', 'b'] });
  assert.equal(fake.putCalls[0].opts.ifMatch, etag);
  assert.equal(fake.putCalls[0].opts.allowOverwrite, true);
  assert.equal(r.etag, fake.etagOf(PATH), 'returns the etag of the version it wrote');
});

test('updateJSON: cacheMaxAge defaults to 0 (an RMW doc must never be served stale) and is passed through', async () => {
  resetAll();
  fake.seed(PATH, {});
  await STORE.updateJSON(PATH, () => ({ x: 1 }), { sleep: noSleep });
  assert.equal(fake.putCalls[0].opts.cacheControlMaxAge, 0);
  await STORE.updateJSON(PATH, () => ({ x: 2 }), { sleep: noSleep, cacheMaxAge: 300 });
  assert.equal(fake.putCalls[1].opts.cacheControlMaxAge, 300);
});

test('updateJSON: mutateFn returning the SAME reference means "no change" — nothing is written', async () => {
  resetAll();
  const etag = fake.seed(PATH, { items: ['a'] });
  const r = await STORE.updateJSON(PATH, (cur) => cur, { sleep: noSleep });
  assert.equal(r.written, false);
  assert.deepEqual(r.value, { items: ['a'] });
  assert.equal(fake.putCalls.length, 0);
  assert.equal(fake.etagOf(PATH), etag);
});

test('updateJSON: an async mutateFn is awaited', async () => {
  resetAll();
  fake.seed(PATH, { n: 1 });
  const r = await STORE.updateJSON(PATH, async (cur) => ({ n: cur.n + 1 }), { sleep: noSleep });
  assert.deepEqual(r.value, { n: 2 });
});

// ── updateJSON: the retry path (the whole point) ────────────────────────────

test('updateJSON: a concurrent write between read and put → stale etag → re-read → BOTH appends survive', async () => {
  resetAll();
  fake.seed(PATH, { items: ['seed'] });
  const sleeps = [];
  const inputsSeen = [];
  // A rival writer lands right before OUR first put: it appends 'rival' and bumps the etag.
  fake.hooks.beforePut = async () => { fake.seed(PATH, { items: ['seed', 'rival'] }); };

  const r = await STORE.updateJSON(PATH, (cur) => {
    inputsSeen.push(JSON.parse(JSON.stringify(cur)));
    return { ...cur, items: [...cur.items, 'mine'] };
  }, { sleep: async (ms) => { sleeps.push(ms); } });

  assert.equal(r.written, true);
  assert.equal(r.attempts, 2);
  assert.deepEqual(fake.read(PATH), { items: ['seed', 'rival', 'mine'] }, 'the rival append is NOT lost');
  assert.equal(fake.putCalls.length, 2, 'first put refused (412), second accepted');
  assert.deepEqual(inputsSeen, [{ items: ['seed'] }, { items: ['seed', 'rival'] }], 'attempt 2 sees the FRESH doc, not attempt 1\'s output');
  assert.equal(sleeps.length, 1, 'one backoff between the two attempts');
  assert.ok(sleeps[0] > 0 && sleeps[0] <= 2000, `jittered backoff within bounds, got ${sleeps[0]}`);
  const stats = STORE.getStoreCasStats();
  assert.equal(stats.conflicts, 1);
  assert.equal(stats.updates, 1);
  assert.equal(stats.exhausted, 0);
  assert.ok(typeof stats.lastConflictAt === 'string');
});

test('updateJSON: backoff grows with the attempt and is jittered (never a thundering herd of fixed delays)', async () => {
  resetAll();
  fake.seed(PATH, { n: 0 });
  const sleeps = [];
  let rivals = 0;
  const rival = async () => { if (rivals++ < 3) { fake.seed(PATH, { n: rivals * 10 }); fake.hooks.beforePut = rival; } };
  fake.hooks.beforePut = rival;
  const r = await STORE.updateJSON(PATH, (cur) => ({ n: cur.n + 1 }), { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(r.attempts, 4);
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps[2] > sleeps[0], `later retries wait longer: ${sleeps.join(',')}`);
  assert.deepEqual(fake.read(PATH), { n: 31 });
});

test('updateJSON: a CREATE race (absent at read, rival creates first) is a conflict, not an error → retried with ifMatch', async () => {
  resetAll();
  fake.hooks.beforePut = async () => { fake.seed(PATH, { items: ['rival'] }); };
  const r = await STORE.updateJSON(PATH, (cur) => ({ ...cur, items: [...cur.items, 'mine'] }), { initial: { items: [] }, sleep: noSleep });
  assert.equal(r.attempts, 2);
  assert.deepEqual(fake.read(PATH), { items: ['rival', 'mine'] });
  assert.equal(fake.putCalls[0].opts.allowOverwrite, false, 'first attempt was a create');
  assert.ok(fake.putCalls[1].opts.ifMatch, 'second attempt is a conditional overwrite');
  assert.equal(STORE.getStoreCasStats().conflicts, 1);
});

test('updateJSON: retries exhausted → typed StoreCasConflictError, nothing of ours written, stats.exhausted bumped', async () => {
  resetAll();
  fake.seed(PATH, { n: 0 });
  const alwaysRival = async () => { fake.seed(PATH, { n: -1 }); fake.hooks.beforePut = alwaysRival; };
  fake.hooks.beforePut = alwaysRival;
  await assert.rejects(
    () => STORE.updateJSON(PATH, (cur) => ({ n: cur.n + 100 }), { retries: 2, sleep: noSleep }),
    (err) => {
      assert.ok(err instanceof STORE.StoreCasConflictError);
      assert.equal(err.name, 'StoreCasConflictError');
      assert.equal(err.code, 'CAS_CONFLICT');
      assert.equal(err.path, PATH);
      assert.equal(err.attempts, 3, 'retries:2 → 3 attempts total');
      return true;
    },
  );
  assert.equal(fake.putCalls.length, 3);
  assert.deepEqual(fake.read(PATH), { n: -1 }, 'the rival\'s last write stands; we never clobbered it');
  const stats = STORE.getStoreCasStats();
  assert.equal(stats.conflicts, 3);
  assert.equal(stats.exhausted, 1);
  assert.equal(stats.updates, 0);
});

test('updateJSON: retries:0 means exactly one attempt', async () => {
  resetAll();
  fake.seed(PATH, { n: 0 });
  fake.hooks.beforePut = async () => { fake.seed(PATH, { n: 5 }); };
  await assert.rejects(() => STORE.updateJSON(PATH, (cur) => ({ n: cur.n + 1 }), { retries: 0, sleep: noSleep }), { code: 'CAS_CONFLICT', attempts: 1 });
  assert.equal(fake.putCalls.length, 1);
});

// ── updateJSON: contract guards ──────────────────────────────────────────────

test('updateJSON: a mutateFn that MUTATES its input is refused (StoreCasMutationError) and nothing is written', async () => {
  resetAll();
  const etag = fake.seed(PATH, { items: ['a'] });
  await assert.rejects(
    () => STORE.updateJSON(PATH, (cur) => { cur.items.push('b'); return cur; }, { sleep: noSleep }),
    { name: 'StoreCasMutationError', code: 'CAS_MUTATED_INPUT' },
  );
  assert.equal(fake.putCalls.length, 0);
  assert.equal(fake.etagOf(PATH), etag);
  assert.deepEqual(fake.read(PATH), { items: ['a'] });
});

test('updateJSON: a mutateFn returning undefined (forgot to return) is a TypeError, not a write of "undefined"', async () => {
  resetAll();
  fake.seed(PATH, { n: 1 });
  await assert.rejects(() => STORE.updateJSON(PATH, () => {}, { sleep: noSleep }), TypeError);
  assert.equal(fake.putCalls.length, 0);
});

test('updateJSON: a NON-conflict put failure is rethrown at once — no retry storm on a real outage', async () => {
  resetAll();
  fake.seed(PATH, { n: 1 });
  const origPut = fake.exports.put;
  fake.exports.put = async () => { const e = new Error('Service unavailable'); e.name = 'BlobServiceNotAvailable'; throw e; };
  try {
    await assert.rejects(() => STORE.updateJSON(PATH, (cur) => ({ n: cur.n + 1 }), { sleep: noSleep }), /Service unavailable/);
  } finally { fake.exports.put = origPut; }
  assert.equal(STORE.getStoreCasStats().conflicts, 0);
});

test('updateJSON: validates its arguments at the boundary', async () => {
  resetAll();
  await assert.rejects(() => STORE.updateJSON(PATH, 'not-a-function'), TypeError);
  await assert.rejects(() => STORE.updateJSON('', () => ({})), TypeError);
  await assert.rejects(() => STORE.updateJSON(PATH, () => ({}), { retries: -1 }), RangeError);
});

test('updateJSON: without a Blob token it throws the same clear error writeJSON does', async () => {
  resetAll();
  const tok = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await assert.rejects(() => STORE.updateJSON(PATH, (c) => c, { sleep: noSleep }), /BLOB_READ_WRITE_TOKEN/);
    assert.deepEqual(await STORE.readJSONWithEtag(PATH), { value: null, etag: null, exists: false });
  } finally { process.env.BLOB_READ_WRITE_TOKEN = tok; }
});

// ── stats ────────────────────────────────────────────────────────────────────

test('getStoreCasStats returns a snapshot copy — callers cannot corrupt the counters', async () => {
  resetAll();
  const a = STORE.getStoreCasStats();
  a.conflicts = 999;
  assert.equal(STORE.getStoreCasStats().conflicts, 0);
  assert.deepEqual(Object.keys(a).sort(), ['conflicts', 'exhausted', 'lastConflictAt', 'updates']);
});

test('lib/store re-exports the CAS surface', () => {
  for (const name of ['updateJSON', 'readJSONWithEtag', 'getStoreCasStats', 'StoreCasConflictError']) {
    assert.equal(typeof STORE[name], name === 'StoreCasConflictError' ? 'function' : 'function', name);
    assert.equal(STORE[name], CAS[name], `${name} is the same binding as lib/store-cas`);
  }
});
