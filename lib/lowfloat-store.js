'use strict';
// BLOB PERSISTENCE for the low-float / intraday-continuation stack.
//
// Thin layer over lib/store.js's generic readJSON/writeJSON so every new document type has
// ONE canonical path builder and the callers never hand-assemble a key. Reads degrade to a
// fallback when Blob is not configured (the whole stack stays operable, just non-durable);
// writes throw so a caller that must persist learns about it instead of silently dropping
// research data.
//
// PATHS (all under stable prefixes so listing by day is cheap):
//   intraday-discovery/<YYYY-MM-DD>/<timestamp>.json   every Stage-0 candidate, per scan
//   low-float-ignition/<YYYY-MM-DD>/<timestamp>.json   every Stage-1 scored candidate
//   intraday-continuation/<YYYY-MM-DD>/<timestamp>.json every Stage-2 analyzed candidate
//   intraday-events/<YYYY-MM-DD>.json                  point-in-time paper-entry events
//   intraday-outcomes/<YYYY-MM-DD>.json                resolved same-session outcomes
//   large-mover-audit/<YYYY-MM-DD>.json                the daily miss audit
//   lowfloat/universe.json                             the eligible tradable universe
//   lowfloat/float-cache.json                          float metadata by ticker
//   lowfloat/promotion.json                            per-template promotion state
//   lowfloat/alert-state.json                          alert dedup / cooldown state

const { readJSON, writeJSON, hasStore } = require('./store');

const DISCOVERY_PREFIX = 'intraday-discovery/';
const IGNITION_PREFIX = 'low-float-ignition/';
const CONTINUATION_PREFIX = 'intraday-continuation/';
const EVENTS_PREFIX = 'intraday-events/';
const OUTCOMES_PREFIX = 'intraday-outcomes/';
const AUDIT_PREFIX = 'large-mover-audit/';

const UNIVERSE_KEY = 'lowfloat/universe.json';
const FLOAT_CACHE_KEY = 'lowfloat/float-cache.json';
const PROMOTION_KEY = 'lowfloat/promotion.json';
const ALERT_STATE_KEY = 'lowfloat/alert-state.json';

// Compact, path-safe instant: 2026-08-05T14:35:12Z → 20260805T143512Z.
function stamp(at = new Date()) {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

const discoveryKey = (date, at) => `${DISCOVERY_PREFIX}${date}/${stamp(at)}.json`;
const ignitionKey = (date, at) => `${IGNITION_PREFIX}${date}/${stamp(at)}.json`;
const continuationKey = (date, at) => `${CONTINUATION_PREFIX}${date}/${stamp(at)}.json`;
const eventsKey = date => `${EVENTS_PREFIX}${date}.json`;
const outcomesKey = date => `${OUTCOMES_PREFIX}${date}.json`;
const auditKey = date => `${AUDIT_PREFIX}${date}.json`;

// ── Per-scan snapshot writers. `cacheMaxAge` 0 — these are research records that must be
//    readable immediately by the grader, never served from a CDN window.
const writeDiscoverySnapshot = (date, doc, at) => writeJSON(discoveryKey(date, at), doc, 0);
const writeIgnitionSnapshot = (date, doc, at) => writeJSON(ignitionKey(date, at), doc, 0);
const writeContinuationSnapshot = (date, doc, at) => writeJSON(continuationKey(date, at), doc, 0);

const readEventsDay = date => readJSON(eventsKey(date), null);
const writeEventsDay = (date, doc) => writeJSON(eventsKey(date), doc, 0);
const readOutcomesDay = date => readJSON(outcomesKey(date), null);
const writeOutcomesDay = (date, doc) => writeJSON(outcomesKey(date), doc, 0);
const readAuditDay = date => readJSON(auditKey(date), null);
const writeAuditDay = (date, doc) => writeJSON(auditKey(date), doc, 0);

const readUniverse = () => readJSON(UNIVERSE_KEY, null);
const writeUniverse = doc => writeJSON(UNIVERSE_KEY, doc, 0);
const readFloatCache = () => readJSON(FLOAT_CACHE_KEY, null);
const writeFloatCache = doc => writeJSON(FLOAT_CACHE_KEY, doc, 0);
const readPromotionState = () => readJSON(PROMOTION_KEY, null);
const writePromotionState = doc => writeJSON(PROMOTION_KEY, doc, 0);
const readAlertState = () => readJSON(ALERT_STATE_KEY, null);
const writeAlertState = doc => writeJSON(ALERT_STATE_KEY, doc, 0);

// APPEND-ONLY event log for a session day. Read-modify-write against a Blob is racy in
// general; here the ONLY writer is the privileged tick (one lease-guarded caller per cycle),
// and readJSON cache-busts its URL, so a lost update would require two concurrent privileged
// ticks — which the tick's own lease already prevents. Events are deduped by id so a retry
// after a partial failure cannot double-log.
async function appendEvents(date, events) {
  if (!events || !events.length) return { appended: 0, total: 0 };
  const doc = (await readEventsDay(date)) || { date, events: [] };
  const seen = new Set((doc.events || []).map(e => e.id));
  const fresh = events.filter(e => e && e.id && !seen.has(e.id));
  const next = { ...doc, date, events: [...(doc.events || []), ...fresh], updatedAt: new Date().toISOString() };
  if (fresh.length) await writeEventsDay(date, next);
  return { appended: fresh.length, total: next.events.length };
}

// List the day-partitioned snapshot keys under a prefix, newest last. Returns [] without a
// store (callers then honestly report zero coverage rather than inventing history).
async function listSnapshotDates(prefix, { limit = 400 } = {}) {
  if (!hasStore()) return [];
  try {
    const { list } = require('@vercel/blob');
    const dates = new Set();
    let cursor;
    do {
      const r = await list({ prefix, cursor, limit: 1000 });
      for (const b of r.blobs) {
        const m = b.pathname.slice(prefix.length).match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) dates.add(m[1]);
      }
      cursor = r.hasMore ? r.cursor : null;
    } while (cursor && dates.size < limit);
    return [...dates].sort();
  } catch { return []; }
}

// Read every snapshot document written for one day under a prefix, oldest first.
async function readSnapshotsForDay(prefix, date, { limit = 200 } = {}) {
  if (!hasStore()) return [];
  try {
    const { list } = require('@vercel/blob');
    const r = await list({ prefix: `${prefix}${date}/`, limit: 1000 });
    const blobs = r.blobs.sort((a, b) => (a.pathname < b.pathname ? -1 : 1)).slice(0, limit);
    const docs = await Promise.all(blobs.map(async b => {
      try {
        const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
        return res.ok ? await res.json() : null;
      } catch { return null; }
    }));
    return docs.filter(Boolean);
  } catch { return []; }
}

module.exports = {
  DISCOVERY_PREFIX, IGNITION_PREFIX, CONTINUATION_PREFIX, EVENTS_PREFIX, OUTCOMES_PREFIX, AUDIT_PREFIX,
  UNIVERSE_KEY, FLOAT_CACHE_KEY, PROMOTION_KEY, ALERT_STATE_KEY,
  stamp, discoveryKey, ignitionKey, continuationKey, eventsKey, outcomesKey, auditKey,
  writeDiscoverySnapshot, writeIgnitionSnapshot, writeContinuationSnapshot,
  readEventsDay, writeEventsDay, appendEvents,
  readOutcomesDay, writeOutcomesDay, readAuditDay, writeAuditDay,
  readUniverse, writeUniverse, readFloatCache, writeFloatCache,
  readPromotionState, writePromotionState, readAlertState, writeAlertState,
  listSnapshotDates, readSnapshotsForDay, hasStore,
};
