// ORBIT-ML date-grouped cross-sectional ranking model (orbit-ml-model-v1).
//
// This is the genuine modelling delta over the (merged) ORBIT system: ORBIT's
// model is POINTWISE (P(up) per name); ORBIT-ML optimises a CROSS-SECTIONAL RANK
// objective — within each decision date, order names by future net RESIDUAL
// return. That is what a stock ranker should optimise, and it is what makes the
// daily rank-IC the honest target rather than absolute price.
//
// Baseline (dependency-free, deterministic): a pairwise RankNet — for every pair
// (i,j) inside the same date group with target_i > target_j, minimise
// −log σ(s_i − s_j) where s = wᵀz over the (reused) standardised features. This is
// a LambdaRank-lite; no gradient boosting, no Python, runs in Node.
//
// A boosted challenger (LightGBM LambdaRank / CatBoost) plugs in via loadTreeArtifact
// + evalTrees — a JSON-tree evaluator. When no artifact is present (the common case
// here: no Python/LightGBM in the environment) gbmStatus() reports it honestly and
// the pipeline uses the linear ranker. No fabricated boosted results.
//
// Preprocessing (winsor + standardise) is REUSED from lib/orbit-model (fit in-fold
// only). Features are the reused ORBIT feature set + ORBIT-ML specialist-evidence.

const M = require('./orbit-math');
const OM = require('./orbit-model');

const ML_MODEL_VERSION = 'orbit-ml-model-v1';

// ── Pairwise RankNet over date groups ───────────────────────────────────────
// rows: [{ decisionDate, features, target }]  (target = future net residual return)
// Returns a frozen linear model: { scaler, weights, features, groups }.
function fitRankModel(rows, opts = {}) {
  const features = opts.features || OM.FEATURE_SET;
  const lambda = opts.lambda != null ? opts.lambda : 1e-3;
  const iters = opts.iters || 300;
  const lr = opts.lr || 0.3;
  const maxPairsPerGroup = opts.maxPairsPerGroup || 200;

  const usable = (rows || []).filter(r => r && r.features && r.target != null && Number.isFinite(r.target));
  const scaler = OM.fitScaler(usable, features);
  // Precompute standardised design vectors (drop the intercept — rank is shift-invariant).
  const X = usable.map(r => OM.transform(scaler, r.features).slice(1));
  const p = features.length;
  const w = new Array(p).fill(0);

  // Build within-date pairs (bounded per group for determinism + cost).
  const byDate = new Map();
  usable.forEach((r, i) => { if (!byDate.has(r.decisionDate)) byDate.set(r.decisionDate, []); byDate.get(r.decisionDate).push(i); });
  const pairs = [];
  for (const [, idxs] of byDate) {
    let made = 0;
    for (let a = 0; a < idxs.length && made < maxPairsPerGroup; a++) {
      for (let b = a + 1; b < idxs.length && made < maxPairsPerGroup; b++) {
        const i = idxs[a], j = idxs[b];
        const ti = usable[i].target, tj = usable[j].target;
        if (ti === tj) continue;
        // Order the pair so the FIRST element is the winner.
        pairs.push(ti > tj ? [i, j] : [j, i]); made++;
      }
    }
  }
  if (!pairs.length) return { version: ML_MODEL_VERSION, trained: false, reason: 'no within-date pairs', scaler, weights: null, features, nPairs: 0 };

  // Gradient descent on the pairwise logistic loss (deterministic, w starts at 0).
  for (let it = 0; it < iters; it++) {
    const grad = new Array(p).fill(0);
    for (const [win, lose] of pairs) {
      let s = 0; for (let k = 0; k < p; k++) s += w[k] * (X[win][k] - X[lose][k]);
      const g = M.sigmoid(-s);   // dL/ds = −σ(−(s_win−s_lose))
      for (let k = 0; k < p; k++) grad[k] += -g * (X[win][k] - X[lose][k]);
    }
    for (let k = 0; k < p; k++) { grad[k] = grad[k] / pairs.length + lambda * w[k]; w[k] -= lr * grad[k]; }
  }
  return { version: ML_MODEL_VERSION, trained: true, scaler, weights: w, features, nPairs: pairs.length, nGroups: byDate.size };
}

// Raw (uncalibrated) rank score for a feature row.
function scoreRankModel(model, features) {
  if (!model || !model.trained) return null;
  const z = OM.transform(model.scaler, features).slice(1);
  let s = 0; for (let k = 0; k < model.weights.length; k++) s += model.weights[k] * z[k];
  return +s.toFixed(6);
}

// Rank a same-date group of candidates → sorted desc with cross-sectional percentile.
function rankGroup(model, candidates) {
  const scored = candidates.map(c => ({ ...c, rankScore: scoreRankModel(model, c.features) })).filter(c => c.rankScore != null);
  scored.sort((a, b) => b.rankScore - a.rankScore);
  const n = scored.length;
  scored.forEach((c, i) => { c.rankPct = n > 1 ? +(1 - i / (n - 1)).toFixed(4) : 1; });
  return scored;
}

