'use strict';
// EVIDENCE STATISTICS — ONE POPULATION, DEPENDENCE-AWARE (redesign Phase 5).
//
// THE DEFECTS THIS CLOSES.
//   1. Different displayed statistics described different populations: an average pooled
//      across tiers, a confidence interval computed from one tier, a win rate counted per
//      pick. Everything here is derived from ONE deduplicated raw series so the numbers on
//      a card are provably about the same set of episodes.
//   2. Correlated observations were counted as independent evidence. Same-day picks share
//      the market factor; overlapping multi-session labels share most of their return
//      path. Both are handled: dedup to one portfolio return per decision date, then HAC
//      standard errors, a moving-block bootstrap, and an EFFECTIVE sample size.
//   3. Small samples used the normal 1.96 critical value. At n=6 that interval is roughly
//      15% too narrow — exactly where a promotion gate must not be generous. A Student-t
//      critical value is used, and the interval reported is the WIDER of the t and
//      bootstrap intervals (a correction may only ever widen a promotion gate).
//   4. Nothing corrected for the number of strategies attempted. Benjamini-Hochberg FDR
//      across the whole attempted family is provided and reported with the verdict.
//
// Pure. No network, no state. Deterministic (the bootstrap is seeded).

const S3 = require('./research/stats-v3');

const EVIDENCE_STATS_VERSION = 'evidence-stats-v1';

// Two-sided 95% Student-t critical values by degrees of freedom. Table to df=30, then the
// standard normal (the difference is <2% beyond df≈30). Fails CONSERVATIVE: an unknown or
// tiny df takes the largest value in the table.
const T95 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306,
  9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
  16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074,
  23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
};
function tCritical95(df) {
  if (!Number.isFinite(df) || df < 1) return T95[1];
  if (df <= 30) return T95[Math.floor(df)];
  return 1.96;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round = (v, d = 2) => (Number.isFinite(v) ? +v.toFixed(d) : null);

// DEDUPLICATION at the decision-date × strategy-policy level (Phase 5 item 4). Rows are
// {date, value, ...}; overlapping signals on one date become ONE equal-weight portfolio
// observation. Returns the chronological date series plus the accounting.
// NB `pickValue`/`pickDate`, not `valueOf`/`dateOf`: destructuring a property named
// `valueOf` out of an object literal resolves Object.prototype.valueOf instead of the
// default, and then calls it unbound. A silent inherited-property trap.
function dedupeToDateSeries(rows, { pickValue = (r) => r.netExc, pickDate = (r) => r.date } = {}) {
  const byDate = new Map();
  let skipped = 0;
  for (const r of rows || []) {
    const d = r && pickDate(r);
    const v = r && pickValue(r);
    if (!d || !Number.isFinite(v)) { skipped++; continue; }
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(v);
  }
  const dates = [...byDate.keys()].sort();
  return {
    dates,
    series: dates.map(d => mean(byDate.get(d))),
    perDateCounts: dates.map(d => byDate.get(d).length),
    observations: (rows || []).length - skipped,
    skipped,
  };
}

// Chronological block consistency: split the series into `blocks` contiguous pieces and
// count how many have a positive mean. A strategy that only works in one regime shows up
// here as 1-of-4 rather than as one flattering average.
function blockConsistency(series, { blocks = 4 } = {}) {
  const n = (series || []).length;
  if (n < blocks * 2) return { blocks: 0, positive: 0, means: [], usable: false, note: `need ≥${blocks * 2} observations for ${blocks} blocks` };
  const size = Math.floor(n / blocks);
  const means = [];
  for (let i = 0; i < blocks; i++) {
    const lo = i * size;
    const hi = i === blocks - 1 ? n : lo + size;
    means.push(round(mean(series.slice(lo, hi)), 3));
  }
  return { blocks, positive: means.filter(m => m > 0).length, means, usable: true };
}

// Seeded moving-block bootstrap, 95% percentile interval on the MEAN. Deterministic:
// same series + same seed ⇒ same interval, so a gate can be reproduced from an artifact.
function movingBlockCI95(vals, { B = 1000, seed = 20260805, blockLen = null } = {}) {
  const xs = (vals || []).filter(Number.isFinite);
  const n = xs.length;
  if (n < 4) return null;
  const L = Math.max(2, Math.min(blockLen || Math.round(Math.cbrt(n) * 1.5), Math.floor(n / 2)));
  const nBlocks = n - L + 1;
  const rnd = S3.lcg(seed);
  const stats = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    while (sample.length < n) {
      const start = Math.floor(rnd() * nBlocks);
      for (let j = 0; j < L && sample.length < n; j++) sample.push(xs[start + j]);
    }
    stats.push(mean(sample));
  }
  stats.sort((a, b) => a - b);
  const q = (p) => stats[Math.min(B - 1, Math.max(0, Math.floor(p * B)))];
  return { lo: q(0.025), hi: q(0.975), blockLen: L, B, seed };
}

