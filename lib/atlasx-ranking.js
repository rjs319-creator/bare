'use strict';
// ATLAS-X — interpretable DISTRIBUTIONAL residual-return model (atlasx-ranking-v1).
//
// This is the ranking layer of the ATLAS-X SHADOW engine (weight-0; live
// eligibility is enforced elsewhere by strategy-gate, never here). It is a
// deliberately WHITE-BOX baseline: an additive linear model over a handful of
// date-normalizable, point-in-time features (residual momentum, residual
// acceleration, transition strength, path quality, expert applicability). There
// is NO trained artifact and NO black box — every prediction exposes its
// per-feature `contributions` so a reviewer can read exactly why a name ranks
// where it does.
//
// It predicts a DISTRIBUTION of residual return, not a single number: a central
// estimate from the additive model, then quantiles from a volatility-scaled
// spread (residual.vol) so p10 <= median <= p90 holds by construction. NO
// probability is ever surfaced — calibrationStatus stays 'uncalibrated' until an
// out-of-fold calibration artifact promotes it (see atlasx-contracts.displayNumber).
//
// ONE weight source (WEIGHTS) drives BOTH predictDistribution (applied to raw
// features → an absolute residual-return estimate) and atlasxRanker.score
// (applied to TRAIN-standardized features → a cross-sectional rank). Same
// interface as lib/research/baseline-ranker.js so it plugs into the same harness
// (compareRankers / runExperiment) unchanged.

const { VERSIONS, RESIDUAL_HORIZONS } = require('./atlasx-config');
const { CALIBRATION_STATUS } = require('./atlasx-contracts');
const { fitStats } = require('./research/baseline-ranker');

const RANKING_VERSION = VERSIONS.ranking;
const UNCALIBRATED = CALIBRATION_STATUS[0]; // 'uncalibrated' — the only honest status pre-calibration

// ── model constants (named, never magic) ─────────────────────────────────────
const DEFAULT_HORIZON = 10;          // completed sessions (matches swing HOLDING_WINDOW)
const RESID_ACCEL_SCALE = 10;        // residualAccel is per-session; ×10 → per-10-session, comparable to residMom
const NORMAL_Z10 = 1.2816;           // |z| at the 10th/90th percentile of a standard normal
const ES_TAIL_MULT = 1.755;          // E[Z | Z < -z.10] magnitude = phi(z.10)/0.10 → ES strictly below p10
const MFE_SIGMA_MULT = 1.5;          // remaining favorable excursion in vol units (mirrors BARRIERS.targetAtr)
const MAE_SIGMA_MULT = 1.0;          // remaining adverse excursion in vol units (mirrors BARRIERS.stopAtr)
const VOL_FALLBACK = 0.06;           // per-session daily stdev used when residual.vol is unknown → WIDE interval
const MIN_SIGMA = 0.005;             // floor so quantiles never collapse to a single point

// WINSORIZATION — an unbounded additive model lets an extreme-move microcap (e.g. a
// parabolic name with a +700% 10-session residual, or a name whose residual is really
// an unadjusted-split / bad-bar artifact) dominate the whole cross-sectional ranking.
// Cap each residual-momentum feature per horizon (grows with √h so a 20-session
// residual is allowed to be larger than a 5-session one), cap the scaled acceleration
// term, and cap the per-session vol that sets the interval spread so the band can't
// explode to ±2000%. This is winsorization, not truncation of the SIGNAL: order among
// normal names is preserved; only the outlier tail is clamped so it can rank high
// without ranking absurd.
const WINSOR_K = 0.16;               // per-horizon residual cap = WINSOR_K·√h  (10-session ≈ 0.51)
const RESID_ACCEL_CAP = 0.5;         // cap on the ×10-scaled residual-acceleration feature
const VOL_CAP = 0.08;                // per-session daily-stdev cap for the distribution spread

function winsorResid(v, h) {
  if (!isFin(v)) return v;
  const cap = WINSOR_K * Math.sqrt(h);
  return clamp(v, -cap, cap);
}
function capAccel(v) {
  return isFin(v) ? clamp(v, -RESID_ACCEL_CAP, RESID_ACCEL_CAP) : v;
}

// The residual horizons this layer reads for its momentum features. Guarded at
// load time against the upstream contract so a horizon rename can never silently
// turn a feature into a permanent null.
const RESID_FEATURE_HORIZONS = Object.freeze({ short: 5, mid: 10, long: 20 });
for (const h of Object.values(RESID_FEATURE_HORIZONS)) {
  if (!RESIDUAL_HORIZONS.includes(h)) {
    throw new Error(`atlasx-ranking: residual horizon ${h} not in RESIDUAL_HORIZONS`);
  }
}

