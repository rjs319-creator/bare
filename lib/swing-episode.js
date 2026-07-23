'use strict';
// SWING EPISODE SCHEMA (swing-episode-v1) — immutable origin + mutable current assessment +
// append-only transition history, following the canonical research-schema-v1 frozen-factory idiom
// (lib/research/schemas.js). Every factory returns a NEW frozen object; nothing here mutates its
// input. The immutable ORIGIN is captured once at inception and is NEVER rewritten — grading,
// re-scoring and management levels all read the origin but can only ever produce a new assessment
// or a new transition, so a pick's original thesis and plan survive whatever happens to the price.
//
// This separation is the mechanism behind the product guarantee: a pick can change state and
// explanation freely (current assessment), while its accountability record (origin) is fixed.

const SCHEMA = 'SwingEpisode';
const VERSION = 'swing-episode-v1';

const orNull = (v) => (v === undefined ? null : v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => ((v === null || v === undefined || v === "" || typeof v === "boolean") ? null : (Number.isFinite(+v) ? +v : null));
const arr = (v) => Object.freeze([...(Array.isArray(v) ? v : [])]);
const frozenObj = (v) => Object.freeze({ ...(isObj(v) ? v : {}) });

// ── Immutable origin ────────────────────────────────────────────────────────────
// Captured once, at the first session the pick was published. Frozen. Never rewritten.
function makeOrigin(input = {}) {
  return Object.freeze({
    schema: SCHEMA + '.Origin', version: VERSION,
    episodeId: orNull(input.episodeId),
    predictionId: orNull(input.predictionId),
    ticker: orNull(input.ticker),
    company: orNull(input.company),
    side: input.side === 'short' ? 'short' : 'long',
    horizon: orNull(input.horizon) || 'swing',
    sourceStrategy: orNull(input.sourceStrategy),
    sourceStrategies: arr(input.sourceStrategies),
    strategyFamily: orNull(input.strategyFamily),
    strategyVersion: orNull(input.strategyVersion),
    modelVersion: orNull(input.modelVersion),
    setupGeneration: Number.isFinite(+input.setupGeneration) ? Math.floor(+input.setupGeneration) : 1,
    firstSuggestedAt: orNull(input.firstSuggestedAt),
    firstDecisionDate: orNull(input.firstDecisionDate),
    decisionBarAsOf: orNull(input.decisionBarAsOf),
    firstSuggestedPrice: num(input.firstSuggestedPrice),
    originalEntry: num(input.originalEntry),
    originalStop: num(input.originalStop),
    originalTargets: arr(input.originalTargets).map(num).filter(v => v != null),
    originalMaxEntry: num(input.originalMaxEntry),
    originalMaxGap: num(input.originalMaxGap),
    originalHoldingWindow: num(input.originalHoldingWindow),
    originalScore: num(input.originalScore),
    originalRank: num(input.originalRank),
    originalTier: orNull(input.originalTier),
    originalSetup: orNull(input.originalSetup),
    originalThesis: orNull(input.originalThesis),
    originalRisks: arr(input.originalRisks),
    originalFeatures: frozenObj(input.originalFeatures),
    originalRegime: orNull(input.originalRegime),
    originalSectorState: orNull(input.originalSectorState),
    setupSignature: orNull(input.setupSignature),
    dataProvenance: orNull(input.dataProvenance) || 'prospective_live',
    executionPolicyVersion: orNull(input.executionPolicyVersion),
    costModelVersion: orNull(input.costModelVersion),
    // Honesty stamp — a lifecycle episode is accountability plumbing, NOT proven edge. Never true
    // unless a caller can prove it; mirrors researchValidity in the canonical schema.
    productionGrade: input.productionGrade === true,
  });
}

// ── Mutable current assessment ────────────────────────────────────────────────────
// Rebuilt from scratch each monitor pass. Frozen for safety, but a full replacement (not an
// in-place edit) — the origin is what is durable, this is the latest read.
function makeAssessment(input = {}) {
  return Object.freeze({
    schema: SCHEMA + '.Assessment', version: VERSION,
    lastEvaluatedAt: orNull(input.lastEvaluatedAt),
    latestCompletedBarAsOf: orNull(input.latestCompletedBarAsOf),
    dataAge: num(input.dataAge),
    sessionsSinceSuggestion: num(input.sessionsSinceSuggestion),
    sessionsSinceEntry: num(input.sessionsSinceEntry),
    sessionsRemaining: num(input.sessionsRemaining),
    sourceStillSelects: input.sourceStillSelects === undefined ? null : !!input.sourceStillSelects,
    currentSources: arr(input.currentSources),
    currentPrice: num(input.currentPrice),
    currentScore: num(input.currentScore),
    scoreDelta: num(input.scoreDelta),
    currentRank: num(input.currentRank),
    rankDelta: num(input.rankDelta),
    currentTier: orNull(input.currentTier),
    currentSetup: orNull(input.currentSetup),
    currentFeatures: frozenObj(input.currentFeatures),
    currentRegime: orNull(input.currentRegime),
    currentSectorState: orNull(input.currentSectorState),
    returnSinceSuggestion: num(input.returnSinceSuggestion),
    returnSinceFill: num(input.returnSinceFill),
    excessVsSpy: num(input.excessVsSpy),
    excessVsSector: num(input.excessVsSector),
    mfeSinceSuggestion: num(input.mfeSinceSuggestion),
    maeSinceSuggestion: num(input.maeSinceSuggestion),
    mfeSinceFill: num(input.mfeSinceFill),
    maeSinceFill: num(input.maeSinceFill),
    remainingToOriginalTarget: num(input.remainingToOriginalTarget),
    remainingRewardRisk: num(input.remainingRewardRisk),
    consumedPct: num(input.consumedPct),
    // Management levels are computed SEPARATELY and shown as advisory — they can never rewrite
    // the origin's grading levels (test: "updated management levels cannot alter original grading").
    managementStop: num(input.managementStop),
    managementNote: orNull(input.managementNote),
    // Multi-dimensional state (never collapsed into one enum).
    lifecycleState: orNull(input.lifecycleState),
    thesisState: orNull(input.thesisState),
    actionState: orNull(input.actionState),
    executionState: orNull(input.executionState),
    outcomeState: orNull(input.outcomeState),
    reasonCodes: arr(input.reasonCodes),
    explanation: orNull(input.explanation),
    dataFreshness: orNull(input.dataFreshness),
    calibrationStatus: orNull(input.calibrationStatus) || 'uncalibrated',
  });
}

// ── Immutable transition event ────────────────────────────────────────────────────
function makeTransition(input = {}) {
  return Object.freeze({
    schema: SCHEMA + '.Transition', version: VERSION,
    at: orNull(input.at),
    session: orNull(input.session),
    prevLifecycle: orNull(input.prevLifecycle),
    newLifecycle: orNull(input.newLifecycle),
    prevThesis: orNull(input.prevThesis),
    newThesis: orNull(input.newThesis),
    prevAction: orNull(input.prevAction),
    newAction: orNull(input.newAction),
    prevExecution: orNull(input.prevExecution),
    newExecution: orNull(input.newExecution),
    prevOutcome: orNull(input.prevOutcome),
    newOutcome: orNull(input.newOutcome),
    reasonCodes: arr(input.reasonCodes),
    explanation: orNull(input.explanation),
    price: num(input.price),
    featureDeltas: frozenObj(input.featureDeltas),
    sourcePresence: frozenObj(input.sourcePresence),
    dataFreshness: orNull(input.dataFreshness),
    strategyVersion: orNull(input.strategyVersion),
    modelVersion: orNull(input.modelVersion),
  });
}

// ── Episode = frozen origin + latest assessment + append-only transitions ─────────────
function makeEpisode({ origin, assessment = null, transitions = [] } = {}) {
  return Object.freeze({
    schema: SCHEMA, version: VERSION,
    slotKey: origin ? require('./swing-identity').slotKey(origin) : null,
    origin: origin && origin.schema ? origin : makeOrigin(origin || {}),
    assessment: assessment ? makeAssessment(assessment) : null,
    transitions: Object.freeze((transitions || []).map(t => (t && t.schema ? t : makeTransition(t)))),
    terminal: assessment ? isTerminalLifecycle(assessment.lifecycleState) : false,
  });
}

// Terminal lifecycle states — accountability-final. A terminal episode is graded and archived,
// never silently deleted, and never reopened without a new setupGeneration.
const TERMINAL_LIFECYCLE = Object.freeze(new Set(['TARGET_HIT', 'INVALIDATED', 'EXPIRED', 'NO_FILL', 'CLOSED']));
function isTerminalLifecycle(s) { return TERMINAL_LIFECYCLE.has(s); }

// Return a NEW episode with the assessment replaced. Origin and transitions untouched.
function withAssessment(episode, assessment) {
  return makeEpisode({ origin: episode.origin, assessment, transitions: episode.transitions });
}

// Return a NEW episode with a transition appended. Prior transitions and origin are never
// rewritten (append-only). Optionally also set the new assessment in the same step.
function appendTransition(episode, transition, assessment = null) {
  return makeEpisode({
    origin: episode.origin,
    assessment: assessment || episode.assessment,
    transitions: [...(episode.transitions || []), transition],
  });
}

function validateOrigin(o) {
  const errors = [];
  if (!isStr(o && o.episodeId)) errors.push('episodeId required');
  if (!isStr(o && o.ticker)) errors.push('ticker required');
  if (!isStr(o && o.firstDecisionDate)) errors.push('firstDecisionDate required');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA, VERSION, TERMINAL_LIFECYCLE, isTerminalLifecycle,
  makeOrigin, makeAssessment, makeTransition, makeEpisode,
  withAssessment, appendTransition, validateOrigin,
};
