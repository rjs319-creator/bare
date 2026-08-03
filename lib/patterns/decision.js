'use strict';
// PATTERN DECISION — one explicit position-aware action per detection, fail-closed.
//
// v2 changes (the defects this closes):
//   • "Proven" now comes ONLY from the fail-closed recommendationEligibility (a versioned
//     validation artifact). `analog.sufficient` — sample size alone — no longer has any
//     vote, and a barrier model-estimate never counts as evidence.
//   • Actions are position-aware (actions.js): a SHORT can never read as "Buy triggered",
//     and "enter short" is distinct from "exit an existing long".
//   • Daily-close-confirmed swing/long-term setups are actionable for NEXT-SESSION
//     execution when their bar is the latest completed session — the old gate demanded
//     live intraday evidence from every horizon, which made swing setups structurally
//     unreachable. Intraday-horizon setups still require current-session freshness.
//   • Stale data still cannot become actionable: a bar older than the most recent
//     session windows down to WATCH.

const { advanceLifecycle, STATES } = require('../opportunity-lifecycle');
const { computeFreshness, isCurrentSessionFresh } = require('../freshness');
const { EP_STATES } = require('./episodes');
const { ACTIONS, actionFor, noviceLine } = require('./actions');
const { recommendationEligibility } = require('./confirm');

const STRATEGY = 'chartpattern';
const STRATEGY_VERSION = 'pattern-decision-v2';

const isNum = v => typeof v === 'number' && isFinite(v);

// How stale a "latest completed daily bar" may be (calendar days) and still support a
// next-session plan. Covers weekends + a holiday; anything older is not the latest session.
const MAX_SESSION_AGE_DAYS = 5;

function isRecentSession(barDate, now) {
  if (!barDate) return false;
  const t = Date.parse(String(barDate));
  const n = now ? Date.parse(String(now)) : Date.now();
  if (!isNum(t) || !isNum(n)) return false;
  const days = (n - t) / 86400000;
  return days >= -1 && days <= MAX_SESSION_AGE_DAYS;
}

// Detection → episode-equivalent state (used when deciding on a fresh detection that has
// no persisted episode yet; the radar path decides directly from real episodes).
function stateFromDetection(d) {
  if (d.invalidationHit) return EP_STATES.FAILED;
  if (d.phase === 'EXPIRED') return EP_STATES.EXPIRED;
  if (d.breakoutConfirmed) return d.retesting ? EP_STATES.RETESTING : EP_STATES.CONFIRMED;
  if (d.confirmation && d.confirmation.status === 'INTRADAY_PENETRATION') return EP_STATES.TRIGGERED_PENDING_CONFIRMATION;
  if (d.phase === 'NEAR_TRIGGER') return EP_STATES.READY;
  if (d.phase === 'FORMING' || d.phase === 'STALLING') return EP_STATES.FORMING;
  return EP_STATES.EMERGING;
}

// Legacy lifecycle bridge — keeps the app-wide lifecycle record (freshness/hysteresis
// machinery) attached without letting it grant actionability on its own.
function lifecycleStateFor(detection, { now, freshness, intraday }) {
  try {
    const ev = {
      ticker: detection.ticker,
      strategy: STRATEGY,
      now,
      freshness,
      metrics: { family: detection.family, phase: detection.phase },
      breakoutFailed: detection.invalidationHit === true,
      stopBreached: detection.invalidationHit === true,
      priorSessionOnly: freshness ? !isCurrentSessionFresh(freshness) : true,
      expired: detection.phase === 'EXPIRED',
    };
    if (intraday) Object.assign(ev, { triggerConfirmed: intraday.triggered === true, session: 'regular' });
    const rec = advanceLifecycle(null, ev, { strategy: STRATEGY, strategyVersion: STRATEGY_VERSION });
    return rec.state;
  } catch { return STATES.WATCHING; }
}

// Decide the explicit action for one detection.
//   opts: { now, freshness, intradayStatus (confirm.technicalStatusIntraday result),
//           dailyStatus (confirm.technicalStatusDaily result), evidenceTable,
//           conflictSevere }
function decidePattern(detection, {
  now = new Date().toISOString(),
  freshness = null,
  intradayStatus = null,
  dailyStatus = null,
  evidenceTable = null,
  conflictSevere = false,
} = {}) {
  const fresh = freshness || computeFreshness({ barDate: detection.patternAsOf });
  const state = stateFromDetection(detection);
  const eligibility = recommendationEligibility({
    evidenceTable,
    family: detection.family,
    direction: detection.direction,
    timeframe: detection.timeframe,
  });

  // Freshness policy by horizon: intraday setups need the CURRENT session; swing and
  // long-term daily-close setups need the latest completed session (next-session intent).
  const liveFresh = isCurrentSessionFresh(fresh);
  const isIntradayHorizon = detection.horizon === 'intraday' || detection.timeframe === 'session';
  const freshEnough = isIntradayHorizon ? liveFresh : isRecentSession(detection.patternAsOf, now);

  const technicalStatus = intradayStatus || dailyStatus || null;
  const remainingRR = technicalStatus && isNum(technicalStatus.remainingRR)
    ? technicalStatus.remainingRR
    : (detection.plan ? detection.plan.rr : null);

  const action = actionFor({
    state,
    direction: detection.direction,
    eligibility,
    fresh: freshEnough,
    planQuality: detection.plan ? detection.plan.quality : 'invalid',
    remainingRR,
    conflictSevere,
  });

  const lifecycleState = lifecycleStateFor(detection, { now, freshness: fresh, intraday: intradayStatus });

  return {
    action,
    actionLabelSafe: true,
    noviceAction: noviceLine(action, {
      direction: detection.direction,
      trigger: detection.plan ? detection.plan.trigger : null,
      invalidation: detection.plan ? detection.plan.stop : null,
    }),
    state,
    lifecycleState,
    technicalStatus,
    recommendationEligibility: eligibility,
    proven: eligibility.eligible === true,
    actionable: action === ACTIONS.LONG_TRIGGERED || action === ACTIONS.SHORT_TRIGGERED,
    thesisValid: !detection.invalidationHit && state !== EP_STATES.FAILED,
    planValid: !!(detection.plan && isNum(detection.plan.rr) && detection.plan.rr > 0 && detection.plan.quality !== 'invalid'),
    currentSessionFresh: liveFresh,
    freshEnough,
    executionIntent: technicalStatus ? technicalStatus.executionIntent || 'none' : (state === EP_STATES.CONFIRMED && freshEnough ? 'next-session' : 'none'),
    strategyVersion: STRATEGY_VERSION,
  };
}

module.exports = { decidePattern, stateFromDetection, isRecentSession, ACTIONS, STRATEGY, STRATEGY_VERSION, MAX_SESSION_AGE_DAYS };
