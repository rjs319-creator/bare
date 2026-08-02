'use strict';
// DATASET → MODEL ADAPTER + TWO-STAGE UTILITY EVALUATION — the missing connection between
// the full-universe PIT dataset (lib/intraday-dataset) and the learning stack.
//
// THE DEFECT THIS CLOSES. The survival harness trained ONLY from lifecycle first-entry
// episodes — the system's own ≤30-name Stage-2 selections — while the full-universe dataset
// (selected + rejected + sampled ordinary candidates, with sampleProb for 1/p weighting) was
// captured and then never read by anything. This module is the canonical loader/joiner:
//   • loadTrainingDays(dates)  — dataset rows ⋈ same-day labels ⋈ sampleProb ⋈ deep features
//   • evaluateDatasetSurvival — weighted walk-forward, two-stage (pTarget/pStop) baseline,
//     expected cost-net UTILITY as the primary actionable target, weighted AND unweighted
//     metrics, single-signal comparators, fail-closed promotion gate.
//
// RESEARCH/SHADOW ONLY. Nothing here is wired into a live ranking; probabilities are never
// displayed anywhere until out-of-fold calibration passes the pre-registered gate. With no
// accrued data the whole thing reports insufficient-data and the gate fails closed.

const { DATASET_VERSION, loadDatasetDay, loadDatasetGrades } = require('./intraday-dataset');
const { LABEL_VERSION } = require('./intraday-labels');
const { DATASET_FEATURES, datasetRowFeatures, toModelRow, missingnessOf } = require('./intraday-schema');
const { trainLogistic, predictProba, rowWeight, WEIGHT_CAP } = require('./survival-model');
const { purgedWalkForward, uniqueSortedDates } = require('./walk-forward');
const { brierScore, expectedCalibrationError, reliabilityBuckets, baseRate, precisionAtK, topKMean } = require('./survival-metrics');
const { checkPromotion } = require('./promotion-gate');

// Pre-registered primary barrier pair for the utility target: +1.0 ATR before −0.5 ATR.
const PRIMARY_BARRIER = 'u1_d0.5';
const PRIMARY_BARRIER_UP = 1.0, PRIMARY_BARRIER_DOWN = 0.5;
const DEEP_JOIN_TOLERANCE_MS = 5 * 60 * 1000;   // deep features must be from the same 5-min decision state

// ── Loader / joiner ─────────────────────────────────────────────────────────────