// ── Boosted-tree challenger adapter (JSON-tree evaluator) ────────────────────
// Artifact schema (produced by research/orbit_ml training, exported frozen):
//   { version, horizon, trees:[{ nodes:[{feature,threshold,left,right,leaf}] }], features, bias }
// evalTrees sums leaf values across trees. Deterministic, dependency-free inference.
function gbmStatus(artifact) {
  if (!artifact || !Array.isArray(artifact.trees) || !artifact.trees.length) {
    return { available: false, reason: 'no frozen boosted artifact (train via research/orbit_ml; requires LightGBM/CatBoost + Python)' };
  }
  return { available: true, version: artifact.version || 'unknown', nTrees: artifact.trees.length };
}
function evalTree(tree, featObj, featOrder) {
  let n = tree.nodes[0], guard = 0;
  while (n && n.leaf == null && guard++ < 1000) {
    const v = featObj[featOrder[n.feature]];
    n = tree.nodes[(v == null || !Number.isFinite(v) || v <= n.threshold) ? n.left : n.right];
  }
  return n ? (n.leaf || 0) : 0;
}
function evalTrees(artifact, featObj) {
  const st = gbmStatus(artifact);
  if (!st.available) return null;
  let s = artifact.bias || 0;
  for (const t of artifact.trees) s += evalTree(t, featObj, artifact.features);
  return +s.toFixed(6);
}

// ── Nested purged walk-forward for the RANK model ───────────────────────────
// Reuses the proven purge/embargo/date-block/grouped-IC machinery from
// lib/orbit-walkforward. Target is the continuous future net residual return;
// the metric is the date-grouped Spearman rank-IC (with purged vs leaky reported).
function rankWalkForward(samples, opts = {}) {
  const WF = require('./orbit-walkforward');
  const horizon = opts.horizon || 'days21';
  const targetField = opts.targetField || 'residualReturn';
  const outerBlocks = opts.outerBlocks || 8;
  const horizonDays = { days5: 5, days21: 21, days63: 63 }[horizon] || 21;
  const embargoDays = opts.embargoDays != null ? opts.embargoDays : Math.ceil(horizonDays * 1.5 * 7 / 5);
  const minTrain = opts.minTrain || 150;

  // Build continuous-target rows from resolved horizons.
  const rows = [];
  for (const s of samples) {
    const h = s.horizons && s.horizons[horizon];
    if (!h || !h.resolved) continue;
    const t = h[targetField] != null ? h[targetField] : h.netReturn;
    if (t == null || !Number.isFinite(t)) continue;
    rows.push({ decisionDate: s.decisionDate, labelEndDate: h.exitDate || WF.addDays(s.decisionDate, 90), ticker: s.ticker, features: s.features, target: t, net: h.netReturn });
  }
  rows.sort((a, b) => a.decisionDate < b.decisionDate ? -1 : a.decisionDate > b.decisionDate ? 1 : 0);
  if (rows.length < minTrain + 50) return { horizon, ok: false, reason: `too few resolved rows (${rows.length})`, nRows: rows.length };

  const blocks = WF.dateBlocks(rows, outerBlocks);
  const run = (purge) => {
    const preds = []; let nOuter = 0;
    for (let b = 1; b < blocks.length; b++) {
      const start = blocks[b][0];
      const train = rows.filter(r => purge ? r.labelEndDate < WF.addDays(start, -embargoDays) : r.decisionDate < start);
      if (train.length < minTrain) continue;
      const model = fitRankModel(train, { features: opts.features });
      if (!model.trained) continue;
      for (const r of rows.filter(x => blocks[b].includes(x.decisionDate))) {
        const sc = scoreRankModel(model, r.features);
        if (sc != null) preds.push({ date: r.decisionDate, score: sc, net: r.net });
      }
      nOuter++;
    }
    return { overall: preds.length ? WF.groupedIC(preds) : null, nOuter, nPreds: preds.length };
  };
  const purged = run(true), leaky = run(false);
  return {
    version: ML_MODEL_VERSION, horizon, targetField, ok: true, nRows: rows.length, embargoDays,
    purged, leaky,
    leakageInflation: (purged.overall && leaky.overall && purged.overall.ic != null && leaky.overall.ic != null) ? +(leaky.overall.ic - purged.overall.ic).toFixed(4) : null,
    researchValidity: opts.researchValidity || { productionGrade: false, survivorshipSafe: false, pointInTimeSafe: false },
  };
}

// ── Reference benchmarks (for the walk-forward comparison) ──────────────────
function fitBaseRate(rows) { return OM.fitBaseRate(rows.map(r => ({ raw: r.target != null && r.target > 0 ? 1 : 0 }))); }
function scoreBaseRate(m) { return { rankScore: m.p }; }
function residualMomentumRank(features) { return { rankScore: features && features.residMom63 != null ? features.residMom63 : 0 }; }

module.exports = {
  ML_MODEL_VERSION, fitRankModel, scoreRankModel, rankGroup, rankWalkForward,
  gbmStatus, evalTrees, fitBaseRate, scoreBaseRate, residualMomentumRank,
};
