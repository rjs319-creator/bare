'use strict';
// CFR OUTPUT CONTRACT (forecast-contract-v1) — the single shape every forecaster speaks.
//
// Chronos-2, Moirai-2 and the Ridge/AR baseline have different native APIs and are NOT forced
// into identical preprocessing. They are normalized HERE, on the way out, so the meta-ranker,
// the ensemble, the scoreboard and the API all consume one record shape.
//
// Two rules the factories enforce rather than trust:
//   1. A missing number is `null`, never 0. `makeForecast` will not accept a point estimate for
//      a record whose `availability` is not 'ok' — a degraded model returns a record that SAYS
//      it is degraded instead of a zero that looks like a prediction.
//   2. Every record carries its own point-in-time stamps (`asOf`, `tradableAt`, `labelStart`,
//      `labelEnd`, `maxSourceTs`) so a downstream leakage audit can prove what it was allowed
//      to see (lib/forecast/leakage.js).
//
// Pure & dependency-free: no clock, no network, no store.

const FORECAST_CONTRACT_VERSION = 'forecast-contract-v1';

// Availability is a closed vocabulary — a caller can switch on it exhaustively.
const AVAILABILITY = Object.freeze({
  OK: 'ok',                       // ran, output usable
  DEGRADED: 'degraded',           // ran, but with reduced capability (fewer quantiles, no covariates…)
  PACKAGE_MISSING: 'package-missing',
  CHECKPOINT_MISSING: 'checkpoint-missing',
  INCOMPATIBLE_VERSION: 'incompatible-version',
  RESOURCE_EXHAUSTED: 'resource-exhausted',
  INFERENCE_FAILED: 'inference-failed',
  DISABLED: 'disabled',
  INSUFFICIENT_HISTORY: 'insufficient-history',
});

const USABLE = new Set([AVAILABILITY.OK, AVAILABILITY.DEGRADED]);
const isUsable = (a) => USABLE.has(a);

const isFin = (v) => Number.isFinite(v);
const orNull = (v) => (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v)) ? null : v);
const num = (v) => (isFin(v) ? v : null);

// A probability must be a real number in [0,1]; anything else is null (unknown), not clamped
// silently to an edge — a model that emitted 1.7 has a bug we want visible.
function prob(v) {
  return isFin(v) && v >= 0 && v <= 1 ? v : null;
}

/**
 * Model identity + exact revision + the environment it ran in. Goes on every forecast so a
 * scoreboard row can be traced back to the artifact that produced it.
 */
function makeModelIdentity(input = {}) {
  return Object.freeze({
    schema: 'ForecastModelIdentity', version: FORECAST_CONTRACT_VERSION,
    name: orNull(input.name),                       // 'chronos2' | 'moirai2' | 'ridge' | 'lightgbm' | 'ensemble-dynamic'
    role: orNull(input.role) || 'candidate',        // 'primary' | 'challenger' | 'baseline' | 'meta' | 'ensemble'
    modelId: orNull(input.modelId),                 // e.g. 'amazon/chronos-2'
    revision: orNull(input.revision),               // exact checkpoint revision, null when unpinned
    packageName: orNull(input.packageName),
    packageVersion: orNull(input.packageVersion),
    device: orNull(input.device),
    dtype: orNull(input.dtype),
    contextLength: num(input.contextLength),
    artifactId: orNull(input.artifactId),
    trainCutoff: orNull(input.trainCutoff),         // last decision date the model was allowed to see
    dataCutoff: orNull(input.dataCutoff),           // last datum in the training panel
    configHash: orNull(input.configHash),
    codeVersion: orNull(input.codeVersion),
  });
}

/**
 * Point-in-time stamps for one prediction row.
 *   asOf        decision session (features computed from bars at or before its close)
 *   tradableAt  first session the signal can be executed in (next-open convention)
 *   labelStart  session whose OPEN is the entry fill
 *   labelEnd    session whose CLOSE ends the label — the purge/embargo axis
 *   maxSourceTs the latest source timestamp any input to this row carried
 */
