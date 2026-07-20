'use strict';
// CANONICAL RESEARCH SCHEMAS (research-schema-v1)
//
// Versioned record factories + validators for the unified research contract (Part II of the
// quant redesign). Every record is IMMUTABLE (factories return a frozen new object; there is
// no in-place mutation anywhere in this module) and self-describing (`schema`, `version`).
//
// The point of this module is a SINGLE definition of what a Prediction and an ExecutableOutcome
// are, shared by training, backtesting, and production so the three cannot silently disagree.
// Ticker is NEVER the identity — `securityId` is (see lib/security-master.js), so a reused or
// renamed symbol cannot merge two securities.
//
// Pure & dependency-free (no network, no clock, no store). `availableAt`/`decisionTs` are
// supplied by the caller — this module never invents a timestamp.

const RESEARCH_SCHEMA_VERSION = 'research-schema-v1';

// ── helpers ──────────────────────────────────────────────────────────────────
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const orNull = (v) => (v === undefined ? null : v);

// A research-validity stamp. `productionGrade`/`survivorshipSafe` default to FALSE — a result is
// only production-grade when a caller can PROVE it, never by omission.
function researchValidity({ productionGrade = false, survivorshipSafe = false, reason = null } = {}) {
  return Object.freeze({ productionGrade: !!productionGrade, survivorshipSafe: !!survivorshipSafe, reason: orNull(reason) });
}

// Collect a {valid, errors[]} result from a list of [condition, message] checks.
function check(pairs) {
  const errors = pairs.filter(([ok]) => !ok).map(([, msg]) => msg);
  return { valid: errors.length === 0, errors };
}

// ── Security master record ─────────────────────────────────────────────────────
// Ticker is a time-varying attribute; securityId is the permanent identity.
function makeSecurityMasterRecord(input = {}) {
  const r = {
    schema: 'SecurityMaster', version: RESEARCH_SCHEMA_VERSION,
    securityId: orNull(input.securityId),
    ticker: orNull(input.ticker),
    validFrom: orNull(input.validFrom),
    validTo: orNull(input.validTo),
    exchange: orNull(input.exchange),
    securityType: orNull(input.securityType),
    listingDate: orNull(input.listingDate),
    delistingDate: orNull(input.delistingDate),
    delistingReturn: orNull(input.delistingReturn),
    sector: orNull(input.sector),
    industry: orNull(input.industry),
    active: input.active === undefined ? null : !!input.active,
    source: orNull(input.source),
    availableAt: orNull(input.availableAt),
  };
  return Object.freeze(r);
}
function validateSecurityMasterRecord(r) {
  return check([
    [isObj(r), 'not an object'],
    [isStr(r && r.securityId), 'securityId is required and must be a non-empty string'],
    [r && r.active !== undefined, 'active must be present (null allowed when unknown)'],
  ]);
}

// ── Universe snapshot ──────────────────────────────────────────────────────────
function makeUniverseSnapshot(input = {}) {
  return Object.freeze({
    schema: 'UniverseSnapshot', version: RESEARCH_SCHEMA_VERSION,
    snapshotId: orNull(input.snapshotId),
    decisionDate: orNull(input.decisionDate),
    generatedAt: orNull(input.generatedAt),
    policyVersion: orNull(input.policyVersion),
    securityMasterVersion: orNull(input.securityMasterVersion),
    members: Object.freeze([...(input.members || [])]),
    exclusions: Object.freeze([...(input.exclusions || [])]),
    survivorshipSafe: input.survivorshipSafe === undefined ? false : !!input.survivorshipSafe,
    limitations: Object.freeze([...(input.limitations || [])]),
  });
}
function validateUniverseSnapshot(s) {
  return check([
    [isObj(s), 'not an object'],
    [isStr(s && s.decisionDate), 'decisionDate is required'],
    [Array.isArray(s && s.members), 'members must be an array'],
    [isBool(s && s.survivorshipSafe), 'survivorshipSafe must be a boolean (default false)'],
  ]);
}

