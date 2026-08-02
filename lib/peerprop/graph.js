'use strict';
// 🕸 PEER PROPAGATION — directed leader→follower graph from residual returns.
//
// For an ordered pair (A, B) inside one peer group, the question is whether A's
// PAST residual return predicts B's FUTURE residual return more strongly than the
// reverse. Correlation is not leadership: contemporaneous co-movement (market or
// sector beta both names share) is stripped BEFORE estimation by working on
// market/sector-residual daily returns, and the symmetric co-movement component is
// separated from the ANTISYMMETRIC directional component — only the directional
// part is treated as potentially alpha-relevant.
//
// Estimation discipline:
//   • only observations dated <= the caller's asOf enter (the residual panel is
//     already PIT-sliced by its builder);
//   • an edge needs minObs aligned pairs — below that it does not exist;
//   • lead correlations are Fisher-z shrunk toward 0 by n/(n+shrinkK), so a short
//     window cannot mint a strong edge;
//   • both the shrunk lead correlation AND the antisymmetric excess must clear
//     floors, and only the top maxEdgesPerFollower survive per follower — dense
//     all-to-all noise is structurally impossible.
//
// Pure & deterministic: no I/O, no clocks, no randomness.

const { VERSIONS, GRAPH_POLICY } = require('./config');

const isFin = Number.isFinite;

/** Pearson correlation of two equal-length arrays; null under n<3 or zero variance. */
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    cov += a * b; vx += a * a; vy += b * b;
  }
  if (!(vx > 0) || !(vy > 0)) return null;
  return cov / Math.sqrt(vx * vy);
}

/** Fisher-z shrinkage of a correlation toward 0 by sample size. */
function shrinkCorr(r, n, shrinkK) {
  if (!isFin(r) || !isFin(n) || n <= 0) return null;
  const clipped = Math.max(-0.9999, Math.min(0.9999, r));
  const z = 0.5 * Math.log((1 + clipped) / (1 - clipped));
  const zs = z * (n / (n + shrinkK));
  return Math.tanh(zs);
}

/**
 * Aligned lagged pairs: x's residual at t-lag vs y's residual at t, matched on
 * the OBSERVED date axis (holidays and per-name gaps drop the pair rather than
 * misaligning it). Series: ascending [{date, residual}].
 */
function laggedPairs(leaderSeries, followerSeries, lag) {
  const followerByDate = new Map();
  for (const p of followerSeries) if (isFin(p.residual)) followerByDate.set(p.date, p.residual);
  const xs = [], ys = [];
  for (let i = 0; i + lag < leaderSeries.length; i++) {
    const lead = leaderSeries[i];
    const at = leaderSeries[i + lag];         // lag sessions later on the LEADER's own axis
    if (!isFin(lead.residual) || !at) continue;
    const fy = followerByDate.get(at.date);
    if (!isFin(fy)) continue;
    xs.push(lead.residual); ys.push(fy);
  }
  return { xs, ys, n: xs.length };
}

/**
 * Best shrunk lead correlation of `leader` onto `follower` over lags 1..maxLag.
 * Returns { corr, lag, obs } or null when no lag has minObs observations.
 */
function bestLead(leaderSeries, followerSeries, policy) {
  let best = null;
  for (let lag = 1; lag <= policy.maxLag; lag++) {
    const { xs, ys, n } = laggedPairs(leaderSeries, followerSeries, lag);
    if (n < policy.minObs) continue;
    const raw = pearson(xs, ys);
    const shrunk = shrinkCorr(raw, n, policy.shrinkK);
    if (shrunk == null) continue;
    if (!best || Math.abs(shrunk) > Math.abs(best.corr)) best = { corr: shrunk, lag, obs: n };
  }
  return best;
}

