'use strict';
// ATLAS-X — optimal ENTER-NOW-vs-WAIT policy (`atlasx-entry-v1`). SHADOW / weight-0.
//
// Turns a candidate + its distributional, survival and prosecutor reads into ONE of eight
// entry actions. It computes the expected utility of ENTERING NOW and of WAITING as two
// SEPARATE numbers (never one blended score) and maps the richer of the two — together
// with gap/extension/cost structure — to an action:
//
//   DO_NOT_CHASE  gap too large to chase at the next open (> MAX_CHASE_GAP)
//   WAIT_BREAKOUT strong setup whose trigger has not printed yet
//   WAIT_PULLBACK extended leader — a better entry is likely on a pullback
//   WAIT_FIRST_HOUR / WAIT_CONFIRMATION  borderline — needs intraday confirmation
//   AVOID / NO_TRADE  costs/risk kill the edge, or there is no tradeable setup
//   ENTER_NEXT_OPEN  clean — entering next open dominates waiting
//
// It NEVER uses the signal-day close as an executable fill. Historical resolution reuses
// the canonical exec-v1 fill model (execution-policy.planFill) verbatim; a no-fill is a
// no-trade, NEVER graded as a loss.

const { VERSIONS, MAX_CHASE_GAP, HURDLES } = require('./atlasx-config');
const { POLICIES, planFill } = require('./execution-policy');

const MIN_UTIL_BPS = HURDLES.minNetUtilityBps;      // 25 — actionability floor
const MIN_RR = HURDLES.minRemainingRR;              // 1.2
const DEFAULT_COST_BPS = 15;                        // liquid round-of-friction fallback
const DEFAULT_RISK_BPS = 300;                       // ~3% stop when geometry is unknown
const FAILURE_PENALTY_BPS = 120;                    // shadow prosecutor shapes utility, never vetoes
const EDGE_DECAY_PER_WAIT = 0.06;                   // fraction of gross edge lost per waited session
const PULLBACK_IMPROVE_FRAC = 0.5;                  // better-entry credit as a fraction of risk

// Entry styles → exec-v1 policies for historical resolution.
const STYLE_TO_POLICY = Object.freeze({
  next_open: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE,
  next_open_no_slip: POLICIES.NEXT_OPEN,
  breakout_stop: POLICIES.BREAKOUT_STOP,
  pullback_limit: POLICIES.PULLBACK_LIMIT,
});

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function num(v) { return isNum(v) ? v : null; }
function clamp01(v) { return Math.max(0, Math.min(1, isNum(v) ? v : 0)); }
function round2(v) { return isNum(v) ? Math.round(v * 100) / 100 : v; }

// Reward/risk geometry in bps, from candidate prices when present, else RR / distribution.
function edgeGeometry(candidate, distribution) {
  const entry = num(candidate.entry) != null ? candidate.entry : num(candidate.price);
  const target = num(candidate.target);
  const stop = num(candidate.stop);
  let rewardBps = null;
  let riskBps = null;
  if (entry != null && entry > 0 && target != null) rewardBps = Math.abs(target - entry) / entry * 10000;
  if (entry != null && entry > 0 && stop != null) riskBps = Math.abs(entry - stop) / entry * 10000;
  if (riskBps == null && num(candidate.riskBps) != null) riskBps = candidate.riskBps;
  if (rewardBps == null && distribution && num(distribution.median) != null) rewardBps = Math.abs(distribution.median) * 10000;
  let rr = num(candidate.remainingRR);
  if (rr == null && rewardBps != null && riskBps != null && riskBps > 0) rr = rewardBps / riskBps;
  if (riskBps == null) riskBps = DEFAULT_RISK_BPS;
  if (rewardBps == null) rewardBps = rr != null ? riskBps * rr : riskBps * 1.5;
  if (rr == null) rr = rewardBps / riskBps;
  return { entry, target, stop, rewardBps, riskBps, remainingRR: rr };
}