// ── Feature snapshot ────────────────────────────────────────────────────────────
// `decisionTs` is when features are known (a daily close); `dataCutoffTs` is the last datum
// that fed them. A feature computed from day-T close has dataCutoffTs = decisionTs = T-close.
function makeFeatureSnapshot(input = {}) {
  return Object.freeze({
    schema: 'FeatureSnapshot', version: RESEARCH_SCHEMA_VERSION,
    securityId: orNull(input.securityId),
    ticker: orNull(input.ticker),
    decisionTs: orNull(input.decisionTs),
    dataCutoffTs: orNull(input.dataCutoffTs),
    universeSnapshotId: orNull(input.universeSnapshotId),
    featureVersion: orNull(input.featureVersion),
    values: Object.freeze({ ...(input.values || {}) }),
    missing: Object.freeze([...(input.missing || [])]),
    sourceAvailability: Object.freeze({ ...(input.sourceAvailability || {}) }),
    researchValidity: researchValidity(input.researchValidity || {}),
  });
}
function validateFeatureSnapshot(f) {
  return check([
    [isObj(f), 'not an object'],
    [isStr(f && f.securityId), 'securityId is required'],
    [isStr(f && f.decisionTs), 'decisionTs is required'],
    [isObj(f && f.values), 'values must be an object'],
    [!f || f.dataCutoffTs == null || f.dataCutoffTs <= f.decisionTs, 'dataCutoffTs must not be after decisionTs (look-ahead)'],
  ]);
}

// ── Prediction ───────────────────────────────────────────────────────────────────
// `decisionTs` = when the model decided (features known). `eligibleEntryTs` = earliest a fill
// could occur (the NEXT session — never the same close). state ∈ research|shadow|eligible|...
function makePrediction(input = {}) {
  return Object.freeze({
    schema: 'Prediction', version: RESEARCH_SCHEMA_VERSION,
    predictionId: orNull(input.predictionId),
    securityId: orNull(input.securityId),
    ticker: orNull(input.ticker),
    decisionTs: orNull(input.decisionTs),
    eligibleEntryTs: orNull(input.eligibleEntryTs),
    horizon: orNull(input.horizon),
    side: input.side === 'short' ? 'short' : (input.side === 'long' ? 'long' : orNull(input.side)),
    modelVersion: orNull(input.modelVersion),
    featureVersion: orNull(input.featureVersion),
    universeSnapshotId: orNull(input.universeSnapshotId),
    rawOutputs: Object.freeze({ ...(input.rawOutputs || {}) }),
    calibratedProbabilities: Object.freeze({ ...(input.calibratedProbabilities || {}) }),
    expectedGrossReturn: orNull(input.expectedGrossReturn),
    expectedCosts: orNull(input.expectedCosts),
    expectedNetReturn: orNull(input.expectedNetReturn),
    tailRisk: orNull(input.tailRisk),
    uncertainty: orNull(input.uncertainty),
    regime: orNull(input.regime),
    state: orNull(input.state),
    rejectionReasons: Object.freeze([...(input.rejectionReasons || [])]),
  });
}
function validatePrediction(p) {
  return check([
    [isObj(p), 'not an object'],
    [isStr(p && p.securityId), 'securityId is required'],
    [isStr(p && p.decisionTs), 'decisionTs is required'],
    [isStr(p && p.horizon), 'horizon is required'],
    // The core causal guarantee: a fill cannot precede or equal the decision close.
    [!p || p.eligibleEntryTs == null || p.eligibleEntryTs > p.decisionTs,
      'eligibleEntryTs must be strictly after decisionTs (no same-close fill)'],
  ]);
}

