'use strict';
// CFL — FORECASTABILITY & ABSTENTION. Pure; evidence-based; fail-closed.
//
// Answers: "is this stock, at this timestamp and horizon, sufficiently supported
// for a directional probability to be trusted?" — from countable evidence only
// (sample support, calibration support, missingness, freshness, distribution
// shift, liquidity, provider health). It never manufactures a probability: when
// calibration support is thin the disposition is the abstention, and the
// conformal block honestly reports `available:false` instead of a fake interval.
//
// Reuses: lib/stats.wilson (uncertainty), lib/atlasx-utility.conformalInterval
// (the repo's one conformal implementation) when OOF residuals are supplied.

const { wilson } = require('../stats');
const { conformalInterval } = require('../atlasx-utility');
const CFG = require('./config');

const DISPOSITIONS = Object.freeze([
  'ACTIONABLE', 'WATCH', 'INSUFFICIENT_EVIDENCE', 'OUT_OF_DISTRIBUTION', 'DATA_STALE', 'ABSTAIN',
]);

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Max |z| of the candidate's decision-time features against cohort mean/sd pairs.
// cohortStats: { featureName: {mean, sd} }; features: { featureName: value }.
function distributionShift(features = {}, cohortStats = {}) {
  let maxZ = 0, checked = 0;
  for (const [k, s] of Object.entries(cohortStats)) {
    const v = features[k];
    if (!Number.isFinite(v) || !s || !Number.isFinite(s.mean) || !(s.sd > 0)) continue;
    maxZ = Math.max(maxZ, Math.abs((v - s.mean) / s.sd));
    checked++;
  }
  return { maxZ: checked ? +maxZ.toFixed(2) : null, featuresChecked: checked };
}

// Assess one candidate. Input (all decision-time facts, injected — no store):
//   analogueCount     resolved comparable historical observations (same setup family)
//   calibrationBinN   resolved samples in the candidate's calibration bin (null = no calibrator)
//   binWins           winners among those (for the Wilson evidence interval)
//   features / cohortStats   for the distribution-shift check
//   missing[]         names of absent decision-time inputs
//   freshnessClass    'current' | 'prior-session' | 'stale' | 'ahead-of-benchmark' | 'future-dated' | 'missing'
//   liquidityOk       dollar volume clears the scope floor
//   providerHealthy   data providers responding (false ⇒ evidence, not a guess)
//   regimeSampleN     resolved analogues within the current regime
//   residualsOOF[]    out-of-fold residuals for the conformal interval (optional)
//   pointEstimate     expected excess return (bps) if a model supplied one (optional)
function assessForecastability(input = {}) {
  const F = CFG.FORECASTABILITY;
  const {
    analogueCount = 0, calibrationBinN = null, binWins = null,
    features = {}, cohortStats = {}, missing = [],
    freshnessClass = 'current', liquidityOk = true, providerHealthy = true,
    regimeSampleN = null, residualsOOF = null, pointEstimate = null,
  } = input;

  const reasons = [];
  const shift = distributionShift(features, cohortStats);

  // Component scores in [0,1] — each one a countable fact, listed with its reason.
  const sampleScore = clamp01(analogueCount / F.strongAnalogues);
  if (analogueCount < F.minAnalogues) reasons.push('THIN_ANALOGUES');
  const calScore = calibrationBinN == null ? 0.5 : clamp01(calibrationBinN / F.minCalibrationBinN);
  if (calibrationBinN != null && calibrationBinN < F.minCalibrationBinN) reasons.push('THIN_CALIBRATION_BIN');
  if (calibrationBinN == null) reasons.push('NO_CALIBRATOR');
  const missScore = clamp01(1 - (missing.length * 0.25));
  if (missing.length) reasons.push('MISSING_FEATURES');
  const freshOk = !F.staleClasses.includes(freshnessClass);
  if (!freshOk) reasons.push('DATA_STALE');
  const oodHit = shift.maxZ != null && shift.maxZ >= F.oodZ;
  if (oodHit) reasons.push('OUT_OF_DISTRIBUTION');
  if (!liquidityOk) reasons.push('LIQUIDITY_BELOW_FLOOR');
  if (!providerHealthy) reasons.push('PROVIDER_UNHEALTHY');
  if (Number.isFinite(regimeSampleN) && regimeSampleN < Math.ceil(F.minAnalogues / 3)) reasons.push('THIN_REGIME_SUPPORT');

  const score = Math.round(100 * clamp01(
    0.35 * sampleScore + 0.25 * calScore + 0.15 * missScore
    + 0.10 * (freshOk ? 1 : 0) + 0.10 * (oodHit ? 0 : 1) + 0.05 * (liquidityOk ? 1 : 0),
  ));

  // Wilson evidence interval on the analogue win rate — an honest uncertainty
  // band on the EVIDENCE, distinct from any model probability.
  const uncertainty = (Number.isFinite(binWins) && calibrationBinN > 0)
    ? wilson(binWins, calibrationBinN, F.wilsonZ)
    : (analogueCount > 0 && Number.isFinite(input.analogueWins))
      ? wilson(input.analogueWins, analogueCount, F.wilsonZ)
      : null;

  // Conformal: only when the caller supplies real OOF residuals and a point estimate.
  const conformal = (Array.isArray(residualsOOF) && Number.isFinite(pointEstimate))
    ? conformalInterval(pointEstimate, residualsOOF)
    : { available: false, reason: 'insufficient-oof-residuals' };

  // Disposition ladder — first failing hard condition wins (fail-closed order).
  let disposition;
  if (!freshOk) disposition = 'DATA_STALE';
  else if (oodHit) disposition = 'OUT_OF_DISTRIBUTION';
  else if (!providerHealthy || !liquidityOk) disposition = 'ABSTAIN';
  else if (analogueCount < F.minAnalogues) disposition = 'INSUFFICIENT_EVIDENCE';
  else if (score >= F.actionableScore) disposition = 'ACTIONABLE';
  else if (score >= F.watchScore) disposition = 'WATCH';
  else disposition = 'ABSTAIN';

  return Object.freeze({
    version: CFG.FORECASTABILITY_VERSION,
    forecastabilityScore: score,
    evidenceStrength: sampleScore >= 0.66 ? 'strong' : sampleScore >= 0.2 ? 'moderate' : 'thin',
    uncertaintyInterval: uncertainty ? { lo: +uncertainty.lo.toFixed(3), hi: +uncertainty.hi.toFixed(3), basis: 'wilson-analogues' } : null,
    analogueCount,
    distributionShiftScore: shift.maxZ,
    featuresChecked: shift.featuresChecked,
    conformal,
    reasonCodes: Object.freeze([...new Set(reasons)]),
    disposition,
    displayProbability: disposition === 'ACTIONABLE' && calibrationBinN != null && calibrationBinN >= F.minCalibrationBinN,
  });
}

module.exports = { DISPOSITIONS, distributionShift, assessForecastability };
