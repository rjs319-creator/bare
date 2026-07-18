// Immutable, append-only, hash-chained ledger (ledger-v1).
//
// WHY: every other Blob write in this app uses `allowOverwrite: true`, so a later
// run can silently replace a day's history and no consumer can tell. That's fine
// for self-correcting caches, but it means there is NO tamper-evident record of
// what the app actually decided on a given day. This module is the institutional
// fix: a write-once, forward-linked chain where each entry embeds the hash of the
// entry before it. Altering, reordering, or deleting any past entry breaks the
// chain, and `verify()` detects exactly where.
//
// STORAGE MODEL (fits Vercel Blob — no atomic append, eventually consistent CDN):
//   ledger/<stream>/<seq>.json   one immutable file per entry (allowOverwrite:FALSE)
//   ledger/<stream>/head.json    mutable convenience pointer to the tip (NOT trusted
//                                for integrity — verify() rebuilds from the entries)
//
// The write-once guarantee comes from Blob rejecting a second `put` to an existing
// pathname when allowOverwrite is false. The single daily cron is the only writer,
// so contention is effectively nil; append still re-derives the true tip by listing
// (not by trusting the possibly-stale head pointer) and retries on collision.
//
// Pure hashing helpers (stableStringify/hashEntry/verifyChain) take no I/O so they
// are unit-testable offline; the Blob-backed functions degrade to no-ops / empty
// reads when BLOB_READ_WRITE_TOKEN is absent, exactly like lib/store.js.
const crypto = require('crypto');

const LEDGER_VERSION = 'ledger-v1';
const GENESIS_HASH = '0'.repeat(64);
const SEQ_PAD = 12;                       // zero-pad so lexical Blob order == numeric order
const MAX_APPEND_RETRIES = 5;

function hasStore() { return !!process.env.BLOB_READ_WRITE_TOKEN; }

function base(stream) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(stream)) {
    throw new Error(`invalid ledger stream name: ${JSON.stringify(stream)}`);
  }
  return `ledger/${stream}/`;
}
const entryKey = (stream, seq) => `${base(stream)}${String(seq).padStart(SEQ_PAD, '0')}.json`;
const headKey = stream => `${base(stream)}head.json`;

// Deterministic JSON: object keys sorted recursively so the same logical payload
// always hashes identically regardless of key insertion order. Arrays keep order.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

// The hash covers everything that defines the entry EXCEPT the hash field itself,
// so it is self-verifying: recompute over the stored fields, compare to entry.hash.
function hashEntry({ v, stream, seq, prevHash, recordedAt, payload }) {
  const canonical = stableStringify({ v, stream, seq, prevHash, recordedAt, payload });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Walk a fully-materialised chain (array of entries in any order) and report the
// first integrity break. Pure — no I/O. Returns a structured verdict.
function verifyChain(stream, entries) {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const issues = [];
  let brokenAt = null;
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const fail = msg => { issues.push({ seq: e.seq, msg }); if (brokenAt === null) brokenAt = e.seq; };
    if (e.seq !== i) fail(`non-contiguous seq (expected ${i}, got ${e.seq})`);
    if (e.stream !== stream) fail(`stream mismatch (expected ${stream}, got ${e.stream})`);
    if (e.prevHash !== expectedPrev) fail(`prevHash breaks the chain (expected ${expectedPrev.slice(0, 12)}…, got ${String(e.prevHash).slice(0, 12)}…)`);
    const recomputed = hashEntry(e);
    if (recomputed !== e.hash) fail(`content hash mismatch — entry was altered (stored ${String(e.hash).slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…)`);
    expectedPrev = e.hash;
  }
  const tip = sorted[sorted.length - 1] || null;
  return {
    ok: issues.length === 0,
    stream,
    length: sorted.length,
    head: tip ? { seq: tip.seq, hash: tip.hash, recordedAt: tip.recordedAt } : null,
    brokenAt,
    issues,
  };
}

// ── Blob-backed operations ──────────────────────────────────────────────────

// List every entry pathname for a stream, in ascending seq order (lexical == numeric
// thanks to zero-padding). Excludes head.json.
async function listEntryBlobs(stream) {
  const { list } = require('@vercel/blob');
  const prefix = base(stream);
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{${SEQ_PAD}}\\.json$`);
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);
  return blobs.filter(b => re.test(b.pathname)).sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
}

async function fetchBlobJson(url) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`ledger blob fetch ${res.status}`);
  return res.json();
}

// Read the full chain (all entries, seq-ordered). Empty array when unconfigured.
async function readChain(stream) {
  if (!hasStore()) return [];
  const blobs = await listEntryBlobs(stream);
  const entries = await Promise.all(blobs.map(b => fetchBlobJson(b.url).catch(() => null)));
  return entries.filter(Boolean).sort((a, b) => a.seq - b.seq);
}

// The current tip {seq, hash, recordedAt} derived from the actual entries (not the
// head pointer), or null for an empty stream.
async function tip(stream) {
  if (!hasStore()) return null;
  const blobs = await listEntryBlobs(stream);
  const last = blobs[blobs.length - 1];
  if (!last) return null;
  try {
    const e = await fetchBlobJson(last.url);
    return { seq: e.seq, hash: e.hash, recordedAt: e.recordedAt };
  } catch { return null; }
}

// Append one immutable entry. Re-derives the true tip by listing (head pointer is
// only a cache), then write-once puts the new entry; a collision (someone else took
// that seq) triggers a bounded retry at the next seq. Returns the written entry.
async function append(stream, payload, { recordedAt } = {}) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const stamp = recordedAt || new Date().toISOString();

  let lastErr;
  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
    const current = await tip(stream);
    const seq = current ? current.seq + 1 : 0;
    const prevHash = current ? current.hash : GENESIS_HASH;
    const entry = { v: LEDGER_VERSION, stream, seq, prevHash, recordedAt: stamp, payload };
    entry.hash = hashEntry(entry);
    try {
      await put(entryKey(stream, seq), JSON.stringify(entry), {
        access: 'public',
        contentType: 'application/json',
        allowOverwrite: false,          // WRITE-ONCE — the whole point
        addRandomSuffix: false,
        cacheControlMaxAge: 0,          // an entry never changes, but reads must see it immediately
      });
    } catch (err) {
      lastErr = err;                    // most likely: seq already taken → re-derive tip and retry
      continue;
    }
    // Best-effort head pointer refresh (mutable cache; integrity does not depend on it).
    try {
      await put(headKey(stream), JSON.stringify({ seq, hash: entry.hash, recordedAt: stamp, updatedAt: new Date().toISOString() }), {
        access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 0,
      });
    } catch { /* head is only a convenience pointer */ }
    return entry;
  }
  throw new Error(`ledger append failed after ${MAX_APPEND_RETRIES} attempts: ${lastErr && lastErr.message}`);
}

// Full integrity check over the persisted chain.
async function verify(stream) {
  const chain = await readChain(stream);
  return verifyChain(stream, chain);
}

module.exports = {
  LEDGER_VERSION, GENESIS_HASH,
  stableStringify, hashEntry, verifyChain,     // pure, unit-testable
  append, readChain, verify, tip,              // Blob-backed
  hasStore,
};
