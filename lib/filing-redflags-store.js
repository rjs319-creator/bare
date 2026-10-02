'use strict';
// FILING RED FLAGS — Blob layout and the pure merge rules the writers obey.
//
//   redflags/v1/<date>.json   day shard: the events the lane KNEW on <date> (ledger rows the
//                             Scoreboard folds as section RedFlags). Multi-writer: the nightly
//                             tick, a re-tick after a partial run, and the backfill may all touch
//                             one shard → written with updateJSON (CAS) as a UNION by event key,
//                             never readJSON→writeJSON (Blob read-back lags; appends get lost).
//   redflags/v1/state.json    per-ticker rolling first-in-252 state ({ byTicker: {T: {NT, GC}} }),
//                             CAS-merged monotonically (latest date per ticker/kind wins).
//   redflags/v1/current.json  display snapshot for the 🚩 chip (symbols flagged inside the
//                             91-day window), rebuilt from the shards by the single nightly
//                             writer; readers never trust it for the ledger.
//
// Pure merge functions are exported for tests; the Blob calls go through lib/store.

const STORE = require('./store');
const RF = require('./filing-redflags');

const PREFIX = 'redflags/v1/';
const DAY_RE = /^redflags\/v1\/\d{4}-\d{2}-\d{2}\.json$/;
const STATE_KEY = `${PREFIX}state.json`;
const CURRENT_KEY = `${PREFIX}current.json`;
const DAY_MS = 86_400_000;

const dayKey = (date) => `${PREFIX}${date}.json`;

// ── Pure merges ──────────────────────────────────────────────────────────────
// Day shard union: rows keyed by ticker|flag|accession; an existing row is kept verbatim
// (first writer wins — the row carries the as-of facts of the tick that saw it first).
// `partial` clears only when a writer reports a complete pass; counts are recomputed.
function mergeDay(prev, patch) {
  const base = prev || { version: RF.VERSION, date: patch.date, picks: [], indexDates: [], stats: [], partial: true };
  const seen = new Set((base.picks || []).map((p) => p.key || RF.eventKey(p)));
  const added = (patch.picks || []).filter((p) => !seen.has(p.key || RF.eventKey(p)));
  const picks = [...(base.picks || []), ...added].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    ...base,
    version: RF.VERSION, date: base.date || patch.date, picks,
    indexDates: patch.indexDates && patch.indexDates.length ? patch.indexDates : base.indexDates,
    stats: [...(base.stats || []), ...(patch.stats ? [patch.stats] : [])],
    partial: patch.partial === false ? false : (base.partial !== false),
    counts: countRows(picks),
    savedAt: patch.savedAt || base.savedAt || null,
  };
}

function countRows(picks) {
  const byFlag = {};
  let excluded = 0;
  for (const p of picks || []) {
    byFlag[p.flag] = (byFlag[p.flag] || 0) + 1;
    if (p.tier === RF.EXCLUDED_TIER) excluded++;
  }
  return { rows: (picks || []).length, excluded, policy: (picks || []).length - excluded, byFlag };
}

// State union: per ticker/kind the LATEST date wins (monotone; a stale writer cannot regress).
function mergeState(prev, next) {
  let out = prev || RF.emptyState();
  for (const [ticker, kinds] of Object.entries((next && next.byTicker) || {})) {
    for (const [kind, date] of Object.entries(kinds || {})) if (date) out = RF.advanceState(out, ticker, kind, date);
  }
  return out;
}

// Display snapshot from day shards: a symbol is flagged while its most recent event is
// inside flagWindowDays at `asOf`; eligible AND excluded rows both show (the chip is a
// disclosure, not a cohort). Pure.
function buildCurrent(days, asOf) {
  const asOfMs = Date.parse(asOf);
  const symbols = {};
  for (const d of days || []) {
    for (const p of d.picks || []) {
      if (!p || !p.ticker || !p.eventDate) continue;
      const age = Math.floor((asOfMs - Date.parse(p.eventDate)) / DAY_MS);
      if (!Number.isFinite(age) || age < 0 || age > RF.FROZEN.flagWindowDays) continue;
      const cur = symbols[p.ticker] || { flags: [], lastDate: null, ageDays: null, events: 0 };
      const flags = cur.flags.includes(p.flag) ? cur.flags : [...cur.flags, p.flag].sort();
      const newer = !cur.lastDate || p.eventDate > cur.lastDate;
      symbols[p.ticker] = { flags, lastDate: newer ? p.eventDate : cur.lastDate, ageDays: newer ? age : cur.ageDays, events: cur.events + 1 };
    }
  }
  const list = Object.values(symbols);
  return { version: RF.VERSION, asOf, symbols, counts: { flagged: list.length, events: list.reduce((s, x) => s + x.events, 0) } };
}

// ── Blob I/O ─────────────────────────────────────────────────────────────────
const hasStore = () => STORE.hasStore();

async function readAllRedflagDays({ since = null, limit = null } = {}) {
  const days = await STORE.readAllByPrefix(PREFIX, DAY_RE, { limit });
  return since ? days.filter((d) => d && d.date >= since) : days;
}

const readState = () => STORE.readJSON(STATE_KEY, null).then((s) => s || RF.emptyState());
const readCurrent = () => STORE.readJSON(CURRENT_KEY, null);
const readDay = (date) => STORE.readJSON(dayKey(date), null);

// CAS union into the day shard. `patch` = { date, picks, indexDates, stats, partial }.
function writeDayUnion(date, patch) {
  return STORE.updateJSON(dayKey(date), (cur) => mergeDay(cur, { ...patch, date, savedAt: new Date().toISOString() }), { initial: null });
}

function writeStateUnion(next) {
  return STORE.updateJSON(STATE_KEY, (cur) => {
    const merged = mergeState(cur, next);
    return JSON.stringify(merged) === JSON.stringify(cur) ? cur : merged;
  }, { initial: null });
}

const writeCurrent = (snap) => STORE.writeJSON(CURRENT_KEY, snap, 60);

module.exports = {
  PREFIX, DAY_RE, STATE_KEY, CURRENT_KEY, dayKey,
  mergeDay, countRows, mergeState, buildCurrent,
  hasStore, readAllRedflagDays, readState, readCurrent, readDay, writeDayUnion, writeStateUnion, writeCurrent,
};
