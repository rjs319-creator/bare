'use strict';
// CHRONOS-2 ADAPTER (forecast-chronos2-adapter-v1) — PRIMARY foundation forecaster (optional).
//
// Forecasts a RESIDUAL-RETURN sequence, never a raw price: the primary target of this system is
// a market/sector-neutralized return, and a price forecast would have to be differenced and
// neutralized afterwards anyway, losing the model's own uncertainty in the process.
//
// The adapter never probes for itself — lib/forecast/capabilities.js decides availability, and
// this module honours that decision. When Chronos-2 is unavailable it returns a Forecast record
// per row carrying the exact reason (package missing / python too old / wrong generation /
// checkpoint missing / inference failed), NOT a zero.
//
// VERSION DISCIPLINE: chronos-forecasting 1.x is Chronos-1/Bolt. The sidecar refuses it; this
// adapter therefore never silently reports a different generation as "Chronos-2".
//
// INTEGRATION STATUS: unverified against a live checkpoint in this repository's environment.
// See docs/FORECAST-RANKING-SYSTEM.md — the deterministic fixture path is what the unit tests
// exercise, and a fixture forecast is stamped as synthetic so it can never enter a benchmark.

const sidecar = require('./sidecar');
const { AVAILABILITY, makeModelIdentity, unavailableForecast } = require('./contract');
const FC = require('./foundation-common');

const CHRONOS_ADAPTER_VERSION = 'forecast-chronos2-adapter-v1';
const NAME = 'chronos2';
const ROLE = 'primary';

function identityFor(cfg, extra = {}) {
  return makeModelIdentity({
    name: NAME, role: ROLE,
    modelId: cfg.models.chronos2.modelId, revision: cfg.models.chronos2.revision,
    packageName: 'chronos-forecasting',
    contextLength: cfg.models.chronos2.contextLength,
    configHash: cfg.configHash, codeVersion: CHRONOS_ADAPTER_VERSION,
    ...extra,
  });
}

/** Build the sidecar request for a batch of rows. Returns { request, kept } — `kept` are the rows with usable context. */
function buildRequest(rows, panel, cfg, horizon) {
  const c = cfg.models.chronos2;
  const series = [];
  const kept = [];
  for (const row of rows) {
    const entry = panel.dataset.get(row.ticker);
    const bIdx = panel.bench.idx.get(row.decisionDate);
    if (!entry || bIdx == null) continue;
    const idx = entry.idx.get(row.decisionDate);
    if (idx == null) continue;
    const ctx = FC.residualReturnSeries(entry.candles, idx, panel.bench.candles, bIdx, row.betaMarket, c.contextLength);
    if (!ctx) continue;
    const etf = panel.sectorEtfOf(row.ticker);
    const sec = etf ? panel.sectorSeries.get(etf) : null;
    const sIdx = sec ? (sec.idx.get(row.decisionDate) ?? -1) : -1;
    series.push({
      id: row.ticker,
      context: ctx.values,
      related: FC.relatedSeries(panel.bench.candles, bIdx, sec ? sec.candles : null, sIdx, c.contextLength),
      knownFuture: null,
    });
    kept.push(row);
  }
  return {
    request: {
      modelId: c.modelId, revision: c.revision, device: c.device, dtype: c.dtype,
      contextLength: c.contextLength, batchSize: c.batchSize,
      predictionLength: horizon, quantileLevels: [...cfg.quantiles],
      series,
    },
    kept,
  };
}

/**
 * Forecast a batch of rows at one horizon.
 * Returns Map(ticker -> Forecast). Every input row gets an entry — an unavailable model yields
 * an explicitly-unavailable record, never a missing key and never a zero.
 */
function forecastBatch({ rows, panel, cfg, caps, horizon, fixture = null, pitFor = () => null }) {
  const out = new Map();
  const status = caps && caps.components ? caps.components.chronos2 : { available: false, availability: AVAILABILITY.DISABLED, reason: 'capabilities not resolved' };

  const useFixture = fixture || (process.env.FORECAST_FIXTURE_MODE === '1' ? 'auto' : null);

  if (!status.available && !useFixture) {
    const identity = identityFor(cfg, { packageVersion: status.packageVersion || null });
    for (const row of rows) {
      out.set(row.ticker, unavailableForecast({
        securityId: row.securityId, ticker: row.ticker, horizon, pit: pitFor(row),
        model: identity, availability: status.availability, reason: status.reason,
        notes: status.notes || [],
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
      model: { modelId: `fixture:${cfg.models.chronos2.modelId}`, revision: 'fixture', packageName: 'fixture', packageVersion: '0', device: 'cpu', dtype: 'float64', contextLength: cfg.models.chronos2.contextLength },
      capabilities: { covariates: true, quantileLevels: [...cfg.quantiles] },
      notes: ['SYNTHETIC FIXTURE OUTPUT — not a real Chronos-2 forecast'],
      forecasts: request.series.map((s, i) => (gen ? gen(s, horizon, cfg) : { id: s.id, ...FC.fixturePath(s.context, horizon, cfg.quantiles, cfg.seed + i) })),
    };
  } else {
    const r = sidecar.runScript('chronos2.py', request, { timeoutMs: 900000 });
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

module.exports = { CHRONOS_ADAPTER_VERSION, NAME, ROLE, forecastBatch, buildRequest, identityFor };
