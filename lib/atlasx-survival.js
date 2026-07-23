'use strict';
// ATLAS-X — competing-risk survival + dynamic landmarking (`atlasx-survival-v1`).
// SHADOW / weight-0: nothing here affects the live rank or grants trade eligibility.
//
// Wraps the existing hierarchical empirical-Bayes competing-risk layer
// (lib/challenger-survival.assessSurvival) so ATLAS-X shares ONE shrinkage table
// (a tiny/cold-start cell can never emit an extreme 0/1 probability — it shrinks
// toward DEFAULT_PRIOR). Adds two things challenger-survival does not:
//   1. per-EXPERT barrier geometry (a compression release, a breakout continuation,
//      a first pullback and a catalyst drift must NOT share identical geometry), and
//   2. DYNAMIC LANDMARKING — an append-only re-assessment of an open episode that
//      preserves every prior prediction and only ever uses info available as-of the
//      landmark date. Outputs are EXPERIMENTAL SCORES (calibrationStatus
//      'uncalibrated'), never probabilities to display as percentages.
//
// Pure functions, frozen outputs, no mutation.

const { VERSIONS, BARRIERS } = require('./atlasx-config');
const { barriersFor } = require('./evolve-labels');
const { assessSurvival, DEFAULT_PRIOR } = require('./challenger-survival');

const SWING_HORIZON = 'swing';
const PHASES = Object.freeze(['pre-entry', 'post-entry']);
const CALIBRATION_STATUS = 'uncalibrated';   // never a % until an OOF artifact promotes it
const PROB_TOLERANCE = 0.02;                  // competing-risk sum must be ~1

// Per-expert geometry MULTIPLIERS over the swing defaults. Deliberately distinct so
// four differently-shaped setups are judged on their OWN tradeable move, not one
// generic barrier. Unknown experts fall back to the config BARRIERS (multiplier 1).
const EXPERT_GEOMETRY = Object.freeze({
  compressionRelease:   Object.freeze({ target: 1.2, stop: 0.9, timeout: 1.0 }), // tight coil break
  breakoutContinuation: Object.freeze({ target: 1.4, stop: 1.0, timeout: 1.0 }), // let a runner run
  firstPullback:        Object.freeze({ target: 1.0, stop: 0.7, timeout: 0.7 }), // tight stop, quick
  catalystDrift:        Object.freeze({ target: 1.6, stop: 1.2, timeout: 1.3 }), // wide + patient
});
const DEFAULT_GEOMETRY = Object.freeze({ target: 1.0, stop: 1.0, timeout: 1.0 });

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function num(v) { return isNum(v) ? v : null; }
function round3(v) { return isNum(v) ? Math.round(v * 1000) / 1000 : v; }
function round4(v) { return isNum(v) ? Math.round(v * 10000) / 10000 : v; }

/**
 * Per-expert configurable barriers. Base geometry comes from the swing triple-barrier
 * defaults (evolve-labels.barriersFor), volatility-adjusted when an ATR% is known, then
 * scaled by the expert's distinct multipliers. Returns BOTH the ATR-multiple geometry
 * (targetAtr/stopAtr/timeoutSessions, matching config BARRIERS) and the fractional
 * up/down/window used by tripleBarrier.
 * @param {string} expertId
 * @param {{atrPct?: number|null}} [opts]
 */
function barriersForExpert(expertId, { atrPct = null } = {}) {
  const g = EXPERT_GEOMETRY[expertId] || DEFAULT_GEOMETRY;
  const base = barriersFor(SWING_HORIZON, { atrPct, volAdjust: isNum(atrPct) && atrPct > 0 });
  const timeoutSessions = Math.max(1, Math.round(BARRIERS.timeoutSessions * g.timeout));
  return Object.freeze({
    expertId: expertId || 'default',
    targetAtr: round4(BARRIERS.targetAtr * g.target),
    stopAtr: round4(BARRIERS.stopAtr * g.stop),
    timeoutSessions,
    up: round4(base.up * g.target),
    down: round4(base.down * g.stop),
    window: timeoutSessions,
    volAdjusted: base.volAdjusted === true,
    atrPct: num(atrPct),
  });
}

