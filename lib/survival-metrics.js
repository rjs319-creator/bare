'use strict';
// SURVIVAL-MODEL CALIBRATION + RANKING METRICS — pure. Brier score, reliability buckets,
// expected calibration error (ECE), and precision@k / top-k mean. Used to judge whether a
// probability output is trustworthy (calibrated) and whether its ranking beats the
// deterministic baseline — never to manufacture one. All return null on empty input rather
// than a misleading 0. (Named survival-metrics to avoid the unrelated lib/calibration.js,
// which is attribution/conviction verdicts.)
//
// WEIGHTS. Every metric takes an optional per-row weight vector (inverse-probability weights
// from the dataset's deterministic negative sampling — 1/sampleProb). Weighted metrics
// estimate the FULL-UNIVERSE quantity; unweighted ones describe the sampled rows as stored.
// Callers should report BOTH so the effect of sampling is visible, never hidden. Omitting
// weights preserves the original unweighted behavior exactly.

const wAt = (weights, i) => (weights && Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 1);

function brierScore(preds, labels, weights = null) {
  if (!preds.length) return null;
  let s = 0, sw = 0;
  for (let i = 0; i < preds.length; i++) {
    const w = wAt(weights, i);
    s += w * (preds[i] - labels[i]) ** 2; sw += w;
  }
  return +(s / sw).toFixed(5);
}

