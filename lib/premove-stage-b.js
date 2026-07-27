'use strict';
// STAGE B — CONDITIONAL EXECUTION MODEL (premove-stage-b-v1) — Phase 7.
//
// Activates ONLY after an objectively defined trigger. Estimates
// P(target before stop | trigger occurred AND executable fill obtained), plus
// expected net R given fill, severe-loss probability, timeout probability and
// an INSPECTABLE expected-net-utility waterfall:
//
//   expected reward − expected loss − transaction costs − slippage
//   − uncertainty penalty − opportunity cost − concentration penalty
//   = expected net utility
//
// Reuse over reinvention: barrier probabilities come from the driftless
// coil-executable model (labeled 'model-estimate' — NEVER validated numbers),
// costs from lib/costs liquidity tiers, fills from exec-v1 semantics. No
// trigger ⇒ WATCH/WAIT, never BUY.
//
// Pure: levels + vol + tier in, frozen decision object out.

const { coilExecutable } = require('./coil-executable');
const { costBreakdown, roundTripCostPct } = require('./costs');

const STAGE_B_VERSION = 'premove-stage-b-v1';

// Objective trigger definition (versioned). A trigger REQUIRES:
//   - the pivot/entry break with price ACCEPTANCE (close beyond the level, not
//     a one-tick tag), OR a tag plus expanding range AND turnover confirmation;
//   - opening gap beyond maxGapPct ⇒ no chase (fill refused);
// Evidence inputs are decision-time bar facts supplied by the caller.
const TRIGGER_RULES = Object.freeze({
  version: 'premove-trigger-v1',
  maxGapPct: 0.05,
  minRangeExpansion: 1.2,       // trigger-bar range vs 20-bar mean range
  minTurnoverRatio: 1.2,        // trigger-bar volume vs 20-bar mean volume
  maxUpperWickShare: 0.6,       // a mostly-wick tag is rejection, not acceptance
});

const num = (v) => (Number.isFinite(v) ? v : null);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Evaluate one bar against the trigger definition.
//   bar: {open,high,low,close,volume}; level: trigger price;
//   base: {meanRange20, meanVol20}
function evaluateTrigger({ bar, level, base = {} } = {}) {
  if (!bar || !(level > 0)) return { triggered: false, reason: 'no-level' };
  const hi = num(bar.high), close = num(bar.close), open = num(bar.open);
  if (hi == null || close == null) return { triggered: false, reason: 'no-bar-data' };
  if (hi < level) return { triggered: false, reason: 'level-not-touched' };
  if (open != null && open > level * (1 + TRIGGER_RULES.maxGapPct)) {
    return { triggered: true, executable: false, reason: 'gap-beyond-max-entry' };
  }
  const range = bar.high - bar.low;
  const upperWick = range > 0 ? (bar.high - Math.max(bar.open, bar.close)) / range : 0;
  const acceptance = close >= level;
  const rangeExp = base.meanRange20 > 0 ? range / base.meanRange20 : null;
  const volConf = base.meanVol20 > 0 && Number.isFinite(bar.volume) ? bar.volume / base.meanVol20 : null;
  const confirmed = acceptance
    || ((rangeExp != null && rangeExp >= TRIGGER_RULES.minRangeExpansion)
      && (volConf != null && volConf >= TRIGGER_RULES.minTurnoverRatio)
      && upperWick <= TRIGGER_RULES.maxUpperWickShare);
  if (!confirmed) return { triggered: false, reason: 'touch-without-acceptance', upperWick: +upperWick.toFixed(3), rangeExpansion: rangeExp, turnoverRatio: volConf };
  return {
    triggered: true, executable: true,
    acceptance, rangeExpansion: rangeExp != null ? +rangeExp.toFixed(2) : null,
    turnoverRatio: volConf != null ? +volConf.toFixed(2) : null,
    upperWick: +upperWick.toFixed(3),
    version: TRIGGER_RULES.version,
  };
}

// The inspectable utility waterfall (all in basis points on the position).
function utilityWaterfall({ expectedRewardBps = 0, expectedLossBps = 0, transactionCostBps = 0, slippageBps = 0, uncertaintyPenaltyBps = 0, opportunityCostBps = 0, concentrationPenaltyBps = 0 } = {}) {
  const rows = [
    { item: 'expectedReward', bps: +expectedRewardBps.toFixed(1) },
    { item: 'expectedLoss', bps: -Math.abs(+expectedLossBps.toFixed(1)) },
    { item: 'transactionCosts', bps: -Math.abs(+transactionCostBps.toFixed(1)) },
    { item: 'slippage', bps: -Math.abs(+slippageBps.toFixed(1)) },
    { item: 'uncertaintyPenalty', bps: -Math.abs(+uncertaintyPenaltyBps.toFixed(1)) },
    { item: 'opportunityCost', bps: -Math.abs(+opportunityCostBps.toFixed(1)) },
    { item: 'concentrationPenalty', bps: -Math.abs(+concentrationPenaltyBps.toFixed(1)) },
  ];
  const expectedNetUtilityBps = +rows.reduce((s, r) => s + r.bps, 0).toFixed(1);
  return Object.freeze({ rows: Object.freeze(rows), expectedNetUtilityBps });
}

