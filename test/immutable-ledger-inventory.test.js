'use strict';
// Inventory-aware ledger verification (lib/immutable-ledger.js verify / verifyInventory).
//
// THE DEFECT: readChain() dropped every entry it could not fetch and verify() then walked
// whatever was left — so an unreadable TAIL verified ok over the readable prefix, and a
// stream whose entries were ALL unreadable verified ok as an "empty" stream. A valid prefix
// is not a verified chain. These tests pin the distinct verdicts with mocked I/O only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/immutable-ledger');

const STREAM = 'unit';

function makeChain(payloads) {
  const entries = [];
  let prevHash = L.GENESIS_HASH;
  payloads.forEach((payload, seq) => {
    const e = { v: L.LEDGER_VERSION, stream: STREAM, seq, prevHash, recordedAt: `2026-01-0${seq + 1}T00:00:00.000Z`, payload };
    e.hash = L.hashEntry(e);
    entries.push(e);
    prevHash = e.hash;
  });
  return entries;
}
const pathOf = (seq) => `ledger/${STREAM}/${String(seq).padStart(12, '0')}.json`;

// Mocked Blob: `entries` are what is LISTED; `unreadable` seqs fail on fetch.
function fakeIo(entries, { unreadable = [], listError = null, configured = true } = {}) {
  const calls = { list: 0, fetch: 0, writes: 0 };
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  return {
    calls,
    hasStore: () => configured,
    listEntryBlobs: async () => {
      calls.list += 1;
      if (listError) throw new Error(listError);
      return entries.map((e) => ({ pathname: pathOf(e.seq), url: `https://blob.test/${e.seq}` }));
    },
    fetchBlobJson: async (url) => {
      calls.fetch += 1;
      const seq = Number(url.split('/').pop());
      if (unreadable.includes(seq)) throw new Error('ledger blob fetch 503');
      return bySeq.get(seq);
    },
  };
}

test('verify: a healthy, fully readable chain is VERIFIED with the tip as head', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  const v = await L.verify(STREAM, { io: fakeIo(chain) });
  assert.equal(v.status, 'verified'); assert.equal(v.ok, true);
  assert.equal(v.listed, 4); assert.equal(v.read, 4); assert.deepEqual(v.unreadable, []);
  assert.equal(v.length, 4); assert.equal(v.head.seq, 3); assert.equal(v.head.hash, chain[3].hash);
  assert.equal(v.brokenAt, null);
});

test('verify: a listing that SUCCEEDS with zero entries is a genuinely EMPTY stream (ok, null head)', async () => {
  const v = await L.verify(STREAM, { io: fakeIo([]) });
  assert.equal(v.status, 'empty'); assert.equal(v.ok, true);
  assert.equal(v.listed, 0); assert.equal(v.head, null);
});

test('verify: an unreadable TAIL is INCOMPLETE — the readable prefix is never a verified chain', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  const v = await L.verify(STREAM, { io: fakeIo(chain, { unreadable: [2, 3] }) });
  assert.equal(v.status, 'incomplete'); assert.equal(v.ok, false);
  assert.equal(v.listed, 4); assert.equal(v.read, 2); assert.deepEqual(v.unreadable, [2, 3]);
  assert.equal(v.head, null, 'no head is claimed over a partial read');
});

test('verify: an unreadable MIDDLE entry is INCOMPLETE, not reported as tampering', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  const v = await L.verify(STREAM, { io: fakeIo(chain, { unreadable: [2] }) });
  assert.equal(v.status, 'incomplete'); assert.equal(v.ok, false);
  assert.deepEqual(v.unreadable, [2]); assert.equal(v.listed, 4); assert.equal(v.read, 3);
  assert.equal(v.brokenAt, null, 'an unreadable entry is not a broken link');
});

test('verify: ALL entries unreadable is INCOMPLETE — never an "empty" stream', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }]);
  const v = await L.verify(STREAM, { io: fakeIo(chain, { unreadable: [0, 1, 2] }) });
  assert.equal(v.status, 'incomplete'); assert.equal(v.ok, false);
  assert.equal(v.listed, 3); assert.equal(v.read, 0); assert.deepEqual(v.unreadable, [0, 1, 2]);
});

test('verify: a LISTING failure is its own status, and no entry is fetched', async () => {
  const io = fakeIo(makeChain([{ a: 1 }]), { listError: 'blob list 500' });
  const v = await L.verify(STREAM, { io });
  assert.equal(v.status, 'listing-error'); assert.equal(v.ok, false);
  assert.match(v.error, /blob list 500/); assert.equal(io.calls.fetch, 0);
  assert.equal(v.listed, null, 'the inventory is unknown, not zero');
});

test('verify: an unconfigured store is UNCONFIGURED — not a verified empty chain', async () => {
  const io = fakeIo([], { configured: false });
  const v = await L.verify(STREAM, { io });
  assert.equal(v.status, 'unconfigured'); assert.equal(v.ok, false);
  assert.equal(io.calls.list, 0);
});

test('verify: a corrupted hash is INVALID at brokenAt (fully readable chain)', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }]);
  const tampered = chain.map((e) => (e.seq === 1 ? { ...e, payload: { b: 999 } } : e));
  const v = await L.verify(STREAM, { io: fakeIo(tampered) });
  assert.equal(v.status, 'invalid'); assert.equal(v.ok, false); assert.equal(v.brokenAt, 1);
  assert.ok(v.issues.some((i) => /content hash mismatch/.test(i.msg)));
});

