'use strict';
// MODEL SCOREBOARD (forecast-scoreboard-v1)
//
// Every model's record, keyed by (model, horizon, fold, evaluationType), with the identity that
// makes a row reproducible: universe, feature version, target version, checkpoint revision,
// config hash and data cutoff.
//
// THE DISTINCTION THIS FILE EXISTS TO ENFORCE:
//   in-sample        diagnostics only — never eligible for anything
//   cross-fitted     the frame the meta-ranker and calibrators may learn from
//   validation       inner-fold validation
//   walk-forward-oos true out-of-sample; the ONLY tier that may inform production eligibility,
//                    model selection, score calibration or dynamic weighting
//   final-holdout    scored once, reported separately, never used to choose anything
//
// `productionEligibleInputs()` returns only matured walk-forward-OOS rows, and it is the single
// door through which results reach lib/forecast/ensemble.js.

const METRICS = require('./metrics');
const Q = require('./quantiles');

const SCOREBOARD_VERSION = 'forecast-scoreboard-v1';

const EVALUATION_TYPES = Object.freeze(['in-sample', 'cross-fitted', 'validation', 'walk-forward-oos', 'final-holdout']);
const OOS_TYPES = new Set(['walk-forward-oos']);

/**
 * Build one scoreboard row from a model's predictions on a block.
 *   predictions: [{ decisionDate, labelEnd, score, actual, quantiles?, probabilities?, classes?,
 *                   availability?, latencyMs? }]
 */
