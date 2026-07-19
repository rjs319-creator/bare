'use strict';
// NOVEL SIGNAL LAB — shared statistics (pure, deterministic).
// Rank-IC (Spearman) with tie-aware ranks, plus small helpers used by the invariance and
// incremental-value evaluators. No network, no clock.

function ranks(xs) {
  // Fractional (average) ranks — tie-correct.
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // 1-based average rank over the tie block
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 3 || b.length !== n) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  if (saa === 0 || sbb === 0) return null;
  return sab / Math.sqrt(saa * sbb);
}

// Spearman rank-IC of signal vs outcome over paired arrays.
function rankIC(signal, outcome) {
  const pairs = [];
  for (let i = 0; i < signal.length; i++) if (Number.isFinite(signal[i]) && Number.isFinite(outcome[i])) pairs.push([signal[i], outcome[i]]);
  if (pairs.length < 5) return null;
  return pearson(ranks(pairs.map(p => p[0])), ranks(pairs.map(p => p[1])));
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)); };

module.exports = { ranks, pearson, rankIC, mean, sd };
