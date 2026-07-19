// ORBIT prediction models (orbit-model-v1).
//
// Increasing-complexity models over a deliberately RESIDUAL/DEMAND/DRIFT-focused
// feature set — raw price-momentum features are excluded on purpose so ORBIT
// stays orthogonal to the momentum engines (Stable Core, OMEGA, Ignition).
//
//   1. base-rate baseline        — constant P = train base rate
//   2. residual-momentum baseline — single-feature logistic on residMom63
//   3. regularised logistic       — the ORBIT model (this artifact)
//
// Every preprocessing statistic (winsor limits, mean/std) is fitted ONLY on the
// training rows passed in and frozen into the artifact, so nothing from a test
// fold can leak into a transform (train/serve parity is unit-tested). Outputs are
// RAW model probabilities; they become calibrated probabilities only via
// lib/orbit-calibration on out-of-fold predictions (contract enforced downstream).

const M = require('./orbit-math');

const MODEL_VERSION = 'orbit-model-v1';

// The ORBIT feature set — residual drift, demand pressure, persistence, relative
// strength. No raw ret21/ret63 (momentum) → orthogonality by construction.
const FEATURE_SET = Object.freeze([
  'residMom21', 'residMom63', 'residConsistency', 'residAccel', 'residAutocorr',
  'residDownDev', 'residDrawdown', 'demandAsymmetry', 'udDollarImbalance',
  'obvSlope', 'closeLocation', 'accumOnMktDown', 'drift', 'driftZ', 'driftSlope',
  'driftProbPositive', 'stateChangeProb', 'recoveryAfterMktDown', 'returnPathStability',
  'mktRelRet63', 'secRelRet63', 'volState',
]);

// Fit winsor limits + standardisation per feature on TRAIN rows only.
function fitScaler(rows, features) {
  const winsor = {}, mean = {}, std = {};
  for (const f of features) {
    const vals = rows.map(r => r.features ? r.features[f] : null).filter(v => v != null && Number.isFinite(v));
    if (vals.length < 5) { winsor[f] = null; mean[f] = 0; std[f] = 1; continue; }
    const lim = M.fitWinsor(vals, 0.02, 0.98);
    const wv = vals.map(v => M.applyWinsor(v, lim));
    winsor[f] = lim; mean[f] = M.mean(wv); std[f] = M.std(wv) || 1;
  }
  return { features, winsor, mean, std };
}

// Transform a feature row → standardised design vector [1, z1, z2, ...]. A missing
// feature imputes to the training mean (z = 0). Pure w.r.t. the frozen scaler.
function transform(scaler, features) {
  const x = [1];
  for (const f of scaler.features) {
    const raw = features ? features[f] : null;
    if (raw == null || !Number.isFinite(raw)) { x.push(0); continue; }
    const w = M.applyWinsor(raw, scaler.winsor[f]);
    const s = scaler.std[f] || 1;
    x.push((w - scaler.mean[f]) / (s < M.EPS ? 1 : s));
  }
  return x;
}

// Fit one logistic sub-model for a binary target selected by `pick(row)`.
function fitTarget(rows, scaler, pick, lambda) {
  const X = [], y = [];
  for (const r of rows) { const t = pick(r); if (t === 0 || t === 1) { X.push(transform(scaler, r.features)); y.push(t); } }
  if (X.length < 20) return null;
  return M.logisticFit(X, y, { lambda, iters: 400 });
}