// ── Executable outcome ──────────────────────────────────────────────────────────
function makeExecutableOutcome(input = {}) {
  return Object.freeze({
    schema: 'ExecutableOutcome', version: RESEARCH_SCHEMA_VERSION,
    predictionId: orNull(input.predictionId),
    fillPolicyVersion: orNull(input.fillPolicyVersion),
    fillTs: orNull(input.fillTs),
    fillPrice: orNull(input.fillPrice),
    fillStatus: orNull(input.fillStatus),          // filled | unfilled | partial
    exitTs: orNull(input.exitTs),
    exitPrice: orNull(input.exitPrice),
    exitReason: orNull(input.exitReason),          // upper | lower | time | delist | gap-through
    grossReturn: orNull(input.grossReturn),
    costs: orNull(input.costs),
    netReturn: orNull(input.netReturn),
    benchmarkReturn: orNull(input.benchmarkReturn),
    sectorReturn: orNull(input.sectorReturn),
    residualReturn: orNull(input.residualReturn),
    barrier: orNull(input.barrier),
    mfe: orNull(input.mfe),
    mae: orNull(input.mae),
    labelEndTs: orNull(input.labelEndTs),
    outcomeVersion: orNull(input.outcomeVersion),
  });
}
function validateExecutableOutcome(o) {
  const filled = o && o.fillStatus === 'filled';
  return check([
    [isObj(o), 'not an object'],
    [isStr(o && o.predictionId), 'predictionId is required'],
    [isStr(o && o.fillStatus), 'fillStatus is required'],
    [!filled || isNum(o.fillPrice), 'a filled outcome must have a numeric fillPrice'],
    [!filled || isStr(o.labelEndTs), 'a filled outcome must record labelEndTs (for exact purge)'],
    // If both fill and exit exist, exit cannot precede fill.
    [!o || o.fillTs == null || o.exitTs == null || o.exitTs >= o.fillTs, 'exitTs must not precede fillTs'],
  ]);
}

// ── Multi-horizon outcome vector ──────────────────────────────────────────────────
// A single immutable Prediction is graded at EVERY session horizon in the ladder, not
// only its declared one. From one recorded decision this extracts a full term structure
// of outcomes plus six distinct target types (Phase 4) — more learning per prediction
// without manufacturing any edge. Each horizon slice carries its own `status`: a horizon
// whose label has not fully elapsed is `pending`, never a smaller number (RULE 1 applies
// per-horizon, so near horizons resolve while far ones stay open).
function makeHorizonReturn(input = {}) {
  return Object.freeze({
    bars: isNum(input.bars) ? input.bars : null,
    status: orNull(input.status),                 // resolved | pending | unfilled
    reason: orNull(input.reason),
    exitTs: orNull(input.exitTs),
    grossReturn: orNull(input.grossReturn),
    costs: orNull(input.costs),
    netReturn: orNull(input.netReturn),
    benchmarkReturn: orNull(input.benchmarkReturn),
    sectorReturn: orNull(input.sectorReturn),
    residualReturn: orNull(input.residualReturn),
    mfe: orNull(input.mfe),
    mae: orNull(input.mae),
    // Six target types (Phase 4). Each is null until the horizon resolves — an
    // unresolved target must never read as a decided false.
    beatBenchmark: input.beatBenchmark === undefined ? null : orNull(input.beatBenchmark), // #2 beat-bench-after-costs
    positiveNet: input.positiveNet === undefined ? null : orNull(input.positiveNet),       // #3 positive-absolute-after-costs
    severeLoss: input.severeLoss === undefined ? null : orNull(input.severeLoss),          // #4 severe-loss
  });
}

