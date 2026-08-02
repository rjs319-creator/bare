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

module.exports = { brierScore, reliabilityBuckets, expectedCalibrationError, baseRate, precisionAtK, topKMean };
