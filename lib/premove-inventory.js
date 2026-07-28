'use strict';
// PRE-MOVE INVENTORY STATES (premove-inventory-v1) — Phases 8+9.
//
// The persistent PRIMED/ARMED/TRIGGERED/ACCEPTED/WEAKENING/INVALIDATED/
// EXPIRED/COMPLETED inventory, DERIVED from the existing Swing Episode
// Supervisor lifecycle (lib/swing-lifecycle) rather than a second state
// machine — the supervisor already guarantees no candidate disappears without
// a documented reason (union universe + displacement codes). This module maps
// supervisor lifecycle+action onto the pre-move vocabulary and builds the
// novice/expert card views with honest probability gating.
//
// Ranking hierarchy (Phase 8): every output stays SEPARATE and NAMED —
// preMoveRank, pTriggerBeforeInvalidation, pFillGivenTrigger,
// pTargetBeforeStopGivenFill, expectedNetRGivenFill, severeLossProbability,
// remainingOpportunity, expectedNetUtility — never one blended "confidence".
//
// Pure: supervisor episodes + stage outputs in, frozen cards out.

const { LIFECYCLE } = require('./swing-lifecycle');
const { displayNumber } = require('./atlasx-contracts');

const PREMOVE_INVENTORY_VERSION = 'premove-inventory-v1';

const STATES = Object.freeze({
  PRIMED: 'PRIMED',           // elevated transition likelihood; watch only
  ARMED: 'ARMED',             // near trigger, evidence improving
  TRIGGERED: 'TRIGGERED',     // objective trigger arrived
  ACCEPTED: 'ACCEPTED',       // trigger held and positive net utility remains
  WEAKENING: 'WEAKENING',     // thesis open but deteriorating
  INVALIDATED: 'INVALIDATED', // downside/failure condition reached
  EXPIRED: 'EXPIRED',         // transition did not occur in time
  COMPLETED: 'COMPLETED',     // target/exit resolved
});

const NOVICE_ACTION = Object.freeze({
  PRIMED: 'watch', ARMED: 'watch', TRIGGERED: 'triggered', ACCEPTED: 'triggered',
  WEAKENING: 'wait', INVALIDATED: 'avoid', EXPIRED: 'avoid', COMPLETED: 'avoid',
});

// Map a supervisor episode (+ optional Stage-B assessment) onto the pre-move state.
function premoveState(episode, stageB = null) {
  // Supervisor assessments carry the axis as `lifecycleState` (swing-episode
  // makeAssessment); `lifecycle` is accepted for older/loose callers. Reading
  // only `lifecycle` made every real episode fall through to PRIMED/ARMED.
  const a = episode && episode.assessment ? episode.assessment : null;
  const lc = a ? (a.lifecycleState ?? a.lifecycle ?? null) : null;
  switch (lc) {
    case LIFECYCLE.TARGET_HIT:
    case LIFECYCLE.CLOSED: return STATES.COMPLETED;
    case LIFECYCLE.INVALIDATED: return STATES.INVALIDATED;
    case LIFECYCLE.EXPIRED:
    case LIFECYCLE.NO_FILL: return STATES.EXPIRED;
    case LIFECYCLE.WEAKENING:
    case LIFECYCLE.DATA_STALE: return STATES.WEAKENING;
    case LIFECYCLE.TRIGGERED:
    case LIFECYCLE.THESIS_INTACT:
    case LIFECYCLE.EXTENDED:
    case LIFECYCLE.VALID_BUT_DISPLACED:
      return stageB && stageB.waterfall && stageB.waterfall.expectedNetUtilityBps > 0 ? STATES.ACCEPTED : STATES.TRIGGERED;
    case LIFECYCLE.ENTERABLE: return STATES.ARMED;
    case LIFECYCLE.NEW:
    case LIFECYCLE.WAITING_FOR_TRIGGER:
    default: {
      // ARMED = near the trigger with improving evidence; PRIMED otherwise.
      const nearTrigger = episode && episode.nearTrigger === true;
      return nearTrigger ? STATES.ARMED : STATES.PRIMED;
    }
  }
}

