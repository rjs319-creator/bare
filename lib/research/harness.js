'use strict';
// VALIDATION HARNESS (research-harness-v1)
//
// Compares a set of rankers on IDENTICAL purged, group-aware, chronological folds and reports a
// per-ranker daily rank-IC battery with a block-bootstrap confidence interval (Parts XIII–XIV).
// The atomic unit of evidence is the DAILY cross-sectional rank-IC — one number per decision date —
// which correctly treats same-date names as one correlated observation rather than N independent
// ones. Purge uses EXACT label-end timestamps (lib/research/label-purge.js), not a calendar
// multiplier. Every run emits a reproducible ExperimentManifest and a researchValidity stamp.
//
// This harness measures RANKING QUALITY only. It NEVER labels a result production-grade on its own;
// `survivorshipSafe` is an input the caller must justify (this repo cannot — see the audit), so the
// stamp defaults to unsafe and the verdict says so.
//
// Pure & deterministic (seeded bootstrap; fixed ranker fits) → byte-identical reruns.

const RQ = require('../rankquality');
const U = require('../evolve-uniqueness');
const LP = require('./label-purge');
const { makeExperimentManifest, researchValidity } = require('./schemas');

const HARNESS_VERSION = 'research-harness-v1';
const MIN_NAMES_PER_DATE = 3;   // a cross-sectional IC needs ≥3 names on the date

