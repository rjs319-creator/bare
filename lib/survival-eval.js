'use strict';
// MOMENTUM SURVIVAL — walk-forward research harness. Fully runnable TODAY, but it fabricates
// nothing: with too few accrued/graded episodes it reports status 'insufficient-data' and the
// promotion gate fails closed. Only once real captured episodes accumulate does it train the
// interpretable baseline out-of-fold, measure calibration + precision/return lift vs the
// deterministic baseline, and check the pre-registered promotion gate.
//
// The model is NOT wired into any live ranking. Promotion (if it ever passes) is a deliberate,
// separate step — this harness only produces the evidence for that decision.
const { trainLogistic, predictProba } = require('./survival-model');
const { purgedWalkForward, uniqueSortedDates } = require('./walk-forward');
const { brierScore, expectedCalibrationError, reliabilityBuckets, precisionAtK, topKMean } = require('./survival-metrics');
const { checkPromotion } = require('./promotion-gate');

const STRATEGY = 'daytrade';
// Entry-time features the survival model may use (all captured in the snapshot, all point-in-
// time). Kept small + interpretable on purpose.
const FEATURES = ['mom15', 'residual15', 'timeOfDayRelVol', 'extensionAtr', 'remainingRR'];
const LABEL = r => (r.label === 1 ? 1 : 0);

// Turn stored grade records into model rows. Only ENTRY (first-entry ACTIONABLE_NOW) episodes
// with a barrier outcome and a feature vector are usable. Label = reached the upside barrier.
function gradesToRows(grades) {
  const list = Array.isArray(grades) ? grades : Object.values(grades || {});   // array (all days) or map (one day)
  return list
    .filter(g => g && g.type === 'entry' && g.outcome && g.features)
    .map(g => ({
      date: String(g.decisionAt || '').slice(0, 10),
      ticker: g.ticker,
      features: g.features,
      label: g.outcome.barrier === 'SUCCESS' ? 1 : 0,
      baselineScore: g.ranking ? (g.ranking.score ?? 0) : 0,
      netReturn: g.outcome.netReturn ?? 0,
    }))
    .filter(r => r.date && r.features);
}

// PURE evaluation core — synthetic rows in tests, real grades in production. Never throws.
function evaluateSurvival(rows, opts = {}) {
  const clean = (rows || []).filter(r => r && r.features && (r.label === 0 || r.label === 1) && r.date);
  const dates = uniqueSortedDates(clean);
  const folds = purgedWalkForward(dates, opts.wf || {});

  const baseResult = (status, extra = {}) => ({
    status, episodes: clean.length, distinctDates: dates.length, folds: folds.length,
    features: FEATURES, ...extra,
    promotion: checkPromotion({ episodes: clean.length, ...(extra.promotionStats || {}) }),
  });

  if (!clean.length || !folds.length) {
    return baseResult('insufficient-data', { need: 'more graded first-entry episodes across more sessions before a fold can be trained' });
  }

  // Out-of-fold predictions from the interpretable baseline, trained per fold on its past only.
  const oof = [];
  let fitFolds = 0;
  for (const fold of folds) {
    const train = clean.filter(r => fold.trainDates.has(r.date));
    const test = clean.filter(r => fold.testDates.has(r.date));
    const model = trainLogistic(train, FEATURES, LABEL, opts.model || {});
    if (!model) continue;           // a fold without both classes in size ⇒ skipped, honestly
    fitFolds++;
    for (const r of test) oof.push({ ...r, pred: predictProba(model, r.features) });
  }

  if (!oof.length) {
    return baseResult('insufficient-data', { fitFolds, reason: 'no fold had ≥ MIN_PER_CLASS of both outcomes to fit' });
  }

  const preds = oof.map(r => r.pred), labels = oof.map(r => r.label);
  const brier = brierScore(preds, labels);
  const ece = expectedCalibrationError(preds, labels);
  const k = Math.max(5, Math.floor(oof.length * 0.1));
  const modelPrec = precisionAtK(oof.map(r => ({ score: r.pred, label: r.label })), k);
  const basePrec = precisionAtK(oof.map(r => ({ score: r.baselineScore, label: r.label })), k);
  const modelNet = topKMean(oof, r => r.pred, r => r.netReturn, k);
  const baseNet = topKMean(oof, r => r.baselineScore, r => r.netReturn, k);
  const precisionLift = modelPrec != null && basePrec != null ? +(modelPrec - basePrec).toFixed(4) : null;
  const netReturnLift = modelNet != null && baseNet != null ? +(modelNet - baseNet).toFixed(5) : null;

  const promotionStats = { testEpisodes: oof.length, folds: fitFolds, precisionLift, netReturnLift, ece, brier };
  return {
    status: 'evaluated',
    episodes: clean.length, distinctDates: dates.length, folds: fitFolds, testEpisodes: oof.length,
    features: FEATURES, k,
    metrics: {
      brier, ece, baseRate: +(labels.reduce((s, v) => s + v, 0) / labels.length).toFixed(4),
      modelPrecisionAtK: modelPrec, baselinePrecisionAtK: basePrec, precisionLift,
      modelTopKNetReturn: modelNet, baselineTopKNetReturn: baseNet, netReturnLift,
      reliability: reliabilityBuckets(preds, labels),
    },
    promotion: checkPromotion({ episodes: clean.length, ...promotionStats }),
  };
}

// op=survival — run the harness over all accrued grades and report status + promotion decision.
async function runSurvival(req, res) {
  const { loadAllGrades } = require('./lifecycle-store');
  const grades = await loadAllGrades(STRATEGY);
  const rows = gradesToRows(grades);
  const evalResult = evaluateSurvival(rows);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  return res.json({
    ok: true, strategy: STRATEGY, mode: 'research-shadow', modelVersion: 'survival-lr-v1',
    ...evalResult,
    note: 'RESEARCH/SHADOW ONLY — not wired into any live ranking. This harness reports honest walk-forward evidence; the interpretable baseline is promoted over the deterministic system ONLY if every pre-registered gate passes (see `promotion.checks`). Until enough graded first-entry episodes accrue it reports insufficient-data and the gate fails closed. A tree model is not attempted until this baseline is beaten out-of-sample.',
  });
}

module.exports = { STRATEGY, FEATURES, gradesToRows, evaluateSurvival, runSurvival };
