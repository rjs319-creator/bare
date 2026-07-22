'use strict';
// IMMUTABLE CAPTURE — one point-in-time snapshot per candidate per evaluation interval, plus
// first-entry episode selection for honest headline evaluation.
//
// The snapshot records everything that was TRUE AND KNOWABLE at the decision instant (state,
// data freshness/timestamps, features, ranking, plan, policy/model versions, whether it was
// displayed and where, whether it was retired and why). It is append-only: outcomes are graded
// into a SEPARATE keyed structure and never rewritten back onto the snapshot, so the record of
// what the system believed at decision time can't be laundered after the fact.
//
// Headline evaluation uses ONE first-entry episode per ticker/day (the first ACTIONABLE_NOW),
// not the hundreds of overlapping 5-min snapshots — otherwise a single move is triple-counted.
const { STATES, RETIRED_STATES } = require('./opportunity-lifecycle');

function isRetired(state) { return RETIRED_STATES.has(state); }

// Build an immutable snapshot from an advanced record + the ev that produced it + display ctx.
function buildSnapshot({ record, ev = {}, pick = {}, displayed = false, displayPosition = null, at = null } = {}) {
  const f = record.lastFreshness || ev.freshness || null;
  const last = record.history.at(-1) || {};
  const metrics = record.lastMetrics || ev.metrics || {};
  const decisionPrice = metrics.last != null ? metrics.last : (pick.last != null ? pick.last : null);
  const atr = pick.orb && pick.orb.atr != null ? pick.orb.atr : null;
  return Object.freeze({
    ticker: record.ticker,
    at: at || record.updatedAt,
    session: ev.session || null,
    state: record.state,
    // Data timestamps / freshness (point-in-time provenance).
    freshness: f,
    dataTimestamps: f ? {
      candidateDate: f.candidateDate || null,
      intradayBarAsOf: f.intradayBarAsOf || null,
      quoteAsOf: f.quoteAsOf || null,
      dataAgeSeconds: f.dataAgeSeconds != null ? f.dataAgeSeconds : null,
    } : null,
    // Model features / discovery + ranking components.
    features: metrics,
    ranking: { score: pick.score ?? null, relScore: pick.relScore ?? null, tier: pick.tier ?? null, scan: pick.scan ?? null },
    // Trade plan (trigger/entry/stop/targets).
    plan: {
      entry: pick.entry ?? null, stop: pick.stop ?? null, target: pick.target ?? null,
      rr: pick.rr ?? null, trigger: pick.orb ? pick.orb.trigger : null,
    },
    decisionPrice,
    atr,
    modelOutputs: null,                         // no learned model yet — deterministic policy only
    policyVersion: record.strategyVersion || null,
    modelVersion: null,
    displayed: !!displayed,
    displayPosition: displayPosition,
    retired: isRetired(record.state),
    retiredReason: isRetired(record.state) ? (last.reasonCode || null) : null,
    reason: last.reasonCode || null,
    entryAlertAt: record.entryAlertAt || null,
  });
}

// First snapshot (earliest `at`) per ticker satisfying `pred`. Deterministic tie-break by `at`.
function firstSnapshotWhere(snapshots, pred) {
  const byTicker = new Map();
  for (const s of snapshots || []) {
    if (!s || !pred(s)) continue;
    const cur = byTicker.get(s.ticker);
    if (!cur || Date.parse(s.at) < Date.parse(cur.at)) byTicker.set(s.ticker, s);
  }
  return [...byTicker.values()];
}

// Headline episodes: the FIRST time each ticker was ACTIONABLE_NOW today (one per ticker/day).
function firstEntryEpisodes(snapshots) {
  return firstSnapshotWhere(snapshots, s => s.state === STATES.ACTIONABLE_NOW)
    .map(s => ({
      episodeId: `${s.ticker}|${s.at}`,
      ticker: s.ticker, decisionAt: s.at, decisionPrice: s.decisionPrice, atr: s.atr,
      state: s.state, displayed: s.displayed, displayPosition: s.displayPosition,
      plan: s.plan, ranking: s.ranking,
    }))
    .filter(e => e.decisionPrice > 0 && e.atr > 0);   // only gradeable episodes
}

// First-retirement observations: the first time each ticker entered a retired state WITHOUT
// having first been actionable — used to measure false retirements (did it later run?).
function firstRetirementObservations(snapshots) {
  const actionableTickers = new Set((snapshots || []).filter(s => s.state === STATES.ACTIONABLE_NOW).map(s => s.ticker));
  return firstSnapshotWhere(snapshots, s => isRetired(s.state))
    .filter(s => !actionableTickers.has(s.ticker))
    .map(s => ({
      episodeId: `${s.ticker}|${s.at}|retired`,
      ticker: s.ticker, decisionAt: s.at, decisionPrice: s.decisionPrice, atr: s.atr,
      state: s.state, retiredReason: s.retiredReason,
    }))
    .filter(e => e.decisionPrice > 0 && e.atr > 0);
}

module.exports = { buildSnapshot, firstEntryEpisodes, firstRetirementObservations, firstSnapshotWhere, isRetired };
