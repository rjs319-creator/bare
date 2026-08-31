'use strict';
// PURGED WALK-FORWARD ORCHESTRATION (forecast-walkforward-v1)
//
// The one place that runs the whole pipeline in the only order that is defensible:
//
//   for each horizon:
//     split off a FINAL UNTOUCHED HOLDOUT
//     for each chronological outer fold (train | embargo | test):
//       purge training labels against the test boundary
//       cross-fit base predictions inside the training window        (crossfit.js)
//       refit base models on the permitted training history and predict the TEST block
//       compute dynamic ensemble weights from MATURED PRIOR-FOLD OOS only  (ensemble.js)
//       fit the meta-ranker on the CROSS-FITTED frames only          (meta-ranker.js)
//       fit calibrators on the CROSS-FITTED frames only              (calibration.js)
//       score the test block, run the cost-aware backtest, record the scoreboard rows
//       run the leakage audit and FAIL CLOSED on any violation
//
// Nothing from a test block ever flows backwards. The dynamic weights for fold k are computed
// from folds < k whose labels had already matured; the meta-ranker and calibrators for fold k
// never see fold k's outcomes; the holdout is not touched at all until `runHoldout` is called
// explicitly, once.

const FOLDS = require('./folds');
const CROSSFIT = require('./crossfit');
const META = require('./meta-ranker');
const CAL = require('./calibration');
const ENS = require('./ensemble');
const ARMS = require('./arms');
const SCORE = require('./score');
const BT = require('./backtest');
const SB = require('./scoreboard');
const LEAK = require('./leakage');
const Q = require('./quantiles');
const { activeBaseModels, availabilitySummary } = require('./base-models');
const RIDGE = require('./ridge');
const METRICS = require('./metrics');

const WALKFORWARD_VERSION = 'forecast-walkforward-v1';

const isFin = Number.isFinite;

/**
 * Threshold probabilities for one frame.
 *
 * The meta-ranker emits an ORDER, not a distribution, so the predictive distribution has to come
 * from a base model. We take the usable base record with the RICHEST quantile grid (the most
 * levels, since a two-level grid supports a far cruder CDF than a seven-level one), recentre it
 * on the ensemble point so the probability heads agree with the point estimate the ranker
 * actually used, and read P(Y > t) off the interpolated CDF.
 *
 * A frame with no usable distribution gets NO probabilities — never a fabricated 0.5.
 */
function frameProbabilities(frame, cfg, ensemblePoint) {
  let best = null;
  for (const b of Object.values(frame.base || {})) {
    if (!ARMS.usable(b)) continue;
    const n = Object.keys(b.quantiles || {}).length;
    if (n >= 2 && (!best || n > Object.keys(best.quantiles).length)) best = b;
  }
  if (!best) return { probabilities: {}, status: 'no-usable-distribution', quantiles: null };
  // Recentre the chosen distribution on the ensemble point so the probability heads agree with
  // the point estimate the ranker actually used.
  const shift = isFin(ensemblePoint) && isFin(best.point) ? ensemblePoint - best.point : 0;
  const shifted = Object.fromEntries(Object.entries(best.quantiles).map(([k, v]) => [Number(k), v + shift]));
  const t = Q.thresholdProbabilities({ quantiles: shifted }, cfg.returnThresholds);
  return { probabilities: t.probabilities, status: t.status, quantiles: shifted, repaired: t.repaired };
}

