'use strict';
// OMEGA-SWING CALIBRATION MATURITY — Phase 9. The single gate that decides whether a numeric
// PROBABILITY may be shown to a trader, or whether only a qualitative evidence band is honest.
//
// The core dishonesty this removes: OMEGA's pPositive / p3pct / p5pct / "model confidence" are
// a TRANSPARENT BASELINE — a monotone map from features, NOT a trained, out-of-fold-calibrated
// model output. Presenting them as percentages implies a calibration that does not exist.
//
// RULE (fail closed): a percentage may be displayed ONLY when ALL hold —
//   1. out-of-fold calibrated (a calibration artifact exists for this horizon),
//   2. sample size ≥ minimum,
//   3. calibration beats the base-rate predictor (Brier skill > 0),
//   4. the calibration version is current,
//   5. drift within tolerance.
// Otherwise: show a RANK + a qualitative band + "probability unavailable — insufficient
// calibration evidence." No trained/calibrated model ships in this run, so `assess` returns
// `display:false` for every current OMEGA probability. That is the correct, honest state.
//
// Pure & deterministic.

const CALIBRATION_MATURITY_VERSION = 'omega-cal-v1';
const MIN_SAMPLES = 200;

const MATURITY = Object.freeze({
  UNCALIBRATED: 'uncalibrated',   // baseline heuristic — NEVER show as a probability
  INSUFFICIENT: 'insufficient',   // a model exists but not enough evidence
  DRIFTED: 'drifted',             // calibration has decayed out of tolerance
  CALIBRATED: 'calibrated',       // all gates pass — a probability may be shown
});

// Map a baseline probability to a qualitative evidence band (what we CAN honestly say).
function qualitativeBand(p) {
  if (p == null || !Number.isFinite(p)) return 'unknown';
  if (p >= 0.62) return 'favorable';
  if (p >= 0.52) return 'lean-favorable';
  if (p >= 0.45) return 'neutral';
  return 'unfavorable';
}

// Decide whether to display a numeric probability for one horizon.
//
//   cal : the calibration artifact for this horizon, or null when none exists. Shape (when
//         present): { version, samples, brierSkill, driftError, horizon }.
//   opts: { currentVersion, maxDrift }
//
// Returns { maturity, display, band, reason }. `display:false` ⇒ the UI must show the band +
// "probability unavailable", never the raw number as a percent.
function assessCalibration(baselineProb, cal = null, opts = {}) {
  const band = qualitativeBand(baselineProb);
  if (!cal || typeof cal !== 'object') {
    return { maturity: MATURITY.UNCALIBRATED, display: false, band, reason: 'no calibration artifact — probabilities are a transparent baseline, not a calibrated model' };
  }
  const currentVersion = opts.currentVersion || cal.version;
  const maxDrift = Number.isFinite(opts.maxDrift) ? opts.maxDrift : 0.05;
  if (!(cal.samples >= MIN_SAMPLES)) {
    return { maturity: MATURITY.INSUFFICIENT, display: false, band, reason: `insufficient calibration sample (${cal.samples || 0} < ${MIN_SAMPLES})` };
  }
  if (!(cal.brierSkill > 0)) {
    return { maturity: MATURITY.INSUFFICIENT, display: false, band, reason: 'calibration does not beat the base-rate predictor (Brier skill ≤ 0)' };
  }
  if (cal.version !== currentVersion) {
    return { maturity: MATURITY.INSUFFICIENT, display: false, band, reason: `stale calibration version (${cal.version} ≠ ${currentVersion})` };
  }
  if (Number.isFinite(cal.driftError) && cal.driftError > maxDrift) {
    return { maturity: MATURITY.DRIFTED, display: false, band, reason: `calibration drift ${cal.driftError} exceeds tolerance ${maxDrift}` };
  }
  return { maturity: MATURITY.CALIBRATED, display: true, band, reason: 'out-of-fold calibrated, sufficient sample, beats base rate, current, within drift' };
}

module.exports = {
  CALIBRATION_MATURITY_VERSION, MIN_SAMPLES, MATURITY,
  qualitativeBand, assessCalibration,
};
