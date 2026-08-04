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
const { LABEL_VERSION, HORIZONS_MIN } = require('./intraday-labels');
const { DATASET_FEATURES, datasetRowFeatures, toModelRow, missingnessOf } = require('./intraday-schema');
const { trainLogistic, predictProba, rowWeight, WEIGHT_CAP } = require('./survival-model');
const { purgedWalkForward, uniqueSortedDates } = require('./walk-forward');
const { brierScore, expectedCalibrationError, reliabilityBuckets, baseRate, precisionAtK, topKMean, rocAuc, prAuc, topDecileLift, logLoss, dedupeByEpisode, clusteredBootstrap } = require('./survival-metrics');
const { checkPromotion } = require('./promotion-gate');

// Pre-registered primary barrier pair for the utility target: +1.0 ATR before −0.5 ATR.
const PRIMARY_BARRIER = 'u1_d0.5';
const PRIMARY_BARRIER_UP = 1.0, PRIMARY_BARRIER_DOWN = 0.5;
// Model A (discovery hazard): "does a material upside move begin within ~30 minutes?" —
// pre-registered as a ≥ +0.75 ATR favorable excursion inside the 30-minute horizon. Recall-
// oriented over the FULL eligible universe; it never requires the alarm threshold already
// exceeded (at-risk and ordinary rows alike carry the label).
const HAZARD_HORIZON = 'h30';
const HAZARD_MFE_ATR = 0.75;
// Purge/embargo derived from the maximum label horizon: intraday labels resolve within the
// session (max horizon 180 min < one session), so ONE date-slot is the correct embargo —
// derived, not a loose constant (a multi-day label would push this up automatically).
const EMBARGO_DAYS = Math.max(1, Math.ceil(Math.max(...HORIZONS_MIN) / 390));
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
    const atrFrac = Number.isFinite(r.atr) && Number.isFinite(r.last) && r.last > 0 ? r.atr / r.last : null;
    // Model-A hazard label: material upside move (≥ HAZARD_MFE_ATR × ATR favorable
    // excursion) within the 30-minute horizon. Null when the horizon window is missing.
    const h30 = g.label.horizons ? g.label.horizons[HAZARD_HORIZON] : null;
    const labelHazard = (h30 && Number.isFinite(h30.mfe) && Number.isFinite(atrFrac) && atrFrac > 0)
      ? (h30.mfe >= HAZARD_MFE_ATR * atrFrac ? 1 : 0) : null;
    // Adverse-scenario cost (2× the modeled round trip) from the label's cost model; the
    // legacy fallback doubles the base.
    const costFrac = Number.isFinite(g.label.costBps) ? g.label.costBps / 10000 : null;
    const costModel = g.label.costModel || null;
    const costFracAdverse = costModel && costModel.scenarios && Number.isFinite(costModel.scenarios.adverse)
      ? costModel.scenarios.adverse / 10000 : (Number.isFinite(costFrac) ? costFrac * 2 : null);
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
      labelHazard,
      netReturn: b && Number.isFinite(b.netReturn) ? b.netReturn : null,
      timeToBarrierMin: b ? b.timeToBarrierMin : null,
      horizons: g.label.horizons || null,
      // POLICY-LEVEL label (the trade the live system actually holds out — executable
      // entry, 1.5×ATR stop, 2R target, 120-min time stop, unfillable ⇒ skipped).
      policy: g.label.policyLabel || null,
      remainingMfe: g.label.remainingMfe ?? null,
      remainingFractionOfDayMove: g.label.remainingFractionOfDayMove ?? null,
      atrFrac,
      costFrac,
      costFracAdverse,
      provenance: r.provenance || null,
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