// Flat feature keys, declared once so predictDistribution, the ranker and the
// harness agree on identity/order. These mirror lib/research/features.js in
// spirit (residMom* ≈ its `residMom21`) but are derived from the ATLAS-X
// upstream artifacts (residual / transition / path / expert), not a raw candle
// vector — so they keep their own namespace.
const ATLASX_FEATURE_KEYS = Object.freeze([
  'residMom5',            // idiosyncratic residual return, 5-session
  'residMom10',           // idiosyncratic residual return, 10-session (central)
  'residMom20',           // idiosyncratic residual return, 20-session
  'residAccel',           // residual acceleration (per-10-session scaled)
  'transitionStrength',   // compression→expansion strength, centered at 0
  'pathQuality',          // smoothness minus spike-share, in [-1, 1]
  'expertApplicability',  // selected-expert strength, centered at 0
]);

// The SINGLE weight source. Positive weights on the residual-momentum terms make
// the central estimate monotonic in residual momentum (a stronger residual ranks
// higher). Residual weights sum to 0.75 → a DAMPED forward projection (not naive
// full continuation); transition/path/expert are small tilts.
const WEIGHTS = Object.freeze({
  residMom5: 0.20,
  residMom10: 0.35,
  residMom20: 0.20,
  residAccel: 0.10,
  transitionStrength: 0.06,
  pathQuality: 0.05,
  expertApplicability: 0.04,
});

// ── small pure helpers ───────────────────────────────────────────────────────
const isFin = (v) => Number.isFinite(v);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clamp01 = (x) => clamp(x, 0, 1);
const r6 = (x) => (isFin(x) ? +x.toFixed(6) : x);

// ── feature extraction (each returns a finite number or null; never fabricates) ─
function residAt(residual, h) {
  const bh = residual && residual.byHorizon;
  const row = bh && bh[h];
  return row && isFin(row.residual) ? row.residual : null;
}

function residAccelFeat(residual) {
  const a = residual && residual.residualAccel;
  return isFin(a) ? a * RESID_ACCEL_SCALE : null;
}

// Transition strength: prefer an explicit score, centered so 0 = neutral. Falls
// back to null (missing) rather than guessing when no score is present.
function transitionStrengthFeat(transition) {
  const scores = transition && transition.scores;
  if (scores) {
    for (const k of ['compressionToExpansion', 'momentumAcceleration', 'breakoutAcceptance']) {
      if (isFin(scores[k])) return clamp01(scores[k]) - 0.5;
    }
  }
  return null;
}

// Path quality: smooth accumulation is favorable, spike-and-fade is not.
function pathQualityFeat(path) {
  const f = path && path.features;
  if (!f) return null;
  const sm = isFin(f.smoothness) ? f.smoothness : null;
  const sp = isFin(f.spikeShare) ? f.spikeShare : null;
  if (sm == null && sp == null) return null;
  return clamp((sm || 0) - (sp || 0), -1, 1);
}

// Expert applicability: strength of the selected expert, centered at 0.
function expertApplicabilityFeat(expert) {
  const a = expert && expert.applicability;
  return isFin(a) ? clamp01(a) - 0.5 : null;
}

/**
 * Flat numeric feature object for a candidate, suitable as a harness row's
 * `.features`. Date-normalization (standardization) happens later in the
 * ranker's fit(); here the values are the raw, PIT, 0-centered signals.
 * @returns {Readonly<Record<string, number|null>>}
 */
function featureRow({ residual, transition, path, expert } = {}) {
  return Object.freeze({
    residMom5: winsorResid(residAt(residual, RESID_FEATURE_HORIZONS.short), RESID_FEATURE_HORIZONS.short),
    residMom10: winsorResid(residAt(residual, RESID_FEATURE_HORIZONS.mid), RESID_FEATURE_HORIZONS.mid),
    residMom20: winsorResid(residAt(residual, RESID_FEATURE_HORIZONS.long), RESID_FEATURE_HORIZONS.long),
    residAccel: capAccel(residAccelFeat(residual)),
    transitionStrength: transitionStrengthFeat(transition),
    pathQuality: pathQualityFeat(path),
    expertApplicability: expertApplicabilityFeat(expert),
  });
}

// ── the additive model (ONE weight source, shared by both consumers) ──────────
// Per-feature contribution = weight × value (missing feature → 0 contribution).
function contributionsOf(features) {
  const c = {};
  for (const k of ATLASX_FEATURE_KEYS) {
    const v = features[k];
    c[k] = isFin(v) ? r6(WEIGHTS[k] * v) : 0;
  }
  return c;
}
function sumContributions(contribs) {
  let s = 0;
  for (const k of ATLASX_FEATURE_KEYS) s += contribs[k];
  return s;
}

