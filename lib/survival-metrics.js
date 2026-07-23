'use strict';
// SURVIVAL-MODEL CALIBRATION + RANKING METRICS — pure. Brier score, reliability buckets,
// expected calibration error (ECE), and precision@k / top-k mean. Used to judge whether a
// probability output is trustworthy (calibrated) and whether its ranking beats the
// deterministic baseline — never to manufacture one. All return null on empty input rather
// than a misleading 0. (Named survival-metrics to avoid the unrelated lib/calibration.js,
// which is attribution/conviction verdicts.)

function brierScore(preds, labels) {
  if (!preds.length) return null;
  let s = 0;
  for (let i = 0; i < preds.length; i++) s += (preds[i] - labels[i]) ** 2;
  return +(s / preds.length).toFixed(5);
}

function reliabilityBuckets(preds, labels, nBuckets = 10) {
  const buckets = Array.from({ length: nBuckets }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const bi = Math.min(nBuckets - 1, Math.max(0, Math.floor(preds[i] * nBuckets)));
    buckets[bi].n++; buckets[bi].sumP += preds[i]; buckets[bi].sumY += labels[i];
  }
  return buckets.map((b, i) => ({
    bucket: i, lo: +(i / nBuckets).toFixed(2), hi: +((i + 1) / nBuckets).toFixed(2), n: b.n,
    avgPred: b.n ? +(b.sumP / b.n).toFixed(4) : null,
    avgObserved: b.n ? +(b.sumY / b.n).toFixed(4) : null,
  }));
}

function expectedCalibrationError(preds, labels, nBuckets = 10) {
  const N = preds.length; if (!N) return null;
  let ece = 0;
  for (const b of reliabilityBuckets(preds, labels, nBuckets)) {
    if (b.n) ece += (b.n / N) * Math.abs(b.avgPred - b.avgObserved);
  }
  return +ece.toFixed(5);
}

// Precision@k on a scored set [{score, label}] — fraction of the top-k that are positives.
function precisionAtK(scored, k) {
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, k);
  if (!top.length) return null;
  return +(top.filter(x => x.label === 1).length / top.length).toFixed(4);
}

// Mean of `valSel` over the top-k rows by `scoreSel` (e.g., avg net return of the top-k picks).
function topKMean(rows, scoreSel, valSel, k) {
  const top = [...rows].sort((a, b) => scoreSel(b) - scoreSel(a)).slice(0, k);
  if (!top.length) return null;
  return +(top.reduce((s, r) => s + (valSel(r) ?? 0), 0) / top.length).toFixed(5);
}

module.exports = { brierScore, reliabilityBuckets, expectedCalibrationError, precisionAtK, topKMean };