// Deterministic LCG for the block bootstrap (no Math.random → reproducible CIs).
function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// Daily cross-sectional rank-IC of a scoring function over a set of scored rows.
// Returns [{ date, ic, n }] — one entry per date with ≥MIN_NAMES_PER_DATE scorable names.
function perDateIC(rows, scoreOf) {
  const byDate = new Map();
  for (const r of rows) {
    const d = r.decisionTs;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const out = [];
  for (const [date, group] of byDate) {
    const items = group
      .map((r) => ({ score: scoreOf(r), outcome: r.outcome }))
      .filter((x) => Number.isFinite(x.score) && Number.isFinite(x.outcome));
    if (items.length < MIN_NAMES_PER_DATE) continue;
    const ic = RQ.informationCoefficient(items).ic;
    if (ic != null) out.push({ date, ic, n: items.length });
  }
  return out;
}

// Per-DATE average-uniqueness weights (López de Prado, Advances in Financial ML
// ch.4, applied at the daily-IC level). The atomic unit of evidence is ONE IC per
// decision date, but adjacent dates' forward LABEL windows [decisionTs → labelEndDate]
// overlap, so their ICs are correlated rather than independent — counting each date
// as one independent trial overstates significance. Each date is weighted by the
// average, over the calendar days its label window is open, of 1/(concurrent
// date-windows). Temporally isolated dates keep weight 1. Uses the ACTUAL logged
// label end per date (the latest across that date's rows). Pure & deterministic.
function datedUniquenessWeights(rows) {
  const day = (d) => Math.round(new Date(d).getTime() / 86400000);
  const spanByDate = new Map();
  for (const r of (rows || [])) {
    if (!r || !r.decisionTs) continue;
    const s = day(r.decisionTs);
    const e = Math.max(s, r.labelEndDate ? day(r.labelEndDate) : s);
    const prev = spanByDate.get(r.decisionTs);
    if (!prev || e > prev.e) spanByDate.set(r.decisionTs, { s, e });
  }
  const spans = [...spanByDate.entries()].map(([date, sp]) => ({ date, s: sp.s, e: sp.e }));
  const w = new Map();
  for (const a of spans) {
    let sum = 0, days = 0;
    for (let d = a.s; d <= a.e; d++) {
      let c = 0;
      for (const b of spans) { if (b.s <= d && d <= b.e) c++; }
      if (c > 0) { sum += 1 / c; days++; }
    }
    w.set(a.date, days ? +(sum / days).toFixed(4) : 1);
  }
  return w;
}

// Uniqueness-adjusted significance battery (ADDITIVE): the naive battery treats the
// k dated ICs as k independent trials; this re-weights by per-date uniqueness so the
// t-stat and CI reflect the EFFECTIVE (de-overlapped) sample size — the fix for
// "effective-N reported but never applied". Returns null when no valid weights.
function weightedBattery(ics, weights, seed) {
  if (!Array.isArray(weights) || weights.length !== ics.length) return null;
  const pairs = [];
  for (let i = 0; i < ics.length; i++) {
    const ic = ics[i].ic, w = weights[i];
    if (Number.isFinite(ic) && Number.isFinite(w) && w > 0) pairs.push({ ic, w });
  }
  if (pairs.length < 2) return null;
  const W = pairs.reduce((a, p) => a + p.w, 0);
  // Effective sample size = Σ uniqueness (López de Prado) — the number of INDEPENDENT
  // observations once overlap is removed — NOT the Kish (Σw)²/Σw² formula, which
  // measures weight-variance and collapses to the raw count when overlap is uniform.
  // Consistent with lib/evolve-uniqueness.uniquenessSummary's effectiveN.
  const effN = W;
  if (!(effN > 1)) return null;
  const wmean = pairs.reduce((a, p) => a + p.w * p.ic, 0) / W;
  const wvarPop = pairs.reduce((a, p) => a + p.w * (p.ic - wmean) ** 2, 0) / W;
  const wvar = wvarPop * (effN / (effN - 1));                // population → sample variance
  const wstd = Math.sqrt(wvar);
  const wtstat = wstd > 0 ? wmean / (wstd / Math.sqrt(effN)) : null;
  // Importance-resampled bootstrap: draw round(effN) dates ∝ weight so the CI width
  // reflects the effective, not the raw, number of independent observations.
  const cum = []; let acc = 0; for (const p of pairs) { acc += p.w; cum.push(acc); }
  const rnd = lcg((seed ^ 0x9e3779b9) >>> 0); const B = 1000; const m = Math.max(2, Math.round(effN)); const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let j = 0; j < m; j++) {
      const u = rnd() * W; let idx = cum.findIndex((c) => u <= c); if (idx < 0) idx = pairs.length - 1;
      s += pairs[idx].ic;
    }
    means.push(s / m);
  }
  means.sort((a, b) => a - b);
  return {
    effectiveDates: +effN.toFixed(1),
    uniquenessRatio: +(effN / pairs.length).toFixed(3),
    weightedMeanIC: +wmean.toFixed(4),
    weightedTstat: wtstat == null ? null : +wtstat.toFixed(2),
    weightedSignificant: wtstat != null && Math.abs(wtstat) >= 2,
    weightedCi90: [+means[Math.floor(0.05 * B)].toFixed(4), +means[Math.floor(0.95 * B)].toFixed(4)],
  };
}

// Summarize a list of daily ICs into the ranking battery + a block-bootstrap 90% CI.
// Optional `weights` (per-date uniqueness, aligned to `ics`) ADD an effective-sample
// battery alongside the naive one — legacy fields are unchanged, so both the raw and
// the honest uniqueness-adjusted significance are visible.
function summarizeICs(ics, seed = 12345, weights = null) {
  const vals = ics.map((x) => x.ic).filter(Number.isFinite);
  const k = vals.length;
  if (k < 2) return { dates: k, meanIC: null, note: 'too few dated ICs' };
  const mean = vals.reduce((a, b) => a + b, 0) / k;
  const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (k - 1);
  const std = Math.sqrt(varr);
  const icir = std > 0 ? mean / std : null;                 // information ratio of the IC
  const tstat = std > 0 ? mean / (std / Math.sqrt(k)) : null;
  const fracPositive = vals.filter((v) => v > 0).length / k;
  // Block bootstrap over dated ICs (each date is a block) for a robust CI on the mean.
  const rnd = lcg(seed); const B = 1000; const means = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < k; i++) s += vals[Math.floor(rnd() * k)]; means.push(s / k); }
  means.sort((a, b) => a - b);
  const ci = [means[Math.floor(0.05 * B)], means[Math.floor(0.95 * B)]];
  const base = {
    dates: k,
    meanIC: +mean.toFixed(4), medianIC: +vals.slice().sort((a, b) => a - b)[k >> 1].toFixed(4),
    stdIC: +std.toFixed(4), icir: icir == null ? null : +icir.toFixed(3),
    tstat: tstat == null ? null : +tstat.toFixed(2), significant: tstat != null && Math.abs(tstat) >= 2,
    fracPositive: +fracPositive.toFixed(2),
    ci90: [+ci[0].toFixed(4), +ci[1].toFixed(4)],
  };
  const adj = weightedBattery(ics, weights, seed);
  return adj ? { ...base, ...adj } : base;
}