// Join one day's dataset rows with their grades (and optional deep Stage-2 feature records).
// INCLUDES selected, rejected and sampled ordinary candidates — no first-entry filtering,
// no actionable-only filtering. Dedup by ticker|at (distinct 5-minute decision states stay
// distinct). Fails closed on version-incompatible rows/labels: counted, never mixed in.
function joinDay({ date, rows, grades, deepRecords = null }) {
  const out = [];
  const skipped = { incompatibleRow: 0, incompatibleLabel: 0, ungraded: 0, duplicate: 0 };
  const seen = new Set();

  // Deep-feature index: ticker → [{atMs, features}] from Stage-2 lifecycle grade records.
  let deepByTicker = null;
  if (Array.isArray(deepRecords) && deepRecords.length) {
    deepByTicker = new Map();
    for (const g of deepRecords) {
      if (!g || !g.ticker || !g.features || !g.decisionAt) continue;
      const atMs = Date.parse(g.decisionAt);
      if (!Number.isFinite(atMs)) continue;
      if (!deepByTicker.has(g.ticker)) deepByTicker.set(g.ticker, []);
      deepByTicker.get(g.ticker).push({ atMs, features: g.features });
    }
  }

  for (const r of rows || []) {
    if (!r || !r.ticker || !r.at) continue;
    if (r.datasetVersion !== DATASET_VERSION) { skipped.incompatibleRow++; continue; }
    const id = `${r.ticker}|${r.at}`;
    if (seen.has(id)) { skipped.duplicate++; continue; }
    seen.add(id);
    const g = grades ? grades[id] : null;
    if (!g || !g.label) { skipped.ungraded++; continue; }
    if (g.label.labelVersion !== LABEL_VERSION) { skipped.incompatibleLabel++; continue; }

    // Deep tier: nearest Stage-2 evaluation of the same ticker within the decision bucket.
    let deep = null;
    if (deepByTicker && deepByTicker.has(r.ticker)) {
      const atMs = Date.parse(r.at);
      let best = null, bestGap = Infinity;
      for (const d of deepByTicker.get(r.ticker)) {
        const gap = Math.abs(d.atMs - atMs);
        if (gap < bestGap) { best = d; bestGap = gap; }
      }
      if (best && bestGap <= DEEP_JOIN_TOLERANCE_MS) deep = toModelRow(best.features);
    }

    const features = { ...datasetRowFeatures(r), ...(deep || {}) };
    // Deep keys must exist as own properties (null when no join) so missingness is explicit.
    for (const k of DATASET_FEATURES) if (!(k in features)) features[k] = null;

    const b = g.label.barriers ? g.label.barriers[PRIMARY_BARRIER] : null;
    const sampleProb = Number.isFinite(r.sampleProb) && r.sampleProb > 0 ? r.sampleProb : 1;
    out.push({
      id, date, ticker: r.ticker, at: r.at, bucket: r.bucket ?? null,
      atRisk: r.atRisk === true, sampleProb,
      weight: Math.min(1 / sampleProb, WEIGHT_CAP),
      features,
      missingness: missingnessOf(features, DATASET_FEATURES),
      featureTier: deep ? 'deep' : 'broad',
      // Primary barrier outcome (target-before-stop race) + utility ingredients.
      outcome: b ? b.outcome : null,                       // SUCCESS | FAILURE | TIMEOUT | null
      labelTarget: b ? (b.outcome === 'SUCCESS' ? 1 : 0) : null,
      labelStop: b ? (b.outcome === 'FAILURE' ? 1 : 0) : null,
      netReturn: b && Number.isFinite(b.netReturn) ? b.netReturn : null,
      timeToBarrierMin: b ? b.timeToBarrierMin : null,
      horizons: g.label.horizons || null,
      remainingMfe: g.label.remainingMfe ?? null,
      remainingFractionOfDayMove: g.label.remainingFractionOfDayMove ?? null,
      atrFrac: Number.isFinite(r.atr) && Number.isFinite(r.last) && r.last > 0 ? r.atr / r.last : null,
      costFrac: Number.isFinite(g.label.costBps) ? g.label.costBps / 10000 : null,
      captureSource: 'dataset',
    });
  }
  return { rows: out, skipped };
}

// Load + join a set of dates. `deps` injectable for tests. Deep records default to the
// day-matched lifecycle grade records (Stage-2 evaluated names) when a loader is provided.
async function loadTrainingDays(dates, { loadDay = loadDatasetDay, loadGrades = loadDatasetGrades, loadDeepRecords = null } = {}) {
  const all = [];
  const skippedTotal = { incompatibleRow: 0, incompatibleLabel: 0, ungraded: 0, duplicate: 0 };
  for (const date of dates || []) {
    const [day, gradesDoc] = await Promise.all([loadDay(date), loadGrades(date)]);
    const deepRecords = loadDeepRecords ? await loadDeepRecords(date) : null;
    const { rows, skipped } = joinDay({ date, rows: day.rows, grades: gradesDoc.grades, deepRecords });
    all.push(...rows);
    for (const k of Object.keys(skippedTotal)) skippedTotal[k] += skipped[k];
  }
  return { rows: all, skipped: skippedTotal };
}

// ── Two-stage utility evaluation (walk-forward, weighted) ───────────────────────

// Deterministic severity baseline — the non-fitted comparator every model must beat.
const severityScore = f => (Number.isFinite(f.cusum) ? f.cusum : 0)
  + (Number.isFinite(f.zShock) ? f.zShock / 1.5 : 0)
  + (Number.isFinite(f.dayPct) ? f.dayPct / 1.5 : 0)
  + (Number.isFinite(f.relVol) ? f.relVol / 1.5 : 0);

