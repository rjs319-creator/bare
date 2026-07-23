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
// Snapshots live under lifecycle/<strategy>/snapshots/<date>.json as an APPEND-ONLY array.
// Grades live under lifecycle/<strategy>/grades/<date>.json — a SEPARATE doc, so grading an
// outcome never rewrites the original snapshot (the whole point of immutable capture).
const snapKey = (strategy, date) => `${LIFECYCLE_PREFIX}${strategy}/snapshots/${date}.json`;
const gradeKey = (strategy, date) => `${LIFECYCLE_PREFIX}${strategy}/grades/${date}.json`;

async function loadSnapshots(strategy, date) {
  const doc = await readJSON(snapKey(strategy, date), null).catch(() => null);
  return Array.isArray(doc && doc.snapshots) ? doc.snapshots : [];
}

// Append a batch to the day's snapshot log (read-modify-write). Existing snapshots are kept
// verbatim; only new ones are appended. No-op { persisted:false } without a store; never throws.
async function appendSnapshots(strategy, date, snapshots) {
  if (!hasStore()) return { persisted: false, reason: 'no-store', total: 0 };
  if (!Array.isArray(snapshots) || !snapshots.length) return { persisted: true, appended: 0, total: (await loadSnapshots(strategy, date)).length };
  try {
    const existing = await loadSnapshots(strategy, date);
    const merged = existing.concat(snapshots);
    await writeJSON(snapKey(strategy, date), { strategy, date, snapshots: merged, updatedAt: new Date().toISOString() }, 0);
    return { persisted: true, appended: snapshots.length, total: merged.length };
  } catch (e) {
    return { persisted: false, reason: String((e && e.message) || e), total: 0 };
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

module.exports = {
  hasDurableStore, loadLifecycleDay, saveLifecycleDay, LIFECYCLE_PREFIX, keyFor,
  loadSnapshots, appendSnapshots, loadGrades, loadAllGrades, saveGrades, snapKey, gradeKey,
};
