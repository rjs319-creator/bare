'use strict';
// BATCH INFERENCE / PREDICTION + RANKING INTERFACE (forecast-infer-v1)
//
// The serving path. It reuses the SAME modules the walk-forward evaluation uses — same features,
// same targets, same cross-fitting, same calibrators, same score — so there is no second
// implementation to drift against. What differs is only that the forward window has not happened
// yet, so the rows being scored carry no label.
//
// PIT DISCIPLINE AT SERVING TIME:
//   * training uses only decision dates whose LABELS had fully closed before `asOf`
//     (the same exact-label-end purge the folds use);
//   * the meta-ranker and calibrators are fitted on CROSS-FITTED frames from that training
//     window, never on rows near `asOf`;
//   * the scored rows are stamped `evaluationType: 'live-prediction'` so no consumer can mistake
//     them for a backtest.
//
// Output is a list of ForecastScoredRow (lib/forecast/contract.js).

const DS = require('./dataset');
const FOLDS = require('./folds');
const CROSSFIT = require('./crossfit');
const META = require('./meta-ranker');
const ENS = require('./ensemble');
const WF = require('./walkforward');
const REG = require('./registry');
const { activeBaseModels, availabilitySummary } = require('./base-models');
const { makeScoredRow, makeQualityFlags } = require('./contract');
const { modelFeatureKeys } = require('./xsection');

const INFER_VERSION = 'forecast-infer-v1';

const isFin = Number.isFinite;

/**
 * Score one decision date.
 *   asOf            decision date to predict for (defaults to the panel's last session)
 *   trainSessions   how much trailing history to train on
 *   dateStride      sample training decision dates every N sessions (cost control; recorded)
 */