function makePitStamps(input = {}) {
  return Object.freeze({
    schema: 'ForecastPitStamps', version: FORECAST_CONTRACT_VERSION,
    asOf: orNull(input.asOf),
    tradableAt: orNull(input.tradableAt),
    labelStart: orNull(input.labelStart),
    labelEnd: orNull(input.labelEnd),
    maxSourceTs: orNull(input.maxSourceTs),
    marketTimezone: orNull(input.marketTimezone) || 'America/New_York',
    session: orNull(input.session) || 'regular',
  });
}

/**
 * Data-quality flags travelling with a row. Every field defaults to the CONSERVATIVE value, so
 * a producer that forgets to set one does not accidentally claim clean data.
 */
function makeQualityFlags(input = {}) {
  return Object.freeze({
    schema: 'ForecastQuality', version: FORECAST_CONTRACT_VERSION,
    featureCoverage: num(input.featureCoverage),          // fraction of the feature vector present
    missingFeatures: Object.freeze([...(input.missingFeatures || [])]),
    staleSessions: num(input.staleSessions),
    historySessions: num(input.historySessions),
    suspectedCorporateAction: input.suspectedCorporateAction === true,
    sectorKnown: input.sectorKnown === true,
    sectorBasisPointInTime: input.sectorBasisPointInTime === true,  // default FALSE — see docs
    survivorshipSafe: input.survivorshipSafe === true,             // default FALSE
    warnings: Object.freeze([...(input.warnings || [])]),
  });
}

/**
 * THE forecaster output record. One per (securityId, asOf, horizon, model).
 *
 * `quantiles` is a { "0.05": number, ... } map over the configured grid; a model that cannot
 * produce a level omits it (the key is absent) rather than interpolating silently — see
 * lib/forecast/quantiles.js for the documented CDF interpolation that IS allowed.
 */
function makeForecast(input = {}) {
  const availability = orNull(input.availability) || AVAILABILITY.OK;
  const usable = isUsable(availability);

  const q = {};
  for (const [k, v] of Object.entries(input.quantiles || {})) {
    const level = Number(k);
    if (isFin(level) && level > 0 && level < 1 && isFin(v)) q[level.toFixed(2)] = +v;
  }

  const rec = {
    schema: 'Forecast', version: FORECAST_CONTRACT_VERSION,
    securityId: orNull(input.securityId),
    ticker: orNull(input.ticker),
    pit: input.pit && input.pit.schema === 'ForecastPitStamps' ? input.pit : makePitStamps(input.pit || {}),
    horizon: num(input.horizon),

    targetDefinition: orNull(input.targetDefinition),
    targetVersion: orNull(input.targetVersion),

    // A record that is not usable carries NO point estimate — never a zero standing in for one.
    point: usable ? num(input.point) : null,
    quantiles: Object.freeze(usable ? q : {}),
    sigma: usable ? num(input.sigma) : null,               // predictive sd, when the model has one
    intervalWidth80: usable ? num(input.intervalWidth80) : null,
    downsideTail: usable ? num(input.downsideTail) : null,  // q05 (or lowest available level)
    upsideTail: usable ? num(input.upsideTail) : null,      // q95
    skew: usable ? num(input.skew) : null,

    // Probability heads. Keys are the thresholds as fractions, e.g. '0', '0.03', '0.05',
    // plus 'drawdown' for P(peak-to-trough drawdown > threshold).
    probabilities: Object.freeze(usable ? Object.fromEntries(
      Object.entries(input.probabilities || {}).map(([k, v]) => [k, prob(v)]).filter(([, v]) => v !== null),
    ) : {}),
    probabilityStatus: orNull(input.probabilityStatus) || (usable ? 'uncalibrated' : 'unavailable'),

    model: input.model && input.model.schema === 'ForecastModelIdentity' ? input.model : makeModelIdentity(input.model || {}),
    quality: input.quality && input.quality.schema === 'ForecastQuality' ? input.quality : makeQualityFlags(input.quality || {}),

    availability,
    availabilityReason: orNull(input.availabilityReason),
    capabilityNotes: Object.freeze([...(input.capabilityNotes || [])]),
    latencyMs: num(input.latencyMs),
  };
  return Object.freeze(rec);
}

/** Convenience: an explicitly unavailable forecast, so callers never hand-roll a null record. */
function unavailableForecast({ model, availability, reason, notes = [], securityId = null, ticker = null, horizon = null, pit = null } = {}) {
  return makeForecast({
    securityId, ticker, horizon, pit: pit || makePitStamps({}),
    availability: availability || AVAILABILITY.INFERENCE_FAILED,
    availabilityReason: reason || null,
    capabilityNotes: notes,
    model,
  });
}

