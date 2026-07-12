// RANKING-QUALITY VALIDATION (#5) — does a higher score actually produce a better
// outcome? Pure statistics over resolved, scored picks so it runs in an op AND in
// tests. Generic: feed it [{score, outcome, won}] from ANY scored ledger (Apex today;
// the unified decision-engine snapshots once they mature). `outcome` is the realized
// forward measure (excess return, or R-multiple); `won` is the binary hit.
//
// Reports the standard rank-quality battery: performance by score decile/quantile,
// Spearman information coefficient (+ significance), top-quantile vs bottom spread,
// lift over the base rate, Brier score + a calibration table, and a plain verdict.

'use strict';

const RQ_VERSION = 'rankquality-v1';
const clean = (items) => (items || []).filter(x => x && Number.isFinite(+x.score) && Number.isFinite(+x.outcome))
  .map(x => ({ score: +x.score, outcome: +x.outcome, won: x.won == null ? +x.outcome > 0 : !!x.won }));
const mean = a => (a.length ? a.reduce((s, b) => s + b, 0) / a.length : 0);

// Average (tie-corrected) ranks — the basis for Spearman.
function averageRanks(vals) {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(vals.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1; // 1-based average rank across the tie block
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// Spearman rank-IC between score and outcome + a t-based significance flag.
function informationCoefficient(items) {
  const rs = averageRanks(items.map(x => x.score));
  const ro = averageRanks(items.map(x => x.outcome));
  const ic = pearson(rs, ro);
  if (ic == null) return { ic: null, n: items.length, t: null, significant: false };
  const n = items.length;
  const t = Math.abs(ic) >= 0.999 ? Infinity : ic * Math.sqrt((n - 2) / (1 - ic * ic));
  return { ic: +ic.toFixed(3), n, t: Number.isFinite(t) ? +t.toFixed(2) : t, significant: Math.abs(t) >= 2 };
}

// Split into K score-quantiles (highest bucket first) with per-bucket stats.
function quantileStats(items, k) {
  const sorted = items.slice().sort((a, b) => a.score - b.score);
  const n = sorted.length;
  const buckets = [];
  for (let q = 0; q < k; q++) {
    const lo = Math.floor((q * n) / k), hi = Math.floor(((q + 1) * n) / k);
    const seg = sorted.slice(lo, hi);
    if (!seg.length) continue;
    buckets.push({
      bucket: q + 1, n: seg.length,
      scoreLo: +seg[0].score.toFixed(1), scoreHi: +seg[seg.length - 1].score.toFixed(1),
      avgOutcome: +mean(seg.map(s => s.outcome)).toFixed(2),
      winRate: +((seg.filter(s => s.won).length / seg.length) * 100).toFixed(0),
    });
  }
  return buckets.reverse(); // highest score bucket first
}

// Is the quantile ladder monotone increasing in outcome? Measured by the correlation
// between bucket score-rank and bucket avg-outcome (robust to small non-monotone wiggles).
function monotonicity(buckets) {
  if (buckets.length < 2) return { rho: null, monotone: false };
  const asc = buckets.slice().reverse();               // lowest→highest score
  const rho = pearson(asc.map((_, i) => i), asc.map(b => b.avgOutcome));
  return { rho: rho == null ? null : +rho.toFixed(2), monotone: rho != null && rho >= 0.6 };
}

// Brier score + calibration table treating score/100 as an implied win probability.
function calibration(items, bins = 5) {
  const withP = items.map(x => ({ p: Math.max(0, Math.min(1, x.score / 100)), won: x.won ? 1 : 0 }));
  const brier = +mean(withP.map(x => (x.p - x.won) ** 2)).toFixed(3);
  const table = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const seg = withP.filter(x => x.p >= lo && (b === bins - 1 ? x.p <= hi : x.p < hi));
    if (!seg.length) continue;
    table.push({ band: `${Math.round(lo * 100)}-${Math.round(hi * 100)}`, n: seg.length,
      predicted: +(mean(seg.map(s => s.p)) * 100).toFixed(0), actual: +((seg.filter(s => s.won).length / seg.length) * 100).toFixed(0) });
  }
  return { brier, table };
}

// Full battery + a plain-English verdict.
function analyzeRankQuality(rawItems, opts = {}) {
  const items = clean(rawItems);
  const n = items.length;
  const minN = opts.minN || 20;
  if (n < minN) return { version: RQ_VERSION, n, ready: false, note: `Need ≥${minN} resolved scored picks (have ${n}).` };

  const k = opts.buckets || (n >= 50 ? 10 : n >= 30 ? 5 : 3);
  const buckets = quantileStats(items, k);
  const icRes = informationCoefficient(items);
  const mono = monotonicity(buckets);
  const baseWin = +((items.filter(x => x.won).length / n) * 100).toFixed(0);
  const baseAvg = +mean(items.map(x => x.outcome)).toFixed(2);

  // Top vs bottom quantile spread + top-K precision.
  const top = buckets[0], bottom = buckets[buckets.length - 1];
  const topKn = Math.max(5, Math.round(n * 0.1));
  const topK = items.slice().sort((a, b) => b.score - a.score).slice(0, topKn);
  const topKprecision = +((topK.filter(x => x.won).length / topK.length) * 100).toFixed(0);
  const cal = calibration(items);

  // Verdict: sign + significance of IC, backed by a monotone ladder.
  const ic = icRes.ic;
  let verdict;
  if (ic == null) verdict = 'insufficient';
  else if (ic >= 0.05 && icRes.significant && mono.monotone) verdict = 'predictive';
  else if (ic >= 0.03 && mono.rho != null && mono.rho > 0) verdict = 'weak-positive';
  else if (ic <= -0.05 && icRes.significant) verdict = 'inverted';
  else verdict = 'noise';

  return {
    version: RQ_VERSION, n, ready: true, buckets, bucketCount: buckets.length,
    ic: icRes, monotonicity: mono,
    baseWinRate: baseWin, baseAvgOutcome: baseAvg,
    topBucket: top, bottomBucket: bottom,
    topBottomSpread: top && bottom ? +(top.avgOutcome - bottom.avgOutcome).toFixed(2) : null,
    topKprecision, topKn,
    liftWinRate: top ? +(top.winRate - baseWin).toFixed(0) : null,   // top-bucket win rate above base rate
    calibration: cal,
    verdict,
  };
}

module.exports = { RQ_VERSION, analyzeRankQuality, informationCoefficient, quantileStats, monotonicity, calibration, averageRanks, pearson };
