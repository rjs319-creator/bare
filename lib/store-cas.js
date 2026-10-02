'use strict';
// Compare-and-swap writes for shared Blob JSON docs (re-exported by lib/store.js).
//
// THE DEFECT THIS CLOSES. lib/store.js readJSON → writeJSON is last-writer-wins: two
// appends to the same doc inside Blob's 10-60s read-back window silently lose the earlier
// one (tech-evidence rows went 139 → 34 on 2026-08-15). @vercel/blob ≥2.4 returns an
// `etag` on list()/head() and honours `put(..., { ifMatch })`, failing the write with
// BlobPreconditionFailedError when the stored etag has moved on. `updateJSON` turns every
// read-modify-write into: read WITH etag → pure mutate → conditional put → on conflict
// re-read and re-apply. A concurrent writer can delay us; it can no longer erase us.
//
// Scope: multi-writer append/merge singletons (health merges, push subscriptions, the
// cron's health runs). Single-writer snapshots keep plain writeJSON — CAS adds a round
// trip and buys nothing there. Public blobs only (the app's store is public): the SDK's
// `get({ useCache:false })` consistent read is a no-op for public blobs, so the body is
// still fetched over the cache-busted public URL; a CDN-stale body paired with the fresh
// etag simply fails the precondition and retries (fail-closed, never a lost update).

const EXACT_MATCH_LIST_ROWS = 10;   // same order-independent exact-match lookup as store.readJSON
const DEFAULT_RETRIES = 5;
const DEFAULT_CACHE_MAX_AGE = 0;    // an RMW doc must never be served stale
const BACKOFF_BASE_MS = 120;
const BACKOFF_CAP_MS = 2000;
const NO_STORE_MESSAGE = 'Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).';

class StoreCasConflictError extends Error {
  constructor(path, attempts) {
    super(`CAS conflict on ${path}: ${attempts} attempt(s) all lost to a concurrent writer`);
    this.name = 'StoreCasConflictError';
    this.code = 'CAS_CONFLICT';
    this.path = path;
    this.attempts = attempts;
  }
}

class StoreCasMutationError extends Error {
  constructor(path) {
    super(`updateJSON(${path}): mutateFn mutated its input — it must return a NEW object`);
    this.name = 'StoreCasMutationError';
    this.code = 'CAS_MUTATED_INPUT';
    this.path = path;
  }
}

// ── Module-level conflict counters (per serverless instance; op=health surfaces them) ──
const ZERO_STATS = Object.freeze({ updates: 0, conflicts: 0, exhausted: 0, lastConflictAt: null });
let stats = ZERO_STATS;
const bumpStats = (patch) => { stats = Object.freeze({ ...stats, ...patch }); };
const getStoreCasStats = () => ({ ...stats });
const resetStoreCasStats = () => { stats = ZERO_STATS; };

const hasStore = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const blobClient = () => require('@vercel/blob');
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with full jitter in [50%, 100%] of the step — retrying writers
// de-synchronise instead of colliding again on the same beat.
function backoffMs(attempt) {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.max(1, Math.round(step * (0.5 + Math.random() * 0.5)));
}

// Exact-pathname row for `path` (url + etag) or null. THROWS on a list failure: a CAS
// loop must never mistake "could not look" for "absent" — that would downgrade the write
// to an unconditional create.
async function locate(path) {
  const { list } = blobClient();
  const r = await list({ prefix: path, limit: EXACT_MATCH_LIST_ROWS });
  return (r.blobs || []).find((b) => b.pathname === path) || null;
}

// list() rows carry the etag on ≥2.4; fall back to head() for an SDK/stub that omits it.
async function etagFor(hit) {
  if (hit.etag) return hit.etag;
  const { head } = blobClient();
  const h = await head(hit.url);
  return (h && h.etag) || null;
}

async function readJSONWithEtag(path) {
  if (!hasStore()) return { value: null, etag: null, exists: false };
  const hit = await locate(path);
  if (!hit) return { value: null, etag: null, exists: false };
  const etag = await etagFor(hit);
  const url = hit.url + (hit.url.includes('?') ? '&' : '?') + '_=' + Date.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`store-cas read ${path}: HTTP ${res.status}`);
  return { value: await res.json(), etag, exists: true };
}