// Adverse gap already run in the trade's favor (unsafe to chase), as a signed fraction.
function adverseGap(candidate) {
  const gap = num(candidate.gapPct) != null ? candidate.gapPct : num(candidate.gap);
  if (gap == null) return null;
  return (candidate.side === 'short' ? -gap : gap);
}

// The two SEPARATE expected utilities (bps): entering next open now vs waiting a session.
function utilities({ geo, survival, prosecutor, costBps, extended, breakoutNotTriggered }) {
  const pWin = clamp01(survival && survival.pTargetBeforeStop);
  const pLose = clamp01(survival && survival.pStopBeforeTarget);
  const failureScore = clamp01(prosecutor && prosecutor.failureScore);
  const failurePenalty = failureScore * FAILURE_PENALTY_BPS;

  const grossNow = pWin * geo.rewardBps - pLose * geo.riskBps;
  const utilityNow = grossNow - costBps - failurePenalty;

  // Waiting: shed a session of edge decay, but an extended name may offer a better entry;
  // a not-yet-triggered breakout risks running away (pMiss forgoes part of the edge).
  const edgeDecay = Math.max(0, grossNow) * EDGE_DECAY_PER_WAIT;
  const entryImprovement = extended ? geo.riskBps * PULLBACK_IMPROVE_FRAC : 0;
  const pMiss = breakoutNotTriggered ? clamp01(pWin * 0.6) : extended ? 0.1 : 0.2;
  const forgone = pMiss * Math.max(0, grossNow);
  const utilityWait = (grossNow - edgeDecay + entryImprovement) - costBps - failurePenalty - forgone;

  return {
    utilityNow: round2(utilityNow),
    utilityWait: round2(utilityWait),
    edgeDecay: round2(edgeDecay),
    entryImprovement: round2(entryImprovement),
    pMiss: round2(pMiss),
  };
}

// Map the two utilities + structure to exactly one of the eight ACTIONS. Early returns.
function chooseAction({ geo, u, entryState, excessiveGap }) {
  const hasSetup = num(geo.remainingRR) != null && geo.riskBps > 0 && entryState !== 'INVALID';
  if (!hasSetup) return 'NO_TRADE';
  if (entryState === 'STALE') return 'NO_TRADE';

  // Costs / risk have killed the edge in BOTH branches.
  if (u.utilityNow <= 0 && u.utilityWait <= 0) {
    return geo.remainingRR < MIN_RR ? 'NO_TRADE' : 'AVOID';
  }
  // Too far gone to chase at the next open.
  if (excessiveGap) return 'DO_NOT_CHASE';

  // Structural waits driven by the survival entry-state classifier.
  if (entryState === 'WAIT_FOR_BREAKOUT') return 'WAIT_BREAKOUT';
  if (entryState === 'WAIT_FOR_PULLBACK') return 'WAIT_PULLBACK';
  if (entryState === 'WAIT_FOR_CONFIRMATION') return 'WAIT_CONFIRMATION';

  // Positive but under the actionability hurdle → seek intraday confirmation first.
  if (u.utilityNow < MIN_UTIL_BPS) return 'WAIT_FIRST_HOUR';

  // Clean: enter next open only when entering dominates waiting.
  return u.utilityNow >= u.utilityWait ? 'ENTER_NEXT_OPEN' : 'WAIT_FIRST_HOUR';
}

function triggerFor(action, geo, candidate) {
  if (action === 'WAIT_BREAKOUT') return { style: 'breakout_stop', price: num(candidate.breakoutLevel) != null ? candidate.breakoutLevel : geo.target };
  if (action === 'WAIT_PULLBACK') return { style: 'pullback_limit', price: num(candidate.pullbackLevel) != null ? candidate.pullbackLevel : geo.entry };
  if (action === 'ENTER_NEXT_OPEN') return { style: 'next_open', price: null };
  return { style: 'none', price: null };
}

