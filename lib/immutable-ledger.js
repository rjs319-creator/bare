// Immutable, append-only, hash-chained ledger (ledger-v1).
//
// WHY: every other Blob write in this app uses `allowOverwrite: true`, so a later
// run can silently replace a day's history and no consumer can tell. That's fine
// for self-correcting caches, but it means there is NO tamper-evident record of
// what the app actually decided on a given day. This module is the institutional
// fix: a write-once, forward-linked chain where each entry embeds the hash of the
// entry before it.
//
// WHAT VERIFICATION CAN AND CANNOT CLAIM:
//   • Altering, reordering, or deleting an INTERIOR entry breaks the chain, and
//     `verify()` reports where (status `invalid`, `brokenAt`).
//   • Deleting the LAST N entries leaves a perfectly valid shorter chain. That is
//     NOT detectable from the entries alone, and head.json is deliberately untrusted.
//     verify() therefore reports `terminalDeletion: 'undetectable-without-checkpoint'`
//     unless the caller supplies an `expectedHead {seq, hash}` obtained from an
//     INDEPENDENT source (never from this stream's own head.json).
//   • A verdict covers the complete LISTED inventory or it is not a verdict: if any
//     listed entry cannot be read (middle, tail or all) the result is `incomplete`.
//     A valid readable prefix is never reported as a verified chain.
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
// Pure hashing helpers (stableStringify/hashEntry/verifyChain/verifyInventory) take no
// I/O so they are unit-testable offline. Without BLOB_READ_WRITE_TOKEN reads return
// empty and verify() answers `unconfigured` (never "verified empty").
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

// ── Inventory-aware verification (pure) ─────────────────────────────────────
//
// verifyChain above answers "is THIS array a valid chain?". It cannot know whether the
// array is everything that exists. verifyInventory is told what the listing reported
// (`listedSeqs`), what was actually read (`entries`) and what failed to read
// (`unreadable`), so a partial read can never be mistaken for a whole chain.
//
//   verified     every listed entry was read and the chain is intact          ok:true
//   empty        the listing SUCCEEDED and returned zero entries              ok:true
//   incomplete   ≥1 listed entry could not be read (middle, tail or all)      ok:false
//   invalid      a hash / prevHash / seq break at `brokenAt`, or a failed
//                expectedHead checkpoint                                     ok:false
//   listing-error / unconfigured — produced by verify() (no inventory at all) ok:false
const VERIFY_STATUS = Object.freeze({
  VERIFIED: 'verified', EMPTY: 'empty', INCOMPLETE: 'incomplete', INVALID: 'invalid',
  LISTING_ERROR: 'listing-error', UNCONFIGURED: 'unconfigured',
});
const TERMINAL_DELETION = Object.freeze({
  UNDETECTABLE: 'undetectable-without-checkpoint',   // no independent checkpoint supplied
  NONE: 'none-at-checkpoint',                        // chain still contains the checkpoint entry
  DETECTED: 'detected',                              // chain ends BEFORE the checkpoint
  MISMATCH: 'checkpoint-mismatch',                   // entry at the checkpoint seq has another hash
  UNKNOWN: 'unknown',                                // checkpoint supplied but the read was not complete
});

// A caller-supplied checkpoint is only usable when it is well-formed. Anything else is
// ignored (reported as "no checkpoint"), never trusted.
function normalizeExpectedHead(h) {
  if (!h || typeof h !== 'object') return null;
  if (!Number.isInteger(h.seq) || h.seq < 0) return null;
  if (typeof h.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(h.hash)) return null;
  return { seq: h.seq, hash: h.hash.toLowerCase() };
}

// Each entry is self-verifying: its stored hash must equal the hash of its own fields.
// That check needs no neighbours, so it stays meaningful over a partial read.
function contentIssues(entries) {
  const issues = [];
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const recomputed = hashEntry(e);
    if (recomputed !== e.hash) {
      issues.push({ seq: e.seq, msg: `content hash mismatch — entry was altered (stored ${String(e.hash).slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…)` });
    }
  }
  return issues;
}

// Check a complete, intact chain against an independent checkpoint.
function checkExpectedHead(sorted, expected) {
  const at = sorted.find((e) => e.seq === expected.seq) || null;
  if (!at) {
    const tipSeq = sorted.length ? sorted[sorted.length - 1].seq : null;
    return {
      terminalDeletion: TERMINAL_DELETION.DETECTED,
      issue: { seq: expected.seq, msg: `terminal deletion — the checkpoint expects seq ${expected.seq} but the chain ends at ${tipSeq === null ? 'nothing (empty)' : `seq ${tipSeq}`}` },
    };
  }
  if (String(at.hash).toLowerCase() !== expected.hash) {
    return {
      terminalDeletion: TERMINAL_DELETION.MISMATCH,
      issue: { seq: expected.seq, msg: `checkpoint mismatch — seq ${expected.seq} has hash ${String(at.hash).slice(0, 12)}…, the checkpoint expects ${expected.hash.slice(0, 12)}…` },
    };
  }
  return { terminalDeletion: TERMINAL_DELETION.NONE, issue: null };
}