// Fit the full ORBIT model for one horizon.
//   rows: [{ features, resid:0|1, raw:0|1, severe:0|1, outcome:'upper'|'lower'|'timeout', netReturn }]
function fitOrbitModel(rows, opts = {}) {
  const features = opts.features || FEATURE_SET;
  const lambda = opts.lambda != null ? opts.lambda : 0.5;
  const horizon = opts.horizon || null;
  const usable = (rows || []).filter(r => r && r.features);
  const scaler = fitScaler(usable, features);

  const wResid = fitTarget(usable, scaler, r => r.resid, lambda);
  const wRaw = fitTarget(usable, scaler, r => r.raw, lambda);
  const wSevere = fitTarget(usable, scaler, r => r.severe, lambda);
  const wUpper = fitTarget(usable, scaler, r => r.outcome === 'upper' ? 1 : 0, lambda);
  const wLower = fitTarget(usable, scaler, r => r.outcome === 'lower' ? 1 : 0, lambda);
  const wTimeout = fitTarget(usable, scaler, r => r.outcome === 'timeout' ? 1 : 0, lambda);

  const rawLabels = usable.map(r => r.raw).filter(v => v === 0 || v === 1);
  const baseRate = rawLabels.length ? M.mean(rawLabels) : 0.5;
  const nets = usable.map(r => r.netReturn).filter(v => v != null && Number.isFinite(v));
  const wins = nets.filter(v => v > 0), losses = nets.filter(v => v <= 0);
  const avgWin = wins.length ? M.mean(wins) : 0.05;
  const avgLoss = losses.length ? M.mean(losses) : -0.05;

  return {
    version: MODEL_VERSION, horizon, features, lambda, n: usable.length,
    scaler, weights: { resid: wResid, raw: wRaw, severe: wSevere, upper: wUpper, lower: wLower, timeout: wTimeout },
    stats: { baseRate: +baseRate.toFixed(4), avgWin: +avgWin.toFixed(4), avgLoss: +avgLoss.toFixed(4), nNet: nets.length },
    trained: !!(wResid && wRaw),
  };
}

// Score one feature row against a frozen ORBIT model → RAW (uncalibrated) outputs.
function scoreOrbit(model, features) {
  if (!model || !model.trained) return null;
  const x = transform(model.scaler, features);
  const pr = (w, fb) => w ? M.logisticPredict(w, x) : fb;
  const rawUp = +pr(model.weights.raw, model.stats.baseRate).toFixed(4);
  const residualUp = +pr(model.weights.resid, model.stats.baseRate).toFixed(4);
  const severe = +pr(model.weights.severe, 0.1).toFixed(4);
  // Barrier probabilities: three one-vs-rest logistics, normalised to sum 1.
  let pU = pr(model.weights.upper, 0.33), pL = pr(model.weights.lower, 0.33), pT = pr(model.weights.timeout, 0.34);
  const s = pU + pL + pT || 1; pU /= s; pL /= s; pT /= s;
  const expectedNetReturn = +(rawUp * model.stats.avgWin + (1 - rawUp) * model.stats.avgLoss).toFixed(4);
  return {
    rawUp, residualUp,
    pUpper: +pU.toFixed(4), pLower: +pL.toFixed(4), pTimeout: +pT.toFixed(4),
    severeLossProbability: severe,
    expectedNetReturn,
    rankScore: residualUp,     // uncalibrated ordering key (always present)
  };
}

// ── Reference baselines (for the walk-forward comparison in Phase 12) ────────
function fitBaseRate(rows) {
  const y = rows.map(r => r.raw).filter(v => v === 0 || v === 1);
  return { version: 'orbit-baserate-v1', p: y.length ? +M.mean(y).toFixed(4) : 0.5 };
}
function scoreBaseRate(model) { return { rankScore: model.p, rawUp: model.p }; }

function fitResidualMomentum(rows) {
  const scaler = fitScaler(rows.filter(r => r.features), ['residMom63']);
  const w = fitTarget(rows.filter(r => r.features), scaler, r => r.raw, 1e-3);
  return { version: 'orbit-residmom-v1', scaler, w, trained: !!w };
}
function scoreResidualMomentum(model, features) {
  if (!model.trained) return { rankScore: 0.5, rawUp: 0.5 };
  const p = M.logisticPredict(model.w, transform(model.scaler, features));
  return { rankScore: +p.toFixed(4), rawUp: +p.toFixed(4) };
}

module.exports = {
  MODEL_VERSION, FEATURE_SET,
  fitScaler, transform, fitOrbitModel, scoreOrbit,
  fitBaseRate, scoreBaseRate, fitResidualMomentum, scoreResidualMomentum,
};