/** Fit the threshold + drawdown calibrators on CROSS-FITTED frames only. */
function fitCalibrators(crossFrames, cfg, ensembleWeights) {
  const calibrators = {};
  const keys = [...cfg.returnThresholds.map(String), 'drawdown'];
  for (const key of keys) {
    const pairs = [];
    for (const f of crossFrames) {
      if (!f.label || !f.label.classes) continue;
      const y = f.label.classes[key];
      if (y !== 0 && y !== 1) continue;
      const ep = ENS.weightedPoint(f, ensembleWeights.weights).point;
      if (key === 'drawdown') {
        // The drawdown head has no direct quantile: use the predicted downside tail magnitude,
        // which is the only distributional quantity that speaks to path risk.
        let down = null;
        for (const b of Object.values(f.base || {})) if (ARMS.usable(b) && isFin(b.downsideTail)) down = down === null ? b.downsideTail : Math.min(down, b.downsideTail);
        if (down === null) continue;
        pairs.push({ x: -down, y, date: f.decisionDate });
      } else {
        const pr = frameProbabilities(f, cfg, ep);
        const p = pr.probabilities[key];
        if (!isFin(p)) continue;
        pairs.push({ x: p, y, date: f.decisionDate });
      }
    }
    calibrators[key] = pairs.length
      ? CAL.fit(pairs, cfg, { sourceEvaluationType: 'cross-fitted', label: key })
      : CAL.identityCalibrator(key, 'no cross-fitted pairs available');
  }
  return calibrators;
}

/**
 * Apply the calibrated probability heads, the weighted point forecast, the uncertainty summary
 * and the 0-100 opportunity score to one test block.
 *
 * The probability heads come from the CDF of the chosen predictive distribution, recentred on the
 * ensemble point, and are then passed through calibrators fitted on cross-fitted frames only. A
 * frame with no usable distribution gets NO probabilities — never a fabricated 0.5.
 */
function scoreTestBlock({ frames, meta, weights, calibrators, reliability, cfg }) {
  const anyCalibrated = Object.values(calibrators).some((c) => c.status === CAL.STATUS.CALIBRATED);
  const worstDownsideTail = (f) => {
    let down = null;
    for (const b of Object.values(f.base || {})) {
      if (ARMS.usable(b) && isFin(b.downsideTail)) down = down === null ? b.downsideTail : Math.min(down, b.downsideTail);
    }
    return down;
  };

  const scored = frames.map((f) => {
    const wp = ENS.weightedPoint(f, weights.weights);
    const ag = ENS.agreement(f);
    const pr = frameProbabilities(f, cfg, wp.point);

    const probabilities = {};
    for (const [key, cal] of Object.entries(calibrators)) {
      // The drawdown head has no direct quantile: the predicted downside tail is the only
      // distributional quantity that speaks to path risk, so that is what the calibrator maps.
      const raw = key === 'drawdown' ? (() => { const d = worstDownsideTail(f); return d === null ? null : -d; })() : pr.probabilities[key];
      if (!isFin(raw)) continue;
      const p = cal.apply(raw);
      if (p !== null) probabilities[key] = p;
    }

    const q = pr.quantiles;
    return {
      ...f,
      rankerScore: meta.ok ? meta.scores.get(f.rowKey) : wp.point,
      rankerBackend: meta.ok ? meta.backend : 'dynamic-ensemble-fallback',
      ensemblePoint: wp.point, ensembleUsedModels: wp.usedModels,
      expectedResidualReturn: wp.point,
      quantiles: q, rawProbabilities: pr.probabilities, probabilities,
      probabilityStatus: anyCalibrated ? 'calibrated' : `uncalibrated:${pr.status}`,
      intervalWidth80: (q && isFin(q[0.10]) && isFin(q[0.90])) ? q[0.90] - q[0.10] : null,
      agreement: ag.agreement, disagreement: ag.disagreement,
      estimatedCostPct: BT.costFor({ adv: f.adv }).cost,
      reliability: reliability.best,
    };
  });

  // The score is a WITHIN-DATE construct, so it is computed one decision date at a time.
  const byDate = new Map();
  for (const s of scored) {
    if (!byDate.has(s.decisionDate)) byDate.set(s.decisionDate, []);
    byDate.get(s.decisionDate).push(s);
  }
  const scoreByKey = new Map();
  for (const group of byDate.values()) {
    for (const out of SCORE.scoreDate(group, cfg)) scoreByKey.set(out.rowKey, out);
  }
  return { scored, scoreByKey };
}

/**
 * Build one scoreboard row per comparison arm, all measured on the SAME test rows so the
 * comparison is like-for-like, each with its own cost-aware backtest.
 */