// Purged, group-aware, expanding-window walk-forward comparing rankers.
//   events        : research rows { securityId, ticker, decisionTs, labelEndDate, horizon, features, outcome, won, score }
//   rankers       : [{ name, fit, score }] from baseline-ranker.js
//   opts.folds    : outer chronological blocks (default 5)
//   opts.embargo  : extra trading-day buffer beyond the exact label end (default 3)
function compareRankers(events, rankers, opts = {}) {
  const folds = opts.folds || 5;
  const embargo = Number.isFinite(opts.embargo) ? opts.embargo : 3;
  const rows = (events || []).filter((e) => e && e.decisionTs && Number.isFinite(e.outcome));
  const axis = LP.buildDateAxis(rows.map((r) => r.decisionTs).concat(rows.map((r) => r.labelEndDate)));
  const dates = [...new Set(rows.map((r) => r.decisionTs))].sort();
  const ordOf = new Map(dates.map((d, i) => [d, i]));
  const D = dates.length;

  const perRankerICs = new Map(rankers.map((r) => [r.name, []]));
  const foldReport = [];
  let purgeStats = { exactKept: 0, leakedByApprox: 0, droppedByApprox: 0, approxKept: 0, n: 0 };

  for (let f = 1; f < folds; f++) {                          // f=0 has no past
    const lo = Math.floor((D * f) / folds), hi = Math.floor((D * (f + 1)) / folds);
    const testStart = dates[lo];
    const testDates = new Set(dates.slice(lo, hi));
    const testRows = rows.filter((r) => testDates.has(r.decisionTs));
    const past = rows.filter((r) => ordOf.get(r.decisionTs) < lo);
    const train = LP.exactPurge(past, axis, testStart, embargo);

    // Measure exact vs. 1.4×-calendar approximation on the SAME past set (quantifies the fix).
    const cmp = LP.comparePurge(past, axis, testStart, embargo, (e) => {
      if (!e.labelEndDate) return false;
      const need = (windowFor(e.horizon) + embargo) * 1.4;
      return (new Date(testStart) - new Date(e.decisionTs)) / 86400000 > need;
    });
    purgeStats = mergePurge(purgeStats, cmp);

    const foldRow = { fold: f, from: dates[lo], to: dates[hi - 1], trainN: train.length, testN: testRows.length, rankers: {} };
    for (const r of rankers) {
      const model = r.fit(train, opts.rankerOpts || {});
      const ics = perDateIC(testRows, (row) => r.score(model, row));
      perRankerICs.get(r.name).push(...ics);
      foldRow.rankers[r.name] = { datedICs: ics.length, meanIC: ics.length ? +(ics.reduce((a, b) => a + b.ic, 0) / ics.length).toFixed(4) : null };
    }
    foldReport.push(foldRow);
  }

  // Per-date uniqueness weights (from the actual label windows) so the summary can
  // report EFFECTIVE-sample significance, not just the naive one-trial-per-date count.
  const dateW = datedUniquenessWeights(rows);
  const summary = {};
  for (const r of rankers) {
    const rICs = perRankerICs.get(r.name);
    const weights = rICs.map((x) => dateW.get(x.date) ?? 1);
    summary[r.name] = summarizeICs(rICs, 12345, weights);
  }

  return {
    version: HARNESS_VERSION, folds, embargo,
    distinctDates: D, events: rows.length,
    uniqueness: U.uniquenessSummary(rows),
    purge: { method: 'exact-label-end', vs14xApprox: purgeStats },
    perRanker: summary,
    foldReport,
  };
}
function windowFor(h) { const M = { micro: 2, fast: 5, swing: 21, position: 63 }; return M[h] || 21; }
function mergePurge(a, c) {
  return { exactKept: a.exactKept + c.exactKept, approxKept: a.approxKept + c.approxKept,
    leakedByApprox: a.leakedByApprox + c.leakedByApprox, droppedByApprox: a.droppedByApprox + c.droppedByApprox, n: a.n + c.n };
}

