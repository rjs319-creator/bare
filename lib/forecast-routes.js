'use strict';
// CFR ROUTE HANDLERS — the cross-sectional forecast & ranking system's read-only API surface.
//
//   op=forecastcaps   what this environment can actually run, and how to raise the tier
//   op=forecastboard  the persisted walk-forward benchmark (model scoreboard by horizon)
//   op=forecastrank   live ranking for a decision date
//
// ALL THREE ARE READ-ONLY. Nothing here places an order, alters a portfolio, writes a ledger or
// promotes anything: this is decision support, and every response says so.
//
// ENVIRONMENT HONESTY. The panel is built from the local research cache (`research/data/`),
// which is gitignored and therefore NOT present in a serverless deployment. `op=forecastrank`
// says exactly that rather than returning an empty board, and `op=forecastboard` reports whether
// it is reading a real artifact or nothing at all. No route fabricates a result.

const fs = require('fs');
const path = require('path');

const FORECAST_ROUTES_VERSION = 'forecast-routes-v1';

const ARTIFACT_PATH = process.env.FORECAST_ARTIFACT_PATH
  || path.join(__dirname, '..', 'research', 'data', 'forecast', 'walkforward-result.json');

const DISCLAIMER = 'Research and decision support only. Forecasts are uncertain; a high opportunity score is not a guarantee and is not a probability. Backtests may be biased or overfit. After-cost walk-forward out-of-sample evidence is what counts, and no result here places trades or promotes any strategy.';

function lazy() {
  // Required lazily so importing the route module never pulls the whole system (or probes for
  // Python) into an unrelated request path.
  return require('./forecast');
}

function resolved(overrides = {}) {
  const F = lazy();
  const cfg = F.config.resolveConfig(overrides);
  return { F, cfg, caps: F.capabilities.detectCapabilities(cfg) };
}

/** op=forecastcaps — capability tier, per-component reason, and actionable setup hints. */
async function runForecastCaps(req, res) {
  const { F, cfg, caps } = resolved();
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  return res.json({
    ok: true,
    version: FORECAST_ROUTES_VERSION,
    tier: caps.tier,
    tierLabel: caps.tierLabel,
    fallbackHierarchy: [
      '1  chronos2 + moirai2 + ridge + lightgbm',
      '2  chronos2 + ridge + lightgbm',
      '3  moirai2 + ridge + lightgbm',
      '4  ridge + lightgbm',
      '5  ridge + ridge-xs cross-sectional ranker',
      '6  ridge only',
    ],
    baseModels: caps.baseModels,
    metaBackend: caps.metaBackend,
    components: caps.components,
    degraded: caps.degraded,
    sidecar: caps.sidecar,
    setupHints: F.capabilities.setupHints(caps),
    config: { configHash: cfg.configHash, horizons: cfg.horizons, quantiles: cfg.quantiles, target: cfg.target.definition, execution: cfg.execution },
    note: DISCLAIMER,
  });
}