function buildArmRows({ frames, scored, meta, metaNoFoundation, shuffled, weights, baseNames, fold, horizon, cfg, stride, trainThrough, fitted, ridgeRank = null }) {
  const scoredByKey = new Map(scored.map((s) => [s.rowKey, s]));
  const metaScoreByKey = meta.ok ? meta.scores : new Map(scored.map((s) => [s.rowKey, s.ensemblePoint]));
  const roleOf = (n) => (n === 'ridge' ? 'baseline' : n === 'chronos2' ? 'primary' : 'challenger');

  const armDefs = [
    { name: 'control-random', role: 'control', preds: ARMS.armPredictions(frames, (f) => ARMS.hashOrder(`${f.ticker}|${f.decisionDate}`)) },
    ...baseNames.map((n) => ({ name: n, role: roleOf(n), preds: ARMS.baseArm(frames, n) })),
    { name: 'static-ensemble', role: 'ensemble', preds: ARMS.armPredictions(frames, ARMS.staticEnsemblePoint) },
    { name: 'dynamic-ensemble', role: 'ensemble', preds: ARMS.armPredictions(frames, (f) => ENS.weightedPoint(f, weights.weights).point) },
  ];
  // Pre-declared second linear arm: the same ridge fitted on the WITHIN-DATE z-scored target.
  // Ranking only — its output is a z-score, never an expected return.
  if (ridgeRank && ridgeRank.fitted) {
    armDefs.push({ name: 'ridge-rank', role: 'baseline', preds: ARMS.armPredictions(frames, (f) => RIDGE.predictPoint(ridgeRank, f)) });
  }
  if (metaNoFoundation && metaNoFoundation.ok) {
    armDefs.push({ name: 'meta-no-foundation', role: 'control', preds: ARMS.armPredictions(frames, (f) => metaNoFoundation.scores.get(f.rowKey)) });
  }
  if (meta.ok) {
    armDefs.push({
      name: 'meta-ranker', role: 'meta',
      preds: ARMS.armPredictions(frames, (f) => meta.scores.get(f.rowKey), (f) => {
        const s = scoredByKey.get(f.rowKey);
        return s ? { quantiles: s.quantiles, probabilities: s.probabilities } : {};
      }),
    });
  }
  if (shuffled.ok) armDefs.push({ name: 'control-shuffled-label', role: 'control', preds: ARMS.armPredictions(frames, (f) => shuffled.scores.get(f.rowKey)) });
  armDefs.push({ name: 'control-delayed-signal', role: 'control', preds: ARMS.delayedSignal(frames, metaScoreByKey, 1) });

  const universeSize = new Set(frames.map((f) => f.ticker)).size;
  return armDefs.map((arm) => {
    const btRows = arm.preds
      .filter((p) => isFin(p.score) && p.label)
      .map((p) => ({ decisionDate: p.decisionDate, ticker: p.ticker, sector: p.sector, score: p.score, adv: p.adv, price: p.price, label: p.label }));
    const backtest = btRows.length >= 50 ? BT.runBacktest(btRows, cfg, { horizon, stride }) : null;
    const fittedModel = fitted[arm.name];
    return SB.buildRow({
      model: arm.name, role: arm.role, horizon, fold: fold.id,
      evaluationType: 'walk-forward-oos',
      predictions: arm.preds, cfg, withBreakdowns: true,
      identity: {
        trainCutoff: trainThrough, dataCutoff: trainThrough,
        modelId: (fittedModel && fittedModel.schema) || null,
        revision: (fittedModel && fittedModel.version) || null,
      },
      backtest: backtest && backtest.ok ? backtest : null,
      universeSize,
      period: { first: fold.testStart, last: fold.testEnd },
    });
  });
}