// THE single summary. Everything a card, a gate or an artifact reports comes from here so
// the population can never diverge between fields.
//   horizonBars — label overlap, for the HAC lag choice
//   blocks      — chronological blocks for the stability read
//   seed/B      — bootstrap determinism
function summarizeDateSeries(series, { horizonBars = null, blocks = 4, B = 1000, seed = 20260805 } = {}) {
  const vals = (series || []).filter(Number.isFinite);
  const n = vals.length;
  if (n < 2) return null;
  const avg = mean(vals);
  const sd = Math.sqrt(vals.reduce((s, x) => s + (x - avg) ** 2, 0) / (n - 1));
  const naiveSe = sd / Math.sqrt(n);

  // Dependence-aware SE: Newey-West, floored at the IID SE (a small-sample HAC estimate
  // can come out too small; a correction may only ever widen the gate).
  const nw = S3.neweyWest(vals, horizonBars != null ? { horizonBars } : {});
  const hacUsable = nw && Number.isFinite(nw.se) && nw.se > 0;
  const se = hacUsable ? Math.max(nw.se, naiveSe) : naiveSe;

  // Effective sample size (autocorrelation-adjusted) — the honest independent-observation
  // count, and the df the t critical value uses.
  const essOut = S3.effectiveSampleSize(vals);
  const essRaw = essOut && Number.isFinite(essOut.ess) ? essOut.ess : n;
  const ess = Math.max(1, Math.min(n, essRaw));
  const tCrit = tCritical95(Math.max(1, Math.floor(ess) - 1));
  const tCI = { lo: avg - tCrit * se, hi: avg + tCrit * se };

  // Moving-block bootstrap CI at 95% — makes no distributional assumption and keeps local
  // dependence intact. (stats-v3's helper reports a 90% interval; the promotion gate is a
  // 95% statement, so the resampling is done here with the same seeded generator.)
  const bootCI = movingBlockCI95(vals, { B, seed, blockLen: horizonBars ? Math.max(2, horizonBars) : null });

  // The reported interval is the WIDER of the two (never the flattering one).
  const ci95 = bootCI
    ? { lo: Math.min(tCI.lo, bootCI.lo), hi: Math.max(tCI.hi, bootCI.hi) }
    : tCI;

  const stability = blockConsistency(vals, { blocks });
  return {
    version: EVIDENCE_STATS_VERSION,
    n,
    effectiveN: round(ess, 1),
    avg: round(avg),
    sd: round(sd),
    se: round(se, 4),
    // Full-precision copies for computation. The rounded fields above are display values;
    // a t-statistic taken from them turns a real ~0.003/cohort mean into t(0.00) and p≈1.
    avgExact: avg,
    seExact: se,
    tCritical: tCrit,
    ci95: { lo: round(ci95.lo), hi: round(ci95.hi) },
    tCI: { lo: round(tCI.lo), hi: round(tCI.hi) },
    bootstrapCI: bootCI ? { lo: round(bootCI.lo), hi: round(bootCI.hi), blockLen: bootCI.blockLen, B, seed } : null,
    seBasis: hacUsable ? `newey-west (lags ${nw.lags}, floored at IID)` : 'iid (too few observations for HAC)',
    ciBasis: bootCI
      ? 'widest of Student-t (df = effective sample size) and a seeded moving-block bootstrap — a correction may only widen a promotion gate'
      : `Student-t at df = effective sample size (${round(ess, 1)}), HAC standard error`,
    blockStability: stability,
    positiveBlocks: stability.positive,
  };
}

// Benjamini-Hochberg FDR across every attempted strategy (Phase 5 item 6). Delegates to
// the research hypothesis registry's implementation so one correction exists, not two.
function fdrAdjust(items, { alpha = 0.05 } = {}) {
  const { benjaminiHochberg } = require('./research/hypothesis-registry');
  const rows = benjaminiHochberg((items || []).filter(x => x && Number.isFinite(x.p)));
  return rows.map(r => ({ ...r, survives: Number.isFinite(r.q) ? r.q <= alpha : false, alpha }));
}

// Two-sided p-value for "is the mean different from zero?" using the dependence-aware SE.
function pValueOf(summary) {
  if (!summary) return null;
  // Prefer the full-precision fields; persisted summaries written before avgExact/seExact
  // existed only carry the rounded display values.
  const avg = Number.isFinite(summary.avgExact) ? summary.avgExact : summary.avg;
  const se = Number.isFinite(summary.seExact) ? summary.seExact : summary.se;
  if (!Number.isFinite(avg) || !Number.isFinite(se) || se <= 0) return null;
  // Student-t at df = effective sample size − 1, matching the CI's critical value.
  // The normal CDF is anti-conservative at the small effective-N these gates see
  // (p 0.028 vs true 0.050 at t=2.2, df=11) — and these p's feed BH demote-gating.
  const df = Number.isFinite(summary.effectiveN) && summary.effectiveN > 1
    ? summary.effectiveN - 1
    : undefined;
  return S3.pFromT(avg / se, df);
}

module.exports = {
  EVIDENCE_STATS_VERSION, T95, tCritical95, movingBlockCI95,
  dedupeToDateSeries, blockConsistency, summarizeDateSeries, fdrAdjust, pValueOf,
};