function validateForecast(f) {
  const errors = [];
  if (!f || f.schema !== 'Forecast') errors.push('not a Forecast record');
  else {
    if (!f.securityId && !f.ticker) errors.push('securityId or ticker required');
    if (!isFin(f.horizon)) errors.push('horizon must be a finite number');
    if (!Object.values(AVAILABILITY).includes(f.availability)) errors.push(`unknown availability "${f.availability}"`);
    if (isUsable(f.availability) && f.point === null && Object.keys(f.quantiles).length === 0) {
      errors.push('usable forecast must carry a point estimate or at least one quantile');
    }
    if (!isUsable(f.availability) && f.point !== null) errors.push('unusable forecast must not carry a point estimate');
    for (const [k, v] of Object.entries(f.probabilities)) {
      if (!(v >= 0 && v <= 1)) errors.push(`probability ${k} out of [0,1]`);
    }
    if (!f.pit || f.pit.schema !== 'ForecastPitStamps') errors.push('pit stamps missing');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * The scored row the ranking interface returns to the app / API. It is a superset of a
 * Forecast: the ensemble view plus score, rank, exposures, costs and eligibility.
 */
function makeScoredRow(input = {}) {
  return Object.freeze({
    schema: 'ForecastScoredRow', version: FORECAST_CONTRACT_VERSION,
    securityId: orNull(input.securityId),
    ticker: orNull(input.ticker),
    pit: input.pit && input.pit.schema === 'ForecastPitStamps' ? input.pit : makePitStamps(input.pit || {}),
    horizon: num(input.horizon),
    targetDefinition: orNull(input.targetDefinition),
    targetVersion: orNull(input.targetVersion),

    opportunityScore: num(input.opportunityScore),
    scoreStatus: orNull(input.scoreStatus) || 'uncalibrated',
    rank: num(input.rank),
    rankPercentile: num(input.rankPercentile),
    cohortSize: num(input.cohortSize),

    expectedResidualReturn: num(input.expectedResidualReturn),
    // Quantile keys are normalized to two decimals ("0.05", "0.10", …) exactly as `makeForecast`
    // does, so an API consumer sees one key format across every endpoint rather than "0.1" here
    // and "0.10" there.
    quantiles: Object.freeze(Object.fromEntries(
      Object.entries(input.quantiles || {})
        .map(([k, v]) => [Number(k), v])
        .filter(([lv, v]) => isFin(lv) && lv > 0 && lv < 1 && isFin(v))
        .sort((a, b) => a[0] - b[0])
        .map(([lv, v]) => [lv.toFixed(2), +v]),
    )),
    probabilities: Object.freeze({ ...(input.probabilities || {}) }),
    probabilityStatus: orNull(input.probabilityStatus) || 'uncalibrated',
    uncertainty: Object.freeze({ ...(input.uncertainty || {}) }),

    componentAvailability: Object.freeze({ ...(input.componentAvailability || {}) }),
    modelWeights: Object.freeze({ ...(input.modelWeights || {}) }),
    agreement: num(input.agreement),
    disagreement: num(input.disagreement),

    marketBeta: num(input.marketBeta),
    sectorBeta: num(input.sectorBeta),
    sector: orNull(input.sector),
    // A FRACTION (0.0016 = 16bps), not a percent. The old name `estimatedCostPct` said percent
    // and carried a fraction, and the first downstream consumer duly divided by 100 twice.
    estimatedCostFraction: num(input.estimatedCostFraction),

    quality: input.quality && input.quality.schema === 'ForecastQuality' ? input.quality : makeQualityFlags(input.quality || {}),
    eligible: input.eligible === true,
    exclusionReason: orNull(input.exclusionReason),
    explanations: Object.freeze([...(input.explanations || [])]),
    evaluationType: orNull(input.evaluationType) || 'live-prediction',
    lineage: Object.freeze({ ...(input.lineage || {}) }),
  });
}

module.exports = {
  FORECAST_CONTRACT_VERSION, AVAILABILITY, isUsable,
  makeModelIdentity, makePitStamps, makeQualityFlags,
  makeForecast, unavailableForecast, validateForecast, makeScoredRow,
};