/** Run one outer fold for one horizon. Returns { rows (scoreboard), diagnostics, audit, scored }. */
function runFold({ fold, horizon, allRows, featureKeys, cfg, caps, panel, axis, priorObservations, fixture = null, stride = 1 }) {
  const models = activeBaseModels(cfg, caps, { includeFixtures: !!fixture });
  const baseNames = models.map((m) => m.name);
  const diagnostics = { fold: fold.id, horizon, baseNames };

  const trainCandidates = FOLDS.rowsInRange(allRows, fold.trainStart, fold.trainEnd);
  const { kept: trainRows, dropped } = FOLDS.purgeTrainingRows(trainCandidates, axis, fold.testStart, fold.embargoSessions);
  const testRows = FOLDS.rowsInRange(allRows, fold.testStart, fold.testEnd);
  diagnostics.purge = { candidates: trainCandidates.length, kept: trainRows.length, ...dropped, test: testRows.length };
  if (trainRows.length < 200 || testRows.length < 50) {
    return { skipped: true, reason: `fold too thin (train ${trainRows.length}, test ${testRows.length})`, diagnostics };
  }

  // 1. Cross-fitted base predictions (the ONLY frames the stack may learn from).
  const cf = CROSSFIT.crossFitBase({ trainRows, featureKeys, cfg, caps, panel, horizon, axis, fixture, models, stride });
  diagnostics.crossfit = cf.diagnostics;
  if (!cf.frames.length) return { skipped: true, reason: 'cross-fitting produced no frames', diagnostics };

  // 2. Refit on the permitted training history and predict the TEST block.
  const outer = CROSSFIT.fitAndPredictOuter({ trainRows, testRows, featureKeys, cfg, caps, panel, horizon, fixture, models });
  diagnostics.outer = outer.diagnostics;

  // 3. Dynamic weights from MATURED PRIOR-FOLD OOS only, as of this fold's first test session.
  const weights = ENS.computeWeights({ observations: priorObservations, models: baseNames, horizon, asOf: fold.testStart, cfg });
  diagnostics.weights = { status: weights.status, fallback: weights.fallback, weights: weights.weights, observations: weights.observations };

  // Trailing reliability KNOWN AT this fold's start — from matured prior-fold OOS only, never
  // from this fold. It becomes a meta-ranker input and a score component.
  const reliability = { best: Math.max(0, ...Object.values(weights.inputs || {}).map((v) => (isFin(v.meanRankIC) ? v.meanRankIC : 0)), 0) };

  // 4. Meta-ranker: trained on cross-fitted frames, applied to the test block.
  //
  // The cross-fitted frames are scored TOO — prediction is nearly free next to training — so the
  // model's rank IC on its own training data can be reported beside the out-of-sample number.
  // Overfitting is then something the scoreboard SHOWS rather than something a reader infers.
  const meta = META.fitAndScore({ trainFrames: cf.frames, predictFrames: outer.frames.concat(cf.frames), baseNames, featureKeys, cfg, caps, id: `${fold.id}.h${horizon}`, ensembleWeights: weights.weights, reliability });
  if (meta.ok) {
    const icOf = (fr) => METRICS.informationCoefficient(fr.map((f) => ({ decisionDate: f.decisionDate, score: meta.scores.get(f.rowKey), actual: f.label && f.label.residualReturn }))).meanRankIC;
    diagnostics.metaFit = {
      objective: meta.objective, rounds: meta.rounds,
      innerValidation: meta.innerValidation,
      rankICInSample: icOf(cf.frames),
      rankICOutOfSample: icOf(outer.frames),
    };
  }
  diagnostics.meta = {
    ok: meta.ok, backend: meta.backend, objective: meta.objective, rounds: meta.rounds || null,
    // An abstention is a DECISION (inner validation showed no ranking value) and is recorded as
    // one — distinct from a failure, and distinct from a silent pass-through.
    abstained: meta.abstained === true,
    reason: meta.reason || null, degradedFrom: meta.degradedFrom || null, degradeReason: meta.degradeReason || null,
    trainRows: meta.trainRows,
    innerValidation: meta.innerValidation || null,
  };
  if (!meta.ok) {
    diagnostics.metaFit = {
      objective: null, rounds: null, abstained: meta.abstained === true,
      innerValidation: meta.innerValidation || null,
      rankICInSample: null, rankICOutOfSample: null,
      note: meta.abstained
        ? 'meta-ranker stood down; the dynamic ensemble ranked this fold'
        : `meta-ranker unavailable: ${meta.reason || 'unknown'}`,
    };
  }

  // 4b. CONTROL — the meta-ranker WITHOUT foundation-model features.
  const noFoundationNames = baseNames.filter((n) => n === 'ridge');
  const metaNoFoundation = baseNames.length > 1
    ? META.fitAndScore({ trainFrames: cf.frames, predictFrames: outer.frames, baseNames: noFoundationNames, featureKeys, cfg, caps, id: `${fold.id}.h${horizon}.nofound`, ensembleWeights: weights.weights, reliability })
    : null;

  // 4c. CONTROL — labels shuffled within date. A persistent edge here means leakage.
  const shuffled = META.fitAndScore({
    trainFrames: ARMS.shuffleLabelsWithinDate(cf.frames, cfg.seed + horizon), predictFrames: outer.frames,
    baseNames, featureKeys, cfg, caps, id: `${fold.id}.h${horizon}.shuffled`,
    ensembleWeights: weights.weights, reliability,
  });

  // 5. Calibrators — cross-fitted frames only.
  const calibrators = fitCalibrators(cf.frames, cfg, weights);
  diagnostics.calibration = Object.fromEntries(Object.entries(calibrators).map(([k, c]) => [k, { status: c.status, n: c.n, prevalence: c.prevalence, through: c.fittedThroughDate }]));

  // 6-7. Score the test block and assign the 0-100 opportunity score per decision date.
  const { scored, scoreByKey } = scoreTestBlock({ frames: outer.frames, meta, weights, calibrators, reliability, cfg });

  // 8. Arms -> scoreboard rows.
  const ridgeRank = RIDGE.fitRidgeRank(trainRows, featureKeys, cfg, { horizon });
  diagnostics.ridgeRank = { fitted: !!ridgeRank.fitted, reason: ridgeRank.reason || null, trainRows: ridgeRank.trainRows || null };

  const rows = buildArmRows({
    frames: outer.frames, scored, meta, metaNoFoundation, shuffled, weights, baseNames,
    fold, horizon, cfg, stride, trainThrough: outer.trainThrough, fitted: outer.fitted, ridgeRank,
  });

  // 9. Leakage audit — fails closed.
  const audit = LEAK.runAudit({
    folds: [fold], axis, trainRows, testRows,
    scaler: outer.fitted.ridge ? outer.fitted.ridge.scaler : null,
    calibrators, stackingFrames: cf.frames,
    sessions: axis.dates,
  });

  return { skipped: false, rows, diagnostics, audit, scored, scoreByKey, weights, calibrators, crossFrames: cf.frames, outerFrames: outer.frames, meta };
}

