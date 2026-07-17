// IMMUTABLE ORIGIN SNAPSHOTS for the remaining-edge model (spec §3 validation rule:
// "preserve immutable prediction snapshots"). One record per signal id, captured at FIRST
// detection and never rewritten — so "how much has moved since the signal" is measured
// against the original plan, not against levels that drift as the screener re-emits daily.
//
// The persisted doc lives at today/origins.json (read/written by decision-routes.js). This
// module is the PURE transform over it: given yesterday's origins + today's live signals +
// today's date, return the new origins map. No blob, no clock — the date is passed in.

'use strict';

const ORIGINS_VERSION = 'origins-v1';
// Drop a name we haven't seen in this many calendar days — a setup that has fallen out of
// every screen for a quarter is not a live signal whose edge we're tracking. Keeps the doc
// bounded without touching still-active names.
const PRUNE_AFTER_DAYS = 90;

const num = (v) => (Number.isFinite(+v) ? +v : null);
const dayDiff = (a, b) => {
  const ta = Date.parse(a), tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
};

// Freeze the immutable half of an origin at first sight.
function captureOrigin(sig, date) {
  return {
    firstDate: date,
    firstPrice: num(sig.price),
    entry: num(sig.entry), stop: num(sig.stop), target: num(sig.target),
    side: sig.side === 'short' ? 'short' : 'long',
    horizon: sig.horizon || 'swing',
    originalScore: num(sig.score),
    scoringVersion: sig.scoringVersion || null,
    bars: 0,
    lastDate: date,
  };
}

// prev: {origins:{id:record}} map (or null). signals: today's enriched signals (need id/price/
// entry/stop/target/side/horizon/score). date: 'YYYY-MM-DD'. Returns a NEW origins map.
// - a NEW id is captured immutably;
// - an EXISTING id keeps every original field; only `bars` advances (once per distinct date)
//   and `lastDate` refreshes;
// - ids unseen for > PRUNE_AFTER_DAYS are dropped.
function updateOrigins(prev, signals, date, { pruneAfterDays = PRUNE_AFTER_DAYS } = {}) {
  const origins = { ...(prev || {}) };
  const seen = new Set();
  for (const sig of signals || []) {
    const id = sig && sig.id;
    if (!id) continue;
    seen.add(id);
    const existing = origins[id];
    if (!existing) { origins[id] = captureOrigin(sig, date); continue; }
    // Immutable original fields preserved; advance the bar counter once per new trading date.
    const advanced = existing.lastDate && existing.lastDate !== date;
    origins[id] = { ...existing, bars: (existing.bars || 0) + (advanced ? 1 : 0), lastDate: date };
  }
  // Prune stale entries (not present today AND untouched for too long).
  for (const id of Object.keys(origins)) {
    if (seen.has(id)) continue;
    const last = origins[id].lastDate || origins[id].firstDate;
    if (last && dayDiff(last, date) > pruneAfterDays) delete origins[id];
  }
  return origins;
}

module.exports = { ORIGINS_VERSION, PRUNE_AFTER_DAYS, captureOrigin, updateOrigins, dayDiff };
