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

module.exports = { hasDurableStore, loadLifecycleDay, saveLifecycleDay, LIFECYCLE_PREFIX, keyFor };