function buildRow({ model, role, horizon, fold, evaluationType, predictions, cfg, identity = {}, backtest = null, universeSize = null, period = null, withBreakdowns = false }) {
  if (!EVALUATION_TYPES.includes(evaluationType)) throw new Error(`unknown evaluationType "${evaluationType}"`);

  const usable = predictions.filter((p) => p && Number.isFinite(p.score) && Number.isFinite(p.actual));
  const failed = predictions.filter((p) => p && p.availability && !['ok', 'degraded'].includes(p.availability));
  const ic = METRICS.informationCoefficient(usable);
  const dir = METRICS.directionalAccuracy(usable);
  const spread = METRICS.quantileSpread(usable, cfg.portfolio.quantiles);

  // Probability metrics per threshold, plus the drawdown head.
  const probability = {};
  const thresholdKeys = [...cfg.returnThresholds.map(String), 'drawdown'];
  for (const key of thresholdKeys) {
    const pairs = predictions
      .filter((p) => p && p.probabilities && Number.isFinite(p.probabilities[key]) && p.classes && (p.classes[key] === 0 || p.classes[key] === 1))
      .map((p) => ({ p: p.probabilities[key], y: p.classes[key] }));
    probability[key] = { ...METRICS.probabilityMetrics(pairs, { bins: cfg.calibration.bins }), ...METRICS.tailPrecisionRecall(pairs, 0.5) };
  }

  const quantilePairs = predictions.filter((p) => p && p.quantiles && Number.isFinite(p.actual)).map((p) => ({ actual: p.actual, quantiles: p.quantiles }));
  const cov = quantilePairs.length ? Q.coverage(quantilePairs, cfg.quantiles) : null;

  const latencies = predictions.map((p) => p && p.latencyMs).filter(Number.isFinite);
  const dates = [...new Set(usable.map((p) => p.decisionDate))].sort();
  let maxLabelEnd = null;
  for (const p of predictions) if (p && p.labelEnd && (maxLabelEnd === null || p.labelEnd > maxLabelEnd)) maxLabelEnd = p.labelEnd;

  return Object.freeze({
    schema: 'ForecastScoreboardRow', version: SCOREBOARD_VERSION,
    model, role, horizon, fold, evaluationType,
    period: period || (dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null),
    maxLabelEnd,
    universe: universeSize,
    identity: Object.freeze({
      featureVersion: cfg.features.version,
      targetVersion: cfg.target.version,
      targetDefinition: cfg.target.definition,
      configHash: cfg.configHash,
      modelId: identity.modelId || null,
      revision: identity.revision || null,
      packageVersion: identity.packageVersion || null,
      dataCutoff: identity.dataCutoff || null,
      trainCutoff: identity.trainCutoff || null,
    }),
    n: usable.length,
    dates: dates.length,
    coverage: predictions.length ? usable.length / predictions.length : null,
    failureRate: predictions.length ? failed.length / predictions.length : null,
    latencyMsMean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    ic: Object.freeze({ meanIC: ic.meanIC, meanRankIC: ic.meanRankIC, icIR: ic.icIR, rankICIR: ic.rankICIR, positiveRankICRate: ic.positiveRankICRate, dates: ic.dates }),
    // The per-date IC series is kept (one small entry per date) so folds can be POOLED and given
    // a dependence-aware interval later — a mean of fold means would throw that information away.
    icPerDate: Object.freeze(ic.perDate.map((d) => ({ date: d.date, n: d.n, rankIC: d.rankIC }))),
    breakdowns: withBreakdowns ? Object.freeze({
      sector: METRICS.breakdown(usable, (r) => r.sector || null),
      liquidity: METRICS.breakdown(usable, (r) => (r.adv == null ? null : METRICS.liquidityBucket(r.adv))),
      year: METRICS.breakdown(usable, (r) => (typeof r.decisionDate === 'string' ? r.decisionDate.slice(0, 4) : null)),
    }) : null,
    directionalAccuracy: dir.accuracy,
    quantileSpread: Object.freeze({ meanSpread: spread.meanSpread, meanTop: spread.meanTop, meanBottom: spread.meanBottom, dates: spread.dates }),
    probability: Object.freeze(probability),
    quantileCoverage: cov,
    backtest: backtest ? Object.freeze({
      grossSharpe: backtest.pooled.gross.sharpe, netSharpe: backtest.pooled.net.sharpe,
      grossAnnReturn: backtest.pooled.gross.annReturn, netAnnReturn: backtest.pooled.net.annReturn,
      netMaxDrawdown: backtest.pooled.net.maxDrawdown,
      // THE CHANNEL THAT ACTUALLY SEPARATES THE ARMS. A long-only top-k book's raw P&L is
      // dominated by market beta — in a rising sample the random and shuffled-label controls post
      // positive net Sharpe too, so the raw column cannot tell a signal from a beta. This system
      // predicts a market- and sector-NEUTRALIZED residual, and `residualNet` is that same book's
      // after-cost P&L on the residual, which is what the prediction is actually about.
      residualNetSharpe: backtest.pooled.residualNet.sharpe,
      residualNetAnnReturn: backtest.pooled.residualNet.annReturn,
      residualNetMaxDrawdown: backtest.pooled.residualNet.maxDrawdown,
      trancheResidualNetSharpe: backtest.trancheSummary.residualNetSharpe,
      trancheNetSharpe: backtest.trancheSummary.netSharpe,
      turnover: backtest.trancheSummary.turnover, rebalances: backtest.rebalances,
      overlappingPooled: true,
    }) : null,
  });
}


/**
 * Pool one model's per-date rank-IC series ACROSS folds and attach a dependence-aware interval.
 *
 * Folds are chronologically disjoint, so their date series concatenate cleanly. Averaging fold
 * means instead would discard the within-fold variation the interval is built from.
 */
function pooledIcUncertainty(scoreboard, { model, horizon, evaluationType = 'walk-forward-oos' } = {}) {
  const rows = scoreboard.rows.filter((r) => r.model === model && r.horizon === horizon && r.evaluationType === evaluationType);
  const perDate = [];
  for (const r of rows) for (const d of r.icPerDate || []) perDate.push(d);
  perDate.sort((a, b) => (a.date < b.date ? -1 : 1));
  const u = METRICS.icUncertainty(perDate, { horizonBars: horizon });
  return u ? { model, horizon, evaluationType, folds: rows.length, ...u } : null;
}

/** A scoreboard is an append-only collection of rows plus query helpers. */
function makeScoreboard(rows = []) {
  const all = [...rows];
  return Object.freeze({
    schema: 'ForecastScoreboard', version: SCOREBOARD_VERSION,
    rows: Object.freeze(all),
    byEvaluationType: (t) => all.filter((r) => r.evaluationType === t),
    byHorizon: (h) => all.filter((r) => r.horizon === h),
    byModel: (m) => all.filter((r) => r.model === m),
    oos: () => all.filter((r) => OOS_TYPES.has(r.evaluationType)),
    counts: Object.freeze(Object.fromEntries(EVALUATION_TYPES.map((t) => [t, all.filter((r) => r.evaluationType === t).length]))),
  });
}

