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
const { brierScore, expectedCalibrationError, reliabilityBuckets, baseRate, precisionAtK, topKMean, rocAuc, prAuc, topDecileLift } = require('./survival-metrics');
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
      sessionBucket: r.sessionBucket ?? null,   // carried through for population-slice reporting
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

// ── Abstention + population-slice reporting (research, never a live gate) ───────

// Pre-registered abstention threshold: expected utility must be POSITIVE after costs.
// Fixed in code before results are seen so it can't drift toward whatever flatters.
const ABSTENTION_THRESHOLD = 0;

const meanFinite = vals => {
  const v = vals.filter(Number.isFinite);
  return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(5) : null;
};

// REPORTING ONLY — this is a research readout of what the utility ranking WOULD decline,
// not a live trading gate. Nothing downstream consumes it as a decision; wiring abstention
// into a live path would require its own pre-registered promotion evidence first.
function abstentionReport(oofRows) {
  const decided = (oofRows || []).filter(r => Number.isFinite(r.utility));
  const traded = decided.filter(r => r.utility > ABSTENTION_THRESHOLD);
  return {
    threshold: ABSTENTION_THRESHOLD,
    decisions: decided.length,
    undecidable: (oofRows || []).length - decided.length,   // utility null (missing inputs) — visible, not folded in
    abstainRate: decided.length ? +((decided.length - traded.length) / decided.length).toFixed(4) : null,
    tradedCount: traded.length,
    tradedMeanNetReturn: meanFinite(traded.map(r => r.netReturn)),
    allMeanNetReturn: meanFinite(decided.map(r => r.netReturn)),
  };
}

// Liquidity tiers from logDollarVol (log10 of average daily dollar volume — the field that
// actually exists on broad-tier dataset rows). Pre-registered dollar-volume cutoffs.
const LIQUIDITY_TIER_MID_MIN = 5e6;     // below → micro/small
const LIQUIDITY_TIER_LARGE_MIN = 5e7;   // below → mid, above → large
const MIN_SLICE_ROWS = 50;              // a slice thinner than this reports 'insufficient', not numbers

function liquidityTierOf(logDollarVol) {
  if (!Number.isFinite(logDollarVol)) return 'unknown';
  if (logDollarVol < Math.log10(LIQUIDITY_TIER_MID_MIN)) return 'micro-small';
  if (logDollarVol < Math.log10(LIQUIDITY_TIER_LARGE_MIN)) return 'mid';
  return 'large';
}

// Pooled OOF metrics for one slice. k adapts to slice size (same 5% rule as the headline,
// floor 1). NOTE: these are DIAGNOSTIC slices of the ONE pooled model — no per-slice models
// are trained until a slice's data suffices on its own (pre-registered: models split only
// when the slice itself clears the promotion gate's sample minima, never before).
function sliceMetricsOf(sliceRows) {
  const n = sliceRows.length;
  if (n < MIN_SLICE_ROWS) return { n, note: 'insufficient' };
  const preds = sliceRows.map(r => r.pTarget), labels = sliceRows.map(r => r.labelTarget);
  const weights = sliceRows.map(rowWeight);
  const k = Math.max(1, Math.floor(n * 0.05));
  const scored = sliceRows.map(r => ({ score: r.utility ?? -Infinity, label: r.labelTarget, weight: rowWeight(r), id: r.id }));
  return {
    n, k,
    baseRate: baseRate(labels, weights),
    brier: brierScore(preds, labels, weights),
    utilityPrecisionAtK: precisionAtK(scored, k, { weighted: true }),
  };
}

function sliceReport(oofRows) {
  const groupBy = keyOf => {
    const groups = {};
    for (const r of oofRows) {
      const key = keyOf(r) ?? 'unknown';
      groups[key] = [...(groups[key] || []), r];
    }
    return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, rows]) => [key, sliceMetricsOf(rows)]));
  };
  return {
    sessionBucket: groupBy(r => r.sessionBucket),
    liquidity: groupBy(r => liquidityTierOf(r.features ? r.features.logDollarVol : null)),
  };
}

