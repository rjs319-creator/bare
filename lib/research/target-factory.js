'use strict';
// 🎯 TARGET FACTORY (research-target-v1) — one place that defines what "worked" means.
//
// lib/research/multi-horizon.js already grades every prediction into a term structure
// of HorizonReturn rungs (gross, net, benchmark, sector, residual, MFE/MAE, severe
// loss). What the repo lacked was a CENTRAL definition of the alternative learning
// TARGETS built from those rungs, so each model quietly invented its own label. This
// module derives every challenger target from the SAME graded rung — no model may
// define an incompatible label privately.
//
// Variants (Phase-4 challenger set):
//   raw                       gross return (no costs, no benchmark)
//   market-residual           net return − market benchmark return
//   sector-residual           net return − sector (fallback market) return
//   cost-adjusted-residual    the rung's residualReturn (net of costs AND benchmark)
//   rank-cost-residual        within-decision-date percentile of cost-adjusted residual
//   hybrid-rank-magnitude     0.7·rank + 0.3·bounded magnitude — order plus size
//   target-before-stop        path-dependent barrier outcome — NOT derivable from
//                             MFE/MAE alone (order within the window is unknown), so
//                             it fails closed to null unless the caller supplies a
//                             real barrier outcome (lib/evolve-labels tripleBarrier).
//
// The PREFERRED ranking target is rank-cost-residual (rank within decision date of
// return − market/sector contribution − trading costs). That preference is a
// HYPOTHESIS to validate against the production champion in the harness, not an
// assumption — nothing here promotes it.
//
// Pure & deterministic. Rows come out in the research-harness event shape so every
// variant runs on identical purged folds.

const { percentileWithTies } = require('../rlt-residual');

const TARGET_FACTORY_VERSION = 'research-target-v1';

const TARGET_VARIANTS = Object.freeze([
  'raw', 'market-residual', 'sector-residual', 'cost-adjusted-residual',
  'rank-cost-residual', 'hybrid-rank-magnitude', 'target-before-stop',
]);

// The pre-declared preferred ranking target (still must beat the champion OOS).
const PREFERRED_TARGET = 'rank-cost-residual';

const isFin = Number.isFinite;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Find the ladder rung for `bars` in a MultiHorizonOutcome; null when absent/unresolved. */
function rungAt(vector, bars) {
  if (!vector || !Array.isArray(vector.horizons)) return null;
  const h = vector.horizons.find(x => x && x.bars === bars);
  return h && h.status === 'resolved' ? h : null;
}

/**
 * Point value of one target variant from a resolved rung.
 * `barrier` (optional) is a real path-dependent outcome from evolve-labels
 * tripleBarrier — required for target-before-stop, which otherwise returns null.
 */
function targetValue(rung, variant, { barrier = null } = {}) {
  if (!rung) return null;
  switch (variant) {
    case 'raw':
      return isFin(rung.grossReturn) ? rung.grossReturn : null;
    case 'market-residual':
      return (isFin(rung.netReturn) && isFin(rung.benchmarkReturn)) ? +(rung.netReturn - rung.benchmarkReturn).toFixed(3) : null;
    case 'sector-residual': {
      const bench = isFin(rung.sectorReturn) ? rung.sectorReturn : rung.benchmarkReturn;
      return (isFin(rung.netReturn) && isFin(bench)) ? +(rung.netReturn - bench).toFixed(3) : null;
    }
    case 'cost-adjusted-residual':
      return isFin(rung.residualReturn) ? rung.residualReturn : null;
    case 'target-before-stop':
      // Order of MFE vs MAE inside the window is unknowable from the rung — fail
      // closed to the caller-supplied path-dependent outcome or null. Never guess.
      return barrier && typeof barrier.won === 'boolean' ? (barrier.won ? 1 : 0) : null;
    default:
      return null;                                     // rank/hybrid need the cross-section
  }
}

