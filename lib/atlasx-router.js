'use strict';
// ATLAS-X — expert router (SHADOW / weight-0).
//
// Turns six per-expert opinions into ONE set of influence weights + a selected
// expert. It is deliberately NOT an average: averaging six correlated or opposing
// opinions manufactures false confirmation. The router therefore:
//
//   1. Bases each expert's weight on its own applicability.
//   2. Scales that by the expert's INCREMENTAL value — performance BEYOND what a
//      simple baseline and the other correlated experts already explain — using
//      HIERARCHICAL SHRINKAGE so a thin expert×regime×setup×liquidity cell falls
//      back toward its parent estimate instead of over-fitting a few samples.
//   3. DE-CORRELATES: experts that fire on the same price path (e.g. compression
//      release & breakout continuation) do not each collect full duplicate credit.
//   4. Resolves OPPOSITION: a bullish and a bearish expert are never both
//      high-weighted — the stronger wins and its opposite is suppressed, so the
//      output is a decision, not a mushy consensus.

const { VERSIONS } = require('./atlasx-config');
const { EXPERTS } = require('./atlasx-contracts');

// ── tunables ─────────────────────────────────────────────────────────────────
const SHRINK_K = 20;        // prior strength: cell needs ~K samples to earn full trust
const INC_GAIN = 3.0;       // how hard shrunk incremental value bends the weight
const INC_FLOOR = 0.25;     // an expert with poor incremental value is damped, never erased
const INC_CEIL = 2.0;       // and a great one is capped (no runaway single expert)
const OPPOSE_SUPPRESS = 0.15; // opposite-direction expert is cut to this fraction
const EPS = 1e-9;

// Correlated expert pairs and their overlap coefficient (0..1). Both firing on
// the same underlying move → the weaker one is largely redundant.
const CORRELATION = Object.freeze([
  Object.freeze(['compressionRelease', 'breakoutContinuation', 0.6]),
  Object.freeze(['firstPullback', 'breakoutContinuation', 0.45]),
  Object.freeze(['compressionRelease', 'firstPullback', 0.3]),
  Object.freeze(['catalystDrift', 'eventDislocation', 0.5]),
]);

const num = x => (x == null || !isFinite(Number(x)) ? 0 : Number(x));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function isOpposite(a, b) {
  return (a === 'bullish' && b === 'bearish') || (a === 'bearish' && b === 'bullish');
}

// ── hierarchical shrinkage ───────────────────────────────────────────────────
// cells = { global, byRegime, byRegimeSetup, byRegimeSetupLiq }, ordered from
// most-general (parent prior) to most-specific (child). Each level shrinks toward
// the shrunk estimate of its parent with weight n/(n+K): a small-n child stays
// near its parent, a large-n child earns its own estimate. Returns the deepest
// shrunk estimate PLUS the parent it was pulled toward (so callers can verify the
// shrunk value lies between the raw child and its parent).
function shrinkHierarchy(cells) {
  const order = ['global', 'byRegime', 'byRegimeSetup', 'byRegimeSetupLiq'];
  const levels = [];
  let est = null;
  let parent = null;
  for (const key of order) {
    const cell = cells && cells[key];
    if (!cell || cell.incrementalValue == null || !isFinite(cell.incrementalValue)) continue;
    const raw = Number(cell.incrementalValue);
    if (est == null) {
      est = raw; // root prior: the global estimate stands as-is
      levels.push(Object.freeze({ key, raw, shrunk: est, n: cell.n == null ? null : num(cell.n) }));
      continue;
    }
    parent = est;
    const n = num(cell.n);
    const w = n / (n + SHRINK_K);
    est = w * raw + (1 - w) * parent;
    levels.push(Object.freeze({ key, raw, shrunk: est, parent, n }));
  }
  return Object.freeze({ shrunk: est, parent, levels: Object.freeze(levels) });
}

// Pull the cell hierarchy for one expert out of the performance blob. Supports
// per-expert performance ({ compressionRelease: {global,...} }) OR a single shared
// hierarchy applied to every expert ({ global, byRegime, ... }).
function cellsFor(performance, expertId) {
  if (!performance || typeof performance !== 'object') return null;
  if (performance[expertId] && typeof performance[expertId] === 'object') return performance[expertId];
  if (performance.global || performance.byRegime || performance.byRegimeSetup || performance.byRegimeSetupLiq) {
    return performance;
  }
  return null;
}

