'use strict';
// EVALUATION METRICS (forecast-metrics-v1)
//
// Every metric here is computed WITHIN a decision date first and then aggregated across dates.
// That is not a stylistic choice: overlapping daily cross-sections are not independent
// observations, and pooling all rows into one correlation would report a t-statistic built on a
// sample size the data does not have. The date is the independence unit; the IC information
// ratio is the mean daily IC over its standard error across dates.
//
// A degenerate cross-section (fewer than `minNames`, or a constant score vector) yields NULL,
// never 0 — a constant score has no ordering, and an "IC" computed from one is an artifact of
// input order.

const METRICS_VERSION = 'forecast-metrics-v1';
const MIN_NAMES_PER_DATE = 5;

const isFin = Number.isFinite;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
};

/** Average-tie ranks (1..n). */
function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
}

function spearman(xs, ys) {
  if (xs.length < 3) return null;
  if (xs.every((v) => v === xs[0])) return null;      // no ordering — see header
  return pearson(ranks(xs), ranks(ys));
}

/**
 * Per-date IC series plus its aggregate.
 *   rows: [{ decisionDate, score, actual }]
 * Returns { dates, perDate:[{date,n,ic,rankIC}], meanIC, meanRankIC, icIR, rankICIR, hitRate }.
 */
function informationCoefficient(rows, { minNames = MIN_NAMES_PER_DATE } = {}) {
  const byDate = new Map();
  for (const r of rows) {
    if (!r || !r.decisionDate || !isFin(r.score) || !isFin(r.actual)) continue;
    if (!byDate.has(r.decisionDate)) byDate.set(r.decisionDate, []);
    byDate.get(r.decisionDate).push(r);
  }
  const perDate = [];
  for (const date of [...byDate.keys()].sort()) {
    const g = byDate.get(date);
    if (g.length < minNames) continue;
    const s = g.map((r) => r.score), a = g.map((r) => r.actual);
    perDate.push({ date, n: g.length, ic: pearson(s, a), rankIC: spearman(s, a) });
  }
  const ics = perDate.map((d) => d.ic).filter(isFin);
  const rics = perDate.map((d) => d.rankIC).filter(isFin);
  const ir = (series) => {
    const m = mean(series), s = sd(series);
    return (m != null && s > 0 && series.length > 1) ? m / (s / Math.sqrt(series.length)) : null;
  };
  return {
    dates: perDate.length,
    perDate,
    meanIC: mean(ics), meanRankIC: mean(rics),
    sdIC: sd(ics), sdRankIC: sd(rics),
    icIR: ir(ics), rankICIR: ir(rics),
    positiveRankICRate: rics.length ? rics.filter((v) => v > 0).length / rics.length : null,
  };
}

/** Directional accuracy of the point forecast's sign against the realized sign. */
function directionalAccuracy(rows) {
  let n = 0, hit = 0;
  for (const r of rows) {
    if (!isFin(r.score) || !isFin(r.actual) || r.actual === 0) continue;
    n++;
    if (Math.sign(r.score) === Math.sign(r.actual)) hit++;
  }
  return n ? { n, accuracy: hit / n } : { n: 0, accuracy: null };
}

/** Brier score, log loss and expected calibration error over (p, y) pairs. */
function probabilityMetrics(pairs, { bins = 10 } = {}) {
  const clean = (pairs || []).filter((p) => p && isFin(p.p) && (p.y === 0 || p.y === 1));
  if (!clean.length) return { n: 0, brier: null, logLoss: null, ece: null, mce: null, prevalence: null, meanPredicted: null };
  let brier = 0, ll = 0, pos = 0, sumP = 0;
  for (const { p, y } of clean) {
    brier += (p - y) * (p - y);
    const pc = Math.max(1e-12, Math.min(1 - 1e-12, p));
    ll += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
    pos += y; sumP += p;
  }
  const sorted = clean.slice().sort((a, b) => a.p - b.p);
  const per = Math.max(1, Math.floor(sorted.length / bins));
  let ece = 0, mce = 0, counted = 0;
  for (let i = 0; i < sorted.length; i += per) {
    const chunk = sorted.slice(i, i + per);
    if (chunk.length < 2) continue;
    const mp = mean(chunk.map((c) => c.p));
    const obs = mean(chunk.map((c) => c.y));
    const gap = Math.abs(obs - mp);
    ece += gap * chunk.length;
    mce = Math.max(mce, gap);
    counted += chunk.length;
  }
  return {
    n: clean.length,
    brier: brier / clean.length,
    logLoss: ll / clean.length,
    ece: counted ? ece / counted : null,
    mce: counted ? mce : null,
    prevalence: pos / clean.length,
    meanPredicted: sumP / clean.length,
  };
}

