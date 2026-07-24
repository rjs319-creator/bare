// PATTERN DECISION — turn a descriptive detection into ONE explicit action, fail-closed.
//
// This does NOT build a second state machine. It maps the detection + freshness + optional
// live intraday validation into an `ev` and runs it through the app's existing
// opportunity-lifecycle engine, then translates the resulting lifecycle STATE (plus the
// pattern phase and whether the edge is proven) into the prompt's explicit action set.
//
// FAIL-CLOSED RULES (a pattern can never amplify a stale/failed setup):
//   • No live current-session evidence ⇒ NO_ACTION_STALE. A daily-only detection can reach
//     at most WAIT_FOR_TRIGGER / FORMING / WATCH, never ACTIONABLE_NOW.
//   • Invalidation hit / stop breach ⇒ FAILED / EXIT_INVALIDATED (retained, not hidden).
//   • Over-extended ⇒ DO_NOT_CHASE.
//   • A shape that WOULD be actionable but has no leakage-safe proven edge ⇒ RESEARCH_ONLY.

const { advanceLifecycle, STATES, isActionable } = require('../opportunity-lifecycle');
const { computeFreshness, isCurrentSessionFresh } = require('../freshness');
const { PHASES } = require('./phases');

const STRATEGY = 'chartpattern';
const STRATEGY_VERSION = 'pattern-decision-v1';

const ACTIONS = Object.freeze({
  NO_ACTION_STALE: 'NO_ACTION_STALE',
  WATCH: 'WATCH',
  FORMING: 'FORMING',
  WAIT_FOR_TRIGGER: 'WAIT_FOR_TRIGGER',
  ACTIONABLE_NOW: 'ACTIONABLE_NOW',
  DO_NOT_CHASE: 'DO_NOT_CHASE',
  STALLING: 'STALLING',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  MANAGE_POSITION: 'MANAGE_POSITION',
  EXIT_INVALIDATED: 'EXIT_INVALIDATED',
  RESEARCH_ONLY: 'RESEARCH_ONLY',   // visually strong but historically unproven
});

const isNum = v => typeof v === 'number' && isFinite(v);

// Build the lifecycle `ev` from a detection + freshness + optional live intraday snapshot.
// Intraday fields are only set when a live snapshot is supplied — that is what lets a
// detection climb to ACTIONABLE_NOW. Without it, the gate stays closed by construction.
function buildPatternEv(detection, { now, freshness, intraday = null } = {}) {
  const plan = detection.plan || {};
  const long = detection.direction !== 'SHORT';
  const ev = {
    ticker: detection.ticker,
    strategy: STRATEGY,
    now,
    freshness,
    metrics: { family: detection.family, phase: detection.phase, similarity: detection.similarity && detection.similarity.combined },
    // Structural signals available from the daily detection:
    breakoutFailed: detection.invalidationHit === true,
    stopBreached: detection.invalidationHit === true,
    priorSessionOnly: freshness ? !isCurrentSessionFresh(freshness) : true,
    expired: detection.phase === PHASES.EXPIRED,
  };
  if (isNum(detection.extensionAtr)) ev.extensionAtr = detection.extensionAtr;

  // LIVE intraday validation (Stage-2). Only these fields can open the actionable gate.
  if (intraday) {
    Object.assign(ev, {
      aboveVwap: long ? intraday.aboveVwap === true : intraday.aboveVwap === false,
      triggerConfirmed: intraday.triggerConfirmed === true,
      momentumOk: intraday.momentumOk !== false,
      residualOk: intraday.residualOk !== false,
      relVolOk: intraday.relVolOk !== false,
      remainingRR: isNum(intraday.remainingRR) ? intraday.remainingRR : (plan.rr ?? null),
      extensionAtr: isNum(intraday.extensionAtr) ? intraday.extensionAtr : ev.extensionAtr,
      closesBelowVwap: intraday.closesBelowVwap ?? 0,
      lossFromDetectionAtr: intraday.lossFromDetectionAtr ?? 0,
      breakoutFailed: intraday.breakoutFailed === true || ev.breakoutFailed,
      stopBreached: intraday.stopBreached === true || ev.stopBreached,
      session: intraday.session || 'regular',
      nearTrigger: intraday.nearTrigger === true,
    });
  }
  return ev;
}

