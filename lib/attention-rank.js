'use strict';
// MARKET ATTENTION ACCELERATION — the cross-scan ranking layer.
//
// Every low-float tick already scans the whole eligible universe and discovers a candidate
// set; what nothing did before this module is compare a candidate's market-wide RANK against
// its rank on PRIOR scans. Rank CHANGE is the signal the spec centers: #184 → #72 → #21 → #5
// matters more than being #5.
//
// PURE except where stated: composite/rank/metrics functions take plain rows and a history
// document; persistence lives in the caller (the privileged tick) via lowfloat-store.
//
// CADENCE HONESTY: the tick runs every ~10 minutes, so "rank 5 minutes ago" is genuinely the
// NEAREST EARLIER STAMP inside the window, not an exact 5-minute lookback. Every metric
// carries the actual timestamps it was computed from.

const C = require('./ignition-live-config');

const finite = v => Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const frac = (v, lo, hi) => (finite(v) ? clamp((v - lo) / (hi - lo), 0, 1) : 0);

// ── Composite over one discovery row. Missing inputs earn 0 — a name with no volume data
//    cannot outrank one showing real participation.
function attentionComposite(row = {}) {
  const W = C.ATTENTION.WEIGHTS;
  const dollarVol = row.currentSessionDollarVolume;
  return +(
    W.PRICE_ACCEL * frac(row.fiveMinChange, 0.3, 5)
    + W.VOLUME_ACCEL * frac(row.volumeAcceleration, 1, 5)
    + W.DOLLAR_VOLUME * frac(finite(dollarVol) && dollarVol > 0 ? Math.log10(dollarVol) : null, 5.7, 8) // $500k → $100M
    + W.RELATIVE_VOLUME * frac(row.relativeVolume, 1.5, 12)
    + W.DAY_CHANGE * frac(row.dayChangePct, 3, 40)
    + W.FLOAT_TURNOVER * frac(row.floatTurnover, 0.05, 1.5)
  ).toFixed(3);
}

// Rank all rows for one scan. Returns { byTicker: {T: {rank, score}}, ranked: [...] }.
function rankCandidates(rows = []) {
  const scored = rows
    .filter(r => r && r.ticker)
    .map(r => ({ ticker: r.ticker, score: attentionComposite(r), floatTurnover: finite(r.floatTurnover) ? r.floatTurnover : null }))
    .sort((a, b) => b.score - a.score);
  const byTicker = {};
  scored.forEach((s, i) => { byTicker[s.ticker] = { rank: i + 1, score: s.score, floatTurnover: s.floatTurnover }; });
  return { byTicker, ranked: scored.map((s, i) => ({ ...s, rank: i + 1 })), universeRanked: scored.length };
}

// ── History document: { version, sessionDate, stamps: [iso...], byTicker: {T: [{at, rank,
//    turnover}]} }. Immutable update; per-ticker entries capped.
function updateHistory(doc, ranks, at, sessionDate) {
  const iso = new Date(at).toISOString();
  const prior = doc && doc.sessionDate === sessionDate ? doc : null;
  const byTicker = { ...((prior && prior.byTicker) || {}) };
  for (const [t, v] of Object.entries(ranks.byTicker)) {
    const entries = [...(byTicker[t] || []), { at: iso, rank: v.rank, turnover: v.floatTurnover }];
    byTicker[t] = entries.slice(-C.ATTENTION.HISTORY_CAP);
  }
  return {
    version: C.ATTENTION_RANK_VERSION,
    sessionDate,
    stamps: [...((prior && prior.stamps) || []), iso].slice(-C.ATTENTION.HISTORY_CAP),
    universeRanked: ranks.universeRanked,
    byTicker,
    updatedAt: iso,
  };
}

// Nearest entry at or before (now - minutesAgo), within a tolerance window.
function entryNear(entries, nowMs, minutesAgo, toleranceMin = 7) {
  const target = nowMs - minutesAgo * 60000;
  let best = null;
  for (const e of entries) {
    const ms = Date.parse(e.at);
    if (!finite(ms) || ms > target + toleranceMin * 60000) continue;
    if (!best || Math.abs(ms - target) < Math.abs(Date.parse(best.at) - target)) best = e;
  }
  return best;
}

// ── Per-ticker attention metrics from the history doc (AFTER updateHistory ran for this
//    scan, so the newest entry is the current rank).
function attentionMetrics(doc, ticker, now = new Date()) {
  const entries = (doc && doc.byTicker && doc.byTicker[ticker]) || [];
  if (!entries.length) return { rankNow: null, basis: 'no rank history for this name' };
  const nowMs = new Date(now).getTime();
  const latest = entries[entries.length - 1];
  const e5 = entryNear(entries.slice(0, -1), nowMs, 5);
  const e10 = entryNear(entries.slice(0, -1), nowMs, 10);
  const e20 = entryNear(entries.slice(0, -1), nowMs, 20);

  // Velocity: ranks gained per minute over the ~20-minute window (positive = improving).
  const refEntry = e20 || e10 || e5;
  let velocity = null, windowMin = null;
  if (refEntry) {
    const dtMin = (Date.parse(latest.at) - Date.parse(refEntry.at)) / 60000;
    if (dtMin >= 3) { velocity = +((refEntry.rank - latest.rank) / dtMin).toFixed(2); windowMin = Math.round(dtMin); }
  }
  // Acceleration: is the improvement rate itself rising? Compare the recent half-window
  // rate against the earlier half-window rate.
  let acceleration = null;
  if (e10 && e20) {
    const early = (e20.rank - e10.rank) / Math.max(1, (Date.parse(e10.at) - Date.parse(e20.at)) / 60000);
    const late = (e10.rank - latest.rank) / Math.max(1, (Date.parse(latest.at) - Date.parse(e10.at)) / 60000);
    acceleration = +(late - early).toFixed(2);
  }
  const surge = !!(refEntry
    && refEntry.rank - latest.rank >= C.ATTENTION.SURGE_MIN_IMPROVEMENT
    && latest.rank <= C.ATTENTION.SURGE_TOP_RANK
    && (Date.parse(latest.at) - Date.parse(refEntry.at)) / 60000 <= C.ATTENTION.SURGE_WINDOW_MIN);

  // Float-turnover velocity (per minute) from the same history — the cross-scan delta the
  // supply-pressure score needs.
  let turnoverVelocityPerMin = null;
  const withTurnover = entries.filter(e => finite(e.turnover));
  if (withTurnover.length >= 2) {
    const a = withTurnover[withTurnover.length - 2], b = withTurnover[withTurnover.length - 1];
    const dtMin = (Date.parse(b.at) - Date.parse(a.at)) / 60000;
    if (dtMin >= 3) turnoverVelocityPerMin = +((b.turnover - a.turnover) / dtMin).toFixed(5);
  }

  return {
    version: C.ATTENTION_RANK_VERSION,
    rankNow: latest.rank,
    rank5mAgo: e5 ? e5.rank : null,
    rank10mAgo: e10 ? e10.rank : null,
    rank20mAgo: e20 ? e20.rank : null,
    velocity, velocityWindowMin: windowMin,
    acceleration,
    surge,
    turnoverVelocityPerMin,
    universeRanked: doc.universeRanked ?? null,
    basis: `nearest-stamp lookback at ~${windowMin ?? '?'}-minute window; scan cadence ~10 min`,
  };
}

module.exports = { attentionComposite, rankCandidates, updateHistory, attentionMetrics, entryNear };
