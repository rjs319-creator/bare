'use strict';
// SHARED DECISION CONTRACT v1 — the one record shape Market Pulse, Trade Alerts, and
// Options all produce, so a single Decision Queue can rank them against each other.
//
// Design rules this file enforces mechanically (not by convention):
//   • Every confidence dimension is SEPARATE. `factConfidence` (do we believe the facts),
//     `modelReliability` (is the model calibrated FOR THIS event family/regime/horizon),
//     and `decisionReadiness` (can a decision be made now) never collapse into one score.
//   • `modelReliability` may only be LOW/MEDIUM/HIGH when a calibration record exists for
//     the relevant cohort. Otherwise it is UNPROVEN with the effective sample attached.
//   • Missing evidence is represented, not omitted: `missingEvidence` entries and
//     `unavailable()` blocks carry reasons.
//   • Dissent is preserved as a list; it can only lower `decisionReadiness`, never be
//     averaged away.
//   • Nothing in this module can change a strategy's weight or governance status. The
//     `governance` block is copied in from the registry and is read-only here.
//
// Pure; no I/O.

const SCHEMA_VERSION = 'decision-contract-v1';

const STATE = Object.freeze(['ACT_NOW', 'SET_ALERT', 'INVESTIGATE', 'MANAGE', 'AVOID', 'WAIT']);
const LIFECYCLE = Object.freeze(['WATCH', 'ARMED', 'TRIGGERED', 'MANAGE', 'INVALIDATED', 'EXPIRED']);
const HORIZON = Object.freeze(['intraday', 'swing', 'investor']);
const CONFIDENCE = Object.freeze(['UNAVAILABLE', 'LOW', 'MEDIUM', 'HIGH']);
const RELIABILITY = Object.freeze(['UNAVAILABLE', 'UNPROVEN', 'LOW', 'MEDIUM', 'HIGH']);

// Lifecycle transitions that are legal. Anything else is rejected, so a renderer or an
// agent cannot walk a record from EXPIRED back to ARMED.
const LEGAL_TRANSITIONS = Object.freeze({
  WATCH: ['ARMED', 'INVALIDATED', 'EXPIRED'],
  ARMED: ['TRIGGERED', 'WATCH', 'INVALIDATED', 'EXPIRED'],
  TRIGGERED: ['MANAGE', 'INVALIDATED', 'EXPIRED'],
  MANAGE: ['INVALIDATED', 'EXPIRED'],
  INVALIDATED: [],
  EXPIRED: [],
});

/** A field the system could not measure, with the reason it could not. Pure. */
const unavailable = reason => ({ available: false, reason: String(reason || 'no data') });

/** A measured field with its provenance. Pure. */
const measured = (value, { asOf = null, source = null, basis = 'MEASURED' } = {}) =>
  ({ available: true, value, asOf, source, basis });

/**
 * Model reliability with the calibration gate baked in. A caller CANNOT hand back
 * LOW/MEDIUM/HIGH without a matching calibration record; without one this returns
 * UNPROVEN plus the effective sample, exactly as the mission requires.
 *
 * @param {object} calibration { cohort, frozen, outOfSample, n, effectiveN, version }
 * @param {object} cohort      { eventFamily, regime, horizon } the record actually belongs to
 */
function reliabilityFor(calibration, cohort = {}) {
  const c = calibration || null;
  const wanted = `${cohort.eventFamily || '?'}|${cohort.regime || '?'}|${cohort.horizon || '?'}`;
  if (!c) {
    return { level: 'UNPROVEN', cohort: wanted, effectiveSample: 0, modelVersion: null,
      reason: 'No calibration record exists for this event family / regime / horizon.' };
  }
  if (c.cohort !== wanted) {
    return { level: 'UNPROVEN', cohort: wanted, effectiveSample: c.effectiveN || 0, modelVersion: c.version || null,
      reason: `Calibration exists for "${c.cohort}" but not for this record's cohort "${wanted}" — it does not transfer.` };
  }
  if (!c.frozen || !c.outOfSample) {
    return { level: 'UNPROVEN', cohort: wanted, effectiveSample: c.effectiveN || 0, modelVersion: c.version || null,
      reason: 'Calibration is not frozen and out-of-sample — it cannot support a reliability level.' };
  }
  const n = c.effectiveN || 0;
  const level = n >= 150 ? 'HIGH' : n >= 60 ? 'MEDIUM' : n >= 20 ? 'LOW' : 'UNPROVEN';
  return { level, cohort: wanted, effectiveSample: n, modelVersion: c.version || null,
    reason: level === 'UNPROVEN' ? `Only ${n} effective independent observations — below the floor for any reliability level.` : null };
}

