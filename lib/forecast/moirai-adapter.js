'use strict';
// MOIRAI-2 ADAPTER (forecast-moirai2-adapter-v1) — OPTIONAL CHALLENGER forecaster.
//
// Challenger status is the DEFAULT, not a demotion: Moirai-2 must earn its ensemble weight from
// realized out-of-sample performance like every other component (lib/forecast/ensemble.js).
//
// Moirai's supported input mode differs from Chronos-2's — the uni2ts predictor path this
// adapter targets is univariate over the target series, with no covariate channel — so this
// adapter does NOT pretend to pass related series. That reduced capability is recorded on every
// record rather than hidden, which is why the two adapters are separate files instead of one
// parameterized one.
//
// VERSION DISCIPLINE: only a uni2ts release exposing `uni2ts.model.moirai2` counts. Moirai-1 is
// reported as `incompatible-version`, never substituted.
//
// INTEGRATION STATUS: unverified against a live checkpoint in this repository's environment.

const sidecar = require('./sidecar');
const { AVAILABILITY, makeModelIdentity, unavailableForecast } = require('./contract');
const FC = require('./foundation-common');

const MOIRAI_ADAPTER_VERSION = 'forecast-moirai2-adapter-v1';
const NAME = 'moirai2';
const ROLE = 'challenger';

function identityFor(cfg, extra = {}) {
  return makeModelIdentity({
    name: NAME, role: ROLE,
    modelId: cfg.models.moirai2.modelId, revision: cfg.models.moirai2.revision,
    packageName: 'uni2ts',
    contextLength: cfg.models.moirai2.contextLength,
    configHash: cfg.configHash, codeVersion: MOIRAI_ADAPTER_VERSION,
    ...extra,
  });
}

function buildRequest(rows, panel, cfg, horizon) {
  const m = cfg.models.moirai2;
  const series = [];
  const kept = [];
  for (const row of rows) {
    const entry = panel.dataset.get(row.ticker);
    const bIdx = panel.bench.idx.get(row.decisionDate);
    if (!entry || bIdx == null) continue;
    const idx = entry.idx.get(row.decisionDate);
    if (idx == null) continue;
    const ctx = FC.residualReturnSeries(entry.candles, idx, panel.bench.candles, bIdx, row.betaMarket, m.contextLength);
    if (!ctx) continue;
    // Univariate only: this predictor path takes no covariates, so none are sent.
    series.push({ id: row.ticker, context: ctx.values });
    kept.push(row);
  }
  return {
    request: {
      modelId: m.modelId, revision: m.revision, device: m.device, dtype: m.dtype,
      contextLength: m.contextLength, batchSize: m.batchSize, numSamples: m.numSamples,
      predictionLength: horizon, quantileLevels: [...cfg.quantiles],
      series,
    },
    kept,
  };
}

function forecastBatch({ rows, panel, cfg, caps, horizon, fixture = null, pitFor = () => null }) {
  const out = new Map();
  const status = caps && caps.components ? caps.components.moirai2 : { available: false, availability: AVAILABILITY.DISABLED, reason: 'capabilities not resolved' };
  const useFixture = fixture || (process.env.FORECAST_FIXTURE_MODE === '1' ? 'auto' : null);

  if (!status.available && !useFixture) {
    const identity = identityFor(cfg, { packageVersion: status.packageVersion || null });
    for (const row of rows) {
      out.set(row.ticker, unavailableForecast({
        securityId: row.securityId, ticker: row.ticker, horizon, pit: pitFor(row),
        model: identity, availability: status.availability, reason: status.reason, notes: status.notes || [],
      }));
    }
    return out;
  }

  const { request, kept } = buildRequest(rows, panel, cfg, horizon);
  const keptSet = new Set(kept.map((r) => r.ticker));

  let response;
  if (useFixture) {
    const gen = typeof fixture === 'function' ? fixture : null;
    response = {
      model: { modelId: `fixture:${cfg.models.moirai2.modelId}`, revision: 'fixture', packageName: 'fixture', packageVersion: '0', device: 'cpu', dtype: 'float64', contextLength: cfg.models.moirai2.contextLength },
      capabilities: { covariates: false, quantileLevels: [...cfg.quantiles] },
      notes: ['SYNTHETIC FIXTURE OUTPUT — not a real Moirai-2 forecast'],
      forecasts: request.series.map((s, i) => (gen ? gen(s, horizon, cfg) : { id: s.id, ...FC.fixturePath(s.context, horizon, cfg.quantiles, cfg.seed + 7919 + i) })),
    };
  } else {
    const r = sidecar.runScript('moirai2.py', request, { timeoutMs: 900000 });
    if (!r.ok) {
      const availability = (r.detail && r.detail.availability) || AVAILABILITY.INFERENCE_FAILED;
      const identity = identityFor(cfg, { packageVersion: (r.detail && r.detail.packageVersion) || null });
      for (const row of rows) {
        out.set(row.ticker, unavailableForecast({
          securityId: row.securityId, ticker: row.ticker, horizon, pit: pitFor(row),
          model: identity, availability, reason: r.error, notes: r.stderr ? [`stderr: ${r.stderr.slice(0, 300)}`] : [],
        }));
      }
      return out;
    }
    response = { ...r.data, latencyMs: r.elapsedMs };
  }

  const byId = new Map((response.forecasts || []).map((f) => [f.id, f]));
  const extraNotes = useFixture ? ['synthetic-fixture'] : [];
  for (const row of rows) {
    if (!keptSet.has(row.ticker)) {
      out.set(row.ticker, unavailableForecast({
        securityId: row.securityId, ticker: row.ticker, horizon, pit: pitFor(row),
        model: identityFor(cfg), availability: AVAILABILITY.INSUFFICIENT_HISTORY,
        reason: 'not enough point-in-time residual-return history for the requested context',
      }));
      continue;
    }
    out.set(row.ticker, FC.normalizeForecast({
      entry: byId.get(row.ticker), request, response, name: NAME, role: ROLE,
      cfg, row, horizon, pit: pitFor(row), extraNotes,
    }));
  }
  return out;
}

module.exports = { MOIRAI_ADAPTER_VERSION, NAME, ROLE, forecastBatch, buildRequest, identityFor };
