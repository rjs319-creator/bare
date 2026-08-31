'use strict';
// CFR CONFIGURATION (forecast-config-v1) — one place that declares every knob of the
// cross-sectional forecast & ranking system, plus the env overrides that change it.
//
// Nothing here reads the network, the clock, or the filesystem. `resolveConfig()` returns a
// FROZEN, fully-defaulted config whose `configHash` identifies the exact settings a run used;
// the hash goes into every manifest so an artifact trained under one config can never be
// silently reused under another (see lib/forecast/registry.js).

const crypto = require('crypto');

const FORECAST_CONFIG_VERSION = 'forecast-config-v1';

// The four supported horizons, in TRADING SESSIONS. Fixed by the product contract.
const HORIZONS = Object.freeze([1, 3, 5, 10]);

// Quantile grid. Anything a model cannot genuinely produce is reported missing, never invented.
const QUANTILES = Object.freeze([0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95]);

// Residual-return thresholds for the probability heads, as FRACTIONS.
const RETURN_THRESHOLDS = Object.freeze([0, 0.03, 0.05]);
// Peak-to-trough drawdown threshold during the holding window, as a POSITIVE fraction.
const DRAWDOWN_THRESHOLD = 0.05;

const DEFAULTS = Object.freeze({
  version: FORECAST_CONFIG_VERSION,

  // ── Prediction / execution timing ────────────────────────────────────────
  // Signal is computed from bars at or before the decision session's CLOSE and is tradable at
  // the NEXT session's open. This reuses lib/execution-policy.js POLICIES.NEXT_OPEN — the
  // convention the rest of this repo already grades against.
  execution: Object.freeze({
    policy: 'next-open',
    signalCutoff: 'decision-session-close',
    entry: 'next-session-open',
    exit: 'close-of-session(decision + h)',
    minSignalDelaySessions: 1,
  }),

  horizons: HORIZONS,
  quantiles: QUANTILES,
  returnThresholds: RETURN_THRESHOLDS,
  drawdownThreshold: DRAWDOWN_THRESHOLD,

  // ── Universe ─────────────────────────────────────────────────────────────
  universe: Object.freeze({
    minPrice: 3,
    minAvgDollarVolume: 5e6,
    advLookback: 60,
    minHistorySessions: 300,     // enough for a 252-bar feature plus a beta window
    maxNames: 12000,
    maxStaleSessions: 3,         // a name whose last bar is older than this is excluded that date
    excludedSectors: Object.freeze([]),
    requireSector: false,        // names without a sector map fall back to market-only residual
    extremeOneDayMove: 0.50,     // suspected unadjusted corporate action → name-date excluded
  }),

  // ── Target ───────────────────────────────────────────────────────────────
  target: Object.freeze({
    definition: 'residual-mkt-sector-v1',
    version: 'forecast-target-v1',
    benchmark: 'SPY',
    sectorProxy: 'spdr-sector-etf',
    betaMethod: 'ols-trailing-orthogonalized',
    betaLookback: 126,
    betaMinObs: 60,
    betaShrink: 0.25,            // shrink toward 1.0 (market) / 0.0 (sector) — Vasicek-style
    betaClamp: Object.freeze({ market: [0, 3], sector: [-1.5, 2.5] }),
  }),

  // ── Features ─────────────────────────────────────────────────────────────
  features: Object.freeze({
    version: 'forecast-features-v1',
    groups: Object.freeze(['trailing', 'volatility', 'liquidity', 'beta', 'crosssection', 'calendar', 'quality']),
    winsorizeP: 0.01,            // fit on TRAIN rows only
    crossSectionMinNames: 20,    // below this a date's cross-sectional transforms are unreliable
    // Date-constant columns (calendar terms, date-level breadth/dispersion/count) cannot change a
    // WITHIN-DATE ordering, but a tree can split on them to fit date means. Excluded by default;
    // see lib/forecast/xsection.js modelFeatureKeys.
    includeDateConstant: false,
    // Scope of the within-date rank transform: 'market' ranks against every name on the date,
    // 'sector' against the name's own sector. The target is sector-neutralized, so a market-wide
    // rank partly encodes a dimension the target already removed — but the neutralization uses
    // estimated betas and is imperfect, so this is an empirical question. Default stays 'market'
    // (the already-measured behaviour) until the A/B says otherwise.
    crossSectionScope: 'market',
  }),

  // ── Walk-forward ─────────────────────────────────────────────────────────
  walkforward: Object.freeze({
    scheme: 'expanding',         // 'expanding' | 'rolling'
    minTrainSessions: 250,
    testSessions: 63,            // one quarter per outer test block
    rollingTrainSessions: 504,
    embargoSessions: null,       // null → max(horizon) + 2, computed per fold
    embargoExtra: 2,
    innerFolds: 3,               // chronological inner folds used for cross-fitting
    innerEmbargoExtra: 2,
    stepSessions: null,          // null → testSessions (non-overlapping test blocks)
    holdoutFraction: 0.2,        // final untouched chronological holdout
  }),

  // ── Models ───────────────────────────────────────────────────────────────
  models: Object.freeze({
    enabled: Object.freeze(['ridge', 'chronos2', 'moirai2']),
    ridge: Object.freeze({
      lambda: 10,
      arLags: 5,
      standardize: true,
      residualQuantileMinObs: 200,
    }),
    chronos2: Object.freeze({
      modelId: 'amazon/chronos-2',
      revision: null,            // pin before any production use
      contextLength: 512,
      batchSize: 64,
      device: 'auto',
      dtype: 'float32',
      series: 'residual-return',
      enabled: true,
    }),
    moirai2: Object.freeze({
      modelId: 'Salesforce/moirai-2.0-R-small',
      revision: null,
      contextLength: 512,
      patchSize: 'auto',
      numSamples: 100,
      batchSize: 32,
      device: 'auto',
      dtype: 'float32',
      enabled: true,
      role: 'challenger',
    }),
  }),

  // ── Meta-ranker ──────────────────────────────────────────────────────────
  metaRanker: Object.freeze({
    backend: 'lightgbm',         // 'lightgbm' | 'ridge-xs'
    // 'regression' (on the within-date z-scored residual) is the default because it is the loss
    // the evaluation metric actually is. 'lambdarank' optimizes NDCG over a truncated head and was
    // measured to be reliably anti-predictive for a full-cross-section rank IC — see the header of
    // lib/forecast/meta-ranker.js. 'auto' selects between them on chronological inner validation.
    objective: 'auto',           // 'auto' | 'regression' | 'lambdarank'
    relevanceBuckets: 5,
    // Capacity is deliberately modest: the first configuration reached an in-sample rank IC of
    // 0.31 against 0.035 on an inner held-out block, which is a model memorizing its training
    // period rather than learning a cross-section.
    numLeaves: 15,
    learningRate: 0.03,
    numRounds: 400,              // an upper bound; early stopping picks the number actually used
    minDataInLeaf: 200,
    featureFraction: 0.6,
    baggingFraction: 0.7,
    baggingFreq: 1,
    lambdaL1: 0.5,
    lambdaL2: 5.0,
    // Chronological inner validation: the last slice of the cross-fitted history, purged by exact
    // label end, used for early stopping AND objective selection. Never the outer test block.
    innerValidFraction: 0.20,
    // Several chronological inner blocks, not one: a single ~20-date block has a rank-IC standard
    // error comparable to the effect being measured, and it picked the wrong objective twice.
    innerValidBlocks: 3,
    // ABSTENTION GATE. Below these the meta-ranker declines to rank and the dynamic ensemble is
    // used instead. Measured: ungated, the model beat the baseline at h=5 and was reliably worse
    // at h=1 — running only where inner validation says it earns it is the honest behaviour.
    minInnerRankIC: 0.0,
    // The decisive test: the meta-ranker must beat the PERMANENT BASELINE on inner validation,
    // not merely be positive — the baseline is already positive. The baseline's inner-block rank
    // IC is free to compute, because the cross-fitted frames already carry its out-of-fold
    // prediction for exactly those rows.
    minInnerEdgeOverBaseline: 0.002,
    minInnerPositiveBlocks: 2,
    earlyStoppingRounds: 40,
    // The sidecar sweeps iteration counts on the validation block in steps of `rankIcStep` and
    // reports the one maximizing mean per-group Spearman — the metric the scoreboard reports.
    rankIcStep: 10,
    minRounds: 10,
    seed: 20260829,
    numThreads: 4,
    monotoneConstraints: null,   // only when economically defensible
  }),

  // ── Calibration ──────────────────────────────────────────────────────────
  calibration: Object.freeze({
    method: 'isotonic',          // 'isotonic' | 'platt' | 'none'
    minSamples: 500,
    minPositives: 25,
    minNegatives: 25,
    bins: 10,
  }),

  // ── Dynamic ensemble weighting ───────────────────────────────────────────
  ensemble: Object.freeze({
    lookbackFolds: 4,
    minObservations: 250,
    minDates: 40,
    minWeight: 0.05,
    maxWeight: 0.70,
    shrinkToEqual: 0.5,          // 0 = pure metric weights, 1 = equal weights
    metric: 'rankIC',
    failureRatePenalty: 2.0,
    fallback: 'baseline-only',
  }),

  // ── Costs & portfolio ────────────────────────────────────────────────────
  costs: Object.freeze({
    model: 'lib/costs.js roundTripCostPct (tiered by dollar volume)',
    stressMultipliers: Object.freeze([1, 2, 3]),
  }),
  portfolio: Object.freeze({
    topK: 20,
    quantiles: 5,
    weighting: 'equal',          // 'equal' | 'score'
    maxWeightPerName: 0.10,
    maxWeightPerSector: 0.35,
    longOnly: true,              // this app does not support shorting in the research backtest
    overlappingSleeves: true,    // h staggered tranches, 1/h of capital each
    // NO-TRADE BAND. A held name is kept while it stays inside rank topK * noTradeBand; only
    // names inside the top topK are bought. 1 disables it (sell-and-rebuy every rebalance).
    // A name oscillating around rank K otherwise pays a round trip every period for no change in
    // exposure — the largest avoidable cost in a small-edge strategy.
    noTradeBand: 2.0,
  }),

  // ── Score ────────────────────────────────────────────────────────────────
  score: Object.freeze({
    version: 'forecast-score-v1',
    bucket: 1,                   // round to whole points; widen when calibration is thin
    weights: Object.freeze({
      rank: 0.40,
      probUp: 0.20,
      magnitude: 0.15,
      drawdownRisk: -0.10,
      uncertainty: -0.05,
      agreement: 0.05,
      reliability: 0.05,
      liquidityCost: -0.05,
      freshness: 0.05,
    }),
  }),

  // ── Reproducibility ──────────────────────────────────────────────────────
  seed: 20260829,
  artifactDir: null,             // null → research/data/forecast (research-side default)
});

