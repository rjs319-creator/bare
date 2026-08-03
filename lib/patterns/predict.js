// PATTERN PREDICTION — honest, staged outcome estimates.
//
// THE HONESTY CONTRACT (mirrors lib/coil-executable.js):
//   • The barrier estimate is a driftless two-barrier random-walk model. It is a
//     MODEL-ESTIMATE, never a calibrated win rate. `calibrated:false` unless a
//     leakage-safe resolved-outcome study says otherwise.
//   • A pattern's target-before-stop rate is meaningless without a BASELINE: what do
//     comparable names in the same regime do WITHOUT the pattern? `incrementalLift` is the
//     only number that speaks to edge, and it is null until matched-control data exists.
//   • Descriptive similarity (detectors.js) is NOT predictive value. This module keeps
//     them separate.

const { coilExecutable } = require('../coil-executable');

const isNum = v => typeof v === 'number' && isFinite(v);
const clamp01 = v => Math.max(0, Math.min(1, v));
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

// Wilson score interval for a binomial rate (used for empirical analog rates only).
function wilson(p, n, z = 1.96) {
  if (!isNum(p) || !isNum(n) || n <= 0) return null;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [round(clamp01(centre - half)), round(clamp01(centre + half))];
}

// Build the prediction block for a single detection.
//   detection : from detectors.detectWindow (has .plan, .direction, .geometry)
//   dailyVol  : the name's own trailing daily-return stdev (log space)
//   horizonBars, roundTripCostPct
//   analog    : optional { targetFirstRate, baselineRate, effectiveN, calibrated } from analog.js
function buildPrediction(detection, { dailyVol, horizonBars = 10, roundTripCostPct = 0.002, analog = null } = {}) {
  const plan = detection && detection.plan;
  const last = detection && detection.geometry && detection.geometry.lastClose;
  if (!plan || !isNum(last) || !isNum(plan.trigger) || !isNum(plan.stop) || !isNum(plan.target)) {
    return { available: false, reason: 'no-plan' };
  }
  if (!isNum(dailyVol) || dailyVol <= 0) {
    return { available: false, reason: 'no-vol' };
  }

  // Barrier MODEL-ESTIMATE (uncalibrated). Long uses the plan as-is. For a short we reflect
  // the price levels about 2·current (synthetic = 2·current − price): this keeps every level
  // POSITIVE and preserves the trigger/stop/target ordering the barrier model requires
  // (down-side trigger below current → synthetic buy-stop above current, etc.).
  const long = detection.direction !== 'SHORT';
  let be;
  if (long) {
    be = coilExecutable({ current: last, entry: plan.trigger, stop: plan.stop, target: plan.target, dailyVol, horizon: horizonBars, roundTripCostPct });
  } else {
    const refl = p => 2 * last - p;
    if (![plan.trigger, plan.stop, plan.target].every(p => refl(p) > 0)) {
      return { available: false, reason: 'short-geometry-out-of-range' };
    }
    be = coilExecutable({ current: last, entry: refl(plan.trigger), stop: refl(plan.stop), target: refl(plan.target), dailyVol, horizon: horizonBars, roundTripCostPct });
  }
  if (!be) return { available: false, reason: 'barrier-model-null' };

  const targetBeforeStop = round(be.pTargetBeforeStopGivenFill);
  const stopBeforeTarget = isNum(targetBeforeStop) ? round(1 - targetBeforeStop) : null;
  const timeout = round(clamp01(1 - (be.pTrigger ?? 0)));            // P(never fills in horizon)

  // Empirical analog block (the only path to a calibrated number).
  let baselineTargetFirst = null;
  let incrementalLift = null;
  let empiricalRate = null;
  let confidenceInterval = be.uncertaintyInterval || null;
  let calibrated = false;
  let effectiveN = 0;
  if (analog && isNum(analog.targetFirstRate) && isNum(analog.effectiveN) && analog.effectiveN > 0) {
    empiricalRate = round(analog.targetFirstRate);
    effectiveN = analog.effectiveN;
    baselineTargetFirst = isNum(analog.baselineRate) ? round(analog.baselineRate) : null;
    if (isNum(baselineTargetFirst)) incrementalLift = round(empiricalRate - baselineTargetFirst);
    confidenceInterval = wilson(empiricalRate, effectiveN) || confidenceInterval;
    calibrated = analog.calibrated === true;   // only the study may assert calibration
  }

  return {
    available: true,
    horizonBars,
    // THE probability contract: `probability` is null unless a leakage-safe study
    // calibrated this family. The barrier numbers below are labeled model estimates and
    // must never be displayed as a probability of success.
    probability: (analog && analog.calibrated === true && isNum(analog.targetFirstRate)) ? round(analog.targetFirstRate) : null,
    probabilityNote: (analog && analog.calibrated === true)
      ? 'empirical out-of-sample target-first rate'
      : 'no calibrated probability — insufficient validated out-of-sample evidence',
    // MODEL-ESTIMATE barrier probabilities (uncalibrated):
    targetBeforeStop,
    stopBeforeTarget,
    timeout,
    triggerProbability: round(be.pTrigger),
    expectedNetR: round(be.expectedNetR),
    expectedNetReturnPct: isNum(be.expectedNetR) && isNum(plan.trigger) && isNum(plan.stop)
      ? round((be.expectedNetR * Math.abs(plan.trigger - plan.stop) / last) * 100, 3)
      : null,
    failureProbability: round(be.severeLossProbability),
    rrNet: round(be.rrNet),
    calibrationStatus: be.calibrationStatus,   // 'model-estimate'
    // EMPIRICAL analog block (may be null → we say so):
    empiricalTargetFirst: empiricalRate,
    baselineTargetFirst,
    incrementalLift,               // the ONLY edge number; null until matched controls exist
    effectiveSampleSize: effectiveN,
    confidenceInterval,
    calibrated,                    // false unless a leakage-safe study calibrated it
  };
}

module.exports = { buildPrediction, wilson };