const RANK_CONF = { UNAVAILABLE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
const CONF_BY_RANK = ['UNAVAILABLE', 'LOW', 'MEDIUM', 'HIGH'];

/**
 * Decision readiness. Deliberately NOT an average: it is the MINIMUM of the fact
 * confidence and the evidence-coverage read, then downgraded once per unresolved
 * dissent and once for any missing REQUIRED evidence. Disagreement contests a decision.
 */
function readinessFor({ factConfidence = 'UNAVAILABLE', evidenceCoverage = 0, dissent = [], missingEvidence = [], deterministicGatePassed = true } = {}) {
  if (!deterministicGatePassed) {
    return { level: 'UNAVAILABLE', reasons: ['A deterministic gate blocks this decision — no agent output can raise it.'] };
  }
  const coverageLevel = evidenceCoverage >= 0.8 ? 'HIGH' : evidenceCoverage >= 0.5 ? 'MEDIUM' : evidenceCoverage > 0 ? 'LOW' : 'UNAVAILABLE';
  let rank = Math.min(RANK_CONF[factConfidence] ?? 0, RANK_CONF[coverageLevel]);
  const reasons = [];
  const unresolved = (dissent || []).filter(d => d && !d.resolved);
  if (unresolved.length) {
    rank = Math.max(0, rank - 1);
    reasons.push(`${unresolved.length} unresolved agent disagreement(s) — readiness downgraded, not averaged away.`);
  }
  const required = (missingEvidence || []).filter(m => m && m.required);
  if (required.length) {
    rank = Math.max(0, rank - 1);
    reasons.push(`Required evidence missing: ${required.map(m => m.field).join(', ')}.`);
  }
  if (coverageLevel === 'UNAVAILABLE') reasons.push('No evidence coverage measured.');
  return { level: CONF_BY_RANK[rank], reasons };
}

/**
 * Build a schema-valid decision record. Unknown fields are dropped; required blocks that
 * the caller omitted become explicit `unavailable()` markers rather than silently absent.
 * Pure — returns a new frozen-shape object.
 */
function makeDecision(input = {}) {
  const i = input;
  const horizon = HORIZON.includes(i.horizon) ? i.horizon : 'swing';
  const lifecycle = LIFECYCLE.includes(i.lifecycle) ? i.lifecycle : 'WATCH';
  const state = STATE.includes(i.state) ? i.state : 'WAIT';
  const dissent = Array.isArray(i.dissent) ? i.dissent : [];
  const missingEvidence = Array.isArray(i.missingEvidence) ? i.missingEvidence : [];

  const modelReliability = i.modelReliability && i.modelReliability.level
    ? i.modelReliability
    : reliabilityFor(i.calibration || null, { eventFamily: i.eventFamily, regime: i.regime, horizon });

  const factConfidence = CONFIDENCE.includes(i.factConfidence) ? i.factConfidence : 'UNAVAILABLE';
  const readiness = i.decisionReadiness && i.decisionReadiness.level
    ? i.decisionReadiness
    : readinessFor({
      factConfidence,
      evidenceCoverage: i.evidenceCoverage ?? 0,
      dissent, missingEvidence,
      deterministicGatePassed: i.deterministicGatePassed !== false,
    });

  return {
    schema: SCHEMA_VERSION,
    decisionId: i.decisionId || null,
    source: i.source || null,                 // 'pulse2' | 'alerts' | 'options-v2'
    entity: i.entity || null,
    horizon,
    state,
    lifecycle,
    thesis: typeof i.thesis === 'string' ? i.thesis.slice(0, 600) : null,
    whatChanged: Array.isArray(i.whatChanged) ? i.whatChanged : [],
    factState: i.factState || {},
    expectationDelta: i.expectationDelta || unavailable('no consensus/expectation feed configured'),
    regimeFit: i.regimeFit || unavailable('no regime read supplied'),
    crossAssetConfirmation: i.crossAssetConfirmation || unavailable('no cross-asset read supplied'),
    priceReaction: i.priceReaction || unavailable('no price-reaction read supplied'),
    positioning: i.positioning || unavailable('no positioning read supplied'),
    portfolioRelevance: i.portfolioRelevance || unavailable('no holdings/watchlist supplied'),
    trigger: i.trigger || unavailable('no deterministic trigger available'),
    entryZone: i.entryZone || unavailable('no entry zone derived'),
    maxChase: i.maxChase || unavailable('no maximum-chase condition derived'),
    invalidation: i.invalidation || unavailable('no deterministic invalidation available'),
    targets: Array.isArray(i.targets) ? i.targets : [],
    timeStop: i.timeStop || unavailable('no time stop derived'),
    executionConstraints: i.executionConstraints || unavailable('no execution evidence supplied'),
    riskPlan: i.riskPlan || unavailable('no risk budget supplied'),
    // ── the three SEPARATE confidence dimensions ──
    factConfidence,
    dataQuality: i.dataQuality || { coverage: i.evidenceCoverage ?? 0, degraded: (i.evidenceCoverage ?? 0) < 0.5, notes: [] },
    modelReliability,
    decisionReadiness: readiness.level,
    decisionReadinessReasons: readiness.reasons,
    dissent,
    missingEvidence,
    sources: Array.isArray(i.sources) ? i.sources : [],
    asOf: i.asOf || null,
    expiresAt: i.expiresAt || null,
    modelVersions: i.modelVersions || {},
    // Read-only echo of the registry's governance status. Nothing here can change it.
    governance: i.governance || null,
    utility: i.utility || null,
  };
}

/** Is this lifecycle move legal? Pure. */
function canTransition(from, to) {
  if (!LIFECYCLE.includes(from) || !LIFECYCLE.includes(to)) return false;
  return (LEGAL_TRANSITIONS[from] || []).includes(to);
}

/**
 * Apply a lifecycle transition immutably. Illegal moves are refused and reported, so an
 * agent or a renderer cannot resurrect an expired decision.
 */
function transition(decision, to, { reason = null, at = null } = {}) {
  const from = decision && decision.lifecycle;
  if (!canTransition(from, to)) {
    return { decision, changed: false, reason: `illegal lifecycle transition ${from} → ${to}` };
  }
  return {
    decision: {
      ...decision,
      lifecycle: to,
      whatChanged: [
        ...(decision.whatChanged || []),
        { kind: 'lifecycle', from, to, reason: reason || null, at: at || null },
      ].slice(-40),
    },
    changed: true,
    reason: null,
  };
}

/** Structural validation. Returns { valid, errors } — pure, no throwing. */
function validateDecision(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return { valid: false, errors: ['not an object'] };
  if (d.schema !== SCHEMA_VERSION) errors.push(`schema must be ${SCHEMA_VERSION}`);
  if (!d.decisionId) errors.push('decisionId is required');
  if (!STATE.includes(d.state)) errors.push(`state must be one of ${STATE.join('|')}`);
  if (!LIFECYCLE.includes(d.lifecycle)) errors.push(`lifecycle must be one of ${LIFECYCLE.join('|')}`);
  if (!HORIZON.includes(d.horizon)) errors.push(`horizon must be one of ${HORIZON.join('|')}`);
  if (!CONFIDENCE.includes(d.factConfidence)) errors.push('factConfidence must be UNAVAILABLE|LOW|MEDIUM|HIGH');
  if (!d.modelReliability || !RELIABILITY.includes(d.modelReliability.level)) errors.push('modelReliability.level is required');
  if (!CONFIDENCE.includes(d.decisionReadiness)) errors.push('decisionReadiness must be UNAVAILABLE|LOW|MEDIUM|HIGH');
  // The calibration gate, enforced structurally: a real reliability level needs a cohort
  // and an effective sample, so no caller can assert HIGH from nowhere.
  if (['LOW', 'MEDIUM', 'HIGH'].includes((d.modelReliability || {}).level)) {
    if (!d.modelReliability.cohort) errors.push('a LOW/MEDIUM/HIGH modelReliability must name its calibration cohort');
    if (!(d.modelReliability.effectiveSample > 0)) errors.push('a LOW/MEDIUM/HIGH modelReliability must carry an effective sample');
  }
  if (d.state === 'ACT_NOW' && d.decisionReadiness === 'UNAVAILABLE') {
    errors.push('ACT_NOW is not permitted while decisionReadiness is UNAVAILABLE');
  }
  if (!Array.isArray(d.dissent)) errors.push('dissent must be an array (dissent is preserved, never averaged)');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION, STATE, LIFECYCLE, HORIZON, CONFIDENCE, RELIABILITY, LEGAL_TRANSITIONS,
  unavailable, measured, reliabilityFor, readinessFor,
  makeDecision, validateDecision, canTransition, transition,
};