function volOf(residual) {
  const v = residual && residual.vol;
  if (!(isFin(v) && v > 0)) return null;
  return Math.min(v, VOL_CAP); // cap the spread so an extreme-vol microcap can't blow the band out
}

/**
 * Distributional prediction of residual return. Satisfies
 * atlasx-contracts.validateDistributional. NO probability is displayed; the
 * `score` is a cost-agnostic cross-sectional central estimate.
 */
function predictDistribution({ residual, transition, path, expert, ctx } = {}) {
  const horizon = (ctx && Number.isInteger(ctx.horizon) && ctx.horizon > 0)
    ? ctx.horizon
    : DEFAULT_HORIZON;

  const features = featureRow({ residual, transition, path, expert });
  const contributions = contributionsOf(features);
  const median = sumContributions(contributions); // central residual-return estimate

  // Volatility-scaled spread: per-session vol grown to the horizon. Unknown vol
  // → a deliberately WIDE fallback so a data-poor name gets an honest wide band.
  const vol = volOf(residual);
  const sigma = Math.max(MIN_SIGMA, (vol != null ? vol : VOL_FALLBACK) * Math.sqrt(horizon));

  const p10 = median - NORMAL_Z10 * sigma;
  const p90 = median + NORMAL_Z10 * sigma;
  const expectedShortfall = median - ES_TAIL_MULT * sigma; // mean of the sub-p10 tail (< p10)
  const remainingMFE = MFE_SIGMA_MULT * sigma + Math.max(0, median);
  const remainingMAE = MAE_SIGMA_MULT * sigma + Math.max(0, -median);

  return Object.freeze({
    horizon,
    p10: r6(p10),
    median: r6(median),
    p90: r6(p90),
    expectedShortfall: r6(expectedShortfall),
    remainingMFE: r6(remainingMFE),
    remainingMAE: r6(remainingMAE),
    score: r6(median),                 // cross-sectional ranking score (cost-agnostic)
    version: RANKING_VERSION,
    calibrationStatus: UNCALIBRATED,   // NEVER a percentage until a calibration artifact promotes it
    volUsed: vol != null,
    sigma: r6(sigma),
    features,
    contributions: Object.freeze(contributions),
  });
}

// ── harness-compatible ranker (baseline-ranker.js contract) ───────────────────
// { name, fit(trainRows) -> model, score(model, row) -> number }
// fit standardizes each feature by TRAIN-only mean/std (no leakage). score
// applies the SAME WEIGHTS to the standardized values → cross-sectional order.
const atlasxRanker = Object.freeze({
  name: 'atlasx-baseline',
  fit(trainRows) {
    const rows = Array.isArray(trainRows) ? trainRows : [];
    const stats = fitStats(rows, ATLASX_FEATURE_KEYS); // reads r.features[k]; imputes to mean (z=0)
    return Object.freeze({
      keys: ATLASX_FEATURE_KEYS,
      stats: Object.freeze(stats),
      weights: WEIGHTS,
      n: rows.length,
      version: RANKING_VERSION,
    });
  },
  score(model, row) {
    if (!model || !model.stats) return 0;
    const vals = (row && row.features) || {};
    let s = 0;
    for (const k of model.keys) {
      const st = model.stats[k];
      const v = vals[k];
      const z = (isFin(v) && st && st.std) ? (v - st.mean) / st.std : 0; // missing → mean → z=0
      s += (WEIGHTS[k] || 0) * z;
    }
    return s;
  },
});

/**
 * Research interface stub. A trained learning-to-rank / gradient-boosting
 * challenger (LambdaRank / CatBoost) is explicitly OUT OF SCOPE and is NOT
 * shipped. It is data- and dependency-gated and must beat this interpretable
 * baseline OOS before it may score any pick. Do NOT fabricate a model here.
 */
function researchInterface() {
  return Object.freeze({
    baseline: atlasxRanker.name,
    challenger: 'atlasx-lambdarank-catboost (NOT IMPLEMENTED)',
    status: 'out-of-scope',
    gatedBy: Object.freeze([
      'point-in-time labeled dataset (residual-return outcomes)',
      'survivorship-safe universe',
      'external dependency: a learning-to-rank / gradient-boosting library',
    ]),
    promotionRule:
      'a trained challenger must beat atlasx-baseline on OOS purged daily rank-IC '
      + '(lib/research/harness.compareRankers) before it may score any live pick',
    note: 'Interpretable additive baseline only; no trained artifact ships.',
  });
}

module.exports = {
  RANKING_VERSION,
  ATLASX_FEATURE_KEYS,
  WEIGHTS,
  featureRow,
  predictDistribution,
  atlasxRanker,
  researchInterface,
};
