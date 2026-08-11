'use strict';
// CFL — IMMUTABLE RECORD SCHEMAS with point-in-time assertions. Pure.
//
// Four record kinds, each versioned, deterministic-id'd and frozen:
//   DecisionSnapshot   — what the pipeline decided at decision time (per scope/date)
//   OpportunityEpisode — a labeled (symbol, checkpoint, horizon) outcome window
//   DetectionTrace     — whether/when/at-what-rank the pipeline saw the symbol
//   FailureAttribution — the deterministic verdict for a miss or a dud
//
// PIT invariants are ENFORCED at construction (a violating record is a bug, not
// data): feature timestamps may never exceed the decision timestamp, and the
// assumed entry may never precede the earliest executable observation.

const crypto = require('node:crypto');
const CFG = require('./config');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isoDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// Throws unless every feature/input timestamp is at or before the decision cutoff.
function assertPointInTime({ decisionDate, featureDates = [], entryDate = null } = {}) {
  if (!isoDate(decisionDate)) throw new Error(`CFL PIT: invalid decisionDate "${decisionDate}"`);
  for (const f of featureDates) {
    if (f != null && String(f).slice(0, 10) > decisionDate) {
      throw new Error(`CFL PIT violation: feature dated ${f} is after decision ${decisionDate}`);
    }
  }
  if (entryDate != null && String(entryDate).slice(0, 10) <= decisionDate) {
    throw new Error(`CFL PIT violation: entry ${entryDate} not after decision ${decisionDate} (EOD signals fill no earlier than the next session)`);
  }
}

function opportunityId({ symbol, checkpointDate, horizon }) {
  for (const [k, v] of Object.entries({ symbol, checkpointDate, horizon })) {
    if (!v) throw new Error(`opportunityId(): missing ${k}`);
  }
  return sha([CFG.LABEL_VERSION, String(symbol).toUpperCase(), checkpointDate, horizon].join('|')).slice(0, 24);
}

function decisionSnapshotId({ scope, decisionDate, engineVersion }) {
  return sha(['cfl-decision', scope, decisionDate, engineVersion || ''].join('|')).slice(0, 24);
}

// One per (scope, decisionDate): the full decision-time record the live route
// used to discard — per-name status/rank/rejection, cohort hash, gates, versions.
function makeDecisionSnapshot({
  scope, decisionDate, decisionSession = null, engineVersion, scoringVersion,
  universeVersion = null, regime = null, macroRiskOff = null,
  candidateSetHash = null, cohortSize = 0, selectedCount = 0,
  rejectionCounts = null, names = [], freshness = null,
  governance = null, dataCutoff = null, capturedAt = null, source = 'live',
} = {}) {
  assertPointInTime({ decisionDate, featureDates: [dataCutoff] });
  if (!scope) throw new Error('makeDecisionSnapshot(): scope required');
  return Object.freeze({
    schemaVersion: CFG.CFL_VERSION,
    decisionId: decisionSnapshotId({ scope, decisionDate, engineVersion }),
    scope, decisionDate, decisionSession, engineVersion, scoringVersion,
    universeVersion, regime, macroRiskOff,
    candidateSetHash, cohortSize, selectedCount,
    rejectionCounts: rejectionCounts || null,
    // names: [{symbol, status, rejectionCode, rank, score, pctile, missing[]}]
    names: Object.freeze((names || []).map(n => Object.freeze({ ...n }))),
    freshness: freshness || null,
    governance: governance || null,
    dataCutoff, capturedAt, source,
  });
}

