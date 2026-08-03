'use strict';
// STANDARD SIGNAL CONTRACT — lookup-contract-v1.
//
// One normalized shape for every engine that feeds the single-ticker lookup
// (intraday, swing, long-term, patterns, options, evidence, social, screeners),
// so the orchestrator can gate/dedup/synthesize them without knowing each
// engine's private vocabulary.
//
// INVARIANTS THIS MODULE ENFORCES:
//   • BUY is not a synonym for "generally bullish" — the action vocabulary
//     separates setup quality (WATCH/READY) from confirmation (TRIGGERED).
//   • A new entry is actionable ONLY when setupState is 'triggered' AND
//     executionAllowed is true; makeSignal demotes anything else.
//   • calibratedProbability may be non-null ONLY with a valid out-of-sample
//     calibration artifact; otherwise it is forced to null (evidenceStrength
//     carries the honest heuristic weight instead).
//   • Unknown values are explicit nulls, never invented numbers.
//
// Pure & dependency-free: no clock, no network, no store. Frozen records.

const ACTIONS = Object.freeze([
  'UNAVAILABLE',  // source missing/failed — not a neutral read
  'STALE',        // source exists but too old to act on
  'NO_TRADE',     // valid read, no edge for this horizon
  'AVOID',        // valid read, active reasons NOT to enter
  'WATCH',        // constructive setup, trigger NOT yet hit
  'READY',        // setup complete, trigger imminent/armed — still not an entry
  'TRIGGERED',    // trigger confirmed AND execution allowed — the only new-entry state
  'MANAGE',       // for existing holders: position management context
  'REDUCE',       // for existing holders: trim/de-risk
  'EXIT',         // for existing holders: exit signal
]);
const ACTION_SET = new Set(ACTIONS);

const SETUP_STATES = Object.freeze([
  'none', 'forming', 'ready', 'triggered', 'failed', 'expired',
]);
const SETUP_SET = new Set(SETUP_STATES);

const DIRECTIONS = Object.freeze(['bullish', 'bearish', 'neutral', 'unknown']);
const DIRECTION_SET = new Set(DIRECTIONS);

const HORIZONS = Object.freeze(['intraday', 'swing', 'longterm']);
const HORIZON_SET = new Set(HORIZONS);

// Correlated-evidence families — the dedup unit. Highly correlated signals map
// to the SAME family and get one combined contribution in the orchestrator.
const EVIDENCE_FAMILIES = Object.freeze([
  'price-trend', 'relative-strength', 'participation', 'volatility-execution',
  'fundamental-quality', 'valuation-expectations', 'analyst-revisions',
  'events-catalysts', 'options-positioning', 'news-thesis', 'social', 'market-regime',
  'pattern-structure', 'insider',
]);
const FAMILY_SET = new Set(EVIDENCE_FAMILIES);

const MODEL_MATURITIES = Object.freeze(['heuristic', 'research', 'shadow', 'validated']);

const isStr = v => typeof v === 'string' && v.length > 0;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isBool = v => typeof v === 'boolean';
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const orNull = v => (v === undefined ? null : v);

// A calibration artifact is valid only when it attests an out-of-sample fit
// with a real sample behind it. Anything less ⇒ "probability unavailable".
function validCalibrationArtifact(a) {
  return isObj(a)
    && isStr(a.version)
    && isNum(a.sampleSize) && a.sampleSize >= 200
    && a.outOfSample === true
    && isStr(a.horizon);
}

// New entries require a confirmed trigger AND execution permission. Everything
// else demotes: an "entry" without confirmation is a WATCH/READY, not a trade.
function demoteAction(action, setupState, executionAllowed) {
  if (action !== 'TRIGGERED') return action;
  if (setupState !== 'triggered') return setupState === 'ready' ? 'READY' : 'WATCH';
  if (executionAllowed !== true) return 'READY';
  return 'TRIGGERED';
}