/**
 * Run the full purged walk-forward for one horizon.
 * `rows` must already be built (lib/forecast/dataset.js) and sorted by decision date.
 */
function runHorizon({ horizon, rows, featureKeys, cfg, caps, panel, decisionDates, sessions = null, stride = 1, fixture = null, onFold = null }) {
  // Two axes, deliberately distinct:
  //   decisionDates — the (possibly strided) axis folds are built on
  //   sessions      — the FULL trading calendar the exact label-end purge measures against
  const { development, holdout, holdoutViable, reason: holdoutReason } = FOLDS.splitHoldout(decisionDates, cfg);
  const devSessions = new Set(development);
  const devRows = rows.filter((r) => devSessions.has(r.decisionDate));
  const axis = FOLDS.buildAxis(sessions || panel.sessions);
  const folds = FOLDS.buildOuterFolds(development, cfg, { stride });

  const scoreboardRows = [];
  const foldReports = [];
  const audits = [];
  let priorObservations = [];

  for (const fold of folds) {
    const res = runFold({ fold, horizon, allRows: devRows, featureKeys, cfg, caps, panel, axis, priorObservations, fixture, stride });
    if (res.skipped) { foldReports.push({ fold: fold.id, skipped: true, reason: res.reason, diagnostics: res.diagnostics }); continue; }
    scoreboardRows.push(...res.rows);
    audits.push({ fold: fold.id, ok: res.audit.ok, failedChecks: res.audit.failedChecks });
    foldReports.push({ fold: fold.id, skipped: false, diagnostics: res.diagnostics, auditOk: res.audit.ok });
    // Feed only this fold's MATURED results forward; ensemble.computeWeights re-filters by date.
    priorObservations = priorObservations.concat(SB.productionEligibleInputs(SB.makeScoreboard(res.rows), fold.testEnd));
    if (onFold) onFold(res, fold);
  }

  return {
    version: WALKFORWARD_VERSION,
    horizon,
    folds, foldReports, audits,
    scoreboardRows,
    holdout: { viable: holdoutViable, reason: holdoutReason, sessions: holdout.length, first: holdout[0] || null, last: holdout[holdout.length - 1] || null },
    development: { sessions: development.length, first: development[0], last: development[development.length - 1] },
    modelAvailability: availabilitySummary(cfg, caps),
    auditOk: audits.every((a) => a.ok),
  };
}