/**
 * Stage-B assessment for one triggered candidate.
 * @param {object} p
 * @param {object} p.trigger      evaluateTrigger() result (must be executable)
 * @param {number} p.current      current price
 * @param {number} p.entry        trigger/fill reference level
 * @param {number} p.stop         invalidation
 * @param {number} p.target       objective
 * @param {number} p.dailyVol     decision-time daily vol
 * @param {string} p.tier         liquidity tier ('liquid'|'small'|'micro'|'biotech')
 * @param {number} [p.holdSessions=10]
 * @param {number} [p.opportunityCostBps=0]   best alternative's expected bps
 * @param {number} [p.concentrationPenaltyBps=0]
 */
function assessStageB(p = {}) {
  const { trigger, current, entry, stop, target, dailyVol, tier = 'small', holdSessions = 10 } = p;
  if (!trigger || trigger.triggered !== true) {
    return Object.freeze({ version: STAGE_B_VERSION, state: 'WATCH', action: 'wait', reason: 'no objective trigger — watch/wait, never buy', probabilities: null, waterfall: null });
  }
  if (trigger.executable === false) {
    return Object.freeze({ version: STAGE_B_VERSION, state: 'NO_FILL', action: 'wait', reason: trigger.reason || 'trigger not executable (gap beyond max entry)', probabilities: null, waterfall: null });
  }
  const rt = roundTripCostPct(tier) / 100;                       // fraction
  const be = coilExecutable({ current, entry, stop, target, dailyVol, horizon: holdSessions, roundTripCostPct: rt });
  if (!be) {
    return Object.freeze({ version: STAGE_B_VERSION, state: 'INVALID_GEOMETRY', action: 'avoid', reason: 'invalid level geometry (need stop < entry < target, positive vol)', probabilities: null, waterfall: null });
  }
  const cb = costBreakdown(tier, { side: 'long', holdSessions });
  const risk = entry - stop;
  const riskBps = (risk / entry) * 10000;
  // Reward/loss in bps of position value, weighted by the barrier model's
  // (model-estimate, uncalibrated) probabilities.
  // pTargetFirst + pStopFirst + pTimeout sum to 1 in the barrier model.
  const rewardBps = (be.pTargetFirst ?? be.pTargetBeforeStopGivenFill) * ((target - entry) / entry) * 10000;
  const expectedLossBps = Math.max(0, be.pStopFirst ?? (1 - be.pTargetBeforeStopGivenFill)) * riskBps;
  const uncertaintyPenaltyBps = (be.uncertaintyInterval
    ? (be.uncertaintyInterval.hi - be.uncertaintyInterval.lo) / 2
    : 0.15) * riskBps;
  const waterfall = utilityWaterfall({
    expectedRewardBps: rewardBps,
    expectedLossBps,
    transactionCostBps: (cb.spreadPct || 0) * 100,
    slippageBps: 0,                                              // slippage is inside the tier spread model; kept as a labeled zero row
    uncertaintyPenaltyBps,
    opportunityCostBps: p.opportunityCostBps || 0,
    concentrationPenaltyBps: p.concentrationPenaltyBps || 0,
  });
  const remainingRewardPct = current > 0 ? (target - current) / current : null;
  return Object.freeze({
    version: STAGE_B_VERSION,
    state: waterfall.expectedNetUtilityBps > 0 ? 'ACCEPT_CANDIDATE' : 'TRIGGERED_NEGATIVE_UTILITY',
    action: waterfall.expectedNetUtilityBps > 0 ? 'triggered' : 'avoid',
    trigger,
    // SEPARATE, NAMED outputs (Phase 8): never collapsed into one confidence.
    probabilities: Object.freeze({
      pFillGivenTrigger: be.pTrigger,
      pTargetBeforeStopGivenFill: be.pTargetBeforeStopGivenFill,
      pTimeout: be.pTimeout,
      severeLossProbability: be.severeLossProbability,
      expectedNetRGivenFill: be.expectedNetRGivenFill,
      calibrationStatus: 'model-estimate',                       // driftless barrier model — NOT validated
      model: be.model || 'driftless-barrier-v1',
    }),
    remainingOpportunity: remainingRewardPct != null ? +(remainingRewardPct * 100).toFixed(2) : null,
    costs: Object.freeze({ tier, roundTripPct: +(rt * 100).toFixed(3), holdSessions, borrow: cb.borrow || null }),
    waterfall,
    executionAssumptions: 'exec-v1: next-session stop-entry, gap-through fills at the worse open, gap beyond max-entry refused, same-bar ambiguity resolves to the stop',
  });
}

module.exports = { STAGE_B_VERSION, TRIGGER_RULES, evaluateTrigger, utilityWaterfall, assessStageB };