// Run the comparison AND wrap it in a reproducible ExperimentManifest with an honest validity stamp.
//   meta: { experimentId, experimentFamilyId, datasetHash, codeCommit, primaryMetric,
//           relatedExperimentsAttempted, survivorshipSafe, survivorshipReason, generatedAt, seed }
function runExperiment(events, rankers, opts = {}, meta = {}) {
  const result = compareRankers(events, rankers, opts);
  const champion = Object.entries(result.perRanker)
    .filter(([, s]) => s && s.meanIC != null)
    .sort((a, b) => b[1].meanIC - a[1].meanIC)[0];
  const validity = researchValidity({
    productionGrade: false,                                // this harness never self-certifies production
    survivorshipSafe: !!meta.survivorshipSafe,
    reason: meta.survivorshipReason || 'survivorship-unsafe: universe reconstructed from present-day lists; no PIT constituents',
  });
  const manifest = makeExperimentManifest({
    experimentId: meta.experimentId || 'exp-unnamed',
    experimentFamilyId: meta.experimentFamilyId || null,
    datasetHash: meta.datasetHash || 'unhashed',
    securityMasterVersion: meta.securityMasterVersion || null,
    universePolicy: meta.universePolicy || 'present-day-static (survivorship-unsafe)',
    featureManifest: require('./features').FEATURE_KEYS,
    labelVersion: require('../evolve-labels').LABELS_VERSION,
    foldDefinitions: result.foldReport.map((f) => ({ fold: f.fold, from: f.from, to: f.to, trainN: f.trainN, testN: f.testN })),
    modelParams: opts.rankerOpts || {},
    calibrationParams: {},
    costModel: meta.costModel || null,
    codeCommit: meta.codeCommit || null,
    randomSeed: meta.seed == null ? 12345 : meta.seed,
    relatedExperimentsAttempted: meta.relatedExperimentsAttempted == null ? rankers.length : meta.relatedExperimentsAttempted,
    primaryMetric: meta.primaryMetric || 'mean-daily-rank-IC (OOS, purged)',
    results: Object.fromEntries(Object.entries(result.perRanker).map(([k, v]) => [k, v.meanIC])),
    confidenceIntervals: Object.fromEntries(Object.entries(result.perRanker).map(([k, v]) => [k, v.ci90 || null])),
    researchValidity: validity,
    generatedAt: meta.generatedAt || null,
  });
  return {
    version: HARNESS_VERSION,
    champion: champion ? { ranker: champion[0], meanIC: champion[1].meanIC, ci90: champion[1].ci90 } : null,
    result, manifest,
    verdict: verdictOf(result, validity),
  };
}

function verdictOf(result, validity) {
  if (!validity.survivorshipSafe) return 'PROVISIONAL — survivorship-unsafe data; cannot support production promotion';
  const prod = result.perRanker['production-composite'];
  const ridge = result.perRanker['ridge-linear'];
  if (!prod || !ridge || prod.meanIC == null || ridge.meanIC == null) return 'INSUFFICIENT';
  return ridge.meanIC > prod.meanIC ? 'ridge-beats-production (OOS rank-IC)' : 'production-not-beaten';
}

module.exports = {
  HARNESS_VERSION, MIN_NAMES_PER_DATE,
  perDateIC, summarizeICs, datedUniquenessWeights, weightedBattery, compareRankers, runExperiment, verdictOf, lcg,
};