function runInference({
  panel, cfg, caps, asOf = null, horizons = null, trainSessions = 500, dateStride = 5,
  priorObservations = [], fixture = null, transforms = ['rank'],
}) {
  const sessions = panel.sessions;
  const date = asOf || sessions[sessions.length - 1];
  const idx = sessions.indexOf(date);
  if (idx < 0) return { ok: false, reason: `asOf ${date} is not a session on this panel's axis` };

  const hs = horizons || cfg.horizons;
  const featureKeys = modelFeatureKeys({ transforms, includeDateConstant: cfg.features.includeDateConstant });
  const axis = FOLDS.buildAxis(sessions);
  const embargo = FOLDS.defaultEmbargo(cfg);

  // Training decision dates: strictly before `asOf`, sampled by stride, and later purged so
  // every surviving training label closed before the embargo boundary at `asOf`.
  const trainStartIdx = Math.max(0, idx - trainSessions);
  const trainDates = [];
  for (let i = trainStartIdx; i < idx; i += dateStride) trainDates.push(sessions[i]);
  if (trainDates.length < 20) return { ok: false, reason: `only ${trainDates.length} training decision dates available before ${date}` };

  const trainPanel = DS.buildPanelRows({ panel, dates: trainDates, cfg, transforms, requireLabel: true });
  const servePanel = DS.buildPanelRows({ panel, dates: [date], cfg, transforms, requireLabel: false });

  const manifest = REG.makeManifest({
    runType: 'inference', cfg, caps,
    universe: null, folds: null, dataCutoff: date,
    codeVersions: { infer: INFER_VERSION, walkforward: WF.WALKFORWARD_VERSION },
    notes: [`training decision dates sampled every ${dateStride} sessions over the trailing ${trainSessions} sessions`],
  });

  const byHorizon = {};
  const models = activeBaseModels(cfg, caps, { includeFixtures: !!fixture });
  const baseNames = models.map((m) => m.name);

  for (const h of hs) {
    const allTrain = trainPanel.rowsByHorizon.get(h) || [];
    const serveRows = servePanel.rowsByHorizon.get(h) || [];
    if (!serveRows.length) { byHorizon[h] = { ok: false, reason: 'no eligible names at the decision date' }; continue; }

    const { kept: trainRows, dropped } = FOLDS.purgeTrainingRows(allTrain, axis, date, embargo);
    if (trainRows.length < 200) { byHorizon[h] = { ok: false, reason: `only ${trainRows.length} purged training rows`, dropped }; continue; }

    const cf = CROSSFIT.crossFitBase({ trainRows, featureKeys, cfg, caps, panel, horizon: h, axis, fixture, models, stride: dateStride });
    if (!cf.frames.length) { byHorizon[h] = { ok: false, reason: 'cross-fitting produced no frames' }; continue; }

    const outer = CROSSFIT.fitAndPredictOuter({ trainRows, testRows: serveRows, featureKeys, cfg, caps, panel, horizon: h, fixture, models });
    const weights = ENS.computeWeights({ observations: priorObservations, models: baseNames, horizon: h, asOf: date, cfg });
    const reliability = { best: Math.max(0, ...Object.values(weights.inputs || {}).map((v) => (Number.isFinite(v.meanRankIC) ? v.meanRankIC : 0)), 0) };
    const meta = META.fitAndScore({ trainFrames: cf.frames, predictFrames: outer.frames, baseNames, featureKeys, cfg, caps, id: `serve.h${h}`, ensembleWeights: weights.weights, reliability });
    const calibrators = WF.fitCalibrators(cf.frames, cfg, weights);

    // The serving path scores the block with the SAME function the walk-forward evaluation
    // uses (lib/forecast/walkforward.js scoreTestBlock) — one implementation, so train/serve
    // parity holds by construction rather than by discipline.
    const { scored: enriched, scoreByKey } = WF.scoreTestBlock({
      frames: outer.frames, meta, weights, calibrators, reliability, cfg,
    });

    const ranked = enriched
      .filter((e) => isFin(e.rankerScore))
      .sort((a, b) => b.rankerScore - a.rankerScore);

    const lineage = REG.lineageFor({ manifest, fold: 'serving', models: outer.fitted, weights, calibrators, scoreMapping: null });
    const serveByTicker = new Map(serveRows.map((r) => [r.ticker, r]));

    byHorizon[h] = {
      ok: true,
      horizon: h,
      asOf: date,
      cohortSize: ranked.length,
      rankerBackend: meta.ok ? meta.backend : 'dynamic-ensemble-fallback',
      metaReason: meta.reason || meta.degradeReason || null,
      weights: { status: weights.status, fallback: weights.fallback, weights: weights.weights },
      calibration: Object.fromEntries(Object.entries(calibrators).map(([k, c]) => [k, { status: c.status, n: c.n, prevalence: c.prevalence }])),
      purge: { candidates: allTrain.length, kept: trainRows.length, ...dropped },
      rows: ranked.map((e, i) => {
        const sc = scoreByKey.get(e.rowKey) || {};
        const srcRow = serveByTicker.get(e.ticker) || null;
        return makeScoredRow({
          securityId: e.securityId, ticker: e.ticker, pit: srcRow ? srcRow.pit : null, horizon: h,
          targetDefinition: cfg.target.definition, targetVersion: cfg.target.version,
          opportunityScore: sc.opportunityScore, scoreStatus: sc.scoreStatus,
          rank: i + 1, rankPercentile: ranked.length > 1 ? +(1 - i / (ranked.length - 1)).toFixed(6) : 1, cohortSize: ranked.length,
          expectedResidualReturn: e.expectedResidualReturn,
          quantiles: e.quantiles || {}, probabilities: e.probabilities,
          probabilityStatus: e.probabilityStatus,
          uncertainty: { intervalWidth80: e.intervalWidth80, disagreement: e.disagreement },
          componentAvailability: Object.fromEntries(Object.entries(e.base || {}).map(([k, b]) => [k, b ? b.availability : 'missing'])),
          modelWeights: weights.weights, agreement: e.agreement, disagreement: e.disagreement,
          marketBeta: srcRow ? srcRow.betaMarket : null, sectorBeta: srcRow ? srcRow.betaSector : null,
          sector: e.sector, estimatedCostPct: e.estimatedCostPct,
          quality: srcRow ? srcRow.quality : makeQualityFlags({}),
          eligible: true, exclusionReason: null,
          explanations: sc.componentsUsed || [],
          evaluationType: 'live-prediction',
          lineage,
        });
      }),
    };
  }

  return {
    ok: true, version: INFER_VERSION, asOf: date, manifest,
    capabilities: { tier: caps.tier, tierLabel: caps.tierLabel, degraded: [...caps.degraded] },
    modelAvailability: availabilitySummary(cfg, caps),
    horizons: byHorizon,
  };
}

module.exports = { INFER_VERSION, runInference };