/** Precision/recall for a rare positive class at a decision cut on the probability. */
function tailPrecisionRecall(pairs, cut = 0.5) {
  const clean = (pairs || []).filter((p) => p && isFin(p.p) && (p.y === 0 || p.y === 1));
  let tp = 0, fp = 0, fn = 0;
  for (const { p, y } of clean) {
    const pred = p >= cut ? 1 : 0;
    if (pred === 1 && y === 1) tp++;
    else if (pred === 1 && y === 0) fp++;
    else if (pred === 0 && y === 1) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return { cut, n: clean.length, tp, fp, fn, precision, recall, f1: (precision != null && recall != null && precision + recall > 0) ? (2 * precision * recall) / (precision + recall) : null };
}

/** Top-minus-bottom quantile spread of the realized target, per date then averaged. */
function quantileSpread(rows, q = 5, { minNames = MIN_NAMES_PER_DATE } = {}) {
  const byDate = new Map();
  for (const r of rows) {
    if (!r || !isFin(r.score) || !isFin(r.actual)) continue;
    if (!byDate.has(r.decisionDate)) byDate.set(r.decisionDate, []);
    byDate.get(r.decisionDate).push(r);
  }
  const spreads = [], tops = [], bottoms = [];
  for (const g of byDate.values()) {
    if (g.length < Math.max(minNames, q)) continue;
    const s = g.slice().sort((a, b) => b.score - a.score);
    const k = Math.max(1, Math.floor(s.length / q));
    const top = mean(s.slice(0, k).map((r) => r.actual));
    const bot = mean(s.slice(-k).map((r) => r.actual));
    if (isFin(top) && isFin(bot)) { spreads.push(top - bot); tops.push(top); bottoms.push(bot); }
  }
  return { dates: spreads.length, meanSpread: mean(spreads), meanTop: mean(tops), meanBottom: mean(bottoms), sdSpread: sd(spreads) };
}


/**
 * Dependence-aware uncertainty on the per-date rank-IC series.
 *
 * Daily cross-sections overlap when the horizon is longer than the rebalance step, so the IC
 * series is autocorrelated and a plain t-interval is too narrow. This uses the repository's own
 * seeded MOVING-BLOCK BOOTSTRAP (lib/research/stats-v3.js) with a block length matched to the
 * horizon, plus a Newey-West HAC standard error, so the two agree or visibly disagree.
 *
 * Returns null when there are too few dates for either to mean anything.
 */
function icUncertainty(perDate, { horizonBars = 5, iterations = 1000, seed = 20260829 } = {}) {
  const ST = require('../research/stats-v3');
  const series = perDate.map((d) => d.rankIC).filter(isFin);
  if (series.length < 12) return null;
  const block = Math.max(2, Math.min(Math.floor(series.length / 4), horizonBars + 1));
  const boot = ST.movingBlockBootstrap(series, { blockLen: block, B: iterations, seed });
  const hac = ST.neweyWest(series, { lags: Math.max(1, horizonBars) });
  const m = mean(series);
  return {
    dates: series.length,
    meanRankIC: m,
    blockLength: boot.blockLen,
    // stats-v3's moving-block bootstrap reports a 90% interval; it is labelled as such rather
    // than relabelled 95% to look tighter or wider than it is.
    bootstrapCi90: boot && Array.isArray(boot.ci90) ? boot.ci90 : null,
    bootstrapIterations: boot ? boot.B : 0,
    hacStdError: hac && Number.isFinite(hac.se) ? hac.se : null,
    hacT: hac && Number.isFinite(hac.tstat) ? hac.tstat : null,
    hacLags: hac ? hac.lags : null,
    method: 'seeded moving-block bootstrap (90% CI) + Newey-West HAC t over the per-date rank-IC series; the decision date is the independence unit',
  };
}

/**
 * Rank IC broken down by a row attribute (sector, liquidity bucket, calendar year, …), reported
 * only for buckets with enough dates to mean anything. Small buckets are RETURNED with their
 * size and a null IC rather than dropped, so a thin bucket is visible instead of missing.
 */
function breakdown(rows, keyOf, { minDates = 10, minNames = MIN_NAMES_PER_DATE } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = {};
  for (const [k, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ic = informationCoefficient(g, { minNames });
    out[k] = ic.dates >= minDates
      ? { n: g.length, dates: ic.dates, meanRankIC: ic.meanRankIC, rankICIR: ic.rankICIR, positiveRankICRate: ic.positiveRankICRate }
      : { n: g.length, dates: ic.dates, meanRankIC: null, rankICIR: null, positiveRankICRate: null, note: `fewer than ${minDates} usable dates — no estimate reported` };
  }
  return out;
}

/** Liquidity buckets matching the cost tiers, so a breakdown lines up with what was charged. */
const liquidityBucket = (adv) => (!isFin(adv) ? 'unknown' : adv >= 5e7 ? 'mega' : adv >= 2e7 ? 'liquid' : adv >= 5e6 ? 'small' : 'micro');

module.exports = {
  METRICS_VERSION, MIN_NAMES_PER_DATE,
  ranks, pearson, spearman, mean, sd,
  informationCoefficient, directionalAccuracy, probabilityMetrics, tailPrecisionRecall, quantileSpread,
  icUncertainty, breakdown, liquidityBucket,
};