// Probability display gate (Phase 9.3/9.4): a % appears ONLY when the premove
// gate carries a valid, current, version-matched calibration artifact; otherwise
// rank percentile + qualitative band + an explicit uncalibrated/shadow label.
function displayProb(value, gate) {
  return displayNumber(value, gate && gate.showProbabilities ? 'calibrated' : 'uncalibrated', 'probability');
}

// Build the dual-view card for one inventory entry.
//   entry: { ticker, company, sector, state, stageA (cross-section row),
//            stageB (assessStageB result|null), episode, features, missing,
//            displacement, timeframeSessions, invalidation, versions }
function inventoryCard(entry, gate) {
  const state = entry.state;
  const a = entry.stageA || {};
  const b = entry.stageB || null;
  const novice = Object.freeze({
    ticker: entry.ticker,
    state,
    action: NOVICE_ACTION[state] || 'watch',
    reason: entry.reason || (state === STATES.PRIMED ? 'building pressure — no valid entry yet'
      : state === STATES.ARMED ? 'close to its trigger — do not buy before it fires'
        : state === STATES.TRIGGERED ? 'objective trigger fired — check the plan before acting'
          : state === STATES.ACCEPTED ? 'trigger held and the math still favors the trade'
            : state === STATES.WEAKENING ? 'thesis deteriorating — wait'
              : 'no longer a candidate'),
    invalidation: entry.invalidation ?? null,
    timeframe: entry.timeframeSessions ? `${entry.timeframeSessions} sessions` : null,
  });
  const expert = Object.freeze({
    preMoveRank: a.preMoveRank ?? null,
    evidenceBand: a.evidenceBand ?? null,
    pTriggerBeforeInvalidation: displayProb(a.pTriggerBeforeInvalidation ?? a.rawScore ?? null, gate),
    pFillGivenTrigger: displayProb(b && b.probabilities ? b.probabilities.pFillGivenTrigger : null, gate),
    pTargetBeforeStopGivenFill: displayProb(b && b.probabilities ? b.probabilities.pTargetBeforeStopGivenFill : null, gate),
    expectedNetRGivenFill: b && b.probabilities ? b.probabilities.expectedNetRGivenFill : null,
    severeLossProbability: displayProb(b && b.probabilities ? b.probabilities.severeLossProbability : null, gate),
    remainingOpportunity: b ? b.remainingOpportunity : null,
    expectedNetUtilityBps: b && b.waterfall ? b.waterfall.expectedNetUtilityBps : null,
    utilityWaterfall: b ? b.waterfall : null,
    costs: b ? b.costs : null,
    triggerAssumptions: b ? b.executionAssumptions : null,
    featureContributions: entry.featureContributions || null,
    missingFeatures: entry.missing || null,
    residualBasis: entry.residualBasis || null,
    failureModes: entry.failureModes || null,
    displacement: entry.displacement || null,
    versions: Object.freeze({
      inventory: PREMOVE_INVENTORY_VERSION,
      stageA: a.modelStatus || 'no-model',
      stageB: b ? b.version : null,
      features: entry.featureVersion || null,
      gateMode: gate ? gate.mode : 'off',
    }),
    shadowLabel: gate && gate.mayAffectLive ? null : 'uncalibrated/shadow — informational only, weight-zero',
  });
  return Object.freeze({ ticker: entry.ticker, company: entry.company || null, sector: entry.sector || null, state, novice, expert });
}

// Aggregate a set of entries → the server-authoritative board (a candidate must
// never vanish: entries whose source dropped stay, with displacement reasons —
// the supervisor's union guarantees the input already includes them).
function buildInventoryBoard(entries, gate) {
  const cards = (entries || []).map(e => inventoryCard(e, gate));
  const byState = {};
  for (const s of Object.keys(STATES)) byState[s] = cards.filter(c => c.state === s);
  return Object.freeze({
    version: PREMOVE_INVENTORY_VERSION,
    states: Object.keys(STATES),
    counts: Object.fromEntries(Object.keys(STATES).map(s => [s, byState[s].length])),
    byState: Object.freeze(byState),
    gate: gate || null,
    note: 'Server-authoritative pre-move inventory. Probabilities appear only behind a valid calibration artifact; otherwise rank percentile + evidence band, labeled uncalibrated/shadow.',
  });
}

module.exports = { PREMOVE_INVENTORY_VERSION, STATES, NOVICE_ACTION, premoveState, inventoryCard, buildInventoryBoard };
