'use strict';
// CFL — VERSIONED STORAGE (thin layer over lib/store Blob helpers).
// One authoritative writer per artifact:
//   cfl/v1/decisions/<scope>-<date>.json   decision snapshots; writer: /api/screener warm hook (write-once per key)
//   cfl/v1/day/<scope>-<horizon>-<date>.json  reconstruction day docs; writers: op=cfltick / op=cflbackfill (idempotent by key)
//   cfl/v1/duds.json                       graded picks ledger; writer: op=cfltick
//   cfl/v1/summary.json                    funnel + aggregates; writer: op=cfltick
//   cfl/v1/state.json                      sweep cursor/health; writer: op=cfltick / op=cflbackfill
// Day docs are keyed by (scope,horizon,date) so a re-run overwrites ITSELF —
// idempotent by construction, no shared read-modify-write doc anywhere.

const { readJSON, writeJSON, hasStore } = require('../store');

const PREFIX = 'cfl/v1/';
const DAY_RE = /^cfl\/v1\/day\/[a-z]+-h\d+-\d{4}-\d{2}-\d{2}\.json$/;
const DECISION_RE = /^cfl\/v1\/decisions\/[a-z]+-\d{4}-\d{2}-\d{2}\.json$/;

const KEYS = Object.freeze({
  DAY_PREFIX: `${PREFIX}day/`,
  DECISION_PREFIX: `${PREFIX}decisions/`,
  DUDS: `${PREFIX}duds.json`,
  SUMMARY: `${PREFIX}summary.json`,
  STATE: `${PREFIX}state.json`,
});

const dayKey = (scope, horizon, date) => `${KEYS.DAY_PREFIX}${scope}-${horizon}-${date}.json`;
const decisionKey = (scope, date) => `${KEYS.DECISION_PREFIX}${scope}-${date}.json`;

const readState = () => readJSON(KEYS.STATE, null);
const writeState = (s) => writeJSON(KEYS.STATE, { ...s, updatedAt: new Date().toISOString() }, 0);
const readSummary = () => readJSON(KEYS.SUMMARY, null);
const writeSummary = (s) => writeJSON(KEYS.SUMMARY, { ...s, savedAt: new Date().toISOString() }, 0);
const readDuds = () => readJSON(KEYS.DUDS, null);
const writeDuds = (d) => writeJSON(KEYS.DUDS, { ...d, savedAt: new Date().toISOString() }, 0);
const readDay = (scope, horizon, date) => readJSON(dayKey(scope, horizon, date), null);
const writeDay = (scope, horizon, date, doc) =>
  writeJSON(dayKey(scope, horizon, date), { ...doc, savedAt: new Date().toISOString() }, 0);
const readDecision = (scope, date) => readJSON(decisionKey(scope, date), null);
const writeDecision = (scope, date, doc) =>
  writeJSON(decisionKey(scope, date), { ...doc, savedAt: new Date().toISOString() }, 0);

// List day-doc paths (cheap — no body fetches). Lazily requires @vercel/blob like
// every other store helper so a token-less environment degrades to [].
async function listDayPaths(prefixFilter = null) {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: KEYS.DAY_PREFIX, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);
  return blobs
    .filter(b => DAY_RE.test(b.pathname))
    .filter(b => !prefixFilter || b.pathname.startsWith(`${KEYS.DAY_PREFIX}${prefixFilter}`))
    .map(b => ({ pathname: b.pathname, url: b.url }))
    .sort((a, b) => a.pathname < b.pathname ? -1 : 1);
}

// Read the newest `limit` day docs for a (scope,horizon). Unreadable shards are
// skipped and COUNTED — a partial read is reported, never silent.
async function readRecentDays(scope, horizon, limit = 30) {
  const paths = await listDayPaths(`${scope}-${horizon}-`);
  const tail = paths.slice(-limit);
  const days = [];
  let unreadable = 0;
  await Promise.all(tail.map(async (b) => {
    try {
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
      if (res.ok) days.push(await res.json()); else unreadable++;
    } catch { unreadable++; }
  }));
  days.sort((a, b) => (a.decisionDate < b.decisionDate ? -1 : 1));
  return { days, unreadable, listed: paths.length };
}

module.exports = {
  PREFIX, KEYS, DAY_RE, DECISION_RE, hasStore,
  dayKey, decisionKey,
  readState, writeState, readSummary, writeSummary, readDuds, writeDuds,
  readDay, writeDay, readDecision, writeDecision,
  listDayPaths, readRecentDays,
};