// Build a normalized, frozen signal record. Missing fields become explicit
// nulls; invariant-violating combinations are corrected (and noted in warnings).
function makeSignal(input = {}) {
  const warnings = arr(input.warnings).slice();

  const setupState = SETUP_SET.has(input.setupState) ? input.setupState : 'none';
  const requestedAction = ACTION_SET.has(input.action) ? input.action : 'UNAVAILABLE';
  const executionAllowed = input.executionAllowed === true;
  const action = demoteAction(requestedAction, setupState, executionAllowed);
  if (action !== requestedAction) {
    warnings.push(`Action demoted ${requestedAction}→${action}: ` +
      (setupState !== 'triggered' ? 'trigger has not occurred.' : 'execution not allowed (session/freshness/liquidity).'));
  }

  const artifact = validCalibrationArtifact(input.calibrationArtifact) ? input.calibrationArtifact : null;
  let calibratedProbability = null;
  if (isNum(input.calibratedProbability)) {
    if (artifact) calibratedProbability = Math.max(0, Math.min(1, input.calibratedProbability));
    else warnings.push('calibratedProbability dropped: no valid out-of-sample calibration artifact.');
  }

  const evidenceStrength = isNum(input.evidenceStrength)
    ? Math.max(0, Math.min(10, input.evidenceStrength))
    : null;

  return Object.freeze({
    schema: 'lookup-contract-v1',
    ticker: isStr(input.ticker) ? input.ticker.toUpperCase() : null,
    horizon: HORIZON_SET.has(input.horizon) ? input.horizon : null,
    engine: isStr(input.engine) ? input.engine : null,
    modelVersion: isStr(input.modelVersion) ? input.modelVersion : null,
    direction: DIRECTION_SET.has(input.direction) ? input.direction : 'unknown',
    setupState,
    action,
    dataAsOf: isStr(input.dataAsOf) ? input.dataAsOf : null,
    marketSession: isStr(input.marketSession) ? input.marketSession : null,
    freshnessState: isStr(input.freshnessState) ? input.freshnessState : null,
    barComplete: isBool(input.barComplete) ? input.barComplete : null,
    evidenceStrength,
    calibratedProbability,
    calibrationArtifact: artifact,
    historicalPerformance: isObj(input.historicalPerformance) ? Object.freeze({ ...input.historicalPerformance }) : null,
    sampleSize: isNum(input.sampleSize) ? input.sampleSize : null,
    trigger: orNull(input.trigger),
    entryZone: orNull(input.entryZone),
    invalidation: orNull(input.invalidation),
    targets: Object.freeze(arr(input.targets).slice()),
    timeStop: orNull(input.timeStop),
    expectedHoldingPeriod: orNull(input.expectedHoldingPeriod),
    eventRisks: Object.freeze(arr(input.eventRisks).slice()),
    liquidityState: isStr(input.liquidityState) ? input.liquidityState : null,
    executionAllowed,
    provisional: input.provisional === true,
    evidenceFamilies: Object.freeze(arr(input.evidenceFamilies).filter(f => FAMILY_SET.has(f))),
    supportingEvidence: Object.freeze(arr(input.supportingEvidence).slice(0, 8)),
    contradictingEvidence: Object.freeze(arr(input.contradictingEvidence).slice(0, 8)),
    warnings: Object.freeze(warnings.slice(0, 8)),
    dataQuality: isStr(input.dataQuality) ? input.dataQuality : null,
    modelMaturity: MODEL_MATURITIES.includes(input.modelMaturity) ? input.modelMaturity : 'heuristic',
    explanation: isStr(input.explanation) ? input.explanation : null,
  });
}

function validateSignal(s) {
  const pairs = [
    [isObj(s), 'signal must be an object'],
    [isObj(s) && s.schema === 'lookup-contract-v1', 'schema must be lookup-contract-v1'],
    [isObj(s) && isStr(s.ticker), 'ticker required'],
    [isObj(s) && HORIZON_SET.has(s.horizon), 'horizon must be intraday|swing|longterm'],
    [isObj(s) && ACTION_SET.has(s.action), 'action must be a known action state'],
    [isObj(s) && SETUP_SET.has(s.setupState), 'setupState must be a known setup state'],
    [isObj(s) && DIRECTION_SET.has(s.direction), 'direction must be a known direction'],
    [isObj(s) && (s.action !== 'TRIGGERED' || (s.setupState === 'triggered' && s.executionAllowed === true)),
      'TRIGGERED requires a confirmed trigger and executionAllowed'],
    [isObj(s) && (s.calibratedProbability == null || validCalibrationArtifact(s.calibrationArtifact)),
      'calibratedProbability requires a valid calibration artifact'],
    [isObj(s) && (s.evidenceStrength == null || (s.evidenceStrength >= 0 && s.evidenceStrength <= 10)),
      'evidenceStrength must be 0–10 or null'],
  ];
  const errors = pairs.filter(([ok]) => !ok).map(([, msg]) => msg);
  return { valid: errors.length === 0, errors };
}

module.exports = {
  ACTIONS, SETUP_STATES, DIRECTIONS, HORIZONS, EVIDENCE_FAMILIES, MODEL_MATURITIES,
  makeSignal, validateSignal, validCalibrationArtifact, demoteAction,
};
