// ═══════════════════════════════════════════════════════════════════════════
// RLT Stage A — the transition model (rlt-stage-a-v1).
//
// Question: will the stock produce an upside trigger before downside
// invalidation or timeout? Competing-risk discrete outcome at 5/10/21
// sessions. Labels REUSE the lead-time v2 engine via premove-stage-a's
// stageALabel — one label definition, not two ({up, down, timeout, censored};
// censored rows are excluded from training, never negatives).
//
// Model policy:
//   • Baselines (mandatory, deterministic): current sector-relative rank;
//     rank acceleration; simple residual momentum — plus Coil/Ghost/ATLAS-X
//     compared at the research layer.
//   • Fitted baseline: regularized (ridge) logistic — deterministic full-batch
//     gradient descent, no RNG. Missing features contribute 0 through an
//     explicit mask, never an imputed bullish value.
//   • GBM/GAM/Bayesian-hazard challengers: NOT available in this
//     dependency-free runtime — an EXTERNAL BLOCKER, recorded, not faked.
//
// Output honesty: until a valid, current, version-matched calibration
// artifact exists (rlt-config.rltGate), only `transitionRank` (cross-sectional
// percentile), a qualitative evidence band and
// calibrationStatus: unavailable|collecting|calibrating are displayable.
// NEVER a numeric probability.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS, STAGE_A_HORIZONS } = require('./rlt-config');
const { stageALabel } = require('./premove-stage-a');
const { bandForScore } = require('./atlasx-contracts');

// Ordered feature vector (rlt-features-v1). APPEND-ONLY: reordering
// invalidates any fitted artifact by design.
const RLT_FEATURE_KEYS = Object.freeze([
  // leadership
  'pctile', 'rankVel3', 'rankVel5', 'rankVel10', 'rankAccel',
  'aboveMedianStreak', 'crossHorizonAgreement',
  'resid5', 'resid10', 'resid21', 'mktResid10',
  'rawVsResidualGap', 'marketVsSectorGap',
  // path quality
  'fracPositiveResidualSessions', 'residualTrendFit', 'smoothness', 'spikeShare',
  'gapDependence', 'closeLocationTrend', 'higherLowPersistence', 'pullbackDepth',
  // turnover-conditioned momentum
  'turnoverPctile', 'residTimesTurnover', 'persistentResidOnTurnover',
  'turnoverAccel', 'abnormalDollarVol', 'pullbackVolumeContraction', 'breakoutParticipation',
  // absorption proxies (experimental)
  'absorptionRatio', 'decliningDownImpact', 'closeLocImprovement', 'wickAsymmetry',
  // setup / extension
  'distanceToPivotAtr', 'compressionPctile', 'compressionDuration',
  'distAbove20MaAtr', 'consumedRangePosition', 'remainingRR', 'breakoutRejections',
  // sector state
  'sectorEtfVsSpy21', 'sectorBreadth20', 'sectorBreadthAccel',
]);