function verifyInventory(stream, { listedSeqs = [], entries = [], unreadable = [] } = {}, { expectedHead = null } = {}) {
  const listed = [...listedSeqs].sort((a, b) => a - b);
  const missing = [...unreadable].sort((a, b) => a - b);
  const expected = normalizeExpectedHead(expectedHead);
  const verdict = {
    stream, listed: listed.length, read: entries.length, listedSeqs: listed, unreadable: missing,
    length: entries.length, head: null, brokenAt: null, issues: [],
    terminalDeletion: expected ? TERMINAL_DELETION.UNKNOWN : TERMINAL_DELETION.UNDETECTABLE,
  };

  if (missing.length) {
    // Not everything listed could be read. An entry whose OWN hash is wrong is still
    // definite evidence of alteration; anything about links or the head is unknowable.
    const altered = contentIssues(entries);
    if (altered.length) {
      return { ...verdict, ok: false, status: VERIFY_STATUS.INVALID, brokenAt: altered[0].seq, issues: altered };
    }
    return {
      ...verdict, ok: false, status: VERIFY_STATUS.INCOMPLETE,
      issues: [{ seq: missing[0], msg: `${missing.length} of ${listed.length} listed entries could not be read — the chain is unverifiable, not verified over the readable part` }],
    };
  }

  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  if (!listed.length) {
    if (expected) {
      const cp = checkExpectedHead(sorted, expected);
      return { ...verdict, ok: false, status: VERIFY_STATUS.INVALID, brokenAt: expected.seq, issues: [cp.issue], terminalDeletion: cp.terminalDeletion };
    }
    return { ...verdict, ok: true, status: VERIFY_STATUS.EMPTY };
  }

  const chain = verifyChain(stream, sorted);
  if (!chain.ok) {
    return { ...verdict, ok: false, status: VERIFY_STATUS.INVALID, brokenAt: chain.brokenAt, issues: chain.issues };
  }
  if (expected) {
    const cp = checkExpectedHead(sorted, expected);
    if (cp.issue) {
      return { ...verdict, ok: false, status: VERIFY_STATUS.INVALID, head: chain.head, brokenAt: expected.seq, issues: [cp.issue], terminalDeletion: cp.terminalDeletion };
    }
    return { ...verdict, ok: true, status: VERIFY_STATUS.VERIFIED, head: chain.head, terminalDeletion: cp.terminalDeletion };
  }
  return { ...verdict, ok: true, status: VERIFY_STATUS.VERIFIED, head: chain.head };
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

// The I/O seam. Tests inject `{ io: { hasStore, listEntryBlobs, fetchBlobJson, put } }`;
// production uses the Blob-backed functions above.
const defaultPut = (...args) => require('@vercel/blob').put(...args);
const DEFAULT_IO = Object.freeze({ hasStore, listEntryBlobs, fetchBlobJson, put: defaultPut });
const ioOf = (io) => ({ ...DEFAULT_IO, ...(io || {}) });

// The seq a listed pathname claims (…/000000000007.json → 7), or null.
function seqOfPath(pathname) {
  const m = /(\d+)\.json$/.exec(String(pathname || ''));
  return m ? Number(m[1]) : null;
}

// List the stream and try to read EVERY listed entry, keeping what the listing said
// beside what was actually read. Never throws: a listing failure is a result.
//   { state: 'unconfigured' | 'listing-error' | 'listed', listedSeqs, entries, unreadable, error }
async function readInventory(stream, { io } = {}) {
  const d = ioOf(io);
  if (!d.hasStore()) return { state: 'unconfigured', listedSeqs: [], entries: [], unreadable: [], error: null };
  let blobs;
  try { blobs = await d.listEntryBlobs(stream); }
  catch (e) { return { state: 'listing-error', listedSeqs: [], entries: [], unreadable: [], error: String((e && e.message) || e).slice(0, 200) }; }
  const listedSeqs = blobs.map((b) => seqOfPath(b.pathname));
  const fetched = await Promise.all(blobs.map((b) => d.fetchBlobJson(b.url).then((v) => v || null, () => null)));
  const entries = fetched.filter(Boolean).sort((a, b) => a.seq - b.seq);
  const unreadable = listedSeqs.filter((_, i) => !fetched[i]);
  return { state: 'listed', listedSeqs, entries, unreadable, error: null };
}

// Read the full chain (all READABLE entries, seq-ordered). Empty array when unconfigured.
// The array carries `listed` / `unreadable` / `complete` so a caller that only wants the
// rows can still tell a short read from a short chain; integrity questions go to verify().
async function readChain(stream, { io } = {}) {
  const d = ioOf(io);
  if (!d.hasStore()) return Object.assign([], { listed: 0, unreadable: [], complete: true });
  const blobs = await d.listEntryBlobs(stream);
  const fetched = await Promise.all(blobs.map(b => d.fetchBlobJson(b.url).catch(() => null)));
  const unreadable = blobs.map((b) => seqOfPath(b.pathname)).filter((_, i) => !fetched[i]);
  const rows = fetched.filter(Boolean).sort((a, b) => a.seq - b.seq);
  return Object.assign(rows, { listed: blobs.length, unreadable, complete: unreadable.length === 0 });
}

// The current tip {seq, hash, recordedAt} derived from the actual entries (not the
// head pointer), or null for an empty stream. Kept lenient for READERS (an unreadable
// tail reads as null); append uses tipStrict below.
async function tip(stream, { io } = {}) {
  const d = ioOf(io);
  if (!d.hasStore()) return null;
  const blobs = await d.listEntryBlobs(stream);
  const last = blobs[blobs.length - 1];
  if (!last) return null;
  try {
    const e = await d.fetchBlobJson(last.url);
    return { seq: e.seq, hash: e.hash, recordedAt: e.recordedAt };
  } catch { return null; }
}

// The tip for WRITERS: null only when the listing SUCCEEDED and is empty. An unreadable
// listed tail throws — append must never treat "could not read the tip" as "no entries"
// and try to start a second chain at seq 0.
async function tipStrict(stream, { io } = {}) {
  const d = ioOf(io);
  const blobs = await d.listEntryBlobs(stream);
  const last = blobs[blobs.length - 1];
  if (!last) return null;
  let e;
  try { e = await d.fetchBlobJson(last.url); }
  catch (err) { throw new Error(`ledger tip for "${stream}" is listed but unreadable (${String((err && err.message) || err).slice(0, 120)}) — refusing to append`); }
  if (!e || !Number.isInteger(e.seq) || typeof e.hash !== 'string') {
    throw new Error(`ledger tip for "${stream}" is listed but unreadable (malformed entry) — refusing to append`);
  }
  return { seq: e.seq, hash: e.hash, recordedAt: e.recordedAt };
}

// Append one immutable entry. Re-derives the true tip by listing (head pointer is
// only a cache), then write-once puts the new entry; a collision (someone else took
// that seq) triggers a bounded retry at the next seq. Returns the written entry.
// Never rewrites or deletes an existing entry.
async function append(stream, payload, { recordedAt, io } = {}) {
  const d = ioOf(io);
  if (!d.hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const stamp = recordedAt || new Date().toISOString();

  let lastErr;
  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
    const current = await tipStrict(stream, { io });
    const seq = current ? current.seq + 1 : 0;
    const prevHash = current ? current.hash : GENESIS_HASH;
    const entry = { v: LEDGER_VERSION, stream, seq, prevHash, recordedAt: stamp, payload };
    entry.hash = hashEntry(entry);
    try {
      await d.put(entryKey(stream, seq), JSON.stringify(entry), {
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
      await d.put(headKey(stream), JSON.stringify({ seq, hash: entry.hash, recordedAt: stamp, updatedAt: new Date().toISOString() }), {
        access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 0,
      });
    } catch { /* head is only a convenience pointer */ }
    return entry;
  }
  throw new Error(`ledger append failed after ${MAX_APPEND_RETRIES} attempts: ${lastErr && lastErr.message}`);
}

// Full integrity check over the persisted chain. Never throws and never writes.
//   expectedHead  optional {seq, hash} from an INDEPENDENT source (see the header) —
//                 the only way a deletion of the newest entries can be detected.
async function verify(stream, { expectedHead = null, io } = {}) {
  const inv = await readInventory(stream, { io });
  if (inv.state === 'unconfigured' || inv.state === 'listing-error') {
    return {
      ok: false,
      status: inv.state === 'unconfigured' ? VERIFY_STATUS.UNCONFIGURED : VERIFY_STATUS.LISTING_ERROR,
      stream, listed: null, read: 0, listedSeqs: [], unreadable: [], length: 0, head: null, brokenAt: null, issues: [],
      terminalDeletion: TERMINAL_DELETION.UNKNOWN,
      error: inv.error || 'Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).',
    };
  }
  return verifyInventory(stream, inv, { expectedHead });
}

module.exports = {
  LEDGER_VERSION, GENESIS_HASH, VERIFY_STATUS, TERMINAL_DELETION,
  stableStringify, hashEntry, verifyChain, verifyInventory,   // pure, unit-testable
  append, readChain, readInventory, verify, tip,               // Blob-backed
  hasStore,
};