/**
 * Build the directed graph for one peer-group membership map.
 *
 * @param seriesByTicker  { ticker -> ascending [{date, residual}] } — PIT residual panel
 * @param groups          { peerGroupId -> [tickers] } (lib/rlt-universe output shape)
 * @param rankOf          optional { ticker -> number } (e.g. dollar volume) used only to
 *                        cap oversized groups deterministically before pairwise work
 * @returns frozen { version, policy, edges, byFollower, stats }
 *   edge: { from, to, lag, leadCorr, followCorr, antisym, strength, obs, group }
 *     leadCorr   — shrunk corr(from residual at t−lag, to residual at t)
 *     followCorr — shrunk corr in the REVERSE direction (same machinery)
 *     antisym    — leadCorr − followCorr: the directional component
 *     strength   — leadCorr clipped at 0 (only positive propagation is an edge)
 */
function buildDirectedGraph({ seriesByTicker = {}, groups = {}, rankOf = null, policy = GRAPH_POLICY } = {}) {
  const edges = [];
  let pairsEvaluated = 0;
  let pairsBelowMinObs = 0;

  for (const [groupId, members] of Object.entries(groups)) {
    if (groupId === 'MARKET') continue;         // market-wide all-to-all is noise by construction
    let names = members.filter(t => Array.isArray(seriesByTicker[t]) && seriesByTicker[t].length >= policy.minObs);
    if (names.length > policy.maxGroupSize) {
      const key = t => (rankOf && isFin(rankOf[t]) ? rankOf[t] : 0);
      names = names.slice().sort((a, b) => key(b) - key(a) || (a < b ? -1 : 1)).slice(0, policy.maxGroupSize);
    }
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        pairsEvaluated++;
        const from = names[i], to = names[j];
        const lead = bestLead(seriesByTicker[from], seriesByTicker[to], policy);
        if (!lead) { pairsBelowMinObs++; continue; }
        const follow = bestLead(seriesByTicker[to], seriesByTicker[from], policy);
        const followCorr = follow ? follow.corr : 0;
        const antisym = lead.corr - followCorr;
        // Only positive, directional propagation qualifies as an edge.
        if (lead.corr < policy.minLeadCorr || antisym < policy.minAntisym) continue;
        edges.push({
          from, to, lag: lead.lag,
          leadCorr: +lead.corr.toFixed(4),
          followCorr: +followCorr.toFixed(4),
          antisym: +antisym.toFixed(4),
          strength: +Math.max(0, lead.corr).toFixed(4),
          obs: lead.obs,
          group: groupId,
        });
      }
    }
  }

  // Retain only the strongest confirmed leaders per follower.
  const byFollower = {};
  for (const e of edges) {
    (byFollower[e.to] = byFollower[e.to] || []).push(e);
  }
  const kept = [];
  for (const t of Object.keys(byFollower)) {
    byFollower[t].sort((a, b) => b.antisym - a.antisym || b.strength - a.strength || (a.from < b.from ? -1 : 1));
    byFollower[t] = byFollower[t].slice(0, policy.maxEdgesPerFollower);
    kept.push(...byFollower[t]);
  }

  return Object.freeze({
    version: VERSIONS.graph,
    policy: { maxLag: policy.maxLag, minObs: policy.minObs, shrinkK: policy.shrinkK, minLeadCorr: policy.minLeadCorr, minAntisym: policy.minAntisym },
    edges: Object.freeze(kept),
    byFollower,
    stats: Object.freeze({
      groups: Object.keys(groups).filter(g => g !== 'MARKET').length,
      pairsEvaluated, pairsBelowMinObs,
      edgesKept: kept.length,
      followersWithLeaders: Object.keys(byFollower).length,
    }),
  });
}

/**
 * Falsification helper: the SAME graph with every edge's direction reversed.
 * A genuine directed signal must materially weaken under this transform; a signal
 * unchanged by it is symmetric co-movement wearing a leadership costume.
 */
function reverseGraph(graph) {
  const edges = (graph.edges || []).map(e => Object.freeze({ ...e, from: e.to, to: e.from }));
  const byFollower = {};
  for (const e of edges) (byFollower[e.to] = byFollower[e.to] || []).push(e);
  return Object.freeze({ ...graph, edges: Object.freeze(edges), byFollower, reversed: true });
}

module.exports = {
  buildDirectedGraph, reverseGraph,
  pearson, shrinkCorr, laggedPairs, bestLead,
};