const RATIONALE = Object.freeze({
  NO_TRADE: 'no tradeable setup (missing/expired geometry)',
  AVOID: 'costs and risk erase the edge in both entering and waiting',
  DO_NOT_CHASE: 'gap exceeds the max-chase threshold — unsafe to chase at the next open',
  WAIT_BREAKOUT: 'strong setup whose breakout trigger has not printed yet',
  WAIT_PULLBACK: 'extended leader — a better entry is likely on a pullback',
  WAIT_CONFIRMATION: 'setup still forming — needs confirmation before entry',
  WAIT_FIRST_HOUR: 'borderline edge — let the first hour confirm before committing',
  ENTER_NEXT_OPEN: 'clean edge — entering next open dominates waiting',
});

/**
 * Decide enter-now vs wait for an ATLAS-X candidate.
 * @param {{candidate:object, distribution?:object, survival?:object, prosecutor?:object, ctx?:object}} input
 * @returns frozen entryDecision satisfying validateEntryDecision
 */
function decideEntry({ candidate = {}, distribution = null, survival = null, prosecutor = null, ctx = {} } = {}) {
  const geo = edgeGeometry(candidate, distribution);
  const costBps = num(ctx.costBps) != null ? ctx.costBps
    : num(candidate.costBps) != null ? candidate.costBps : DEFAULT_COST_BPS;

  const entryState = (survival && survival.entryState) || 'WAIT_FOR_CONFIRMATION';
  const extended = entryState === 'WAIT_FOR_PULLBACK' || candidate.state === 'extended';
  const breakoutNotTriggered = entryState === 'WAIT_FOR_BREAKOUT';

  const gap = adverseGap(candidate);
  const gapRisk = gap != null ? clamp01(Math.abs(gap) / (2 * MAX_CHASE_GAP)) : 0;
  const excessiveGap = gap != null && gap > MAX_CHASE_GAP;

  const u = utilities({ geo, survival, prosecutor, costBps, extended, breakoutNotTriggered });
  const action = chooseAction({ geo, u, entryState, excessiveGap });
  const trigger = triggerFor(action, geo, candidate);

  return Object.freeze({
    version: VERSIONS.entry,
    action,
    utilityNow: u.utilityNow,
    utilityWait: u.utilityWait,
    pMiss: u.pMiss,
    entryImprovement: u.entryImprovement,
    gapRisk: round2(gapRisk),
    edgeDecay: u.edgeDecay,
    remainingRR: round2(geo.remainingRR),
    trigger,
    invalidation: num(candidate.stop) != null ? candidate.stop : (candidate.invalidation || null),
    costBps,
    rationale: RATIONALE[action] || null,
  });
}

/**
 * Resolve the HISTORICAL fill for a decision, reusing exec-v1 planFill verbatim. A no-fill
 * is a no-trade, NOT a loss. `plan.style` ∈ next_open | breakout_stop | pullback_limit |
 * gap-skip; a gap-skip is a deliberate, honest skip (never a fabricated fill).
 * @returns {{filled:boolean, fillPrice:number|null, fillDate:string|null, reason:string}}
 */
function resolveHistoricalFill(candles, decisionDate, plan = {}) {
  const style = plan.style || plan.entryStyle || 'next_open';
  if (style === 'gap-skip' || style === 'gap_skip') {
    return Object.freeze({ filled: false, fillPrice: null, fillDate: null, reason: 'gap-skip (avoided chasing — not a loss)' });
  }
  const policy = STYLE_TO_POLICY[style] || POLICIES.NEXT_OPEN_PLUS_SLIPPAGE;
  const res = planFill(candles, decisionDate, {
    policy,
    side: plan.side === 'short' ? 'short' : 'long',
    tier: plan.tier || 'liquid',
    trigger: plan.trigger,
    slippagePct: plan.slippagePct,
  });
  return Object.freeze({
    filled: res.filled === true,
    fillPrice: res.filled === true ? res.fillPrice : null,
    fillDate: res.filled === true ? res.earliestFillDate : null,
    reason: res.fillReason,
  });
}

module.exports = {
  STYLE_TO_POLICY,
  edgeGeometry,
  utilities,
  chooseAction,
  decideEntry,
  resolveHistoricalFill,
};