/** Flatten leadership + feature record + sector state into the ordered vector's source map. */
function flattenFeatures({ leadership = null, features = null, sectorState = null } = {}) {
  const bh = (h, k) => (leadership && leadership.byHorizon && leadership.byHorizon[h]
    ? leadership.byHorizon[h][k] : null);
  const g = (obj, k) => (obj && Number.isFinite(obj[k]) ? obj[k] : null);
  const sv = sectorState && sectorState.vector ? sectorState.vector : null;
  return {
    pctile: leadership ? leadership.pctile : null,
    rankVel3: leadership ? leadership.rankVel3 : null,
    rankVel5: leadership ? leadership.rankVel5 : null,
    rankVel10: leadership ? leadership.rankVel10 : null,
    rankAccel: leadership ? leadership.rankAccel : null,
    aboveMedianStreak: leadership ? leadership.aboveMedianStreak : null,
    crossHorizonAgreement: leadership ? leadership.crossHorizonAgreement : null,
    resid5: bh(5, 'sectorResidual'),
    resid10: bh(10, 'sectorResidual'),
    resid21: bh(21, 'sectorResidual'),
    mktResid10: bh(10, 'marketResidual'),
    rawVsResidualGap: leadership ? leadership.rawVsResidualGap : null,
    marketVsSectorGap: leadership ? leadership.marketVsSectorGap : null,
    fracPositiveResidualSessions: g(features && features.path, 'fracPositiveResidualSessions'),
    residualTrendFit: g(features && features.path, 'residualTrendFit'),
    smoothness: g(features && features.path, 'smoothness'),
    spikeShare: g(features && features.path, 'spikeShare'),
    gapDependence: g(features && features.path, 'gapDependence'),
    closeLocationTrend: g(features && features.path, 'closeLocationTrend'),
    higherLowPersistence: g(features && features.path, 'higherLowPersistence'),
    pullbackDepth: g(features && features.path, 'pullbackDepth'),
    turnoverPctile: g(features && features.turnover, 'turnoverPctile'),
    residTimesTurnover: g(features && features.turnover, 'residTimesTurnover'),
    persistentResidOnTurnover: g(features && features.turnover, 'persistentResidOnTurnover'),
    turnoverAccel: g(features && features.turnover, 'turnoverAccel'),
    abnormalDollarVol: g(features && features.turnover, 'abnormalDollarVol'),
    pullbackVolumeContraction: g(features && features.turnover, 'pullbackVolumeContraction'),
    breakoutParticipation: g(features && features.turnover, 'breakoutParticipation'),
    absorptionRatio: g(features && features.absorption, 'absorptionRatio'),
    decliningDownImpact: g(features && features.absorption, 'decliningDownImpact'),
    closeLocImprovement: g(features && features.absorption, 'closeLocImprovement'),
    wickAsymmetry: g(features && features.absorption, 'wickAsymmetry'),
    distanceToPivotAtr: g(features && features.setup, 'distanceToPivotAtr'),
    compressionPctile: g(features && features.setup, 'compressionPctile'),
    compressionDuration: g(features && features.setup, 'compressionDuration'),
    distAbove20MaAtr: g(features && features.setup, 'distAbove20MaAtr'),
    consumedRangePosition: g(features && features.setup, 'consumedRangePosition'),
    remainingRR: g(features && features.setup, 'remainingRR'),
    breakoutRejections: g(features && features.setup, 'breakoutRejections'),
    sectorEtfVsSpy21: sv ? sv.etfVsSpy21 : null,
    sectorBreadth20: sv ? sv.breadth20 : null,
    sectorBreadthAccel: sv ? sv.breadthAcceleration : null,
  };
}

// ── deterministic ridge logistic (mirrors premove-stage-a, own key set) ─────
function vectorize(features) {
  const x = new Array(RLT_FEATURE_KEYS.length);
  const mask = new Array(RLT_FEATURE_KEYS.length);
  for (let i = 0; i < RLT_FEATURE_KEYS.length; i++) {
    const v = features ? features[RLT_FEATURE_KEYS[i]] : null;
    const ok = Number.isFinite(v);
    x[i] = ok ? v : 0;
    mask[i] = ok ? 1 : 0;
  }
  return { x, mask };
}

function fitStageA(rows, { lambda = 1.0, iters = 300, lr = 0.1 } = {}) {
  const usable = (rows || []).filter(r => r && (r.y === 0 || r.y === 1) && r.features);
  if (usable.length < 20) {
    return {
      version: VERSIONS.stageA, featureVersion: VERSIONS.features,
      status: 'insufficient-data', n: usable.length, weights: null,
    };
  }
  const D = RLT_FEATURE_KEYS.length;
  const vecs = usable.map(r => vectorize(r.features));
  const mean = new Array(D).fill(0), sd = new Array(D).fill(1);
  for (let j = 0; j < D; j++) {
    const obs = vecs.map(v => (v.mask[j] ? v.x[j] : null)).filter(x => x != null);
    if (obs.length >= 5) {
      const m = obs.reduce((a, b) => a + b, 0) / obs.length;
      const s = Math.sqrt(obs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, obs.length - 1));
      mean[j] = m; sd[j] = s > 1e-9 ? s : 1;
    }
  }
  const std = vecs.map(v => v.mask.map((m, j) => (m ? (v.x[j] - mean[j]) / sd[j] : 0)));
  const y = usable.map(r => r.y);
  let w = new Array(D).fill(0), b = 0;
  const N = usable.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(D).fill(0);
    let gb = 0;
    for (let i = 0; i < N; i++) {
      let z = b;
      for (let j = 0; j < D; j++) z += w[j] * std[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const e = p - y[i];
      gb += e;
      for (let j = 0; j < D; j++) gw[j] += e * std[i][j];
    }
    b -= lr * (gb / N);
    for (let j = 0; j < D; j++) w[j] -= lr * (gw[j] / N + (lambda / N) * w[j]);
  }
  return {
    version: VERSIONS.stageA, featureVersion: VERSIONS.features, labelVersion: VERSIONS.labels,
    status: 'fitted', n: N, lambda, iters,
    weights: w.map(x => +x.toFixed(6)), bias: +b.toFixed(6),
    mean: mean.map(x => +x.toFixed(6)), sd: sd.map(x => +x.toFixed(6)),
    featureKeys: RLT_FEATURE_KEYS,
  };
}