function makeMultiHorizonOutcome(input = {}) {
  return Object.freeze({
    schema: 'MultiHorizonOutcome', version: RESEARCH_SCHEMA_VERSION,
    predictionId: orNull(input.predictionId),
    ticker: orNull(input.ticker),
    side: input.side === 'short' ? 'short' : 'long',
    primaryHorizon: orNull(input.primaryHorizon),
    primaryBars: isNum(input.primaryBars) ? input.primaryBars : null,
    fillPolicyVersion: orNull(input.fillPolicyVersion),
    fillStatus: orNull(input.fillStatus),          // filled | unfilled
    fillTs: orNull(input.fillTs),
    fillPrice: orNull(input.fillPrice),
    noFill: input.noFill === undefined ? null : !!input.noFill,   // #6 execution/no-fill target
    horizons: Object.freeze((input.horizons || []).map(makeHorizonReturn)),
    outcomeVersion: orNull(input.outcomeVersion),
  });
}
function validateMultiHorizonOutcome(o) {
  return check([
    [isObj(o), 'not an object'],
    [isStr(o && o.predictionId), 'predictionId is required'],
    [isStr(o && o.fillStatus), 'fillStatus is required'],
    [Array.isArray(o && o.horizons), 'horizons must be an array'],
    // A resolved horizon of a FILLED prediction must carry a numeric netReturn.
    [!o || !Array.isArray(o.horizons) || o.fillStatus !== 'filled' ||
      o.horizons.filter(h => h.status === 'resolved').every(h => isNum(h.netReturn)),
      'every resolved horizon of a filled outcome must have a numeric netReturn'],
  ]);
}

// ── Experiment manifest ──────────────────────────────────────────────────────────
// Records EVERYTHING needed to reproduce a result and to deflate it for multiple testing:
// what data, what folds, what code, and how many sibling experiments were attempted.
function makeExperimentManifest(input = {}) {
  return Object.freeze({
    schema: 'ExperimentManifest', version: RESEARCH_SCHEMA_VERSION,
    experimentId: orNull(input.experimentId),
    experimentFamilyId: orNull(input.experimentFamilyId),
    datasetHash: orNull(input.datasetHash),
    securityMasterVersion: orNull(input.securityMasterVersion),
    universePolicy: orNull(input.universePolicy),
    featureManifest: Object.freeze([...(input.featureManifest || [])]),
    labelVersion: orNull(input.labelVersion),
    foldDefinitions: Object.freeze([...(input.foldDefinitions || [])]),
    modelParams: Object.freeze({ ...(input.modelParams || {}) }),
    calibrationParams: Object.freeze({ ...(input.calibrationParams || {}) }),
    costModel: orNull(input.costModel),
    codeCommit: orNull(input.codeCommit),
    randomSeed: input.randomSeed === undefined ? null : input.randomSeed,
    relatedExperimentsAttempted: isNum(input.relatedExperimentsAttempted) ? input.relatedExperimentsAttempted : null,
    primaryMetric: orNull(input.primaryMetric),           // declared BEFORE evaluation
    results: Object.freeze({ ...(input.results || {}) }),
    confidenceIntervals: Object.freeze({ ...(input.confidenceIntervals || {}) }),
    researchValidity: researchValidity(input.researchValidity || {}),
    generatedAt: orNull(input.generatedAt),
  });
}
function validateExperimentManifest(m) {
  return check([
    [isObj(m), 'not an object'],
    [isStr(m && m.experimentId), 'experimentId is required'],
    [isStr(m && m.primaryMetric), 'primaryMetric must be declared (before evaluation)'],
    [isStr(m && m.datasetHash), 'datasetHash is required for reproducibility'],
    [Array.isArray(m && m.foldDefinitions), 'foldDefinitions must be an array'],
  ]);
}

module.exports = {
  RESEARCH_SCHEMA_VERSION,
  researchValidity,
  makeSecurityMasterRecord, validateSecurityMasterRecord,
  makeUniverseSnapshot, validateUniverseSnapshot,
  makeFeatureSnapshot, validateFeatureSnapshot,
  makePrediction, validatePrediction,
  makeExecutableOutcome, validateExecutableOutcome,
  makeHorizonReturn, makeMultiHorizonOutcome, validateMultiHorizonOutcome,
  makeExperimentManifest, validateExperimentManifest,
};