// Incremental-value multiplier for one expert (neutral 1.0 when no performance).
function incrementalFactor(performance, expertId) {
  const cells = cellsFor(performance, expertId);
  if (!cells) return { factor: 1, shrunk: null, parent: null, raw: null, n: null };
  const s = shrinkHierarchy(cells);
  if (s.shrunk == null) return { factor: 1, shrunk: null, parent: null, raw: null, n: null };
  const deepest = s.levels[s.levels.length - 1] || {};
  return {
    factor: clamp(1 + INC_GAIN * s.shrunk, INC_FLOOR, INC_CEIL),
    shrunk: s.shrunk,
    parent: s.parent,
    raw: deepest.raw != null ? deepest.raw : null,
    n: deepest.n != null ? deepest.n : null,
  };
}

// ── main router ──────────────────────────────────────────────────────────────
function routeExperts({ expertAssessments, ctx, performance } = {}) {
  const src = expertAssessments || {};
  const c = ctx || {};

  // 1) base weight = applicability, 2) × incremental-value factor.
  const weights = {};
  const shrinkage = {};
  for (const id of EXPERTS) {
    const a = src[id];
    const applic = a ? num(a.applicability) : 0;
    const inc = incrementalFactor(performance, id);
    weights[id] = Math.max(0, applic * inc.factor);
    if (inc.shrunk != null) {
      shrinkage[id] = Object.freeze({ raw: inc.raw, parent: inc.parent, shrunk: inc.shrunk, n: inc.n, factor: inc.factor });
    }
  }

  // 3) de-correlate: remove duplicate credit from the WEAKER of each correlated
  //    pair so two experts on one price path can't double-count.
  const penalty = {};
  for (const [a, b, coef] of CORRELATION) {
    const wa = weights[a], wb = weights[b];
    if (wa > EPS && wb > EPS) {
      const overlap = coef * Math.min(wa, wb);
      const weaker = wa <= wb ? a : b;
      penalty[weaker] = (penalty[weaker] || 0) + overlap;
    }
  }
  for (const id of EXPERTS) weights[id] = Math.max(0, weights[id] - (penalty[id] || 0));

  // 4) resolve opposition around the current leader: any expert pointing the
  //    opposite way to the strongest one is suppressed (no false confirmation).
  const leader = argmax(weights);
  const leaderDir = leader && src[leader] ? src[leader].direction : null;
  const suppressed = [];
  if (leaderDir) {
    for (const id of EXPERTS) {
      if (id === leader) continue;
      const dir = src[id] ? src[id].direction : null;
      if (dir && isOpposite(dir, leaderDir) && weights[id] > EPS) {
        weights[id] *= OPPOSE_SUPPRESS;
        suppressed.push(id);
      }
    }
  }

  const selectedExpert = argmax(weights);
  const rationale = buildRationale(selectedExpert, weights, penalty, suppressed);

  return Object.freeze({
    selectedExpert: selectedExpert && weights[selectedExpert] > EPS ? selectedExpert : null,
    weights: Object.freeze(weights),
    context: Object.freeze({
      regime: c.regime || 'unknown',
      riskOff: c.riskOff === true,
      liqTier: c.liqTier || null,
      leaderDirection: leaderDir || null,
    }),
    version: VERSIONS.router,
    rationale,
    shrinkage: Object.freeze(shrinkage),
  });
}

function argmax(weights) {
  let best = null, bestW = -Infinity;
  for (const id of EXPERTS) {
    if (weights[id] > bestW) { bestW = weights[id]; best = id; }
  }
  return bestW > EPS ? best : null;
}

function buildRationale(selected, weights, penalty, suppressed) {
  if (!selected || !(weights[selected] > EPS)) return 'No expert cleared a positive influence weight; abstain.';
  const parts = [`selected ${selected} (w=${weights[selected].toFixed(3)})`];
  const decorr = Object.keys(penalty).filter(k => penalty[k] > EPS);
  if (decorr.length) parts.push(`de-correlated: ${decorr.join(', ')}`);
  if (suppressed.length) parts.push(`opposition-suppressed: ${suppressed.join(', ')}`);
  return parts.join('; ');
}

module.exports = {
  routeExperts,
  shrinkHierarchy,
  incrementalFactor,
  cellsFor,
  CORRELATION,
  SHRINK_K,
  OPPOSE_SUPPRESS,
};
