// ORBIT probability calibration (orbit-calib-v1).
//
// Raw model outputs are NOT probabilities until they are mapped to observed
// frequencies out-of-fold. This module fits several calibrators on a training
// split and selects the one with the best HELD-OUT Brier + log loss:
//   - none      : identity (baseline — sometimes the raw model is already OK)
//   - platt     : sigmoid(a + b·logit(p))           (parametric, low-data)
//   - beta      : sigmoid(a + b·ln p + c·ln(1−p))   (asymmetric parametric)
//   - isotonic  : monotone PAV map  (reuses lib/evolve fitCalibrator; needs data)
//
// Contract: when out-of-fold support is insufficient, calibrate() returns
//   { calibrated:false, probability:null, reason }
// and the caller must expose an uncalibrated RANK score instead of a "probability".
// Calibration is horizon-specific — fit one calibrator per 5/21/63 horizon.

const M = require('./orbit-math');
const { fitCalibrator, applyCalibrator } = require('./evolve');

const CALIBRATION_VERSION = 'orbit-calib-v1';
const MIN_CALIBRATION_N = 60;    // minimum OOF pairs before we trust any calibrator
const MIN_ISOTONIC_N = 120;      // isotonic needs more support than the parametric maps

// pairs: [{ p (raw model prob 0..1), won (0|1) }]
function fitPlatt(pairs) {
  const X = pairs.map(r => [1, M.logit(r.p)]);
  const y = pairs.map(r => r.won);
  const w = M.logisticFit(X, y, { lambda: 1e-4, iters: 500 });
  return w ? { method: 'platt', w } : null;
}
function fitBeta(pairs) {
  const X = pairs.map(r => [1, Math.log(M.clamp(r.p, 1e-4, 1 - 1e-4)), Math.log(1 - M.clamp(r.p, 1e-4, 1 - 1e-4))]);
  const y = pairs.map(r => r.won);
  const w = M.logisticFit(X, y, { lambda: 1e-4, iters: 500 });
  return w ? { method: 'beta', w } : null;
}
function applyOne(cal, p) {
  if (!cal || p == null) return p;
  const q = M.clamp(p, 1e-4, 1 - 1e-4);
  if (cal.method === 'none') return p;
  if (cal.method === 'platt') return M.logisticPredict(cal.w, [1, M.logit(q)]);
  if (cal.method === 'beta') return M.logisticPredict(cal.w, [1, Math.log(q), Math.log(1 - q)]);
  if (cal.method === 'isotonic') return applyCalibrator(cal.model, p);
  return p;
}

// Calibration slope/intercept: logistic-regress outcome on the calibrated logit.
// Ideal is slope≈1, intercept≈0. Returns {slope,intercept}.
function calibrationSlope(probs, labels) {
  const rows = [], y = [];
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] == null || labels[i] == null) continue;
    rows.push([1, M.logit(M.clamp(probs[i], 1e-4, 1 - 1e-4))]); y.push(labels[i]);
  }
  if (rows.length < 10) return { slope: null, intercept: null };
  const w = M.logisticFit(rows, y, { lambda: 1e-6, iters: 500 });
  return { slope: +w[1].toFixed(3), intercept: +w[0].toFixed(3) };
}

// Fit + select a calibrator. `train` and `valid` are disjoint [{p,won}] splits
// (the caller provides an OUT-OF-FOLD split). Returns the winning calibrator with
// its held-out metrics, or the insufficient-support sentinel.
function selectCalibrator(train, valid, opts = {}) {
  const minN = opts.minN || MIN_CALIBRATION_N;
  const tr = (train || []).filter(r => r && Number.isFinite(r.p) && (r.won === 0 || r.won === 1));
  const va = (valid || []).filter(r => r && Number.isFinite(r.p) && (r.won === 0 || r.won === 1));
  if (tr.length < minN || va.length < Math.max(20, minN / 2)) {
    return { calibrated: false, probability: null, reason: `insufficient out-of-fold calibration support (train ${tr.length}, valid ${va.length})`, version: CALIBRATION_VERSION };
  }

  const candidates = [{ method: 'none' }];
  const platt = fitPlatt(tr); if (platt) candidates.push(platt);
  const beta = fitBeta(tr); if (beta) candidates.push(beta);
  if (tr.length >= MIN_ISOTONIC_N) {
    const iso = fitCalibrator(tr, { bins: 10, minN: MIN_ISOTONIC_N });
    if (iso) candidates.push({ method: 'isotonic', model: iso });
  }

  let best = null;
  for (const cal of candidates) {
    const probs = va.map(r => applyOne(cal, r.p));
    const labels = va.map(r => r.won);
    const brier = M.brier(probs, labels);
    const ll = M.logLoss(probs, labels);
    if (brier == null) continue;
    const score = brier + 0.25 * (ll == null ? 0 : ll);   // Brier-led, log-loss tiebreak
    if (!best || score < best.score) best = { cal, brier: +brier.toFixed(4), logLoss: ll == null ? null : +ll.toFixed(4), score };
  }
  if (!best) return { calibrated: false, probability: null, reason: 'no calibrator scored', version: CALIBRATION_VERSION };

  const valProbs = va.map(r => applyOne(best.cal, r.p));
  const cs = calibrationSlope(valProbs, va.map(r => r.won));
  return {
    calibrated: true, version: CALIBRATION_VERSION,
    method: best.cal.method, model: best.cal,
    metrics: { brier: best.brier, logLoss: best.logLoss, slope: cs.slope, intercept: cs.intercept, n: va.length },
  };
}

// Apply a selected calibrator (the object returned by selectCalibrator) to a raw p.
function calibrate(selected, p) {
  if (!selected || !selected.calibrated) return null;
  return +M.clamp(applyOne(selected.model, p), 0, 1).toFixed(4);
}

module.exports = {
  CALIBRATION_VERSION, MIN_CALIBRATION_N, MIN_ISOTONIC_N,
  fitPlatt, fitBeta, applyOne, calibrationSlope, selectCalibrator, calibrate,
};