/**
 * Score the FINAL UNTOUCHED HOLDOUT — once.
 *
 * Everything before this point (fold construction, tuning, calibration, weighting, model
 * selection) is confined to the development span. This function trains on ALL of development,
 * purged against the holdout boundary, and reads the holdout exactly one time. Its rows are
 * stamped `final-holdout` so `productionEligibleInputs` can never feed them back into weighting
 * or eligibility — the holdout informs nothing, it only reports.
 *
 * Call it LAST, and do not call it repeatedly while iterating: a holdout inspected many times is
 * just another validation set.
 */
function runHoldout({ horizon, rows, featureKeys, cfg, caps, panel, decisionDates, sessions = null, stride = 1, priorObservations = [], fixture = null }) {
  const { development, holdout, holdoutViable, reason } = FOLDS.splitHoldout(decisionDates, cfg);
  if (!holdoutViable || holdout.length < 5) return { ok: false, reason: reason || 'holdout too short to score' };

  const axis = FOLDS.buildAxis(sessions || panel.sessions);
  const embargoUnits = FOLDS.embargoUnitsFor(cfg, stride);
  // THE HOLDOUT NEEDS ITS EMBARGO TOO. Development ends where it ends, but training for the
  // holdout must stop `embargoUnits` decision dates earlier — otherwise the last development
  // labels straddle the holdout boundary and the "untouched" block is contaminated by exactly
  // the overlap the outer folds are careful to exclude.
  const trainEndIdx = development.length - 1 - embargoUnits;
  if (trainEndIdx < 30) return { ok: false, reason: `development span too short to hold out with a ${embargoUnits}-step embargo` };

  const fold = Object.freeze({
    id: 'holdout',
    scheme: cfg.walkforward.scheme,
    trainStart: development[0], trainEnd: development[trainEndIdx],
    testStart: holdout[0], testEnd: holdout[holdout.length - 1],
    embargoSessions: FOLDS.defaultEmbargo(cfg),
    embargoUnits,
    decisionDateStride: stride,
    trainSessions: trainEndIdx + 1,
    testSessionsCount: holdout.length,
  });

  const res = runFold({ fold, horizon, allRows: rows, featureKeys, cfg, caps, panel, axis, priorObservations, fixture, stride });
  if (res.skipped) return { ok: false, reason: res.reason, diagnostics: res.diagnostics };

  // Re-stamp every scoreboard row as the FINAL HOLDOUT — it is not walk-forward OOS and must
  // never be pooled with it, nor reach productionEligibleInputs.
  const restamped = res.rows.map((r) => Object.freeze({ ...r, fold: 'holdout', evaluationType: 'final-holdout' }));

  return {
    ok: true, fold, rows: restamped, audit: res.audit, diagnostics: res.diagnostics,
    inspectedOnce: true,
    warning: 'A holdout inspected more than once stops being a holdout. Treat this number as read.',
  };
}

module.exports = { WALKFORWARD_VERSION, runFold, runHorizon, runHoldout, fitCalibrators, frameProbabilities, scoreTestBlock, buildArmRows };
