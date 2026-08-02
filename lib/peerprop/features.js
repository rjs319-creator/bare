'use strict';
// 🕸 PEER PROPAGATION — peer-index features, unreflected strength, stage.
//
// Three core quantities, computed per stock from the PIT residual panel:
//
//   peerStrength           robust (median / MAD) condition of the peer group,
//                          in the group's own volatility units — one extreme
//                          peer cannot dominate a median;
//   withinPeerPosition     tie-aware percentile of the stock inside its peers;
//   unreflectedPeerStrength peerStrength − the stock's OWN normalized reaction —
//                          the "peers moved, this name hasn't yet" gap that makes
//                          a candidate interesting BEFORE its own tape is obvious.
//
// Plus the directed-graph read: weighted leader pressure, number of confirming
// leaders, age of the latest leader impulse, propagation decay, and a late/crowding
// penalty. A peer group below minPeers yields nulls — never a false-precision
// aggregate. Pure & deterministic.

const { VERSIONS, FEATURE_POLICY } = require('./config');
const { percentileWithTies } = require('../rlt-residual');

const isFin = Number.isFinite;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round4 = v => (isFin(v) ? +v.toFixed(4) : null);

/** Sum of the last `h` residual daily returns (the h-session residual move). */
function residMomentum(series, h) {
  if (!Array.isArray(series) || series.length < h) return null;
  let sum = 0;
  for (let i = series.length - h; i < series.length; i++) {
    const v = series[i] ? series[i].residual : null;
    if (!isFin(v)) return null;
    sum += v;
  }
  return sum;
}