// Numeric env override helper — an unparseable value is IGNORED (never silently zero).
function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function envStr(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}
function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

// Deep-freeze a plain object tree so a resolved config cannot be mutated by a consumer.
function deepFreeze(o) {
  if (o == null || typeof o !== 'object' || Object.isFrozen(o)) return o;
  for (const v of Object.values(o)) deepFreeze(v);
  return Object.freeze(o);
}

// Shallow-merge one level deep (the config is intentionally only two levels deep).
function mergeSection(base, over) {
  if (!over) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? { ...base[k], ...v }
      : v;
  }
  return out;
}

// Stable stringify (sorted keys) so the config hash does not depend on key order.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function configHash(cfg) {
  return crypto.createHash('sha256').update(stableStringify(cfg)).digest('hex').slice(0, 16);
}

/**
 * Resolve the effective config: DEFAULTS ← env overrides ← explicit `overrides`.
 * Returns a frozen config carrying its own `configHash`.
 */
function resolveConfig(overrides = {}) {
  const env = {
    seed: envNum('FORECAST_SEED', DEFAULTS.seed),
    artifactDir: envStr('FORECAST_ARTIFACT_DIR', DEFAULTS.artifactDir),
    models: {
      enabled: envStr('FORECAST_MODELS', null)
        ? envStr('FORECAST_MODELS', '').split(',').map((s) => s.trim()).filter(Boolean)
        : DEFAULTS.models.enabled,
      chronos2: { ...DEFAULTS.models.chronos2, enabled: envBool('FORECAST_CHRONOS2', DEFAULTS.models.chronos2.enabled), modelId: envStr('FORECAST_CHRONOS2_MODEL', DEFAULTS.models.chronos2.modelId), revision: envStr('FORECAST_CHRONOS2_REVISION', DEFAULTS.models.chronos2.revision) },
      moirai2: { ...DEFAULTS.models.moirai2, enabled: envBool('FORECAST_MOIRAI2', DEFAULTS.models.moirai2.enabled), modelId: envStr('FORECAST_MOIRAI2_MODEL', DEFAULTS.models.moirai2.modelId), revision: envStr('FORECAST_MOIRAI2_REVISION', DEFAULTS.models.moirai2.revision) },
      ridge: DEFAULTS.models.ridge,
    },
    metaRanker: { ...DEFAULTS.metaRanker, backend: envStr('FORECAST_META_BACKEND', DEFAULTS.metaRanker.backend), objective: envStr('FORECAST_META_OBJECTIVE', DEFAULTS.metaRanker.objective) },
    walkforward: {
      ...DEFAULTS.walkforward,
      testSessions: envNum('FORECAST_TEST_SESSIONS', DEFAULTS.walkforward.testSessions),
      minTrainSessions: envNum('FORECAST_MIN_TRAIN_SESSIONS', DEFAULTS.walkforward.minTrainSessions),
      innerFolds: envNum('FORECAST_INNER_FOLDS', DEFAULTS.walkforward.innerFolds),
    },
    universe: { ...DEFAULTS.universe, maxNames: envNum('FORECAST_MAX_NAMES', DEFAULTS.universe.maxNames), minAvgDollarVolume: envNum('FORECAST_MIN_ADV', DEFAULTS.universe.minAvgDollarVolume) },
    features: { ...DEFAULTS.features, crossSectionScope: envStr('FORECAST_XS_SCOPE', DEFAULTS.features.crossSectionScope) },
    portfolio: { ...DEFAULTS.portfolio, noTradeBand: envNum('FORECAST_NO_TRADE_BAND', DEFAULTS.portfolio.noTradeBand) },
  };

  let cfg = { ...DEFAULTS };
  for (const key of Object.keys(env)) cfg[key] = mergeSection(DEFAULTS[key] || {}, env[key]);
  cfg.seed = env.seed;
  cfg.artifactDir = env.artifactDir;
  for (const key of Object.keys(overrides)) {
    cfg[key] = (overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key]))
      ? mergeSection(cfg[key] || {}, overrides[key])
      : overrides[key];
  }
  cfg.configHash = configHash({ ...cfg, configHash: undefined });
  return deepFreeze(cfg);
}

module.exports = {
  FORECAST_CONFIG_VERSION, HORIZONS, QUANTILES, RETURN_THRESHOLDS, DRAWDOWN_THRESHOLD,
  DEFAULTS, resolveConfig, configHash, stableStringify,
};