function makeOpportunityEpisode({
  symbol, checkpointDate, horizon, label, crossSection = null,
  liquidity = null, dataQuality = null, universeScope = null,
} = {}) {
  if (!label || label.ok === false) throw new Error('makeOpportunityEpisode(): a valid label is required');
  assertPointInTime({ decisionDate: checkpointDate, entryDate: label.entryDate || null });
  return Object.freeze({
    schemaVersion: CFG.CFL_VERSION, labelVersion: label.labelVersion,
    opportunityId: opportunityId({ symbol, checkpointDate, horizon }),
    symbol: String(symbol).toUpperCase(), checkpointDate, horizon, universeScope,
    earliestExecutableAt: label.earliestExecutableAt || null,
    entryDate: label.entryDate || null, entryPrice: label.entryPrice ?? null,
    targetPrice: label.targetPrice ?? null, stopPrice: label.stopPrice ?? null,
    barriers: label.barriers || null,
    outcome: label.outcome, matured: !!label.matured,
    mfe: label.mfe ?? null, mae: label.mae ?? null,
    timeToTarget: label.timeToTarget ?? null, timeToStop: label.timeToStop ?? null,
    rawReturn: label.rawReturn ?? null, benchmarkReturn: label.benchmarkReturn ?? null,
    excessReturn: label.excessReturn ?? null, sectorReturn: label.sectorReturn ?? null,
    sectorExcess: label.sectorExcess ?? null,
    gap: label.gap || null, bigMove: !!label.bigMove,
    crossSection: crossSection || null,
    liquidity, dataQuality: dataQuality || null,
  });
}

// Rank/status history across checkpoints for one opportunity.
function makeDetectionTrace({
  opportunityId: oid, symbol, horizon, universeEligible = null,
  candidateGenerated = false, firstDetectionDate = null, firstSelectedDate = null,
  rankHistory = [], riskVetoes = [], alertHistory = null, displayHistory = [],
  earliestActionableDate = null, warningSessions = null,
  detectedBeforeMoveFrac = null, highestRankBeforeMove = null,
  forecastability = null,
} = {}) {
  if (!oid) throw new Error('makeDetectionTrace(): opportunityId required');
  return Object.freeze({
    schemaVersion: CFG.CFL_VERSION, opportunityId: oid,
    symbol: String(symbol || '').toUpperCase(), horizon,
    universeEligible, candidateGenerated: !!candidateGenerated,
    firstDetectionDate, firstSelectedDate,
    // rankHistory: [{date, status, rejectionCode, rank, score}]
    rankHistory: Object.freeze((rankHistory || []).map(r => Object.freeze({ ...r }))),
    riskVetoes: Object.freeze([...(riskVetoes || [])]),
    alertHistory: alertHistory || null,   // null = this lane has no alert layer (a finding, not a blank)
    displayHistory: Object.freeze([...(displayHistory || [])]),
    earliestActionableDate, warningSessions,
    detectedBeforeMoveFrac, highestRankBeforeMove,
    forecastability: forecastability || null,
  });
}

const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

function makeFailureAttribution({
  opportunityId: oid = null, decisionId = null, kind, primaryFailure,
  secondaryFailures = [], evidence = [], confidence = 'medium', preventable = null,
} = {}) {
  if (!oid && !decisionId) throw new Error('makeFailureAttribution(): opportunityId or decisionId required');
  if (!primaryFailure) throw new Error('makeFailureAttribution(): primaryFailure required');
  if (!CONFIDENCE.includes(confidence)) throw new Error(`makeFailureAttribution(): invalid confidence "${confidence}"`);
  return Object.freeze({
    schemaVersion: CFG.CFL_VERSION, attributionVersion: CFG.ATTRIBUTION_VERSION,
    attributionId: sha([CFG.ATTRIBUTION_VERSION, oid || decisionId, kind, primaryFailure].join('|')).slice(0, 24),
    opportunityId: oid, decisionId, kind,   // 'missed-winner' | 'dud'
    primaryFailure,
    secondaryFailures: Object.freeze([...(secondaryFailures || [])]),
    evidence: Object.freeze((evidence || []).map(e => Object.freeze({ ...e }))),
    confidence, preventable,
  });
}

module.exports = {
  assertPointInTime, opportunityId, decisionSnapshotId,
  makeDecisionSnapshot, makeOpportunityEpisode, makeDetectionTrace, makeFailureAttribution,
};