/**
 * The ONLY inputs allowed to influence dynamic weighting / eligibility: matured walk-forward
 * OOS rows whose labels closed strictly before `asOf`. Flattened to the observation shape
 * lib/forecast/ensemble.js consumes.
 */
function productionEligibleInputs(scoreboard, asOf) {
  const out = [];
  for (const r of scoreboard.rows) {
    if (!OOS_TYPES.has(r.evaluationType)) continue;
    if (!r.maxLabelEnd || !(r.maxLabelEnd < asOf)) continue;
    const covErr = r.quantileCoverage && r.quantileCoverage[0.90] ? r.quantileCoverage[0.90].error : null;
    out.push({
      model: r.model, horizon: r.horizon, fold: r.fold,
      decisionDate: r.period && r.period.last, labelEnd: r.maxLabelEnd,
      rankIC: r.ic.meanRankIC,
      netReturn: r.backtest ? r.backtest.netAnnReturn : null,
      brier: r.probability && r.probability['0'] ? r.probability['0'].brier : null,
      coverageError: covErr,
      latencyMs: r.latencyMsMean,
      failed: r.failureRate != null && r.failureRate > 0.5,
      observations: r.n, dates: r.dates,
    });
  }
  return out;
}

/** Compact comparison table — one line per (model, horizon) at one evaluation type. */
function compare(scoreboard, { evaluationType = 'walk-forward-oos' } = {}) {
  const rows = scoreboard.byEvaluationType(evaluationType);
  const byKey = new Map();
  for (const r of rows) {
    const k = `${r.model}|${r.horizon}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const agg = (vals) => { const v = vals.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return [...byKey.entries()].map(([k, rs]) => {
    const [model, horizon] = k.split('|');
    return {
      model, horizon: Number(horizon), evaluationType, folds: rs.length,
      n: rs.reduce((a, r) => a + r.n, 0), dates: rs.reduce((a, r) => a + r.dates, 0),
      meanIC: agg(rs.map((r) => r.ic.meanIC)),
      meanRankIC: agg(rs.map((r) => r.ic.meanRankIC)),
      rankICIR: agg(rs.map((r) => r.ic.rankICIR)),
      positiveRankICRate: agg(rs.map((r) => r.ic.positiveRankICRate)),
      directionalAccuracy: agg(rs.map((r) => r.directionalAccuracy)),
      grossSharpe: agg(rs.map((r) => (r.backtest ? r.backtest.grossSharpe : null))),
      netSharpe: agg(rs.map((r) => (r.backtest ? r.backtest.netSharpe : null))),
      netAnnReturn: agg(rs.map((r) => (r.backtest ? r.backtest.netAnnReturn : null))),
      residualNetSharpe: agg(rs.map((r) => (r.backtest ? r.backtest.residualNetSharpe : null))),
      residualNetAnnReturn: agg(rs.map((r) => (r.backtest ? r.backtest.residualNetAnnReturn : null))),
      turnover: agg(rs.map((r) => (r.backtest && r.backtest.turnover ? r.backtest.turnover.mean : null))),
      brier: agg(rs.map((r) => (r.probability && r.probability['0'] ? r.probability['0'].brier : null))),
      logLoss: agg(rs.map((r) => (r.probability && r.probability['0'] ? r.probability['0'].logLoss : null))),
      ece: agg(rs.map((r) => (r.probability && r.probability['0'] ? r.probability['0'].ece : null))),
      coverage: agg(rs.map((r) => r.coverage)),
      failureRate: agg(rs.map((r) => r.failureRate)),
    };
  }).sort((a, b) => (a.horizon - b.horizon) || (a.model < b.model ? -1 : 1));
}

module.exports = { SCOREBOARD_VERSION, EVALUATION_TYPES, buildRow, makeScoreboard, productionEligibleInputs, compare, pooledIcUncertainty };