// Expected cost-net utility from the two-stage outputs. Reward/risk are the pre-registered
// barrier distances in return units for THIS row (ATR fraction of price); the timeout return
// is the TRAINING-fold weighted mean net return of timeout rows (never the test fold's).
function expectedUtility({ pTarget, pStop, atrFrac, timeoutNet, costFrac }) {
  if (!Number.isFinite(pTarget) || !Number.isFinite(pStop) || !Number.isFinite(atrFrac)) return null;
  const pNeither = Math.max(0, 1 - pTarget - pStop);
  const reward = PRIMARY_BARRIER_UP * atrFrac;
  const risk = PRIMARY_BARRIER_DOWN * atrFrac;
  const cost = Number.isFinite(costFrac) ? costFrac : 0.0010;
  return pTarget * reward - pStop * risk + pNeither * (Number.isFinite(timeoutNet) ? timeoutNet : 0) - cost;
}

// PURE evaluation core — synthetic rows in tests, real joined rows in production. Weighted
// (1/sampleProb) throughout; unweighted metrics reported alongside so sampling is visible.
function evaluateDatasetSurvival(rows, opts = {}) {
  const clean = (rows || []).filter(r => r && r.features && r.date
    && (r.labelTarget === 0 || r.labelTarget === 1) && (r.labelStop === 0 || r.labelStop === 1));
  const dates = uniqueSortedDates(clean);
  const folds = purgedWalkForward(dates, opts.wf || {});
  const features = opts.features || DATASET_FEATURES;

  const base = (status, extra = {}) => ({
    status, rows: clean.length, distinctDates: dates.length, folds: folds.length,
    features, datasetVersion: DATASET_VERSION, ...extra,
    promotion: checkPromotion({ episodes: clean.length, ...(extra.promotionStats || {}) }),
  });
  if (!clean.length || !folds.length) {
    return base('insufficient-data', { need: 'more graded full-universe dataset days before a fold can be trained (dataset accrues prospectively — see DAYTRADE-PREDICTIVE.md)' });
  }

  const oof = [];
  let fitFolds = 0;
  for (const fold of folds) {
    const train = clean.filter(r => fold.trainDates.has(r.date));
    const test = clean.filter(r => fold.testDates.has(r.date));
    const mTarget = trainLogistic(train, features, r => r.labelTarget, { ...(opts.model || {}), weighted: true });
    const mStop = trainLogistic(train, features, r => r.labelStop, { ...(opts.model || {}), weighted: true });
    if (!mTarget || !mStop) continue;   // a fold without both classes for both models ⇒ skipped, honestly
    fitFolds++;
    // Timeout net return: weighted mean over TRAINING timeout rows only (no test leakage).
    let tSum = 0, tW = 0;
    for (const r of train) {
      if (r.outcome === 'TIMEOUT' && Number.isFinite(r.netReturn)) { const w = rowWeight(r); tSum += w * r.netReturn; tW += w; }
    }
    const timeoutNet = tW > 0 ? tSum / tW : 0;
    for (const r of test) {
      const pTarget = predictProba(mTarget, r.features);
      const pStop = predictProba(mStop, r.features);
      oof.push({ ...r, pTarget, pStop, utility: expectedUtility({ pTarget, pStop, atrFrac: r.atrFrac, timeoutNet, costFrac: r.costFrac }) });
    }
  }
  if (!oof.length) {
    return base('insufficient-data', { fitFolds, reason: 'no fold had ≥ MIN_PER_CLASS of both outcomes for both stage models' });
  }

  const preds = oof.map(r => r.pTarget), labels = oof.map(r => r.labelTarget);
  const weights = oof.map(rowWeight);
  const k = Math.max(5, Math.floor(oof.length * 0.05));
  const scoredBy = sel => oof.map(r => ({ score: sel(r) ?? -Infinity, label: r.labelTarget, weight: rowWeight(r), id: r.id }));

  const utilityPrec = precisionAtK(scoredBy(r => r.utility), k, { weighted: true });
  const severityPrec = precisionAtK(scoredBy(r => severityScore(r.features)), k, { weighted: true });
  const utilityNet = topKMean(oof, r => r.utility ?? -Infinity, r => r.netReturn, k, rowWeight);
  const severityNet = topKMean(oof, r => severityScore(r.features), r => r.netReturn, k, rowWeight);
  const precisionLift = utilityPrec != null && severityPrec != null ? +(utilityPrec - severityPrec).toFixed(4) : null;
  const netReturnLift = utilityNet != null && severityNet != null ? +(utilityNet - severityNet).toFixed(5) : null;

  const brierW = brierScore(preds, labels, weights);
  const eceW = expectedCalibrationError(preds, labels, 10, weights);

  const comparators = {
    cusumAlone: precisionAtK(scoredBy(r => r.features.cusum), k, { weighted: true }),
    relVolAlone: precisionAtK(scoredBy(r => r.features.relVol), k, { weighted: true }),
    dayPctAlone: precisionAtK(scoredBy(r => r.features.dayPct), k, { weighted: true }),
  };

  const promotionStats = { testEpisodes: oof.length, folds: fitFolds, precisionLift, netReturnLift, ece: eceW, brier: brierW };
  return {
    status: 'evaluated',
    rows: clean.length, distinctDates: dates.length, folds: fitFolds, testRows: oof.length, k,
    features, datasetVersion: DATASET_VERSION,
    tierCounts: {
      deep: clean.filter(r => r.featureTier === 'deep').length,
      broad: clean.filter(r => r.featureTier === 'broad').length,
      atRisk: clean.filter(r => r.atRisk).length,
    },
    metrics: {
      weighted: {
        brier: brierW, ece: eceW, baseRate: baseRate(labels, weights),
        utilityPrecisionAtK: utilityPrec, severityPrecisionAtK: severityPrec, precisionLift,
        utilityTopKNet: utilityNet, severityTopKNet: severityNet, netReturnLift,
        comparators,
        reliability: reliabilityBuckets(preds, labels, 10, weights),
      },
      unweighted: {
        brier: brierScore(preds, labels), ece: expectedCalibrationError(preds, labels),
        baseRate: baseRate(labels),
        utilityPrecisionAtK: precisionAtK(scoredBy(r => r.utility), k),
        severityPrecisionAtK: precisionAtK(scoredBy(r => severityScore(r.features)), k),
      },
    },
    promotion: checkPromotion({ episodes: clean.length, ...promotionStats }),
  };
}

