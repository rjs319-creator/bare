'use strict';
// STAGE A — PRE-MOVE TRANSITION MODEL (premove-stage-a-v1) — Phase 6.
//
// Estimates, per horizon: P(upside trigger occurs before downside invalidation
// or timeout) as a COMPETING-RISK discrete outcome. Labels come from lead-time
// v2 (lib/leadtime2) so the label and the live measurement can never disagree:
//   up      — upside trigger first (incl. trigger-no-fill: the TRANSITION happened)
//   down    — downside invalidation first
//   timeout — full window, neither
//   censored — window not elapsed (EXCLUDED from training, never a negative)
//
// Model policy (docs/premove-transition-v2.md):
//   - Baseline: REGULARIZED (ridge) logistic on the shared premove feature
//     vector, deterministic full-batch gradient descent (no RNG, byte-identical
//     refits). Missing features contribute 0 through an explicit mask — never
//     an imputed bullish value.
//   - Gradient-boosted challenger (CatBoost/LightGBM): NOT available in this
//     dependency-free runtime — an EXTERNAL BLOCKER, recorded, not faked. The
//     harness accepts any challenger exposing {fit, score}.
//   - No deep nets for sophistication's sake.
//
// OUTPUT HONESTY: score() returns a RAW score. Without a valid, current,
// version-matched calibration artifact (lib/premove-flags.premoveGate) the only
// displayable outputs are `preMoveRank` (cross-sectional percentile) and a
// qualitative evidence band — NEVER a percentage.

const { FEATURE_KEYS, PREMOVE_FEATURE_VERSION } = require('./premove-features');
const LT2 = require('./leadtime2');
const { bandForScore } = require('./atlasx-contracts');

const STAGE_A_VERSION = 'premove-stage-a-v1';
const STAGE_A_LABEL_VERSION = 'premove-labels-v1';

// ── labels ───────────────────────────────────────────────────────────────────
// One episode + candles → the competing-risk label at each horizon. Reuses the
// lead-time v2 engine (vol-normalized barriers, conservative same-bar, censoring).
function stageALabel(pick, candles, ctx = {}) {
  const r = LT2.episodeLeadTime(pick, candles, ctx);
  if (r.skipped) return { skipped: r.skipped };
  const out = { decisionDate: r.decisionDate, horizons: {} };
  for (const [H, h] of Object.entries(r.horizons)) {
    out.horizons[H] = {
      event: h.outcome === 'censored' ? 'censored'
        : h.outcome === 'downside-first' ? 'down'
          : h.outcome === 'no-trigger' ? 'timeout'
            : 'up',                                   // trigger occurred (fill or not — the transition happened)
      sessionsToEvent: h.sessionsToTrigger ?? h.sessionsToOutcome ?? null,
      version: STAGE_A_LABEL_VERSION,
    };
  }
  return out;
}

// ── deterministic ridge logistic ─────────────────────────────────────────────
// rows: [{ features: {key: value|null}, y: 0|1 }] (censored rows must be
// filtered OUT by the caller — they are not negatives).
function vectorize(features) {
  const x = new Array(FEATURE_KEYS.length);
  const mask = new Array(FEATURE_KEYS.length);
  for (let i = 0; i < FEATURE_KEYS.length; i++) {
    const v = features ? features[FEATURE_KEYS[i]] : null;
    const ok = Number.isFinite(v);
    x[i] = ok ? v : 0;               // masked-to-zero AFTER standardization offset (see fit)
    mask[i] = ok ? 1 : 0;
  }
  return { x, mask };
}

function fitStageA(rows, { lambda = 1.0, iters = 300, lr = 0.1 } = {}) {
  const usable = (rows || []).filter(r => r && (r.y === 0 || r.y === 1) && r.features);
  if (usable.length < 20) {
    return { version: STAGE_A_VERSION, featureVersion: PREMOVE_FEATURE_VERSION, status: 'insufficient-data', n: usable.length, weights: null };
  }
  const vecs = usable.map(r => vectorize(r.features));
  const D = FEATURE_KEYS.length;
  // per-feature standardization over OBSERVED values only
  const mean = new Array(D).fill(0), sd = new Array(D).fill(1);
  for (let j = 0; j < D; j++) {
    const obs = vecs.map((v, i) => (v.mask[j] ? v.x[j] : null)).filter(x => x != null);
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
    version: STAGE_A_VERSION, featureVersion: PREMOVE_FEATURE_VERSION, labelVersion: STAGE_A_LABEL_VERSION,
    status: 'fitted', n: N, lambda, iters,
    weights: w.map(x => +x.toFixed(6)), bias: +b.toFixed(6),
    mean: mean.map(x => +x.toFixed(6)), sd: sd.map(x => +x.toFixed(6)),
    featureKeys: FEATURE_KEYS,
  };
}

// Raw model score (a monotone score, NOT a probability until calibrated).
function scoreStageA(model, features) {
  if (!model || model.status !== 'fitted' || !Array.isArray(model.weights)) return null;
  const { x, mask } = vectorize(features);
  let z = model.bias;
  for (let j = 0; j < FEATURE_KEYS.length; j++) {
    if (!mask[j]) continue;
    z += model.weights[j] * ((x[j] - model.mean[j]) / model.sd[j]);
  }
  return 1 / (1 + Math.exp(-z));     // squashed for stable ranking; still UNCALIBRATED
}

// ── cross-sectional output (the only shape live surfaces may consume) ────────
// candidates: [{ ticker, features }]. gate: premove-flags.premoveGate() result.
// With no valid calibration artifact only rank + band are emitted.
function stageACrossSection(candidates, model, gate = null) {
  const scored = (candidates || []).map(c => ({ ...c, rawScore: model ? scoreStageA(model, c.features) : null }));
  const withScore = scored.filter(c => c.rawScore != null).sort((a, b) => a.rawScore - b.rawScore);
  const rankOf = new Map(withScore.map((c, i) => [c.ticker, withScore.length > 1 ? i / (withScore.length - 1) : 0.5]));
  const showProb = !!(gate && gate.showProbabilities);
  return scored.map(c => {
    const pct = rankOf.get(c.ticker);
    return {
      ticker: c.ticker,
      preMoveRank: pct != null ? +pct.toFixed(3) : null,                 // cross-sectional percentile 0..1
      evidenceBand: pct != null ? bandForScore(pct) : null,              // qualitative band
      // A percentage exists ONLY behind a valid calibration artifact.
      pTriggerBeforeInvalidation: showProb && c.rawScore != null ? +c.rawScore.toFixed(4) : null,
      calibrationStatus: showProb ? 'calibrated' : 'uncalibrated',
      modelStatus: model && model.status === 'fitted' ? 'fitted-shadow' : 'no-model',
      note: showProb ? null : 'uncalibrated/shadow — rank and band only, no probability',
    };
  });
}

module.exports = {
  STAGE_A_VERSION, STAGE_A_LABEL_VERSION,
  stageALabel, fitStageA, scoreStageA, stageACrossSection, vectorize,
};
