'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../lib/immutable-ledger');

// Build a valid chain in memory the way append() would, so verifyChain has real hashes.
function makeChain(stream, payloads) {
  const entries = [];
  let prevHash = L.GENESIS_HASH;
  payloads.forEach((payload, seq) => {
    const e = { v: L.LEDGER_VERSION, stream, seq, prevHash, recordedAt: `2026-01-0${seq + 1}T00:00:00.000Z`, payload };
    e.hash = L.hashEntry(e);
    entries.push(e);
    prevHash = e.hash;
  });
  return entries;
}

// ── stableStringify: deterministic regardless of key order ──────────────────
test('stableStringify is key-order independent (so the same payload always hashes equal)', () => {
  const a = L.stableStringify({ b: 1, a: [3, { y: 2, x: 1 }] });
  const b = L.stableStringify({ a: [3, { x: 1, y: 2 }], b: 1 });
  assert.equal(a, b);
});

test('stableStringify preserves array order (arrays are ordered, objects are not)', () => {
  assert.notEqual(L.stableStringify([1, 2]), L.stableStringify([2, 1]));
});

// ── verifyChain: a well-formed chain passes ─────────────────────────────────
test('a valid hash-chain verifies ok with the tip as head', () => {
  const chain = makeChain('runs', [{ n: 0 }, { n: 1 }, { n: 2 }]);
  const v = L.verifyChain('runs', chain);
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.equal(v.length, 3);
  assert.equal(v.head.seq, 2);
  assert.equal(v.brokenAt, null);
});

test('verifyChain accepts entries in any order (it sorts by seq first)', () => {
  const chain = makeChain('runs', [{ n: 0 }, { n: 1 }, { n: 2 }]);
  const shuffled = [chain[2], chain[0], chain[1]];
  assert.equal(L.verifyChain('runs', shuffled).ok, true);
});

test('an empty stream verifies ok with a null head', () => {
  const v = L.verifyChain('runs', []);
  assert.equal(v.ok, true);
  assert.equal(v.head, null);
  assert.equal(v.length, 0);
});

// ── tamper detection ────────────────────────────────────────────────────────
test('editing a past entry payload breaks its content hash (tamper detected)', () => {
  const chain = makeChain('runs', [{ n: 0 }, { n: 1 }, { n: 2 }]);
  const tampered = chain.map((e, i) => (i === 1 ? { ...e, payload: { n: 999 } } : e)); // hash left stale
  const v = L.verifyChain('runs', tampered);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.ok(v.issues.some(x => /content hash mismatch/.test(x.msg)));
});

test('deleting a middle entry breaks contiguity + the forward link', () => {
  const chain = makeChain('runs', [{ n: 0 }, { n: 1 }, { n: 2 }]);
  const missing = [chain[0], chain[2]]; // seq 1 removed
  const v = L.verifyChain('runs', missing);
  assert.equal(v.ok, false);
  // chain[2] now sits at index 1 → non-contiguous seq AND its prevHash points at the deleted entry.
  assert.ok(v.issues.some(x => /non-contiguous seq/.test(x.msg)));
  assert.ok(v.issues.some(x => /prevHash breaks the chain/.test(x.msg)));
});

test('reordering (rewriting prevHash to forge a link) is caught by the recomputed hash', () => {
  const chain = makeChain('runs', [{ n: 0 }, { n: 1 }]);
  // Forge entry 1 to chain off GENESIS instead of entry 0, without recomputing hash.
  const forged = [chain[0], { ...chain[1], prevHash: L.GENESIS_HASH }];
  const v = L.verifyChain('runs', forged);
  assert.equal(v.ok, false);
});

// ── hashEntry stability ─────────────────────────────────────────────────────
test('hashEntry ignores the hash field itself and is reproducible', () => {
  const e = { v: L.LEDGER_VERSION, stream: 'runs', seq: 0, prevHash: L.GENESIS_HASH, recordedAt: '2026-01-01T00:00:00.000Z', payload: { a: 1 } };
  const h1 = L.hashEntry(e);
  const h2 = L.hashEntry({ ...e, hash: 'anything' });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});
