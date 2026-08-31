'use strict';
// BASE-MODEL REGISTRY (forecast-base-models-v1)
//
// One uniform interface over models with very different natures, so the cross-fitting
// orchestrator does not have to know which is which:
//
//   { name, role, requiresFit, fit(trainRows, featureKeys, cfg, ctx) -> model,
//     predict(model, rows, ctx) -> Map(rowKey -> Forecast) }
//
// `requiresFit:false` marks a ZERO-SHOT model (Chronos-2, Moirai-2): it is never fitted on
// local outcomes, so it cannot leak through its own parameters. That does NOT exempt it from
// the discipline — its predictions still enter the cross-fitted frame, and test-period outcomes
// still may not influence preprocessing, selection, weighting or calibration. Cross-fitting a
// zero-shot model is a no-op for the model and a REQUIREMENT for everything stacked on top.
//
// The ridge baseline is `requiresFit:true` and is the only model whose parameters see local
// labels, which is exactly why it must be refitted inside every fold.

const RIDGE = require('./ridge');
const CHRONOS = require('./chronos-adapter');
const MOIRAI = require('./moirai-adapter');
const { AVAILABILITY } = require('./contract');

const BASE_MODELS_VERSION = 'forecast-base-models-v1';

const rowKey = (r) => `${r.ticker}|${r.decisionDate}`;

/** Group rows by decision date, preserving chronological order. */
function byDate(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.decisionDate)) m.set(r.decisionDate, []);
    m.get(r.decisionDate).push(r);
  }
  return new Map([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

const ridgeModel = Object.freeze({
  name: 'ridge', role: 'baseline', requiresFit: true,
  fit(trainRows, featureKeys, cfg, { horizon }) {
    return RIDGE.fitRidge(trainRows, featureKeys, cfg, { horizon });
  },
  predict(model, rows, { cfg, horizon, pitFor }) {
    const out = new Map();
    for (const r of rows) out.set(rowKey(r), RIDGE.forecast(model, r, cfg, { pit: pitFor ? pitFor(r) : null }));
    return out;
  },
});

function foundationModel(adapter, name, role) {
  return Object.freeze({
    name, role, requiresFit: false,
    fit() { return Object.freeze({ fitted: true, zeroShot: true, name }); },
    predict(_model, rows, { cfg, caps, panel, horizon, pitFor, fixture }) {
      const out = new Map();
      // The adapters batch per decision date: every name on a date shares the same market and
      // sector context, and batching keeps the sidecar call count proportional to dates.
      for (const [, group] of byDate(rows)) {
        const res = adapter.forecastBatch({ rows: group, panel, cfg, caps, horizon, fixture, pitFor });
        for (const r of group) {
          const f = res.get(r.ticker);
          if (f) out.set(rowKey(r), f);
        }
      }
      return out;
    },
  });
}

const chronosModel = foundationModel(CHRONOS, 'chronos2', 'primary');
const moiraiModel = foundationModel(MOIRAI, 'moirai2', 'challenger');

const ALL = Object.freeze({ ridge: ridgeModel, chronos2: chronosModel, moirai2: moiraiModel });

/**
 * The base models a run may actually use.
 * Ridge is ALWAYS included — it is the permanent baseline and the minimum operational fallback.
 * A foundation model is included only when capabilities say it can run (or fixture mode is on,
 * which is a test-only path that stamps its output as synthetic).
 */
function activeBaseModels(cfg, caps, { includeFixtures = false } = {}) {
  const out = [ridgeModel];
  const enabled = new Set(cfg.models.enabled || []);
  for (const [name, model] of [['chronos2', chronosModel], ['moirai2', moiraiModel]]) {
    if (!enabled.has(name)) continue;
    const status = caps && caps.components ? caps.components[name] : null;
    if ((status && status.available) || includeFixtures) out.push(model);
  }
  return out;
}

/** Availability summary for the manifest — why each model is or is not in the run. */
function availabilitySummary(cfg, caps) {
  const summary = {};
  for (const name of ['ridge', 'chronos2', 'moirai2']) {
    const s = caps && caps.components ? caps.components[name] : null;
    summary[name] = s
      ? { available: s.available, availability: s.availability, reason: s.reason, packageVersion: s.packageVersion || null }
      : { available: name === 'ridge', availability: name === 'ridge' ? AVAILABILITY.OK : AVAILABILITY.DISABLED, reason: 'capabilities not resolved', packageVersion: null };
  }
  return summary;
}

module.exports = { BASE_MODELS_VERSION, ALL, ridgeModel, chronosModel, moiraiModel, activeBaseModels, availabilitySummary, rowKey, byDate };