/**
 * Within-decision-date percentile ranks of the cost-adjusted residual across a
 * batch of vectors sharing ONE decision date. Tie-aware; groups below minNames
 * return an empty map (a cross-sectional rank needs a cross-section).
 */
function rankWithinDate(vectors, bars, { minNames = 3 } = {}) {
  const vals = [];
  for (const v of vectors) {
    const r = rungAt(v, bars);
    const t = targetValue(r, 'cost-adjusted-residual');
    if (t != null) vals.push({ ticker: v.ticker, value: t });
  }
  if (vals.length < minNames) return {};
  const all = vals.map(x => x.value);
  const out = {};
  for (const x of vals) out[x.ticker] = +percentileWithTies(all, x.value).toFixed(4);
  return out;
}

/**
 * Build harness-ready rows for one decision-date batch of MultiHorizonOutcome
 * vectors, under one target variant. Every row keeps `labelEndDate` (the rung's
 * exit date) so lib/research/label-purge can drop it exactly.
 *
 * @param vectors   MultiHorizonOutcome[] for ONE decision date
 * @param opts      { bars, variant, decisionTs, featuresOf?, scoreOf?, barriersOf? }
 */
function buildTargetRows(vectors, { bars = 21, variant = PREFERRED_TARGET, decisionTs = null, featuresOf = null, scoreOf = null, barriersOf = null, minNames = 3 } = {}) {
  if (!TARGET_VARIANTS.includes(variant)) throw new Error(`unknown target variant: ${variant}`);
  const ranks = (variant === 'rank-cost-residual' || variant === 'hybrid-rank-magnitude')
    ? rankWithinDate(vectors, bars, { minNames })
    : null;

  // Magnitude scale for the hybrid: MAD of the date's cost-adjusted residuals.
  let scale = null;
  if (variant === 'hybrid-rank-magnitude') {
    const vals = vectors.map(v => targetValue(rungAt(v, bars), 'cost-adjusted-residual')).filter(isFin);
    if (vals.length >= minNames) {
      const med = vals.slice().sort((a, b) => a - b)[vals.length >> 1];
      const devs = vals.map(x => Math.abs(x - med)).sort((a, b) => a - b);
      scale = devs[devs.length >> 1] || 1;
    }
  }

  const rows = [];
  for (const v of vectors) {
    const rung = rungAt(v, bars);
    if (!rung) continue;                               // pending/unresolved: not trainable yet
    let outcome = null;
    if (variant === 'rank-cost-residual') {
      outcome = ranks[v.ticker] != null ? ranks[v.ticker] : null;
    } else if (variant === 'hybrid-rank-magnitude') {
      const rank = ranks[v.ticker];
      const mag = targetValue(rung, 'cost-adjusted-residual');
      outcome = (rank != null && mag != null && scale)
        ? +(0.7 * rank + 0.3 * clamp(mag / (3 * scale) + 0.5, 0, 1)).toFixed(4)
        : null;
    } else {
      const barrier = typeof barriersOf === 'function' ? barriersOf(v.ticker) : null;
      outcome = targetValue(rung, variant, { barrier });
    }
    if (outcome == null) continue;                     // an unbuildable label is dropped, not zeroed
    rows.push({
      securityId: v.ticker,
      ticker: v.ticker,
      decisionTs: decisionTs || v.fillTs || null,
      labelEndDate: rung.exitTs,
      horizon: bars,
      features: typeof featuresOf === 'function' ? (featuresOf(v.ticker) || {}) : {},
      score: typeof scoreOf === 'function' ? scoreOf(v.ticker) : null,
      outcome,
      won: outcome > (variant === 'rank-cost-residual' || variant === 'hybrid-rank-magnitude' ? 0.5 : 0),
      targetVariant: variant,
      targetVersion: TARGET_FACTORY_VERSION,
    });
  }
  return rows;
}

module.exports = {
  TARGET_FACTORY_VERSION, TARGET_VARIANTS, PREFERRED_TARGET,
  rungAt, targetValue, rankWithinDate, buildTargetRows,
};