/** Read the persisted benchmark artifact, or say precisely why there is none. */
function readArtifact() {
  try {
    if (!fs.existsSync(ARTIFACT_PATH)) {
      return { ok: false, reason: `no benchmark artifact at ${ARTIFACT_PATH}. Generate one with: node --max-old-space-size=8192 research/88-forecast-walkforward.js (requires the local research cache, which is gitignored and absent from serverless deployments).` };
    }
    return { ok: true, doc: JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8')) };
  } catch (e) {
    return { ok: false, reason: `benchmark artifact unreadable: ${String((e && e.message) || e)}` };
  }
}

/**
 * op=forecastboard — the model scoreboard from the last walk-forward run.
 * Query: horizon (optional), full=1 to include per-fold rows.
 */
async function runForecastBoard(req, res) {
  const art = readArtifact();
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  if (!art.ok) return res.json({ ok: true, available: false, reason: art.reason, version: FORECAST_ROUTES_VERSION, note: DISCLAIMER });

  const doc = art.doc;
  const wanted = req.query && req.query.horizon ? Number(req.query.horizon) : null;
  const full = req.query && req.query.full === '1';

  const horizons = {};
  for (const [h, v] of Object.entries(doc.horizons || {})) {
    if (wanted && Number(h) !== wanted) continue;
    horizons[h] = v.ok ? {
      ok: true,
      rows: v.rows,
      classPrevalence: v.classPrevalence,
      folds: v.folds.length,
      foldDefinitions: v.folds,
      auditOk: v.auditOk,
      development: v.development,
      holdout: v.holdout,
      // Evaluation types are kept apart on purpose: only walk-forward OOS may inform anything.
      walkForwardOos: v.comparison,
      finalHoldout: v.holdoutResult && v.holdoutResult.ok ? v.holdoutResult.comparison : null,
      finalHoldoutStatus: v.holdoutResult && v.holdoutResult.ok ? 'scored-once' : (v.holdoutResult && v.holdoutResult.reason) || 'not scored',
      scoreboardRows: full ? v.scoreboardRows : undefined,
    } : v;
  }

  return res.json({
    ok: true, available: true, version: FORECAST_ROUTES_VERSION,
    generatedAt: doc.generatedAt,
    manifestHash: doc.manifest && doc.manifest.manifestHash,
    capabilities: doc.capabilities,
    data: doc.data,
    contract: doc.contract,
    evaluationTypes: {
      'walk-forward-oos': 'true out-of-sample; the only tier that may inform eligibility, selection, calibration or weighting',
      'final-holdout': 'read once, reported separately, influences nothing',
      'cross-fitted': 'the frames the meta-ranker and calibrators were allowed to learn from',
    },
    horizons,
    honesty: doc.honesty,
    note: DISCLAIMER,
  });
}

/**
 * op=forecastrank — live ranking for a decision date.
 * Query: horizon (default 5), asOf (default the panel's last session), limit (default 25).
 *
 * Requires the local research cache. In an environment without it this returns
 * `available:false` and the exact reason — never an empty or fabricated board.
 */
async function runForecastRank(req, res) {
  const horizon = Number((req.query && req.query.horizon) || 5);
  const limit = Math.max(1, Math.min(200, Number((req.query && req.query.limit) || 25)));
  const asOf = (req.query && req.query.asOf) || null;

  // Validate against the CANONICAL horizon list before resolving a config — resolving with
  // `horizons: [horizon]` would make any value validate against itself.
  const forecast = lazy();
  if (!forecast.config.HORIZONS.includes(horizon)) {
    return res.status(400).json({ ok: false, reason: `horizon must be one of ${forecast.config.HORIZONS.join(',')}` });
  }
  const { F, cfg, caps } = resolved({
    horizons: [horizon],
    universe: { maxNames: Number(process.env.FORECAST_MAX_NAMES || 800), minAvgDollarVolume: Number(process.env.FORECAST_MIN_ADV || 2e7) },
  });

  // THE ONLY live -> research-data coupling in this subsystem, and it is deliberately explicit,
  // lazy and guarded: the loader lives on the research side (research/lib/forecast-panel.js) so
  // lib/forecast/ itself stays free of research artifact reads. research/data/ is gitignored and
  // is NOT deployed, so in a serverless environment this branch is the expected one.
  let panel;
  try {
    ({ panel } = require('../research/lib/forecast-panel').loadPanel(cfg));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ok: true, available: false, version: FORECAST_ROUTES_VERSION,
      reason: `the local research price cache is not available in this environment: ${String((e && e.message) || e)}`,
      hint: 'research/data/ is gitignored and is not deployed. Run this op locally, or point RESEARCH_DATA_DIR at a populated cache.',
      capabilities: { tier: caps.tier, tierLabel: caps.tierLabel, degraded: caps.degraded },
      note: DISCLAIMER,
    });
  }

  const out = F.infer.runInference({
    panel, cfg, caps, asOf, horizons: [horizon],
    trainSessions: Number(process.env.FORECAST_TRAIN_SESSIONS || 500),
    dateStride: Number(process.env.FORECAST_STRIDE || 5),
  });
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  if (!out.ok) return res.json({ ok: true, available: false, reason: out.reason, version: FORECAST_ROUTES_VERSION, note: DISCLAIMER });

  const h = out.horizons[horizon];
  if (!h || !h.ok) return res.json({ ok: true, available: false, reason: (h && h.reason) || 'no result for this horizon', version: FORECAST_ROUTES_VERSION, note: DISCLAIMER });

  return res.json({
    ok: true, available: true, version: FORECAST_ROUTES_VERSION,
    asOf: out.asOf,
    horizon,
    evaluationType: 'live-prediction',
    target: { definition: cfg.target.definition, version: cfg.target.version, benchmark: cfg.target.benchmark, note: 'the prediction is a market- and sector-neutralized RESIDUAL return, not a price' },
    execution: cfg.execution,
    capabilities: out.capabilities,
    modelAvailability: out.modelAvailability,
    rankerBackend: h.rankerBackend,
    ensembleWeights: h.weights,
    calibration: h.calibration,
    cohortSize: h.cohortSize,
    manifestHash: out.manifest.manifestHash,
    rows: h.rows.slice(0, limit),
    truncated: h.rows.length > limit,
    note: DISCLAIMER,
  });
}

module.exports = { FORECAST_ROUTES_VERSION, ARTIFACT_PATH, DISCLAIMER, runForecastCaps, runForecastBoard, runForecastRank, readArtifact };
