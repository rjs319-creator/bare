'use strict';
// ATLAS-X — data & prediction contracts.
//
// The single authority on the SHAPE of every artifact that flows between ATLAS-X
// layers, plus the runtime validators and the calibration DISPLAY GUARD. Every
// layer stamps a provenance block and validates its output here; missing or
// incompatible artifacts FAIL CLOSED (the engine drops them rather than guessing).
//
// The most important export is displayNumber(): an uncalibrated probability-like
// score can NEVER be rendered as a percentage. UI wording cannot override this —
// it routes through this one function, mirroring how strategy-gate makes maturity
// the only control over live eligibility.

const { VERSIONS } = require('./atlasx-config');

// ── enumerations shared across layers ────────────────────────────────────────
const EXPERTS = Object.freeze([
  'compressionRelease',
  'catalystDrift',
  'firstPullback',
  'breakoutContinuation',
  'redTapeReversal',
  'eventDislocation',
]);

const ACTIONS = Object.freeze([
  'ENTER_NEXT_OPEN',
  'WAIT_BREAKOUT',
  'WAIT_PULLBACK',
  'WAIT_FIRST_HOUR',
  'WAIT_CONFIRMATION',
  'DO_NOT_CHASE',
  'AVOID',
  'NO_TRADE',
]);

const CALIBRATION_STATUS = Object.freeze(['uncalibrated', 'bands', 'calibrated']);
const EVIDENCE_MATURITY = Object.freeze(['experimental', 'accruing', 'validated']);
const GOVERNANCE_STATUS = Object.freeze(['shadow', 'candidate', 'production']);

// ── provenance ────────────────────────────────────────────────────────────────
// Every prediction MUST carry these so an old episode stays honest about which
// engine produced it and whether entry timing was legal (eligibleEntryTs > cutoff).
function makeProvenance(f = {}) {
  return Object.freeze({
    decisionTs: f.decisionTs || null,        // when the decision was formed
    eligibleEntryTs: f.eligibleEntryTs || null, // first legal executable entry (next session)
    dataCutoff: f.dataCutoff || f.decisionTs || null, // last bar/data used
    featureVersion: f.featureVersion || VERSIONS.residual,
    strategyVersion: f.strategyVersion || VERSIONS.strategy,
    modelVersion: f.modelVersion || VERSIONS.ranking,
    executionVersion: f.executionVersion || VERSIONS.execution,
    costVersion: f.costVersion || 'costs-v1',
    universeSnapshotId: f.universeSnapshotId || null,
    provenance: f.provenance || null,        // source lineage (op=today / episode / control)
    calibrationStatus: normEnum(f.calibrationStatus, CALIBRATION_STATUS, 'uncalibrated'),
    governanceStatus: normEnum(f.governanceStatus, GOVERNANCE_STATUS, 'shadow'),
  });
}

function validateProvenance(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['provenance missing'] };
  if (!p.decisionTs) errors.push('decisionTs required');
  // Executable entry may never precede the data cutoff (leakage / same-close fill).
  if (p.decisionTs && p.eligibleEntryTs && !(p.eligibleEntryTs > p.dataCutoff)) {
    errors.push('eligibleEntryTs must be strictly after dataCutoff (no same-bar fill)');
  }
  for (const k of ['strategyVersion', 'executionVersion']) {
    if (!p[k]) errors.push(`${k} required`);
  }
  return { ok: errors.length === 0, errors };
}

// ── the calibration DISPLAY GUARD ────────────────────────────────────────────
const BANDS = Object.freeze(['very-low', 'low', 'moderate', 'elevated', 'high', 'very-high']);

function bandForScore(score) {
  if (score == null || !isFinite(score)) return 'unknown';
  const s = Math.max(0, Math.min(1, score));
  const i = Math.min(BANDS.length - 1, Math.floor(s * BANDS.length));
  return BANDS[i];
}

/**
 * The one chokepoint for surfacing any probability-like number. Until an
 * out-of-fold calibration artifact promotes status to 'calibrated', a score is
 * shown ONLY as a qualitative band / "experimental score" — never a percentage.
 * @returns {{kind, isPercent, display, band, raw}}
 */
function displayNumber(value, calibrationStatus, kind = 'probability') {
  const status = normEnum(calibrationStatus, CALIBRATION_STATUS, 'uncalibrated');
  const raw = (value == null || !isFinite(value)) ? null : Number(value);
  if (kind !== 'probability') {
    // plain magnitudes (returns, RR, bps) are fine to show numerically
    return Object.freeze({ kind, isPercent: false, display: raw, band: null, raw });
  }
  if (status === 'calibrated' && raw != null) {
    return Object.freeze({ kind, isPercent: true, display: `${Math.round(raw * 100)}%`, band: bandForScore(raw), raw });
  }
  // uncalibrated / bands → NEVER a percent
  const band = bandForScore(raw);
  return Object.freeze({ kind, isPercent: false, display: `${band} (experimental score)`, band, raw });
}

// ── artifact validators (structural, fail-closed) ────────────────────────────
function req(obj, keys, errors, label) {
  for (const k of keys) if (obj[k] === undefined) errors.push(`${label}.${k} required`);
}