function reliabilityBuckets(preds, labels, nBuckets = 10, weights = null) {
  const buckets = Array.from({ length: nBuckets }, () => ({ n: 0, w: 0, sumP: 0, sumY: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const bi = Math.min(nBuckets - 1, Math.max(0, Math.floor(preds[i] * nBuckets)));
    const w = wAt(weights, i);
    buckets[bi].n++; buckets[bi].w += w; buckets[bi].sumP += w * preds[i]; buckets[bi].sumY += w * labels[i];
  }
  return buckets.map((b, i) => ({
    bucket: i, lo: +(i / nBuckets).toFixed(2), hi: +((i + 1) / nBuckets).toFixed(2), n: b.n,
    weight: +b.w.toFixed(2),
    avgPred: b.n ? +(b.sumP / b.w).toFixed(4) : null,
    avgObserved: b.n ? +(b.sumY / b.w).toFixed(4) : null,
  }));
}

function expectedCalibrationError(preds, labels, nBuckets = 10, weights = null) {
  const N = preds.length; if (!N) return null;
  const buckets = reliabilityBuckets(preds, labels, nBuckets, weights);
  const totalW = buckets.reduce((s, b) => s + b.weight, 0);
  let ece = 0;
  for (const b of buckets) {
    if (b.n) ece += (b.weight / totalW) * Math.abs(b.avgPred - b.avgObserved);
  }
  return +ece.toFixed(5);
}

// Weighted base rate — the full-universe positive rate the sample represents.
function baseRate(labels, weights = null) {
  if (!labels.length) return null;
  let s = 0, sw = 0;
  for (let i = 0; i < labels.length; i++) { const w = wAt(weights, i); s += w * labels[i]; sw += w; }
  return +(s / sw).toFixed(4);
}

// Precision@k on a scored set [{score, label, weight?}] — fraction of the top-k that are
// positives. Ranking is by score (weights never reorder); with weights the precision itself
// is the weighted fraction. Deterministic tiebreak on the optional `id` field.
function precisionAtK(scored, k, { weighted = false } = {}) {
  const top = [...scored].sort((a, b) => (b.score - a.score) || String(a.id || '').localeCompare(String(b.id || ''))).slice(0, k);
  if (!top.length) return null;
  if (!weighted) return +(top.filter(x => x.label === 1).length / top.length).toFixed(4);
  let s = 0, sw = 0;
  for (const x of top) { const w = Number.isFinite(x.weight) && x.weight > 0 ? x.weight : 1; s += w * (x.label === 1 ? 1 : 0); sw += w; }
  return +(s / sw).toFixed(4);
}

// Mean of `valSel` over the top-k rows by `scoreSel` (e.g., avg net return of the top-k picks).
// `weightSel` (optional) makes it the inverse-probability-weighted mean.
function topKMean(rows, scoreSel, valSel, k, weightSel = null) {
  const top = [...rows].sort((a, b) => scoreSel(b) - scoreSel(a)).slice(0, k);
  if (!top.length) return null;
  if (!weightSel) return +(top.reduce((s, r) => s + (valSel(r) ?? 0), 0) / top.length).toFixed(5);
  let s = 0, sw = 0;
  for (const r of top) {
    const w = Math.max(0, weightSel(r) ?? 1) || 1;
    s += w * (valSel(r) ?? 0); sw += w;
  }
  return sw ? +(s / sw).toFixed(5) : null;
}

// ── Ranking-quality metrics over scored sets [{score, label, weight?, id?}] ──────
// Same row shape as precisionAtK. All are weighted-capable via { weighted: true }:
// weights change the ESTIMATE (full-universe quantity), never the ranking itself.

const scoredWeight = r => (Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 1);
const validScored = rows => (rows || []).filter(r => r && Number.isFinite(r.score) && (r.label === 0 || r.label === 1));
const byScoreDesc = (a, b) => (b.score - a.score) || String(a.id || '').localeCompare(String(b.id || ''));

// ROC AUC via the rank-based (Mann-Whitney) formulation with tied scores averaged:
// P(random positive scores above random negative), ties counting 1/2. Null when either
// class is empty — an AUC of a one-class set is meaningless, not 0.5.
function rocAuc(rows, { weighted = false } = {}) {
  const scored = validScored(rows);
  if (!scored.length) return null;
  if (!scored.some(r => r.label === 1) || !scored.some(r => r.label === 0)) return null;
  const wOf = r => (weighted ? scoredWeight(r) : 1);
  const sorted = [...scored].sort((a, b) => a.score - b.score);
  // Sweep ascending, grouping tied scores: positives in a tie group see all negatives
  // strictly below plus HALF the group's own negatives (rank-averaged ties).
  let cumNeg = 0, num = 0, wPos = 0, wNeg = 0, i = 0;
  while (i < sorted.length) {
    let j = i, groupPos = 0, groupNeg = 0;
    while (j < sorted.length && sorted[j].score === sorted[i].score) {
      const w = wOf(sorted[j]);
      if (sorted[j].label === 1) groupPos += w; else groupNeg += w;
      j++;
    }
    num += groupPos * (cumNeg + 0.5 * groupNeg);
    cumNeg += groupNeg; wPos += groupPos; wNeg += groupNeg;
    i = j;
  }
  return +(num / (wPos * wNeg)).toFixed(4);
}

// PR AUC as AVERAGE PRECISION: Σ Δrecall × precision over the ranked list (deterministic
// id tiebreak, like precisionAtK). Null when there are no positives — precision/recall
// are undefined, and a fabricated value would flatter an empty class.
function prAuc(rows, { weighted = false } = {}) {
  const scored = validScored(rows);
  if (!scored.length) return null;
  const wOf = r => (weighted ? scoredWeight(r) : 1);
  const totalPos = scored.reduce((s, r) => s + (r.label === 1 ? wOf(r) : 0), 0);
  if (totalPos <= 0) return null;
  const sorted = [...scored].sort(byScoreDesc);
  let seen = 0, tp = 0, ap = 0;
  for (const r of sorted) {
    const w = wOf(r);
    seen += w;
    if (r.label === 1) { tp += w; ap += w * (tp / seen); }   // Δrecall = w/totalPos
  }
  return +(ap / totalPos).toFixed(4);
}

const TOP_DECILE_MIN_ROWS = 10;   // below this a "decile" is a single arbitrary row

// Lift of the top 10% by prediction: mean label rate in the top decile ÷ base rate.
// Null when < TOP_DECILE_MIN_ROWS rows (no meaningful decile) or the base rate is 0
// (lift undefined — never report ∞ or a fake number).
function topDecileLift(rows, { weighted = false } = {}) {
  const scored = validScored(rows);
  if (scored.length < TOP_DECILE_MIN_ROWS) return null;
  const wOf = r => (weighted ? scoredWeight(r) : 1);
  const k = Math.floor(scored.length / 10);
  const top = [...scored].sort(byScoreDesc).slice(0, k);
  const rateOf = set => {
    let s = 0, sw = 0;
    for (const r of set) { const w = wOf(r); s += w * (r.label === 1 ? 1 : 0); sw += w; }
    return sw > 0 ? s / sw : null;
  };
  const topRate = rateOf(top), base = rateOf(scored);
  if (topRate == null || !base) return null;
  return +(topRate / base).toFixed(4);
}

// Weighted log loss (cross-entropy) — clamped to avoid infinities on hard 0/1 predictions.
function logLoss(preds, labels, weights = null) {
  if (!preds.length) return null;
  let s = 0, sw = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, preds[i]));
    const w = wAt(weights, i);
    s += -w * (labels[i] === 1 ? Math.log(p) : Math.log(1 - p)); sw += w;
  }
  return +(s / sw).toFixed(5);
}