// Force the three competing-risk probabilities to sum to exactly 1 (validateSurvival
// requires it). pNeither is DERIVED last from the rounded pair so there is no residual.
function normalizeTriple(pTarget, pStop, pNeither) {
  let a = num(pTarget), b = num(pStop), c = num(pNeither);
  a = a == null ? 0 : a; b = b == null ? 0 : b; c = c == null ? 0 : c;
  let s = a + b + c;
  if (!(s > 0)) { a = DEFAULT_PRIOR.pTarget; b = DEFAULT_PRIOR.pStop; c = DEFAULT_PRIOR.pNeither; s = 1; }
  const t = round3(a / s);
  const st = round3(b / s);
  const n = round3(1 - t - st);           // exact remainder → sum is exactly 1
  return { pTargetBeforeStop: t, pStopBeforeTarget: st, pNeither: n };
}

function atrPctOf(sig, ctx) {
  return num(sig && sig.atrPct) != null ? sig.atrPct
    : num(ctx && ctx.atrPct) != null ? ctx.atrPct
      : num(sig && sig.features && sig.features.atrPct);
}

/**
 * Competing-risk survival for an ATLAS-X candidate. Wraps challenger-survival and
 * returns a contract-shaped, phase-tagged assessment whose three probabilities sum to 1.
 * Pre-entry vs post-entry are SEPARATE assessments: post-entry drops the entry-timing
 * classification (you are already in) and tags the phase so an episode never conflates
 * "should I enter?" with "am I surviving?".
 * @param {object} sig  enriched signal (expert, horizon, state, liquidity, ...)
 * @param {object} [ctx] { table, regime, atrPct }
 * @param {'pre-entry'|'post-entry'} [phase]
 */
function assessAtlasSurvival(sig, ctx = {}, phase = 'pre-entry') {
  const ph = PHASES.includes(phase) ? phase : 'pre-entry';
  const base = assessSurvival(sig || {}, ctx || {});
  const probs = normalizeTriple(base.pTargetBeforeStop, base.pStopBeforeTarget, base.pNeither);
  const expertId = (sig && sig.expert) || (ctx && ctx.expert) || 'default';
  const barriers = barriersForExpert(expertId, { atrPct: atrPctOf(sig, ctx) });
  const entryState = ph === 'post-entry' ? 'IN_TRADE' : base.entryState;

  return Object.freeze({
    version: VERSIONS.survival,
    phase: ph,
    calibrationStatus: CALIBRATION_STATUS,
    isExperimentalScore: true,           // NOT a validated probability — never shown as %
    ...probs,
    expectedSessions: round3(base.expectedSessionsToResolution),
    entryState,
    effN: base.effN,
    shrunkToPrior: base.shrunkToPrior === true,
    barriers,
  });
}

/**
 * Open an immutable episode around a pre-entry prediction. `original` is frozen and is
 * NEVER rewritten; `landmarks` is an append-only, frozen array.
 */
function openEpisode(sig, ctx = {}) {
  const original = assessAtlasSurvival(sig, ctx, 'pre-entry');
  return Object.freeze({
    securityId: (sig && (sig.securityId || sig.ticker || sig.symbol)) || null,
    expert: (sig && sig.expert) || 'default',
    openedAt: (sig && sig.date) || (ctx && ctx.asOf) || null,
    original,
    landmarks: Object.freeze([]),
  });
}

/**
 * DYNAMIC LANDMARKING. Given an open episode and a context carrying the observed state
 * as-of a landmark date (ctx.sig, ctx.table, ctx.asOf), compute a NEW post-entry
 * assessment and return a NEW episode with it appended to `landmarks`. The `original`
 * prediction and every earlier landmark are preserved by reference — nothing is mutated.
 * Uses ONLY the info in the supplied as-of context (the caller slices point-in-time).
 * @param {object} episode  { original, landmarks }
 * @param {object} [ctx]    { sig, table, regime, atrPct, asOf }
 * @returns {object} a new frozen episode
 */
function landmark(episode, ctx = {}) {
  if (!episode || typeof episode !== 'object') {
    throw new Error('landmark: episode object required');
  }
  const sig = ctx.sig || episode.current || null;
  const asOf = ctx.asOf || ctx.landmarkDate || (sig && sig.date) || null;
  const assessment = assessAtlasSurvival(sig, ctx, 'post-entry');
  const entry = Object.freeze({ asOf, ...assessment });
  const prior = Array.isArray(episode.landmarks) ? episode.landmarks : [];
  return Object.freeze({
    ...episode,
    original: episode.original,                       // preserved reference — never rewritten
    landmarks: Object.freeze([...prior, entry]),      // append-only copy
  });
}

module.exports = {
  PHASES,
  EXPERT_GEOMETRY,
  barriersForExpert,
  normalizeTriple,
  assessAtlasSurvival,
  openEpisode,
  landmark,
};