test('verify: a forged prevHash link is INVALID at the forged entry', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }]);
  const forged = { ...chain[2], prevHash: 'f'.repeat(64) };
  forged.hash = L.hashEntry(forged);
  const v = await L.verify(STREAM, { io: fakeIo([chain[0], chain[1], forged]) });
  assert.equal(v.status, 'invalid'); assert.equal(v.brokenAt, 2);
});

test('verify: a definitely altered entry is INVALID even when other entries are unreadable', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  const tampered = chain.map((e) => (e.seq === 0 ? { ...e, payload: { a: 'x' } } : e));
  const v = await L.verify(STREAM, { io: fakeIo(tampered, { unreadable: [3] }) });
  assert.equal(v.status, 'invalid'); assert.equal(v.brokenAt, 0); assert.deepEqual(v.unreadable, [3]);
});

test('verify: an interior DELETION (seq missing from the listing) is INVALID', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  const v = await L.verify(STREAM, { io: fakeIo([chain[0], chain[1], chain[3]]) });
  assert.equal(v.status, 'invalid'); assert.equal(v.ok, false); assert.equal(v.brokenAt, 3);
});

test('verify: terminal deletion is UNDETECTABLE without a checkpoint — and says so', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  // The last two entries were deleted: what is left is a perfectly valid shorter chain.
  const v = await L.verify(STREAM, { io: fakeIo(chain.slice(0, 2)) });
  assert.equal(v.status, 'verified');
  assert.equal(v.terminalDeletion, 'undetectable-without-checkpoint');
  const empty = await L.verify(STREAM, { io: fakeIo([]) });
  assert.equal(empty.terminalDeletion, 'undetectable-without-checkpoint');
});

test('verify: an independently supplied expectedHead DETECTS a terminal deletion', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  const expectedHead = { seq: 3, hash: chain[3].hash };
  const cut = await L.verify(STREAM, { io: fakeIo(chain.slice(0, 2)), expectedHead });
  assert.equal(cut.status, 'invalid'); assert.equal(cut.ok, false); assert.equal(cut.terminalDeletion, 'detected');
  const wiped = await L.verify(STREAM, { io: fakeIo([]), expectedHead });
  assert.equal(wiped.status, 'invalid'); assert.equal(wiped.terminalDeletion, 'detected');
  // Intact at the checkpoint, and grown past it: both fine.
  const exact = await L.verify(STREAM, { io: fakeIo(chain), expectedHead });
  assert.equal(exact.status, 'verified'); assert.equal(exact.terminalDeletion, 'none-at-checkpoint');
  const grown = await L.verify(STREAM, { io: fakeIo(chain), expectedHead: { seq: 1, hash: chain[1].hash } });
  assert.equal(grown.status, 'verified'); assert.equal(grown.terminalDeletion, 'none-at-checkpoint');
  // A checkpoint hash that does not match the entry at that seq = the history was rewritten.
  const rewritten = await L.verify(STREAM, { io: fakeIo(chain), expectedHead: { seq: 3, hash: 'a'.repeat(64) } });
  assert.equal(rewritten.status, 'invalid'); assert.equal(rewritten.terminalDeletion, 'checkpoint-mismatch');
});

test('verify: a malformed expectedHead is ignored, never trusted as a checkpoint', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }]);
  const v = await L.verify(STREAM, { io: fakeIo(chain), expectedHead: { seq: 'x' } });
  assert.equal(v.status, 'verified'); assert.equal(v.terminalDeletion, 'undetectable-without-checkpoint');
});

test('verify never writes: verification is read-only whatever it finds', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }]);
  const io = fakeIo(chain, { unreadable: [1] });
  io.put = async () => { io.calls.writes += 1; };
  await L.verify(STREAM, { io });
  assert.equal(io.calls.writes, 0);
});

test('verifyInventory is pure and keeps the complete LISTED inventory in its verdict', () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }]);
  const v = L.verifyInventory(STREAM, { listedSeqs: [0, 1, 2], entries: [chain[0], chain[2]], unreadable: [1] });
  assert.equal(v.status, 'incomplete'); assert.equal(v.listed, 3); assert.equal(v.read, 2);
  assert.deepEqual(v.listedSeqs, [0, 1, 2]);
});

test('readChain still returns the readable entries, now with listed/unreadable counts attached', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }, { c: 3 }]);
  const rows = await L.readChain(STREAM, { io: fakeIo(chain, { unreadable: [2] }) });
  assert.deepEqual(rows.map((e) => e.seq), [0, 1]);
  assert.equal(rows.listed, 3); assert.deepEqual(rows.unreadable, [2]); assert.equal(rows.complete, false);
});

test('append refuses to guess the tip when the listed tail is unreadable (no fork at seq 0)', async () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }]);
  const io = fakeIo(chain, { unreadable: [1] });
  const puts = [];
  io.put = async (key) => { puts.push(key); };
  await assert.rejects(() => L.append(STREAM, { x: 1 }, { io }), /tip .*unreadable/i);
  assert.deepEqual(puts, [], 'nothing is written when the tip cannot be read');
});

test('the pure verifyChain contract is unchanged for existing callers', () => {
  const chain = makeChain([{ a: 1 }, { b: 2 }]);
  const v = L.verifyChain(STREAM, chain);
  assert.equal(v.ok, true); assert.equal(v.length, 2); assert.equal(v.head.seq, 1);
  assert.equal(L.verifyChain(STREAM, []).ok, true);
});