// EPISODE-DEDUPED top-K: one slot per episode key (e.g. date|ticker) — the best-scored row
// of each episode competes, and one ticker's forty 5-minute rows can never occupy forty
// top-K slots. Returns the deduped scored set (callers then apply precisionAtK/topKMean).
function dedupeByEpisode(rows, scoreSel, episodeKeyOf) {
  const best = new Map();
  for (const r of rows || []) {
    const key = episodeKeyOf(r);
    const cur = best.get(key);
    if (!cur || (scoreSel(r) ?? -Infinity) > (scoreSel(cur) ?? -Infinity)) best.set(key, r);
  }
  return [...best.values()];
}

// SESSION-CLUSTERED uncertainty via block bootstrap over cluster keys (session dates):
// resample whole clusters with replacement, recompute the statistic, report the sd and a
// central 90% interval. Deterministic (seeded LCG — no ambient RNG), so tests can pin it.
// Correlated rows within a session inflate naive (row-iid) confidence; clustering by date
// is the honest unit of independence for intraday data.
function clusteredBootstrap(rows, statFn, clusterKeyOf, { B = 200, seed = 42 } = {}) {
  const clusters = new Map();
  for (const r of rows || []) {
    const key = clusterKeyOf(r);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(r);
  }
  const keys = [...clusters.keys()];
  if (keys.length < 2) return { se: null, lo: null, hi: null, clusters: keys.length, note: 'needs ≥2 clusters' };
  let s = seed >>> 0;
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const stats = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < keys.length; i++) sample.push(...clusters.get(keys[Math.floor(rand() * keys.length)]));
    const v = statFn(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  if (stats.length < 10) return { se: null, lo: null, hi: null, clusters: keys.length, note: 'statistic undefined on most resamples' };
  stats.sort((a, b) => a - b);
  const mean = stats.reduce((a, x) => a + x, 0) / stats.length;
  const se = Math.sqrt(stats.reduce((a, x) => a + (x - mean) ** 2, 0) / (stats.length - 1));
  return {
    se: +se.toFixed(6),
    lo: +stats[Math.floor(0.05 * stats.length)].toFixed(6),
    hi: +stats[Math.min(stats.length - 1, Math.floor(0.95 * stats.length))].toFixed(6),
    clusters: keys.length, resamples: stats.length,
  };
}

module.exports = {
  brierScore, reliabilityBuckets, expectedCalibrationError, baseRate, precisionAtK, topKMean,
  rocAuc, prAuc, topDecileLift, TOP_DECILE_MIN_ROWS,
  logLoss, dedupeByEpisode, clusteredBootstrap,
};