// Conditional put. With an etag: overwrite only if unchanged. Without one (doc absent at
// read): create-only — the SDK rejects ifMatch together with allowOverwrite:false, and a
// create that finds the blob already there is the create-side race.
function putConditional(path, obj, etag, cacheMaxAge) {
  const { put } = blobClient();
  const condition = etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false };
  return put(path, JSON.stringify(obj), {
    access: 'public', contentType: 'application/json', addRandomSuffix: false,
    cacheControlMaxAge: cacheMaxAge, ...condition,
  });
}

function isPreconditionFailure(err) {
  if (!err) return false;
  const { BlobPreconditionFailedError } = blobClient();
  if (typeof BlobPreconditionFailedError === 'function' && err instanceof BlobPreconditionFailedError) return true;
  return err.name === 'BlobPreconditionFailedError' || /precondition failed/i.test(String(err.message));
}

// A failed CREATE is a conflict iff the doc now exists (a rival created it first).
async function isCreateRace(path, etag) {
  if (etag) return false;
  try { return !!(await locate(path)); } catch { return false; }
}

function validateUpdateArgs(path, mutateFn, retries) {
  if (typeof path !== 'string' || !path) throw new TypeError('updateJSON: path must be a non-empty string');
  if (typeof mutateFn !== 'function') throw new TypeError('updateJSON: mutateFn must be a function');
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('updateJSON: retries must be an integer ≥ 0');
}

// One read → mutate → conditional-put round. Returns the result, or null on a conflict.
async function attemptUpdate(path, mutateFn, { initial, cacheMaxAge, attempt }) {
  const { value, etag, exists } = await readJSONWithEtag(path);
  const current = exists ? value : initial;
  const before = JSON.stringify(current);
  const next = await mutateFn(current);
  if (JSON.stringify(current) !== before) throw new StoreCasMutationError(path);
  if (next === undefined) throw new TypeError(`updateJSON(${path}): mutateFn returned undefined — return the new doc (or the input to skip)`);
  if (next === current) return { written: false, value: current, etag, attempts: attempt + 1 };
  try {
    const put = await putConditional(path, next, etag, cacheMaxAge);
    bumpStats({ updates: stats.updates + 1 });
    return { written: true, value: next, etag: (put && put.etag) || null, attempts: attempt + 1 };
  } catch (err) {
    if (!isPreconditionFailure(err) && !(await isCreateRace(path, etag))) throw err;
    bumpStats({ conflicts: stats.conflicts + 1, lastConflictAt: new Date().toISOString() });
    return null;
  }
}

/**
 * Read-modify-write with optimistic concurrency.
 *   mutateFn(current) → NEW object (never mutate `current`; return it unchanged to skip).
 *   `current` is the stored doc, or `initial` when the doc does not exist yet.
 * Resolves { written, value, etag, attempts }. Throws StoreCasConflictError once
 * `retries` extra attempts are all lost to concurrent writers; rethrows any other error.
 */
async function updateJSON(path, mutateFn, { retries = DEFAULT_RETRIES, initial = null, cacheMaxAge = DEFAULT_CACHE_MAX_AGE, sleep = defaultSleep } = {}) {
  validateUpdateArgs(path, mutateFn, retries);
  if (!hasStore()) throw new Error(NO_STORE_MESSAGE);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await attemptUpdate(path, mutateFn, { initial, cacheMaxAge, attempt });
    if (result) return result;
    if (attempt < retries) await sleep(backoffMs(attempt));
  }
  bumpStats({ exhausted: stats.exhausted + 1 });
  throw new StoreCasConflictError(path, retries + 1);
}

module.exports = {
  updateJSON, readJSONWithEtag,
  getStoreCasStats, resetStoreCasStats,
  StoreCasConflictError, StoreCasMutationError,
  DEFAULT_RETRIES,
};
