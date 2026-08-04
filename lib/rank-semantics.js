'use strict';
// SCORE vs PROBABILITY SEMANTICS (swing defect #7). Complements
// lib/prediction-contract.js: that module governs the full canonical Prediction
// record; THIS one is the lightweight descriptor every swing source attaches to
// its ranked rows so a reader (human or code) can never mistake a ranking score
// for a probability.
//
// THE CONTRACT.
//   rankScore        — the source's own ordering number (any scale). NOT a probability.
//   rankPercentile   — cross-sectional standing 0..100 within the SAME-DATE cohort.
//                      An honest relative order. NOT a probability.
//   probability      — null unless produced OUT-OF-FOLD for one exact, named outcome
//                      and validated on untouched observations. NEVER derived from a
//                      score by any transform (sigmoid, scaling, clamping — nothing).
//   probabilityOutcome — the exact outcome the probability is about (e.g.
//                      'target-before-stop@21s'); required whenever probability≠null.
//   calibrationStatus / calibrationVersion — how (and by which artifact) the
//                      probability earned display. 'uncalibrated' forces null.
//   evidenceClass    — ACTIONABLE | RESEARCH (board clearance), or 'rankOnly'.
//   sampleSize       — resolved observations behind any probability/record shown.
//
// `describeRank` FAILS CLOSED: any attempt to pass a probability without a
// calibrated status + outcome + sample throws — a score physically cannot
// populate the probability field.

const CALIBRATED = 'calibrated';
const UNCALIBRATED = 'uncalibrated';
const PROBABILITY_UNAVAILABLE_TEXT = 'Probability unavailable — evidence building';

function describeRank({
  rankScore = null,
  rankPercentile = null,
  probability = null,
  probabilityOutcome = null,
  calibrationStatus = UNCALIBRATED,
  calibrationVersion = null,
  evidenceClass = 'rankOnly',
  sampleSize = null,
} = {}) {
  if (rankPercentile != null && (!Number.isFinite(+rankPercentile) || rankPercentile < 0 || rankPercentile > 100)) {
    throw new Error(`describeRank(): rankPercentile must be 0..100 or null (got ${rankPercentile})`);
  }
  if (probability != null) {
    if (!Number.isFinite(+probability) || probability < 0 || probability > 1) {
      throw new Error(`describeRank(): probability must be in [0,1] or null (got ${probability})`);
    }
    if (calibrationStatus !== CALIBRATED) {
      throw new Error('describeRank(): a probability may only be attached with calibrationStatus="calibrated" — scores can never become probabilities');
    }
    if (!probabilityOutcome) {
      throw new Error('describeRank(): probability requires probabilityOutcome (the one exact outcome it is about)');
    }
    if (!calibrationVersion) {
      throw new Error('describeRank(): probability requires the calibrationVersion artifact reference');
    }
    if (!Number.isFinite(+sampleSize) || sampleSize <= 0) {
      throw new Error('describeRank(): probability requires the resolved sampleSize it was validated on');
    }
  } else if (calibrationStatus === CALIBRATED) {
    throw new Error('describeRank(): calibrationStatus="calibrated" with a null probability is contradictory');
  }
  return {
    rankScore: Number.isFinite(+rankScore) ? +rankScore : null,
    rankPercentile: rankPercentile != null ? +rankPercentile : null,
    probability: probability != null ? +probability : null,
    probabilityOutcome: probability != null ? probabilityOutcome : null,
    calibrationStatus,
    calibrationVersion: probability != null ? calibrationVersion : (calibrationVersion || null),
    evidenceClass,
    sampleSize: Number.isFinite(+sampleSize) ? +sampleSize : null,
    displayWhenNull: PROBABILITY_UNAVAILABLE_TEXT,
  };
}

// Convenience: the honest descriptor for a plain ranking score (the common case).
function rankOnly(rankScore, rankPercentile = null, evidenceClass = 'rankOnly') {
  return describeRank({ rankScore, rankPercentile, evidenceClass });
}

module.exports = { describeRank, rankOnly, PROBABILITY_UNAVAILABLE_TEXT };
