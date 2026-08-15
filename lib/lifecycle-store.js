'use strict';
// DURABLE STORE for opportunity-lifecycle records — one Blob doc per strategy per ET day
// (lifecycle/<strategy>/<date>.json holding { records: {ticker: record}, ... }).
//
// Backed by lib/store's generic JSON helpers, and degrades GRACEFULLY when Blob isn't
// configured (no BLOB_READ_WRITE_TOKEN): reads return an empty map, writes are a no-op that
// returns { persisted:false } instead of throwing. The route therefore still runs — the
// lifecycle just can't survive across serverless invocations until storage is provisioned.
// That limitation is surfaced (`durable`/`persisted`) rather than hidden.
const { readJSON, writeJSON, hasStore } = require('./store');

const LIFECYCLE_PREFIX = 'lifecycle/';
const keyFor = (strategy, date) => `${LIFECYCLE_PREFIX}${strategy}/${date}.json`;

function hasDurableStore() { return hasStore(); }

// Load { records, updatedAt, durable } for a strategy+date. Empty (never throws) when the
// doc is absent, malformed, or storage is unconfigured.
async function loadLifecycleDay(strategy, date) {
  const doc = await readJSON(keyFor(strategy, date), null).catch(() => null);
  const records = doc && doc.records && typeof doc.records === 'object' ? doc.records : {};
  return { records, updatedAt: (doc && doc.updatedAt) || null, durable: hasStore() };
}

// Persist the FULL records map for a strategy+date (idempotent per day). No CDN cache
// (cacheMaxAge 0) so a subsequent read-modify-write in the same session sees fresh state.
// Returns { persisted:boolean, reason? } and never throws — a storage failure must not take
// down the live board.
async function saveLifecycleDay(strategy, date, records) {
  if (!hasStore()) return { persisted: false, reason: 'no-store' };
  try {
    await writeJSON(keyFor(strategy, date), { strategy, date, records, updatedAt: new Date().toISOString() }, 0);
    return { persisted: true };
  } catch (e) {
    return { persisted: false, reason: String((e && e.message) || e) };
  }
}