// PURE evaluation core — synthetic rows in tests, real joined rows in production. Weighted
// (1/sampleProb) throughout; unweighted metrics reported alongside so sampling is visible.
function evaluateDatasetSurvival(rows, opts = {}) {
  const clean = (rows || []).filter(r => r && r.features && r.date
    && (r.labelTarget === 0 || r.labelTarget === 1) && (r.labelStop === 0 || r.labelStop === 1));
  const dates = uniqueSortedDates(clean);
  const folds = purgedWalkForward(dates, opts.wf || {});
  const features = opts.features || DATASET_FEATURES;

  // DEFECT FIX (promotion-gate semantics): this module previously passed dataset ROWS
  // (clean.length) as `episodes` into checkPromotion, whose minEpisodes:400 is documented
  // as EPISODES — one ticker contributing many 5-minute decision states inflated the count
  // toward the gate. The truthful count is distinct (date × ticker) pairs; rows are
  // reported separately so both remain visible. The gate itself is unchanged.
  const episodes = new Set(clean.map(r => `${r.date}|${r.ticker}`)).size;

  const base = (status, extra = {}) => ({
    status, rows: clean.length, episodes, distinctDates: dates.length, folds: folds.length,
    features, datasetVersion: DATASET_VERSION, ...extra,
    promotion: checkPromotion({ episodes, ...(extra.promotionStats || {}) }),
  });
  if (!clean.length || !folds.length) {
    return base('insufficient-data', { need: 'more graded full-universe dataset days before a fold can be trained (dataset accrues prospectively — see DAYTRADE-PREDICTIVE.md)' });
  }

  const oof = [];
  const foldReports = [];
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
    const foldOof = [];
    for (const r of test) {
      const pTarget = predictProba(mTarget, r.features);
      const pStop = predictProba(mStop, r.features);
      foldOof.push({ ...r, pTarget, pStop, utility: expectedUtility({ pTarget, pStop, atrFrac: r.atrFrac, timeoutNet, costFrac: r.costFrac }) });
    }
    oof.push(...foldOof);
    // Per-fold metric block (weighted) — so one lucky test window can't hide in the pool.
    const fScored = foldOof.map(r => ({ score: r.pTarget, label: r.labelTarget, weight: rowWeight(r), id: r.id }));
    foldReports.push({
      fold: fitFolds, testRows: foldOof.length,
      brier: brierScore(foldOof.map(r => r.pTarget), foldOof.map(r => r.labelTarget), foldOof.map(rowWeight)),
      rocAuc: rocAuc(fScored, { weighted: true }),
      prAuc: prAuc(fScored, { weighted: true }),
      topDecileLift: topDecileLift(fScored, { weighted: true }),
    });
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

  // Pooled ranking-quality metrics on the model's pTarget (weighted = full-universe estimate).
  const pooledScored = oof.map(r => ({ score: r.pTarget, label: r.labelTarget, weight: rowWeight(r), id: r.id }));
  const pooledScoredUnw = oof.map(r => ({ score: r.pTarget, label: r.labelTarget, id: r.id }));

  const promotionStats = { testEpisodes: oof.length, folds: fitFolds, precisionLift, netReturnLift, ece: eceW, brier: brierW };
  return {
    status: 'evaluated',
    rows: clean.length, episodes, distinctDates: dates.length, folds: fitFolds, testRows: oof.length, k,
    features, datasetVersion: DATASET_VERSION,
    tierCounts: {
      deep: clean.filter(r => r.featureTier === 'deep').length,
      broad: clean.filter(r => r.featureTier === 'broad').length,
      atRisk: clean.filter(r => r.atRisk).length,
    },
    metrics: {
      weighted: {
        brier: brierW, ece: eceW, baseRate: baseRate(labels, weights),
        rocAuc: rocAuc(pooledScored, { weighted: true }),
        prAuc: prAuc(pooledScored, { weighted: true }),
        topDecileLift: topDecileLift(pooledScored, { weighted: true }),
        utilityPrecisionAtK: utilityPrec, severityPrecisionAtK: severityPrec, precisionLift,
        utilityTopKNet: utilityNet, severityTopKNet: severityNet, netReturnLift,
        comparators,
        reliability: reliabilityBuckets(preds, labels, 10, weights),
      },
      unweighted: {
        brier: brierScore(preds, labels), ece: expectedCalibrationError(preds, labels),
        baseRate: baseRate(labels),
        rocAuc: rocAuc(pooledScoredUnw),
        prAuc: prAuc(pooledScoredUnw),
        topDecileLift: topDecileLift(pooledScoredUnw),
        utilityPrecisionAtK: precisionAtK(scoredBy(r => r.utility), k),
        severityPrecisionAtK: precisionAtK(scoredBy(r => severityScore(r.features)), k),
      },
    },
    foldReport: foldReports,
    abstention: abstentionReport(oof),
    slices: sliceReport(oof),
    promotion: checkPromotion({ episodes, ...promotionStats }),
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
  ABSTENTION_THRESHOLD, MIN_SLICE_ROWS, LIQUIDITY_TIER_MID_MIN, LIQUIDITY_TIER_LARGE_MIN,
  joinDay, loadTrainingDays, severityScore, expectedUtility, evaluateDatasetSurvival, runDatasetSurvival,
  abstentionReport, liquidityTierOf, sliceReport,
};