/** Std of daily residuals over the trailing window (annualization-free). */
function residDailyStd(series, window = 63) {
  if (!Array.isArray(series) || series.length < 10) return null;
  const xs = series.slice(-window).map(p => p.residual).filter(isFin);
  if (xs.length < 10) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function median(xs) {
  const v = xs.filter(isFin).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mad(xs) {
  const m = median(xs);
  if (m == null) return null;
  return median(xs.filter(isFin).map(x => Math.abs(x - m)));
}

/** A stock's h-session residual move in its OWN volatility units (z-like). */
function reactionZ(series, h) {
  const mom = residMomentum(series, h);
  const sd = residDailyStd(series);
  if (mom == null || !(sd > 0)) return null;
  return mom / (sd * Math.sqrt(h));
}

/**
 * Robust peer aggregates for one group (the stock itself EXCLUDED by the caller).
 * Returns null when the group is below minPeers — fail closed, no aggregate.
 */
function peerAggregates(peerSeriesList, policy = FEATURE_POLICY) {
  const usable = (peerSeriesList || []).filter(s => Array.isArray(s) && s.length >= 21);
  if (usable.length < policy.minPeers) return null;

  const perHorizon = {};
  for (const h of policy.momentumHorizons) {
    const moms = usable.map(s => residMomentum(s, h)).filter(isFin);
    if (moms.length < policy.minPeers) { perHorizon[h] = null; continue; }
    perHorizon[h] = {
      median: round4(median(moms)),
      mad: round4(mad(moms)),
      breadthPositive: round4(moms.filter(v => v > 0).length / moms.length),
      n: moms.length,
    };
  }

  const zs = usable.map(s => reactionZ(s, 21)).filter(isFin);
  const strengthZ = zs.length >= policy.minPeers ? median(zs) : null;
  // Acceleration: is the short-horizon pace ahead of the long-horizon pace?
  const m5 = perHorizon[5] && perHorizon[5].median, m21 = perHorizon[21] && perHorizon[21].median;
  const accel = (isFin(m5) && isFin(m21)) ? m5 - m21 * (5 / 21) : null;

  return {
    version: VERSIONS.features,
    peers: usable.length,
    byHorizon: perHorizon,
    strengthZ: round4(strengthZ == null ? null : clamp(strengthZ, -3, 3)),
    accel: round4(accel),
    breadthImproving: perHorizon[21] ? perHorizon[21].breadthPositive : null,
    dispersion: perHorizon[21] ? perHorizon[21].mad : null,
  };
}

/**
 * Directed-graph read for one follower: weighted movement of its historical
 * leaders, confirmation count, impulse age and decay. Null-safe when the stock
 * has no surviving in-edges (that is a real state, not an error).
 */
function leaderRead({ ticker, byFollower = {}, seriesByTicker = {}, policy = FEATURE_POLICY } = {}) {
  const edges = byFollower[ticker] || [];
  if (!edges.length) {
    return { leaders: 0, leadersConfirming: 0, leaderPressure: null, impulseAgeSessions: null, decay: null, topLeaders: [] };
  }
  let wSum = 0, pSum = 0, confirming = 0;
  let youngestImpulse = null;
  const top = [];
  for (const e of edges) {
    const s = seriesByTicker[e.from];
    const z = s ? reactionZ(s, policy.impulseWindow) : null;
    if (z == null) continue;
    wSum += e.strength;
    pSum += e.strength * clamp(z, -3, 3);
    if (z > 0.5) confirming++;
    // Age of the leader's latest large residual day within the impulse window.
    if (Array.isArray(s) && s.length) {
      const tail = s.slice(-policy.impulseWindow);
      const sd = residDailyStd(s);
      if (sd > 0) {
        let bestIdx = -1, bestAbs = 0;
        tail.forEach((p, i) => { if (isFin(p.residual) && Math.abs(p.residual) > bestAbs) { bestAbs = Math.abs(p.residual); bestIdx = i; } });
        if (bestIdx >= 0 && bestAbs / sd >= 1.5) {
          const age = tail.length - 1 - bestIdx;
          if (youngestImpulse == null || age < youngestImpulse) youngestImpulse = age;
        }
      }
    }
    top.push({ ticker: e.from, lag: e.lag, antisym: e.antisym, strength: e.strength, impulseZ: round4(z) });
  }
  top.sort((a, b) => b.antisym - a.antisym || (a.ticker < b.ticker ? -1 : 1));
  const leaderPressure = wSum > 0 ? pSum / wSum : null;
  const decay = youngestImpulse == null ? null : round4(Math.max(0, 1 - youngestImpulse / policy.impulseWindow));
  return {
    leaders: edges.length,
    leadersConfirming: confirming,
    leaderPressure: round4(leaderPressure),
    impulseAgeSessions: youngestImpulse,
    decay,
    topLeaders: top.slice(0, 3),
  };
}

const STAGES = Object.freeze(['EARLY', 'CONFIRMING', 'MATURE', 'LATE', 'NONE', 'INVALID']);

/**
 * Stage of propagation. Precedence: INVALID (no data basis) → LATE (own move
 * already large — chasing) → MATURE (gap closed) → CONFIRMING (own move started,
 * gap remains) → EARLY (peers/leaders moved, own reaction still quiet) → NONE.
 */
function classifyStage({ unreflected, ownReactionZ, ownMove21Pct, leadersConfirming, peerStrengthZ, decay, dataOk } = {}, policy = FEATURE_POLICY) {
  if (!dataOk) return 'INVALID';
  const own = isFin(ownReactionZ) ? ownReactionZ : 0;
  const gap = isFin(unreflected) ? unreflected : 0;
  const confirmed = (leadersConfirming || 0) >= 2 || (isFin(peerStrengthZ) && peerStrengthZ >= 0.75);
  if (isFin(ownMove21Pct) && ownMove21Pct >= policy.lateOwnMovePct) return 'LATE';
  if (own >= policy.reactionScale) return gap > 0.3 ? 'LATE' : 'MATURE';
  if (confirmed && gap >= 0.75 && own < 0.5 && (decay == null || decay >= 0.3)) return 'EARLY';
  if (confirmed && gap >= 0.3 && own >= 0.5) return 'CONFIRMING';
  if (confirmed && gap <= 0.3 && own >= 1) return 'MATURE';
  return 'NONE';
}

/**
 * Full per-stock feature bundle. `groupSeries` must EXCLUDE the stock itself.
 * All outputs bounded/rounded; anything uncomputable is null with the reason
 * captured in `missing`.
 */
function stockPeerFeatures({ ticker, ownSeries, groupSeries = [], graph = null, seriesByTicker = {}, policy = FEATURE_POLICY } = {}) {
  const missing = [];
  const agg = peerAggregates(groupSeries, policy);
  if (!agg) missing.push('peer-group-below-min-or-thin-history');

  const ownReaction = reactionZ(ownSeries, 21);
  if (ownReaction == null) missing.push('own-residual-history-thin');
  const ownMom21 = residMomentum(ownSeries, 21);

  const peerMoms = groupSeries.map(s => residMomentum(s, 21)).filter(isFin);
  const withinPeerPosition = (agg && isFin(ownMom21)) ? percentileWithTies([...peerMoms, ownMom21], ownMom21) : null;

  const peerStrengthZ = agg ? agg.strengthZ : null;
  const unreflected = (isFin(peerStrengthZ) && isFin(ownReaction))
    ? round4(clamp(peerStrengthZ, -3, 3) - clamp(ownReaction, -3, 3))
    : null;

  const lead = leaderRead({ ticker, byFollower: (graph && graph.byFollower) || {}, seriesByTicker, policy });

  const dataOk = !!agg && ownReaction != null;
  const stage = classifyStage({
    unreflected, ownReactionZ: ownReaction,
    ownMove21Pct: isFin(ownMom21) ? ownMom21 * 100 : null,
    leadersConfirming: lead.leadersConfirming,
    peerStrengthZ, decay: lead.decay, dataOk,
  }, policy);

  // Bounded heuristic rank score, 0..100. EXPLICITLY not a probability — the
  // display path keeps probabilities null until OOF calibration has the sample.
  const sig = x => 1 / (1 + Math.exp(-(isFin(x) ? x : 0)));
  const late = stage === 'LATE' ? 0.5 : 1;
  const score = round4(100 * late * (
    0.40 * sig(unreflected == null ? 0 : unreflected) +
    0.30 * sig(lead.leaderPressure == null ? 0 : lead.leaderPressure) +
    0.15 * (agg && isFin(agg.breadthImproving) ? agg.breadthImproving : 0.5) +
    0.15 * (lead.decay == null ? 0.5 : lead.decay)
  ));

  // Data-quality: peers present, leader coverage, history depth — 0..1.
  const dataQuality = round4(clamp(
    (agg ? 0.5 : 0) +
    (ownReaction != null ? 0.25 : 0) +
    (lead.leaders > 0 ? 0.15 : 0) +
    ((ownSeries || []).length >= 100 ? 0.10 : 0), 0, 1));

  return {
    version: VERSIONS.features,
    ticker,
    peerStrengthZ,
    peerAccel: agg ? agg.accel : null,
    peerBreadthImproving: agg ? agg.breadthImproving : null,
    peerDispersion: agg ? agg.dispersion : null,
    peerCount: agg ? agg.peers : (groupSeries || []).length,
    withinPeerPosition: round4(withinPeerPosition),
    ownReactionZ: round4(ownReaction),
    ownMove21Pct: isFin(ownMom21) ? round4(ownMom21 * 100) : null,
    unreflectedPeerStrength: unreflected,
    leaderPressure: lead.leaderPressure,
    leadersConfirming: lead.leadersConfirming,
    leaders: lead.leaders,
    topLeaders: lead.topLeaders,
    impulseAgeSessions: lead.impulseAgeSessions,
    propagationDecay: lead.decay,
    stage,
    score,
    dataQuality,
    missing,
  };
}

module.exports = {
  residMomentum, residDailyStd, reactionZ, median, mad,
  peerAggregates, leaderRead, classifyStage, stockPeerFeatures,
  STAGES,
};
