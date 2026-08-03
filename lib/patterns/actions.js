'use strict';
// PATTERN ACTIONS — position-aware professional vocabulary.
//
// Replaces the ambiguous BUY/SELL language. A short setup can NEVER say "Buy triggered"
// and "enter short" is never conflated with "sell/exit an existing long" — the action set
// itself makes the confusion unrepresentable, and tests assert the wording.

const { EP_STATES } = require('./episodes');

const ACTIONS = Object.freeze({
  LONG_ENTRY_READY: 'LONG_ENTRY_READY',
  LONG_TRIGGERED: 'LONG_TRIGGERED',
  SHORT_ENTRY_READY: 'SHORT_ENTRY_READY',
  SHORT_TRIGGERED: 'SHORT_TRIGGERED',
  HOLD_LONG: 'HOLD_LONG',
  HOLD_SHORT: 'HOLD_SHORT',
  TRIM_LONG: 'TRIM_LONG',
  COVER_SHORT: 'COVER_SHORT',
  EXIT_LONG: 'EXIT_LONG',
  AVOID: 'AVOID',
  WATCH: 'WATCH',
  RESEARCH_ONLY: 'RESEARCH_ONLY',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});

const isNum = v => typeof v === 'number' && isFinite(v);

// Decide the action for an episode.
//   input: {
//     state          — episode state (EP_STATES)
//     direction      — 'LONG' | 'SHORT'
//     eligibility    — from confirm.recommendationEligibility (fail-closed)
//     fresh          — is the underlying data current-session/current-bar fresh?
//     planQuality    — 'good' | 'acceptable' | 'poor' | 'invalid'
//     remainingRR    — live remaining reward:risk (null = unknown)
//     conflictSevere — an opposing higher-priority setup exists
//   }
function actionFor({ state, direction, eligibility = null, fresh = true, planQuality = 'acceptable', remainingRR = null, conflictSevere = false } = {}) {
  const long = direction !== 'SHORT';
  const eligible = !!(eligibility && eligibility.eligible);

  switch (state) {
    case EP_STATES.FAILED: return ACTIONS.FAILED;
    case EP_STATES.EXPIRED: return ACTIONS.EXPIRED;
    case EP_STATES.STOPPED:
    case EP_STATES.TARGET_REACHED:
      return long ? ACTIONS.EXIT_LONG : ACTIONS.COVER_SHORT;
    case EP_STATES.MANAGING: {
      // In a position: manage it. Near-target or badly extended → take some off.
      if (isNum(remainingRR) && remainingRR < 0.5) return long ? ACTIONS.TRIM_LONG : ACTIONS.COVER_SHORT;
      return long ? ACTIONS.HOLD_LONG : ACTIONS.HOLD_SHORT;
    }
    case EP_STATES.CONFIRMED: {
      if (planQuality === 'poor' || planQuality === 'invalid') return ACTIONS.AVOID;
      if (conflictSevere) return ACTIONS.AVOID;
      if (isNum(remainingRR) && remainingRR < 1) return ACTIONS.AVOID; // move mostly gone
      if (!fresh) return ACTIONS.WATCH;                                // stale data cannot be actionable
      if (!eligible) return ACTIONS.RESEARCH_ONLY;                     // triggered but unvalidated
      return long ? ACTIONS.LONG_TRIGGERED : ACTIONS.SHORT_TRIGGERED;
    }
    case EP_STATES.TRIGGERED_PENDING_CONFIRMATION:
    case EP_STATES.RETESTING:
    case EP_STATES.READY: {
      if (planQuality === 'poor' || planQuality === 'invalid') return ACTIONS.AVOID;
      if (conflictSevere) return ACTIONS.AVOID;
      if (!fresh) return ACTIONS.WATCH;
      if (!eligible) return ACTIONS.WATCH; // pre-trigger + unvalidated → plain watch
      return long ? ACTIONS.LONG_ENTRY_READY : ACTIONS.SHORT_ENTRY_READY;
    }
    default:
      return ACTIONS.WATCH;
  }
}

// Plain-English labels. Direction-safe by construction: every SHORT label speaks in
// short/cover terms, every LONG label in buy/sell-to-close terms.
const ACTION_LABEL = Object.freeze({
  LONG_ENTRY_READY: 'Long setup — near trigger',
  LONG_TRIGGERED: 'Long entry triggered',
  SHORT_ENTRY_READY: 'Short setup — near trigger',
  SHORT_TRIGGERED: 'Short entry triggered',
  HOLD_LONG: 'Holding long — manage against plan',
  HOLD_SHORT: 'Holding short — manage against plan',
  TRIM_LONG: 'Trim the long — most of the move is gone',
  COVER_SHORT: 'Cover the short',
  EXIT_LONG: 'Exit the long',
  AVOID: 'Avoid — setup not worth taking',
  WATCH: 'Watch only',
  RESEARCH_ONLY: 'Triggered — research only (edge unproven)',
  FAILED: 'Failed — invalidation hit',
  EXPIRED: 'Expired without triggering',
});

// Novice one-liner explaining what the action means for THIS setup.
function noviceLine(action, { direction, trigger, invalidation } = {}) {
  const short = direction === 'SHORT';
  const trigTxt = isNum(trigger) ? `$${trigger.toFixed(2)}` : 'the trigger';
  const invTxt = isNum(invalidation) ? `$${invalidation.toFixed(2)}` : 'its invalidation level';
  switch (action) {
    case ACTIONS.LONG_ENTRY_READY: return `Watching for a move above ${trigTxt} to open a long. It fails below ${invTxt}.`;
    case ACTIONS.SHORT_ENTRY_READY: return `Watching for a break below ${trigTxt} to open a short. The short thesis is void above ${invTxt}.`;
    case ACTIONS.LONG_TRIGGERED: return `The long trigger at ${trigTxt} confirmed. This is an entry signal for a NEW long, not advice on an existing position.`;
    case ACTIONS.SHORT_TRIGGERED: return `The breakdown below ${trigTxt} confirmed. This is an entry signal for a NEW short — it is not a "sell your shares" alert.`;
    case ACTIONS.HOLD_LONG: return `If you took the long, hold it against the plan. It exits below ${invTxt}.`;
    case ACTIONS.HOLD_SHORT: return `If you took the short, hold it against the plan. Cover above ${invTxt}.`;
    case ACTIONS.TRIM_LONG: return 'Most of the measured move has played out — consider taking partial profits on the long.';
    case ACTIONS.COVER_SHORT: return 'Cover the short — the plan has run its course.';
    case ACTIONS.EXIT_LONG: return 'The long plan has resolved — exit per the plan.';
    case ACTIONS.AVOID: return 'The structure exists but the trade is not worth taking (poor remaining reward:risk or a conflicting setup).';
    case ACTIONS.WATCH: return short ? 'A bearish structure is developing — nothing to do yet.' : 'A bullish structure is developing — nothing to do yet.';
    case ACTIONS.RESEARCH_ONLY: return `Technical ${short ? 'breakdown' : 'breakout'} triggered — research only. This family has no independently validated edge yet, so it is not a trade recommendation.`;
    case ACTIONS.FAILED: return 'The setup failed — its invalidation level was hit. Kept visible so you can see why.';
    case ACTIONS.EXPIRED: return 'The setup aged out without triggering.';
    default: return 'Watch only.';
  }
}

module.exports = { ACTIONS, ACTION_LABEL, actionFor, noviceLine };