/** Raw monotone score — NOT a probability until calibrated. */
function scoreStageA(model, features) {
  if (!model || model.status !== 'fitted' || !Array.isArray(model.weights)) return null;
  const { x, mask } = vectorize(features);
  let z = model.bias;
  for (let j = 0; j < RLT_FEATURE_KEYS.length; j++) {
    if (!mask[j]) continue;
    z += model.weights[j] * ((x[j] - model.mean[j]) / model.sd[j]);
  }
  return 1 / (1 + Math.exp(-z));
}

// ── mandatory simple baselines (deterministic; the fitted model must beat
//    these out of sample or it has no reason to exist) ───────────────────────
const BASELINES = Object.freeze({
  'rank-level': f => (Number.isFinite(f.pctile) ? f.pctile : null),
  'rank-acceleration': f => (Number.isFinite(f.rankVel5) ? f.rankVel5 : null),
  'residual-momentum': f => (Number.isFinite(f.resid10) ? f.resid10 : null),
  // Fixed-weight residual baseline: rank change + level, no fitting at all.
  'fixed-transition': f => {
    const vel = Number.isFinite(f.rankVel5) ? f.rankVel5 : null;
    const lvl = Number.isFinite(f.pctile) ? f.pctile : null;
    if (vel == null && lvl == null) return null;
    return (vel ?? 0) * 2 + (lvl ?? 0.5);
  },
});

/**
 * Cross-sectional output — the ONLY shape live surfaces may consume.
 * Without a valid calibration artifact: rank + band + calibrationStatus only.
 */
function stageACrossSection(candidates, model, gate = null, { resolvedCount = 0 } = {}) {
  const scoreOf = model && model.status === 'fitted'
    ? c => scoreStageA(model, c.features)
    : c => BASELINES['fixed-transition'](c.features || {});
  const basis = model && model.status === 'fitted' ? 'fitted-shadow' : 'fixed-baseline';
  const scored = (candidates || []).map(c => ({ ...c, rawScore: scoreOf(c) }));
  const withScore = scored.filter(c => c.rawScore != null).sort((a, b) => a.rawScore - b.rawScore);
  const rankOf = new Map(withScore.map((c, i) => [c.ticker, withScore.length > 1 ? i / (withScore.length - 1) : 0.5]));
  const showProb = !!(gate && gate.showProbabilities);
  const calibrationStatus = showProb ? 'calibrating'
    : resolvedCount > 0 ? 'collecting' : 'unavailable';
  return scored.map(c => {
    const pct = rankOf.get(c.ticker);
    return {
      ticker: c.ticker,
      transitionRank: pct != null ? +pct.toFixed(3) : null,
      transitionPercentile: pct != null ? +pct.toFixed(3) : null,
      evidenceBand: pct != null ? bandForScore(pct) : null,
      pTriggerBeforeInvalidation: showProb && c.rawScore != null ? +c.rawScore.toFixed(4) : null,
      calibrationStatus,
      modelStatus: basis,
      note: showProb ? null : 'shadow — rank and band only, no probability (fail closed)',
    };
  });
}

module.exports = {
  STAGE_A_VERSION: VERSIONS.stageA,
  STAGE_A_HORIZONS,
  RLT_FEATURE_KEYS, flattenFeatures, vectorize,
  fitStageA, scoreStageA, stageACrossSection,
  BASELINES,
  stageALabel,   // reused competing-risk labeler (lead-time v2)
};
