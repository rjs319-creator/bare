'use strict';
// CROSS-FITTED BASE PREDICTIONS (forecast-crossfit-v1)
//
// THIS IS THE MOST IMPORTANT LEAKAGE CONTROL IN THE SYSTEM.
//
// The meta-ranker and the calibrators learn a mapping FROM base-model predictions. If those
// predictions were produced by base models that had already seen the same rows' labels, the
// meta-ranker learns how well the base model memorizes, not how well it forecasts, and every
// downstream number is optimistic. So, for each outer training window:
//
//   1. split the outer training history into chronological INNER folds;
//   2. train each base model only on data strictly BEFORE an inner validation segment;
//   3. predict that later segment;
//   4. purge overlapping labels and apply the inner embargo at every inner boundary;
//   5. concatenate the chronological out-of-fold predictions;
//   6. hand ONLY those to the meta-ranker and the calibrators;
//   7. refit the base models on the permitted outer training history;
//   8. predict the outer TEST period with those refits;
//   9. apply the already-fitted meta-ranker and calibrators to the outer test period.
//
// Every returned frame is stamped with `evaluationType` — 'cross-fitted' or 'walk-forward-oos' —
// and `producedByModelTrainedThrough`, so `assertNoInSampleStacking` (below, and exercised by
// test/forecast-leakage.test.js) can prove no in-sample prediction reached the stack.

const { activeBaseModels, rowKey } = require('./base-models');
const FOLDS = require('./folds');

const CROSSFIT_VERSION = 'forecast-crossfit-v1';

// Every Forecast record inherits the point-in-time stamps its ROW already carries, so a base
// model's output can be audited on its own (contract.js requires them) without the orchestrator
// having to thread a stamp factory through every call site.
const rowPit = (row) => (row && row.pit) || null;

const EVAL = Object.freeze({
  IN_SAMPLE: 'in-sample',
  CROSS_FITTED: 'cross-fitted',
  VALIDATION: 'validation',
  WALK_FORWARD_OOS: 'walk-forward-oos',
  HOLDOUT: 'final-holdout',
});

/**
 * Produce cross-fitted base predictions over one outer training window.
 *
 *   trainRows  rows whose decisionDate lies in [fold.trainStart, fold.trainEnd], already
 *              purged against the OUTER test block by the caller
 *   axis       session ordinal axis (folds.buildAxis)
 *
 * Returns { frames: [{ rowKey, ticker, decisionDate, horizon, base: { model -> forecast },
 *           label, evaluationType, innerFold, producedByModelTrainedThrough }], innerFolds,
 *           diagnostics }.
 */
function crossFitBase({ trainRows, featureKeys, cfg, caps, panel, horizon, axis, pitFor = rowPit, fixture = null, models = null, stride = 1 }) {
  const baseModels = models || activeBaseModels(cfg, caps, { includeFixtures: !!fixture });
  const sessions = [...new Set(trainRows.map((r) => r.decisionDate))].sort();
  const innerFolds = FOLDS.buildInnerFolds(sessions, cfg, { stride });

  const diagnostics = { innerFolds: innerFolds.length, purged: [], unfittedModels: [], rowsIn: trainRows.length, rowsOut: 0 };
  if (!innerFolds.length) {
    return { frames: [], innerFolds: [], diagnostics: { ...diagnostics, reason: 'training window too short for chronological inner folds' } };
  }

  const framesByKey = new Map();

  for (const inner of innerFolds) {
    const innerTrainCandidates = FOLDS.rowsInRange(trainRows, inner.trainStart, inner.trainEnd);
    const { kept: innerTrain, dropped } = FOLDS.purgeTrainingRows(innerTrainCandidates, axis, inner.validStart, inner.embargoSessions);
    const innerValid = FOLDS.rowsInRange(trainRows, inner.validStart, inner.validEnd);
    diagnostics.purged.push({ innerFold: inner.id, candidates: innerTrainCandidates.length, kept: innerTrain.length, ...dropped, valid: innerValid.length });
    if (!innerValid.length) continue;

    for (const bm of baseModels) {
      const model = bm.requiresFit ? bm.fit(innerTrain, featureKeys, cfg, { horizon }) : bm.fit();
      if (bm.requiresFit && !model.fitted) {
        diagnostics.unfittedModels.push({ innerFold: inner.id, model: bm.name, reason: model.reason });
        continue;
      }
      const preds = bm.predict(model, innerValid, { cfg, caps, panel, horizon, pitFor, fixture });
      for (const r of innerValid) {
        const k = rowKey(r);
        if (!framesByKey.has(k)) {
          framesByKey.set(k, {
            rowKey: k, ticker: r.ticker, securityId: r.securityId, sector: r.sector,
            decisionDate: r.decisionDate, horizon,
            features: r.features, label: r.label, quality: r.quality, pit: r.pit,
            // Execution context travels WITH the frame. Without adv/price here, every
            // downstream cost lookup falls to the most expensive tier and the after-cost
            // numbers are wrong by an order of magnitude — the frame must carry what the
            // cost model needs, not hope the caller still has the row.
            adv: r.adv, price: r.price,
            betaMarket: r.betaMarket, betaSector: r.betaSector,
            base: {}, evaluationType: EVAL.CROSS_FITTED, innerFold: inner.id,
            producedByModelTrainedThrough: inner.trainEnd,
          });
        }
        const f = preds.get(k);
        if (f) framesByKey.get(k).base[bm.name] = f;
      }
    }
  }

  const frames = [...framesByKey.values()].sort((a, b) => (a.decisionDate < b.decisionDate ? -1 : a.decisionDate > b.decisionDate ? 1 : (a.ticker < b.ticker ? -1 : 1)));
  diagnostics.rowsOut = frames.length;
  return { frames, innerFolds, diagnostics };
}