function validateExpertAssessment(a) {
  const e = [];
  if (!a || typeof a !== 'object') return closed('expert', ['missing']);
  if (!EXPERTS.includes(a.expert)) e.push(`unknown expert: ${a.expert}`);
  req(a, ['applicability', 'stage', 'entryIntent', 'invalidation', 'target', 'uncertainty', 'maturity', 'version'], e, 'expert');
  if (a.applicability != null && (a.applicability < 0 || a.applicability > 1)) e.push('applicability out of [0,1]');
  if (a.maturity && !EVIDENCE_MATURITY.includes(a.maturity)) e.push(`bad maturity: ${a.maturity}`);
  return e.length ? closed('expert', e) : { ok: true, errors: [] };
}

function validateRouterAssessment(a) {
  const e = [];
  if (!a || typeof a !== 'object') return closed('router', ['missing']);
  req(a, ['selectedExpert', 'weights', 'context', 'version'], e, 'router');
  if (a.weights && typeof a.weights === 'object') {
    for (const [k, v] of Object.entries(a.weights)) {
      if (!EXPERTS.includes(k)) e.push(`router weight for unknown expert ${k}`);
      if (v < 0) e.push(`negative router weight ${k}`);
    }
  }
  return e.length ? closed('router', e) : { ok: true, errors: [] };
}

function validateDistributional(a) {
  const e = [];
  if (!a || typeof a !== 'object') return closed('distributional', ['missing']);
  req(a, ['horizon', 'median', 'p10', 'p90', 'expectedShortfall', 'score', 'version'], e, 'dist');
  if (a.p10 != null && a.median != null && a.p90 != null && !(a.p10 <= a.median && a.median <= a.p90)) {
    e.push('quantiles must satisfy p10 <= median <= p90');
  }
  return e.length ? closed('distributional', e) : { ok: true, errors: [] };
}

function validateSurvival(a) {
  const e = [];
  if (!a || typeof a !== 'object') return closed('survival', ['missing']);
  req(a, ['pTargetBeforeStop', 'pStopBeforeTarget', 'pNeither', 'expectedSessions', 'calibrationStatus', 'version'], e, 'survival');
  const sum = (a.pTargetBeforeStop || 0) + (a.pStopBeforeTarget || 0) + (a.pNeither || 0);
  if (a.pTargetBeforeStop != null && Math.abs(sum - 1) > 0.02) e.push(`competing-risk probs must sum to 1 (got ${sum.toFixed(3)})`);
  return e.length ? closed('survival', e) : { ok: true, errors: [] };
}

function validateProsecutor(a) {
  const e = [];
  if (!a || typeof a !== 'object') return closed('prosecutor', ['missing']);
  req(a, ['failureModes', 'severity', 'failureScore', 'action', 'binding', 'calibrationStatus', 'version'], e, 'prosecutor');
  if (a.binding === true) e.push('prosecutor must be non-binding while shadow'); // fail closed: never binds unproven
  return e.length ? closed('prosecutor', e) : { ok: true, errors: [] };
}

function validateEntryDecision(a) {
  const e = [];
  if (!a || typeof a !== 'object') return closed('entry', ['missing']);
  if (!ACTIONS.includes(a.action)) e.push(`unknown action: ${a.action}`);
  req(a, ['action', 'utilityNow', 'utilityWait', 'trigger', 'invalidation', 'version'], e, 'entry');
  return e.length ? closed('entry', e) : { ok: true, errors: [] };
}

function validateOutcomeLabel(a) {
  const e = [];
  if (!a || typeof a !== 'object') return closed('outcome', ['missing']);
  req(a, ['securityId', 'decisionTs', 'labelEndDate', 'horizon', 'outcome'], e, 'outcome');
  const OUT = ['target', 'stop', 'neither', 'no_fill'];
  if (a.outcome && !OUT.includes(a.outcome)) e.push(`bad outcome: ${a.outcome}`);
  // no_fill is NOT a loss — asserted by keeping it a distinct label, never graded down
  return e.length ? closed('outcome', e) : { ok: true, errors: [] };
}

function validateCalibrationArtifact(a) {
  const e = [];
  if (!a || typeof a !== 'object') return closed('calibration', ['missing']);
  req(a, ['status', 'samples', 'brier', 'ece', 'builtFrom', 'version'], e, 'calibration');
  if (a.status && !CALIBRATION_STATUS.includes(a.status)) e.push(`bad calibration status ${a.status}`);
  return e.length ? closed('calibration', e) : { ok: true, errors: [] };
}

const VALIDATORS = Object.freeze({
  expert: validateExpertAssessment,
  router: validateRouterAssessment,
  distributional: validateDistributional,
  survival: validateSurvival,
  prosecutor: validateProsecutor,
  entry: validateEntryDecision,
  outcome: validateOutcomeLabel,
  calibration: validateCalibrationArtifact,
  provenance: (p) => validateProvenance(p),
});

// Validate an artifact of a given kind. Unknown kind fails closed.
function validateArtifact(kind, obj) {
  const v = VALIDATORS[kind];
  if (!v) return { ok: false, errors: [`no validator for kind '${kind}'`] };
  return v(obj);
}

function closed(kind, errors) { return { ok: false, errors: errors.map(x => `[${kind}] ${x}`) }; }
function normEnum(v, allowed, dflt) { return allowed.includes(v) ? v : dflt; }

module.exports = {
  EXPERTS, ACTIONS, CALIBRATION_STATUS, EVIDENCE_MATURITY, GOVERNANCE_STATUS, BANDS,
  makeProvenance, validateProvenance,
  bandForScore, displayNumber,
  validateArtifact, VALIDATORS,
  validateExpertAssessment, validateRouterAssessment, validateDistributional,
  validateSurvival, validateProsecutor, validateEntryDecision, validateOutcomeLabel,
  validateCalibrationArtifact,
};
