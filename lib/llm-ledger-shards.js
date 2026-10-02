'use strict';
// 🧾 LLM LEDGER SHARDS — per-writer daily Blob shards for append-only telemetry.
//
// WHY NOT read-modify-write. Vercel Blob overwrites propagate with a 10-60s lag and two
// concurrent writers of one doc lose each other's appends (see lib/pulse2-store.js and the
// tech-evidence store). A ledger whose counters only ever increase has a simpler safe shape:
// each PROCESS writes ONLY its own shard — `<prefix><YYYY-MM-DD>/<instanceId>.json` — and
// every write is the instance's full cumulative doc for that day, so a stale read-back is
// irrelevant (nothing is ever read before writing) and a lost write is repaired by the next
// flush. Readers list the day's shards and fold them (union of writers, monotonic per writer).
//
// Pure helpers are exported for tests; the store is injected so no test touches Blob.

const crypto = require('crypto');

// One id per process (Vercel instance / local script). Stable for the life of the process.
const INSTANCE_ID = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const SHARD_RE = /\.json$/;

/** 'YYYY-MM-DD' in UTC — Anthropic bills in UTC days, so the ledger does too. */
function utcDate(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayPrefix(prefix, date) {
  return `${prefix}${date}/`;
}

function shardPath(prefix, date, instanceId = INSTANCE_ID) {
  return `${dayPrefix(prefix, date)}${instanceId}.json`;
}

function defaultStore() {
  return require('./store');
}

/**
 * Overwrite this process's shard for `date`. Never throws — returns `{ written, error }`.
 * `doc` must already be the instance's full cumulative record for that day.
 */
async function writeShard(prefix, date, doc, { instanceId = INSTANCE_ID, store = null } = {}) {
  const s = store || defaultStore();
  if (!s.hasStore()) return { written: false, error: 'no-store' };
  try {
    await s.writeJSON(shardPath(prefix, date, instanceId), doc, 0);
    return { written: true, error: null };
  } catch (err) {
    return { written: false, error: err && err.message ? String(err.message).slice(0, 200) : String(err) };
  }
}

/** All shard docs for one day (order unspecified). Never throws — unreadable shards are dropped. */
async function readDayShards(prefix, date, { store = null } = {}) {
  const s = store || defaultStore();
  if (!s.hasStore()) return [];
  try {
    const docs = await s.readAllByPrefix(dayPrefix(prefix, date), SHARD_RE);
    return Array.isArray(docs) ? docs.filter(d => d && typeof d === 'object') : [];
  } catch {
    return [];
  }
}

module.exports = { INSTANCE_ID, utcDate, dayPrefix, shardPath, writeShard, readDayShards };