/**
 * Refit the base models on the permitted outer training history and predict the outer test
 * block. These are the TRUE out-of-sample base predictions.
 */
function fitAndPredictOuter({ trainRows, testRows, featureKeys, cfg, caps, panel, horizon, pitFor = rowPit, fixture = null, models = null }) {
  const baseModels = models || activeBaseModels(cfg, caps, { includeFixtures: !!fixture });
  const fitted = {};
  const diagnostics = { unfittedModels: [] };
  let trainThrough = null;
  for (const r of trainRows) if (trainThrough === null || r.decisionDate > trainThrough) trainThrough = r.decisionDate;

  const framesByKey = new Map();
  for (const r of testRows) {
    const k = rowKey(r);
    framesByKey.set(k, {
      rowKey: k, ticker: r.ticker, securityId: r.securityId, sector: r.sector,
      decisionDate: r.decisionDate, horizon,
      features: r.features, label: r.label, quality: r.quality, pit: r.pit,
      adv: r.adv, price: r.price,
      betaMarket: r.betaMarket, betaSector: r.betaSector,
      base: {}, evaluationType: EVAL.WALK_FORWARD_OOS, innerFold: null,
      producedByModelTrainedThrough: trainThrough,
    });
  }

  for (const bm of baseModels) {
    const model = bm.requiresFit ? bm.fit(trainRows, featureKeys, cfg, { horizon }) : bm.fit();
    if (bm.requiresFit && !model.fitted) { diagnostics.unfittedModels.push({ model: bm.name, reason: model.reason }); continue; }
    fitted[bm.name] = model;
    const preds = bm.predict(model, testRows, { cfg, caps, panel, horizon, pitFor, fixture });
    for (const r of testRows) {
      const f = preds.get(rowKey(r));
      if (f) framesByKey.get(rowKey(r)).base[bm.name] = f;
    }
  }

  const frames = [...framesByKey.values()].sort((a, b) => (a.decisionDate < b.decisionDate ? -1 : a.decisionDate > b.decisionDate ? 1 : (a.ticker < b.ticker ? -1 : 1)));
  return { frames, fitted, trainThrough, diagnostics };
}

/**
 * LEAKAGE ASSERTION. Every frame handed to the meta-ranker or a calibrator must come from a
 * base model whose training window ENDED STRICTLY BEFORE the frame's own decision date. A frame
 * that fails this is an in-sample stacking prediction, and the caller must refuse to train on it.
 *
 * Returns { ok, violations:[{rowKey, decisionDate, trainedThrough}] }. Exercised directly by
 * test/forecast-leakage.test.js with a deliberately-poisoned frame set.
 */
function assertNoInSampleStacking(frames) {
  const violations = [];
  for (const f of frames) {
    if (f.evaluationType === EVAL.IN_SAMPLE) {
      violations.push({ rowKey: f.rowKey, decisionDate: f.decisionDate, trainedThrough: f.producedByModelTrainedThrough, reason: 'frame is explicitly in-sample' });
      continue;
    }
    const through = f.producedByModelTrainedThrough;
    if (through == null) {
      violations.push({ rowKey: f.rowKey, decisionDate: f.decisionDate, trainedThrough: null, reason: 'no training cutoff recorded — provenance cannot be proven' });
      continue;
    }
    if (through >= f.decisionDate) {
      violations.push({ rowKey: f.rowKey, decisionDate: f.decisionDate, trainedThrough: through, reason: 'base model training window reaches the frame\'s own decision date' });
    }
  }
  return { ok: violations.length === 0, violations, checked: frames.length };
}

module.exports = { CROSSFIT_VERSION, EVAL, crossFitBase, fitAndPredictOuter, assertNoInSampleStacking };