// Decide the explicit action from a detection.
function decidePattern(detection, { now = new Date().toISOString(), freshness = null, intraday = null, prediction = null, analog = null } = {}) {
  const fresh = freshness || computeFreshness({ barDate: detection.patternAsOf });
  const ev = buildPatternEv(detection, { now, freshness: fresh, intraday });
  const record = advanceLifecycle(null, ev, { strategy: STRATEGY, strategyVersion: STRATEGY_VERSION });
  const lifecycleState = record.state;

  const liveFresh = isCurrentSessionFresh(fresh);
  const proven = !!(prediction && prediction.calibrated) || !!(analog && analog.calibrated) || !!(analog && analog.sufficient);

  const action = mapAction({ lifecycleState, phase: detection.phase, detection, liveFresh, proven });

  return {
    lifecycleState,
    patternPhase: detection.phase,
    action,
    actionable: action === ACTIONS.ACTIONABLE_NOW,
    thesisValid: !(detection.invalidationHit || lifecycleState === STATES.FAILED),
    planValid: !!(detection.plan && isNum(detection.plan.rr) && detection.plan.rr > 0),
    currentSessionFresh: liveFresh,
    proven,
    strategyVersion: STRATEGY_VERSION,
  };
}

function mapAction({ lifecycleState, phase, detection, liveFresh, proven }) {
  // Terminal / failure first (retained visibly). EXIT_INVALIDATED only applies when there
  // is actually a position to exit (post-entry); a never-entered detection just FAILED.
  if (detection.invalidationHit) return lifecycleState === STATES.MANAGING ? ACTIONS.EXIT_INVALIDATED : ACTIONS.FAILED;
  if (lifecycleState === STATES.FAILED) return ACTIONS.FAILED;
  if (lifecycleState === STATES.EXPIRED || phase === PHASES.EXPIRED) return ACTIONS.EXPIRED;
  if (lifecycleState === STATES.MANAGING) return ACTIONS.MANAGE_POSITION;
  if (lifecycleState === STATES.TOO_EXTENDED || phase === PHASES.EXTENDED) return ACTIONS.DO_NOT_CHASE;
  if (lifecycleState === STATES.STALLING || phase === PHASES.STALLING) return ACTIONS.STALLING;

  // Actionable ONLY when: the STRUCTURE is trigger-ready (a still-forming base can't be a
  // breakout no matter how strong the intraday tape), the live gate opened, and the setup
  // is fresh. Even then, an unproven edge is RESEARCH_ONLY, not a buy.
  const triggerReady = phase === PHASES.CONFIRMED || phase === PHASES.RETESTING || phase === PHASES.NEAR_TRIGGER;
  if (triggerReady && isActionable(lifecycleState) && liveFresh) {
    return proven ? ACTIONS.ACTIONABLE_NOW : ACTIONS.RESEARCH_ONLY;
  }

  // Not (yet) actionable — fail closed on staleness.
  if (!liveFresh && (phase === PHASES.CONFIRMED || phase === PHASES.NEAR_TRIGGER)) return ACTIONS.NO_ACTION_STALE;
  if (phase === PHASES.CONFIRMED || phase === PHASES.RETESTING) return ACTIONS.WAIT_FOR_TRIGGER;
  if (phase === PHASES.NEAR_TRIGGER) return ACTIONS.WAIT_FOR_TRIGGER;
  if (phase === PHASES.FORMING) return ACTIONS.FORMING;
  return ACTIONS.WATCH;
}

module.exports = { decidePattern, buildPatternEv, mapAction, ACTIONS, STRATEGY, STRATEGY_VERSION };