// ── Immutable snapshot log + separate grades doc ─────────────────────────────
// Snapshots are APPEND-ONLY. Each append batch writes its OWN shard blob under
// lifecycle/<strategy>/snapshots/<date>/<ts>-<seq>-<rand>.json (a unique key that is never
// overwritten), and the reader merges every shard — the apex/fundshard/* pattern. This
// replaces the old read-modify-write of a single lifecycle/<strategy>/snapshots/<date>.json
// day doc, where two appends inside the Blob overwrite read-back window (10-30s) lost the
// earlier batch, and concurrent intraday captures interleaved. Legacy single-doc day files
// are still read (merged FIRST — they predate every shard) for backward compatibility.
// Grades live under lifecycle/<strategy>/grades/<date>.json — a SEPARATE doc, so grading an
// outcome never rewrites the original snapshot (the whole point of immutable capture).
const snapKey = (strategy, date) => `${LIFECYCLE_PREFIX}${strategy}/snapshots/${date}.json`;
const gradeKey = (strategy, date) => `${LIFECYCLE_PREFIX}${strategy}/grades/${date}.json`;
const snapShardPrefix = (strategy, date) => `${LIFECYCLE_PREFIX}${strategy}/snapshots/${date}/`;
const SNAP_SHARD_RE = /^lifecycle\/[\w.-]+\/snapshots\/\d{4}-\d{2}-\d{2}\/[\w.-]+\.json$/;
// Shard keys sort chronologically: ms epoch (zero-padded) + in-process sequence keeps
// same-instance appends ordered; the random tail makes cross-instance collisions impossible.
const SHARD_TS_PAD = 14;    // zero-pad ms epoch so lexicographic order == chronological order
const SHARD_SEQ_PAD = 6;
let snapShardSeq = 0;
function snapShardKey(strategy, date) {
  const ts = String(Date.now()).padStart(SHARD_TS_PAD, '0');
  const seq = String(snapShardSeq++).padStart(SHARD_SEQ_PAD, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${snapShardPrefix(strategy, date)}${ts}-${seq}-${rand}.json`;
}

// Merge legacy single-doc day file (if any) + every append shard, in chronological order.
// Best-effort like every reader here: unreadable shards are skipped, never thrown.
async function loadSnapshots(strategy, date) {
  const doc = await readJSON(snapKey(strategy, date), null).catch(() => null);
  const legacy = Array.isArray(doc && doc.snapshots) ? doc.snapshots : [];
  return legacy.concat(await loadSnapshotShards(strategy, date));
}

async function loadSnapshotShards(strategy, date) {
  if (!hasStore()) return [];
  try {
    const { list } = require('@vercel/blob');
    const blobs = [];
    let cursor;
    do {
      const r = await list({ prefix: snapShardPrefix(strategy, date), cursor, limit: 1000 });
      blobs.push(...(r.blobs || []));
      cursor = r.cursor;
    } while (cursor);
    const shards = blobs
      .filter(b => SNAP_SHARD_RE.test(b.pathname))
      .sort((a, b) => (a.pathname < b.pathname ? -1 : 1));   // ts-prefixed keys → append order
    const out = [];
    for (const b of shards) {
      try {
        const res = await fetch(b.url + (b.url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) continue;
        const j = await res.json();
        if (Array.isArray(j && j.snapshots)) out.push(...j.snapshots);
      } catch { /* skip unreadable shard */ }
    }
    return out;
  } catch { return []; }
}

// Append a batch by writing it to its OWN shard blob — no shared-doc read-modify-write, so
// concurrent (or rapid sequential) appends can never lose each other's batches. No-op
// { persisted:false } without a store; never throws.
async function appendSnapshots(strategy, date, snapshots) {
  if (!hasStore()) return { persisted: false, reason: 'no-store', total: 0 };
  if (!Array.isArray(snapshots) || !snapshots.length) return { persisted: true, appended: 0 };
  try {
    await writeJSON(snapShardKey(strategy, date), { strategy, date, snapshots, savedAt: new Date().toISOString() }, 0);
    return { persisted: true, appended: snapshots.length };
  } catch (e) {
    return { persisted: false, reason: String((e && e.message) || e) };
  }
}

async function loadGrades(strategy, date) {
  const doc = await readJSON(gradeKey(strategy, date), null).catch(() => null);
  return doc && doc.grades ? doc.grades : {};
}

// Merge every day's graded episodes into one flat array (across all accrued dates). Empty when
// storage is unconfigured. Used by the survival-model research harness.
async function loadAllGrades(strategy) {
  if (!hasStore()) return [];
  try {
    const { list } = require('@vercel/blob');
    const prefix = `${LIFECYCLE_PREFIX}${strategy}/grades/`;
    const rows = [];
    let cursor;
    do {
      const r = await list({ prefix, cursor, limit: 1000 });
      for (const b of r.blobs) {
        try {
          const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
          if (!res.ok) continue;
          const doc = await res.json();
          if (doc && doc.grades) rows.push(...Object.values(doc.grades));
        } catch { /* skip unreadable day */ }
      }
      cursor = r.cursor;
    } while (cursor);
    return rows;
  } catch { return []; }
}

async function saveGrades(strategy, date, grades) {
  if (!hasStore()) return { persisted: false, reason: 'no-store' };
  try {
    await writeJSON(gradeKey(strategy, date), { strategy, date, grades, updatedAt: new Date().toISOString() }, 0);
    return { persisted: true, count: Object.keys(grades || {}).length };
  } catch (e) {
    return { persisted: false, reason: String((e && e.message) || e) };
  }
}

// ── Stage-2 budget-rejection log ─────────────────────────────────────────────
// Every deep-validation budget rejection, WITH the lane/priority that lost and the candidate
// that occupied the marginal slot — so a recall miss caused by budget can be MEASURED by the
// capture/retrospective pipeline instead of inferred from the absence of a lifecycle record.
// Append-only per day, bounded (newest kept).
const rejKey = (strategy, date) => `${LIFECYCLE_PREFIX}${strategy}/rejections/${date}.json`;
const REJECTION_BATCH_CAP = 240;   // ~one batch/cycle × a full session at 60-150s cadence

async function loadStage2Rejections(strategy, date) {
  const doc = await readJSON(rejKey(strategy, date), null).catch(() => null);
  return Array.isArray(doc && doc.batches) ? doc.batches : [];
}

async function appendStage2Rejections(strategy, date, batch) {
  if (!hasStore()) return { persisted: false, reason: 'no-store' };
  try {
    const existing = await loadStage2Rejections(strategy, date);
    const merged = existing.concat([batch]).slice(-REJECTION_BATCH_CAP);
    await writeJSON(rejKey(strategy, date), { strategy, date, batches: merged, updatedAt: new Date().toISOString() }, 0);
    return { persisted: true, total: merged.length };
  } catch (e) {
    return { persisted: false, reason: String((e && e.message) || e) };
  }
}

module.exports = {
  hasDurableStore, loadLifecycleDay, saveLifecycleDay, LIFECYCLE_PREFIX, keyFor,
  loadSnapshots, appendSnapshots, loadGrades, loadAllGrades, saveGrades, snapKey, gradeKey, snapShardPrefix,
  loadStage2Rejections, appendStage2Rejections, rejKey,
};