// Expected cost-net utility from the two-stage outputs (Model C). Reward/risk are the
// pre-registered barrier distances in return units for THIS row (ATR fraction of price);
// the timeout return is the TRAINING-fold weighted mean net return of timeout rows (never
// the test fold's). The two independently-fitted heads are PROJECTED ONTO THE SIMPLEX
// first (pTarget + pStop ≤ 1) — without that, two unconstrained logits could imply a
// negative timeout probability that Math.max used to hide.
function simplexProject(pTarget, pStop) {
  if (!Number.isFinite(pTarget) || !Number.isFinite(pStop)) return { pTarget, pStop };
  const sum = pTarget + pStop;
  if (sum <= 1) return { pTarget, pStop };
  return { pTarget: pTarget / sum, pStop: pStop / sum };
}

function expectedUtility({ pTarget, pStop, atrFrac, timeoutNet, costFrac }) {
  if (!Number.isFinite(pTarget) || !Number.isFinite(pStop) || !Number.isFinite(atrFrac)) return null;
  const proj = simplexProject(pTarget, pStop);
  const pNeither = Math.max(0, 1 - proj.pTarget - proj.pStop);
  const reward = PRIMARY_BARRIER_UP * atrFrac;
  const risk = PRIMARY_BARRIER_DOWN * atrFrac;
  const cost = Number.isFinite(costFrac) ? costFrac : 0.0010;
  return proj.pTarget * reward - proj.pStop * risk + pNeither * (Number.isFinite(timeoutNet) ? timeoutNet : 0) - cost;
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
    // Top-K net return within the slice — the stability gate's input (a model that only
    // wins in one session bucket or liquidity tier must be visible here).
    utilityTopKNet: topKMean(sliceRows, r => r.utility ?? -Infinity, r => r.netReturn, k, rowWeight),
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

// Chronological inner-calibration split: the LAST ~25% of a fold's training dates (min 3)
// are held out to fit/select the calibrator; the model trains on the earlier dates only.
// Nested: outer test dates stay untouched by both stages.
function splitInnerCalibration(trainDates) {
  const sorted = [...trainDates].sort();
  const calN = Math.max(3, Math.floor(sorted.length * 0.25));
  if (sorted.length < calN + 5) return { innerTrain: new Set(sorted), innerCal: new Set() };
  return {
    innerTrain: new Set(sorted.slice(0, sorted.length - calN)),
    innerCal: new Set(sorted.slice(sorted.length - calN)),
  };
}

// PURE evaluation core — synthetic rows in tests, real joined rows in production. Weighted
// (1/sampleProb) throughout; unweighted metrics reported alongside so sampling is visible.
// opts.context supplies the evaluation-context stats the promotion gate needs beyond the
// fold math itself: { joinLossRatio, trials, shadowDays, shadowEpisodes, provenanceProspective }.
function evaluateDatasetSurvival(rows, opts = {}) {
  const clean = (rows || []).filter(r => r && r.features && r.date
    && (r.labelTarget === 0 || r.labelTarget === 1) && (r.labelStop === 0 || r.labelStop === 1));
  const dates = uniqueSortedDates(clean);
  const folds = purgedWalkForward(dates, { embargoDays: EMBARGO_DAYS, ...(opts.wf || {}) });
  const features = opts.features || DATASET_FEATURES;
  const ctx = opts.context || {};

  // Truthful counts: EPISODES are distinct (date × ticker) — one ticker contributing many
  // 5-minute decision states can inflate neither the train-side nor the TEST-side count.
  const episodes = new Set(clean.map(r => `${r.date}|${r.ticker}`)).size;

  const contextStats = {
    joinLossRatio: ctx.joinLossRatio ?? null,
    trials: ctx.trials ?? null,
    shadowDays: ctx.shadowDays ?? 0,
    shadowEpisodes: ctx.shadowEpisodes ?? 0,
    provenanceProspective: ctx.provenanceProspective ?? (clean.length > 0 && clean.every(r => r.provenance === 'prospective-live')),
  };
  const base = (status, extra = {}) => ({
    status, rows: clean.length, episodes, distinctDates: dates.length, folds: folds.length,
    features, datasetVersion: DATASET_VERSION, embargoDays: EMBARGO_DAYS, ...extra,
    promotion: checkPromotion({ episodes, distinctDates: dates.length, ...contextStats, ...(extra.promotionStats || {}) }),
  });
  if (!clean.length || !folds.length) {
    return base('insufficient-data', { need: 'more graded full-universe dataset days before a fold can be trained (dataset accrues prospectively — see DAYTRADE-PREDICTIVE.md)' });
  }

  const { selectCalibrator, calibrate } = require('./orbit-calibration');
  const oof = [];
  const foldReports = [];
  let fitFolds = 0;
  for (const fold of folds) {
    const trainAll = clean.filter(r => fold.trainDates.has(r.date));
    const test = clean.filter(r => fold.testDates.has(r.date));
    // NESTED CHRONOLOGICAL CALIBRATION: model fits on the inner-train window; the
    // calibrator (none/Platt/beta/isotonic, selected by held-out Brier+log-loss) fits on
    // the inner-calibration window; BOTH are frozen before touching the outer test dates.
    const { innerTrain, innerCal } = splitInnerCalibration(fold.trainDates);
    const train = trainAll.filter(r => innerTrain.has(r.date));
    const calRows = trainAll.filter(r => innerCal.has(r.date));
    const mTarget = trainLogistic(train, features, r => r.labelTarget, { ...(opts.model || {}), weighted: true });
    const mStop = trainLogistic(train, features, r => r.labelStop, { ...(opts.model || {}), weighted: true });
    if (!mTarget || !mStop) continue;   // a fold without both classes for both models ⇒ skipped, honestly
    fitFolds++;
    // Model A — discovery hazard head (recall-oriented; null-label rows excluded).
    const hazardRows = train.filter(r => r.labelHazard === 0 || r.labelHazard === 1);
    const mHazard = hazardRows.length ? trainLogistic(hazardRows, features, r => r.labelHazard, { ...(opts.model || {}), weighted: true }) : null;
    // Calibrators from the inner-calibration window (raw model p vs observed outcome).
    const calPairs = sel => calRows.map(r => ({ p: predictProba(sel === 'target' ? mTarget : mStop, r.features), won: sel === 'target' ? r.labelTarget : r.labelStop }));
    const calTargetSplit = calPairs('target');
    const calStopSplit = calPairs('stop');
    const mid = arr => Math.floor(arr.length / 2);
    const calTarget = calRows.length ? selectCalibrator(calTargetSplit.slice(0, mid(calTargetSplit)), calTargetSplit.slice(mid(calTargetSplit))) : { calibrated: false };
    const calStop = calRows.length ? selectCalibrator(calStopSplit.slice(0, mid(calStopSplit)), calStopSplit.slice(mid(calStopSplit))) : { calibrated: false };
    // Timeout net return: weighted mean over TRAINING timeout rows only (no test leakage).
    let tSum = 0, tW = 0;
    for (const r of train) {
      if (r.outcome === 'TIMEOUT' && Number.isFinite(r.netReturn)) { const w = rowWeight(r); tSum += w * r.netReturn; tW += w; }
    }
    const timeoutNet = tW > 0 ? tSum / tW : 0;
    const foldOof = [];
    for (const r of test) {
      const pTargetRaw = predictProba(mTarget, r.features);
      const pStopRaw = predictProba(mStop, r.features);
      const pTarget = calTarget.calibrated ? (calibrate(calTarget, pTargetRaw) ?? pTargetRaw) : pTargetRaw;
      const pStop = calStop.calibrated ? (calibrate(calStop, pStopRaw) ?? pStopRaw) : pStopRaw;
      const pHazard = mHazard ? predictProba(mHazard, r.features) : null;
      foldOof.push({
        ...r, pTargetRaw, pStopRaw, pTarget, pStop, pHazard,
        calibrated: calTarget.calibrated === true,
        utility: expectedUtility({ pTarget, pStop, atrFrac: r.atrFrac, timeoutNet, costFrac: r.costFrac }),
        utilityAdverse: expectedUtility({ pTarget, pStop, atrFrac: r.atrFrac, timeoutNet, costFrac: r.costFracAdverse ?? (Number.isFinite(r.costFrac) ? r.costFrac * 2 : null) }),
      });
    }
    oof.push(...foldOof);
    // Per-fold metric block (weighted) — so one lucky test window can't hide in the pool.
    const fScored = foldOof.map(r => ({ score: r.pTarget, label: r.labelTarget, weight: rowWeight(r), id: r.id }));
    const fK = Math.max(3, Math.floor(foldOof.length * 0.05));
    const fUtilNet = topKMean(foldOof, r => r.utility ?? -Infinity, r => r.netReturn, fK, rowWeight);
    const fSevNet = topKMean(foldOof, r => severityScore(r.features), r => r.netReturn, fK, rowWeight);
    foldReports.push({
      fold: fitFolds, testRows: foldOof.length,
      calibration: { targetMethod: calTarget.calibrated ? calTarget.method : 'none-insufficient', stopMethod: calStop.calibrated ? calStop.method : 'none-insufficient' },
      brier: brierScore(foldOof.map(r => r.pTarget), foldOof.map(r => r.labelTarget), foldOof.map(rowWeight)),
      rocAuc: rocAuc(fScored, { weighted: true }),
      prAuc: prAuc(fScored, { weighted: true }),
      topDecileLift: topDecileLift(fScored, { weighted: true }),
      netReturnLift: fUtilNet != null && fSevNet != null ? +(fUtilNet - fSevNet).toFixed(5) : null,
      beatsBaseline: fUtilNet != null && fSevNet != null ? fUtilNet > fSevNet : null,
    });
  }
  if (!oof.length) {
    return base('insufficient-data', { fitFolds, reason: 'no fold had ≥ MIN_PER_CLASS of both outcomes for both stage models' });
  }

  const preds = oof.map(r => r.pTarget), labels = oof.map(r => r.labelTarget);
  const weights = oof.map(rowWeight);
  const k = Math.max(5, Math.floor(oof.length * 0.05));
  const scoredBy = sel => oof.map(r => ({ score: sel(r) ?? -Infinity, label: r.labelTarget, weight: rowWeight(r), id: r.id }));

  // ROW-LEVEL diagnostics (hazard training uses every 5-min row — that is legitimate).
  const utilityPrec = precisionAtK(scoredBy(r => r.utility), k, { weighted: true });
  const severityPrec = precisionAtK(scoredBy(r => severityScore(r.features)), k, { weighted: true });
  const precisionLift = utilityPrec != null && severityPrec != null ? +(utilityPrec - severityPrec).toFixed(4) : null;
  const brierW = brierScore(preds, labels, weights);
  const eceW = expectedCalibrationError(preds, labels, 10, weights);
  const logLossW = logLoss(preds, labels, weights);
  const { calibrationSlope } = require('./orbit-calibration');
  const calSlope = calibrationSlope(preds, labels);

  // POLICY-LEVEL evaluation (what promotion depends on): ONE episode per date×ticker (the
  // best-utility decision state), top-K with per-episode dedup, graded on the POLICY label
  // (executable entry, real stop/target/time-stop, unfillable ⇒ excluded) under base AND
  // adverse costs. Rows can never occupy multiple top-K slots for the same episode.
  const episodeKey = r => `${r.date}|${r.ticker}`;
  const epRows = dedupeByEpisode(oof, r => r.utility, episodeKey).filter(r => r.policy && r.policy.filled === true);
  const testEpisodes = new Set(oof.map(episodeKey)).size;
  const kEp = Math.max(3, Math.floor(epRows.length * 0.05));
  const policyNetOf = r => (r.policy && Number.isFinite(r.policy.netReturn) ? r.policy.netReturn : null);
  const policyNetAdvOf = r => (r.policy && Number.isFinite(r.policy.netReturnAdverse) ? r.policy.netReturnAdverse : null);
  const utilityTopKPolicyNet = epRows.length ? topKMean(epRows, r => r.utility ?? -Infinity, policyNetOf, kEp, rowWeight) : null;
  const severityTopKPolicyNet = epRows.length ? topKMean(epRows, r => severityScore(r.features), policyNetOf, kEp, rowWeight) : null;
  const adverseTopKPolicyNet = epRows.length ? topKMean(epRows, r => r.utility ?? -Infinity, policyNetAdvOf, kEp, rowWeight) : null;
  const policyNetLift = utilityTopKPolicyNet != null && severityTopKPolicyNet != null
    ? +(utilityTopKPolicyNet - severityTopKPolicyNet).toFixed(5) : null;
  // Ticker concentration of the top-K episode slots.
  const topEp = [...epRows].sort((a, b) => ((b.utility ?? -Infinity) - (a.utility ?? -Infinity))).slice(0, kEp);
  const tickerCounts = {};
  for (const r of topEp) tickerCounts[r.ticker] = (tickerCounts[r.ticker] || 0) + 1;
  const tickerConcentration = topEp.length ? +((Math.max(0, ...Object.values(tickerCounts)) / topEp.length).toFixed(3)) : null;

  // LEGACY row-level net lift retained as a diagnostic (was the old headline).
  const utilityNet = topKMean(oof, r => r.utility ?? -Infinity, r => r.netReturn, k, rowWeight);
  const severityNet = topKMean(oof, r => severityScore(r.features), r => r.netReturn, k, rowWeight);
  const rowNetReturnLift = utilityNet != null && severityNet != null ? +(utilityNet - severityNet).toFixed(5) : null;

  const comparators = {
    cusumAlone: precisionAtK(scoredBy(r => r.features.cusum), k, { weighted: true }),
    relVolAlone: precisionAtK(scoredBy(r => r.features.relVol), k, { weighted: true }),
    dayPctAlone: precisionAtK(scoredBy(r => r.features.dayPct), k, { weighted: true }),
  };
  const beatsAllComparators = utilityPrec != null
    && Object.values(comparators).every(c => c != null && utilityPrec > c);

  // Slice stability: every SUFFICIENT session/liquidity slice must have a non-negative
  // top-K net (a model that only wins at the open is not a promotable model).
  const slices = sliceReport(oof);
  const sliceVals = [...Object.values(slices.sessionBucket), ...Object.values(slices.liquidity)]
    .filter(s => s && s.note !== 'insufficient');
  const sliceStable = sliceVals.length > 0 && sliceVals.every(s => s.utilityTopKNet == null || s.utilityTopKNet >= 0);

  // SESSION-CLUSTERED uncertainty on the policy-net lift (block bootstrap over dates) —
  // wider than a naive row-iid interval whenever rows co-move within a session.
  const liftStat = sample => {
    const ep = dedupeByEpisode(sample, r => r.utility, episodeKey).filter(r => r.policy && r.policy.filled === true);
    if (ep.length < 10) return NaN;
    const kk = Math.max(3, Math.floor(ep.length * 0.05));
    const u = topKMean(ep, r => r.utility ?? -Infinity, policyNetOf, kk, rowWeight);
    const s = topKMean(ep, r => severityScore(r.features), policyNetOf, kk, rowWeight);
    return u != null && s != null ? u - s : NaN;
  };
  const policyNetLiftCI = clusteredBootstrap(oof, liftStat, r => r.date, { B: 200, seed: 42 });

  // Hazard head (Model A) — recall-oriented diagnostics over ALL rows with a hazard label.
  const hazardRows = oof.filter(r => (r.labelHazard === 0 || r.labelHazard === 1) && Number.isFinite(r.pHazard));
  const hazardScored = hazardRows.map(r => ({ score: r.pHazard, label: r.labelHazard, weight: rowWeight(r), id: r.id }));
  const hazardTopFifth = hazardRows.length >= 25 ? (() => {
    const kh = Math.max(5, Math.floor(hazardRows.length * 0.2));
    const top = [...hazardScored].sort((a, b) => b.score - a.score).slice(0, kh);
    const totalPos = hazardScored.reduce((s, r) => s + (r.label === 1 ? r.weight : 0), 0);
    const capturedPos = top.reduce((s, r) => s + (r.label === 1 ? r.weight : 0), 0);
    return totalPos > 0 ? +(capturedPos / totalPos).toFixed(4) : null;
  })() : null;

  // Pooled ranking-quality metrics on the model's pTarget (weighted = full-universe estimate).
  const pooledScored = oof.map(r => ({ score: r.pTarget, label: r.labelTarget, weight: rowWeight(r), id: r.id }));
  const pooledScoredUnw = oof.map(r => ({ score: r.pTarget, label: r.labelTarget, id: r.id }));

  const foldsPositive = foldReports.filter(f => f.beatsBaseline === true).length;
  const promotionStats = {
    testEpisodes, folds: fitFolds, foldsPositive,
    precisionLift,
    netReturnLift: policyNetLift,               // POLICY-level lift is what the gate consumes
    adverseTopKNet: adverseTopKPolicyNet,
    tickerConcentration,
    beatsAllComparators, sliceStable,
    ece: eceW, brier: brierW,
    ...contextStats,
  };
  return {
    status: 'evaluated',
    rows: clean.length, episodes, distinctDates: dates.length, folds: fitFolds, testRows: oof.length,
    testEpisodes, policyEpisodes: epRows.length, k, kEpisodes: kEp,
    features, datasetVersion: DATASET_VERSION, embargoDays: EMBARGO_DAYS,
    tierCounts: {
      deep: clean.filter(r => r.featureTier === 'deep').length,
      broad: clean.filter(r => r.featureTier === 'broad').length,
      atRisk: clean.filter(r => r.atRisk).length,
    },
    metrics: {
      weighted: {
        brier: brierW, ece: eceW, logLoss: logLossW,
        calibrationSlope: calSlope.slope, calibrationIntercept: calSlope.intercept,
        baseRate: baseRate(labels, weights),
        rocAuc: rocAuc(pooledScored, { weighted: true }),
        prAuc: prAuc(pooledScored, { weighted: true }),
        topDecileLift: topDecileLift(pooledScored, { weighted: true }),
        utilityPrecisionAtK: utilityPrec, severityPrecisionAtK: severityPrec, precisionLift,
        utilityTopKNet: utilityNet, severityTopKNet: severityNet, rowNetReturnLift,
        comparators,
        reliability: reliabilityBuckets(preds, labels, 10, weights),
      },
      // POLICY-LEVEL results — deduped executable episodes, real policy trades. THIS block
      // (not the row-level one) is what promotion depends on.
      policy: {
        testEpisodes, filledEpisodes: epRows.length,
        utilityTopKPolicyNet, severityTopKPolicyNet, netReturnLift: policyNetLift,
        adverseTopKPolicyNet,
        netReturnLiftCI: policyNetLiftCI,
        tickerConcentration,
      },
      hazard: {
        rows: hazardRows.length,
        rocAuc: rocAuc(hazardScored, { weighted: true }),
        prAuc: prAuc(hazardScored, { weighted: true }),
        captureRateTop20pct: hazardTopFifth,
        note: 'Model A (discovery hazard): recall-oriented — share of all material 30-min upside moves captured by the top 20% of hazard scores.',
      },
      unweighted: {
        brier: brierScore(preds, labels), ece: expectedCalibrationError(preds, labels),
        logLoss: logLoss(preds, labels),
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
    slices,
    promotion: checkPromotion({ episodes, distinctDates: dates.length, ...promotionStats }),
  };
}

// ── Trials ledger — every attempted model/feature/policy variant is LOGGED so the
// promotion gate can deflate for the search (best-of-many can never pass the single-trial
// bar). Config-hashed: re-running the identical configuration does not add a trial.
const TRIALS_KEY = 'lifecycle/daytrade/models/trials.json';

function trialConfigHash(config) {
  const { fnv1a } = require('./intraday-dataset');
  return fnv1a(JSON.stringify(config)).toString(16);
}

async function recordTrial(config, summary) {
  const { readJSON, writeJSON, hasStore } = require('./store');
  const hash = trialConfigHash(config);
  if (!hasStore()) return { trials: 1, hash, persisted: false };
  try {
    const doc = await readJSON(TRIALS_KEY, { trials: [] }).catch(() => ({ trials: [] }));
    const trials = Array.isArray(doc.trials) ? doc.trials : [];
    const existing = trials.find(t => t.hash === hash);
    const next = existing
      ? trials.map(t => (t.hash === hash ? { ...t, lastRunAt: new Date().toISOString(), runs: (t.runs || 1) + 1, summary } : t))
      : [...trials, { hash, config, firstRunAt: new Date().toISOString(), lastRunAt: new Date().toISOString(), runs: 1, summary }].slice(-500);
    await writeJSON(TRIALS_KEY, { trials: next, updatedAt: new Date().toISOString() }, 0);
    return { trials: next.length, hash, persisted: true };
  } catch {
    return { trials: null, hash, persisted: false };
  }
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
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  const joinLossRatio = rows.length + skippedTotal > 0 ? +(skippedTotal / (rows.length + skippedTotal)).toFixed(4) : null;

  // Log this evaluation as a TRIAL (config-hashed) and read the prospective shadow stats —
  // both feed the promotion gate's multiple-testing and shadow-evidence checks.
  const config = {
    modelVersion: 'dataset-utility-v2', features: DATASET_FEATURES,
    primaryBarrier: PRIMARY_BARRIER, labelVersion: LABEL_VERSION, datasetVersion: DATASET_VERSION,
    wf: { embargoDays: EMBARGO_DAYS },
  };
  const trial = await recordTrial(config, { dates: dates.length, rows: rows.length });
  let shadow = { shadowDays: 0, shadowEpisodes: 0 };
  try { shadow = await require('./model-registry').shadowStats(); } catch { /* absent ⇒ gate fails closed */ }

  const evalResult = evaluateDatasetSurvival(rows, {
    context: {
      joinLossRatio, trials: trial.trials,
      shadowDays: shadow.shadowDays, shadowEpisodes: shadow.shadowEpisodes,
    },
  });
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  return res.json({
    ok: true, strategy: 'daytrade', mode: 'research-shadow', modelVersion: 'dataset-utility-v2',
    policyVersion: require('./daytrade-decision-policy').POLICY_VERSION,
    datasetDates: dates.length, joinSkipped: skipped, joinLossRatio, trialsLogged: trial.trials,
    ...evalResult,
    note: 'RESEARCH/SHADOW ONLY — trains on the FULL-UNIVERSE PIT dataset (selected + rejected + sampled candidates, inverse-probability weighted by 1/sampleProb). Promotion depends on the POLICY-level block (deduped executable episodes, real policy trades, adverse-cost scenario), never on row-level diagnostics. Nothing here touches a live ranking, and no probability is displayed anywhere until nested out-of-fold calibration passes the pre-registered promotion gate. Until enough graded dataset days accrue this reports insufficient-data and the gate fails closed.',
  });
}

module.exports = {
  PRIMARY_BARRIER, PRIMARY_BARRIER_UP, PRIMARY_BARRIER_DOWN, DEEP_JOIN_TOLERANCE_MS,
  ABSTENTION_THRESHOLD, MIN_SLICE_ROWS, LIQUIDITY_TIER_MID_MIN, LIQUIDITY_TIER_LARGE_MIN,
  HAZARD_HORIZON, HAZARD_MFE_ATR, EMBARGO_DAYS, TRIALS_KEY,
  joinDay, loadTrainingDays, severityScore, simplexProject, expectedUtility, evaluateDatasetSurvival, runDatasetSurvival,
  abstentionReport, liquidityTierOf, sliceReport, splitInnerCalibration, recordTrial, trialConfigHash,
};
