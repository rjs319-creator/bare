'use strict';
// 🧬 BIOTECH GRADING (Phase 12) — leakage-resistant, multi-horizon outcome measurement built on
// the existing options-grade engine. Every episode enters at the NEXT session's OPEN (T+1, never
// the decision close), is measured at 3/5/10/21 sessions, made XBI-relative (biotech beta
// stripped, not SPY), and cost-adjusted. A horizon that has not elapsed reports {resolved:false}
// and is NEVER counted as a zero or a loss — the 21-session horizon stays open while 3/5 resolve.
// Outcomes roll up by archetype so a post-catalyst continuation is never averaged with a binary
// watch. This is measurement only; it changes NO live weight (see the Phase-13 validation gate).

const OG = require('./options-grade');
const { HORIZONS, BIOTECH_ETF } = require('./biotech-config');

// Adapt a biotech ledger pick → the episode shape options-grade expects (all biotech is long).
function toEpisode(pick) {
  return {
    id: pick.episodeId || `${pick.ticker}:${pick.date}`,
    ticker: pick.ticker,
    side: 'bullish',
    firstSeenDate: pick.date,
    firstSeenState: { score: pick.score != null ? pick.score : null },
  };
}

/**
 * Grade one pick. `series` = { candles, xbi }. Returns a per-horizon grid with explicit
 * resolved flags plus the pick's archetype/tier for stratified rollups.
 */
function gradeBiotechEpisode(pick, series = {}, opts = {}) {
  const g = OG.gradeEpisode(toEpisode(pick), { candles: series.candles || [], spy: series.xbi || [] }, { horizons: HORIZONS, costBps: opts.costBps != null ? opts.costBps : 25 });
  if (!g.graded) return { graded: false, reason: g.reason, ticker: pick.ticker, date: pick.date, archetype: pick.archetype || null, tier: pick.tier || null };
  const byHorizon = {};
  for (const h of HORIZONS) {
    const cell = g.horizons[h];
    byHorizon[h] = cell == null
      ? { resolved: false }
      : { resolved: true, rawReturn: cell.rawReturn, directional: cell.directional, xbiRelative: cell.excessVsSpy };
  }
  return {
    graded: true, ticker: g.ticker, date: g.decisionDate, entryDate: g.entryDate,
    archetype: pick.archetype || null, tier: pick.tier || null, score: g.score,
    actionCeiling: pick.actionCeiling || null,
    byHorizon, mfe: g.mfe, mae: g.mae, benchmark: BIOTECH_ETF,
  };
}

// Aggregate resolved episodes at one horizon (XBI-relative by default). De-dupes by decision
// date for independentDates so a name listed across days isn't overcounted.
function summarize(graded, { horizon = 10, metric = 'xbiRelative' } = {}) {
  const rows = (graded || []).filter(g => g && g.graded && g.byHorizon[horizon] && g.byHorizon[horizon].resolved && g.byHorizon[horizon][metric] != null);
  const vals = rows.map(g => g.byHorizon[horizon][metric]);
  if (!vals.length) return { n: 0, independentDates: 0, note: 'insufficient resolved episodes', horizon, metric };
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  const wins = vals.filter(v => v > 0).length;
  const variance = vals.length > 1 ? vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1) : 0;
  const se = Math.sqrt(variance / vals.length);
  return {
    n: vals.length,
    independentDates: new Set(rows.map(g => g.date)).size,
    hitRate: +((wins / vals.length) * 100).toFixed(1),
    meanExcess: +mean.toFixed(3),
    worst: +Math.min(...vals).toFixed(3),
    ci95: [+(mean - 1.96 * se).toFixed(3), +(mean + 1.96 * se).toFixed(3)],
    horizon, metric, benchmark: BIOTECH_ETF,
  };
}

// Per-archetype breakdown at a horizon — so lanes are evaluated separately.
function summarizeByArchetype(graded, { horizon = 10, metric = 'xbiRelative' } = {}) {
  const out = {};
  const byArch = {};
  for (const g of graded || []) { const a = (g && g.archetype) || 'UNKNOWN'; (byArch[a] = byArch[a] || []).push(g); }
  for (const a in byArch) out[a] = summarize(byArch[a], { horizon, metric });
  return out;
}

module.exports = { gradeBiotechEpisode, summarize, summarizeByArchetype, toEpisode };