// ── op=datasetsurvival — research/shadow report over the accrued PIT dataset ────
async function runDatasetSurvival(req, res) {
  const { listDatasetDates } = require('./intraday-backlog');
  const dates = await listDatasetDates();
  // Deep tier joins the day's lifecycle grade records (Stage-2 evaluated names) when present.
  const loadDeepRecords = async date => {
    try {
      const { loadGrades } = require('./lifecycle-store');
      const grades = await loadGrades('daytrade', date);
      return Object.values(grades || {}).filter(g => g && g.features && g.decisionAt);
    } catch { return null; }
  };
  const { rows, skipped } = await loadTrainingDays(dates, { loadDeepRecords });
  const evalResult = evaluateDatasetSurvival(rows);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  return res.json({
    ok: true, strategy: 'daytrade', mode: 'research-shadow', modelVersion: 'dataset-utility-v1',
    datasetDates: dates.length, joinSkipped: skipped,
    ...evalResult,
    note: 'RESEARCH/SHADOW ONLY — trains on the FULL-UNIVERSE PIT dataset (selected + rejected + sampled candidates, inverse-probability weighted by 1/sampleProb). The primary target is expected cost-net utility, not directional accuracy. Nothing here touches a live ranking, and no probability is displayed anywhere until out-of-fold calibration passes the pre-registered promotion gate. Until enough graded dataset days accrue this reports insufficient-data and the gate fails closed.',
  });
}

module.exports = {
  PRIMARY_BARRIER, PRIMARY_BARRIER_UP, PRIMARY_BARRIER_DOWN, DEEP_JOIN_TOLERANCE_MS,
  joinDay, loadTrainingDays, severityScore, expectedUtility, evaluateDatasetSurvival, runDatasetSurvival,
};
