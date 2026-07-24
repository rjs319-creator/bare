'use strict';
// 🧬 BIOTECH GATES (Phase 6) — independent severe-loss and action-ceiling gates. These run
// AFTER scoring and can only ever LOWER a candidate's ceiling, never raise it, so a high
// Research-Priority number can never hide an unresolved binary, a pending dilution, an illiquid
// promotion, an already-consumed move, or missing critical data. Missing data is treated as
// missing (it lowers the ceiling); it never earns a neutral or positive default.

const { ACTION, ACTION_RANK, ARCHETYPES: A, CAPITAL_STATES: S, DATA_QUALITY } = require('./biotech-config');

const SWING_LIQUIDITY_FLOOR = 2_000_000;   // avg $ vol below this → not executable as a swing
const LOW_LIQUIDITY = 5_000_000;           // below this + unidentified reason → watch only
const MIN_REWARD_RISK = 1.3;               // below this → wait for a better entry
const OVEREXTENDED_ATR = 4;                // last-bar move in ATR units → blow-off / late
const CONSUMED_RET5 = 45;                  // % 5-day move already banked → late for a fresh entry

// Take the most restrictive (minimum-rank) of the current ceiling and a candidate ceiling.
function lower(current, candidate) {
  return ACTION_RANK[candidate] < ACTION_RANK[current] ? candidate : current;
}

/**
 * @param {object} ctx { archetype, event, capital, features, liquidity:{avgDollarVol,price},
 *                       plan:{rewardRisk,planStatus}, aiClass, timing, hasExitBefore, dataQuality }
 * @returns { actionCeiling, actionCeilingReasons:[], actionability, severeLossRisk }
 */
function applyGates(ctx = {}) {
  const f = ctx.features || {};
  const cap = ctx.capital || null;
  const arch = ctx.archetype || A.UNCLASSIFIED;
  const liq = ctx.liquidity || {};
  const plan = ctx.plan || {};
  const aiClass = ctx.aiClass || null;
  const ev = ctx.event || null;
  const reasons = [];

  const verified = !!(ev && ev.verified);
  // Starting ceiling: verified catalyst may reach PRIMARY-SOURCE CONFIRMED; otherwise ACTIONABLE.
  let ceiling = verified ? ACTION.PRIMARY_CONFIRMED : ACTION.ACTIONABLE;
  if (!verified) reasons.push('catalyst not primary-source verified → capped below PRIMARY-SOURCE CONFIRMED');

  // ── Liquidity (independent, hard) ──
  const adv = liq.avgDollarVol;
  if (adv != null && adv < SWING_LIQUIDITY_FLOOR) {
    ceiling = lower(ceiling, ACTION.NON_EXECUTABLE);
    reasons.push(`avg $ volume ~$${Math.round(adv / 1e6 * 10) / 10}M below the $${SWING_LIQUIDITY_FLOOR / 1e6}M swing floor → non-executable`);
  }

  // ── Binary / special-situation routing ──
  if (arch === A.BINARY_WATCH) {
    ceiling = lower(ceiling, ACTION.BINARY_WATCH_ONLY);
    reasons.push('unresolved binary / special situation — outside normal actionable swing ranking');
  }

  // ── Conflicting scientific / regulatory evidence ──
  if (ev && (ev.verification === 'CONFLICTED' || (ev.conflicts && ev.conflicts.length))) {
    ceiling = lower(ceiling, ACTION.NEEDS_REVIEW);
    reasons.push('conflicting scientific/regulatory evidence — needs review');
  }

  // ── Capital-structure gates ──
  if (cap) {
    if (cap.state === S.SEVERE_DILUTION_RISK) { ceiling = lower(ceiling, ACTION.AVOID); reasons.push('severe dilution / distress signal → avoid'); }
    else if (cap.state === S.PENDING_OFFERING) { ceiling = lower(ceiling, ACTION.WAIT_FOR_FINANCING); reasons.push('offering in progress → wait for the financing to clear'); }
    else if (cap.state === S.ACTIVE_ATM) { ceiling = lower(ceiling, ACTION.WAIT_FOR_FINANCING); reasons.push('active ATM into strength → they may sell your breakout'); }
  }

  // ── Unidentified reason + thin liquidity → watch only ──
  const unidentified = arch === A.UNCLASSIFIED || aiClass === 'NOISE' || aiClass === 'STEALTH';
  if (unidentified && adv != null && adv < LOW_LIQUIDITY) {
    ceiling = lower(ceiling, ACTION.WATCH_ONLY);
    reasons.push('no identified catalyst + thin liquidity → watch only');
  }
  if (aiClass === 'STEALTH') reasons.push('unexplained accumulation — NOT credited as a catalyst until prospective evidence supports it');

  // ── Already-consumed / overextended → late ──
  const overextended = (f.extAtr != null && f.extAtr >= OVEREXTENDED_ATR) || (f.ret5 != null && f.ret5 >= CONSUMED_RET5 && arch === A.POST_CATALYST);
  if (overextended) {
    ceiling = lower(ceiling, ACTION.LATE);
    reasons.push('move already consumed / overextended → late for a fresh swing entry');
  }

  // ── Invalid reward/risk → wait ──
  if (plan.rewardRisk != null && plan.rewardRisk < MIN_REWARD_RISK && ACTION_RANK[ceiling] > ACTION_RANK[ACTION.WAIT_FOR_TRIGGER]) {
    ceiling = lower(ceiling, ACTION.WAIT_FOR_TRIGGER);
    reasons.push(`reward:risk ${plan.rewardRisk} below ${MIN_REWARD_RISK} → wait for a better entry`);
  }
  // Plan says the trigger has not fired yet.
  if (plan.planStatus === 'wait-trigger' && ACTION_RANK[ceiling] > ACTION_RANK[ACTION.WAIT_FOR_TRIGGER]) {
    ceiling = lower(ceiling, ACTION.WAIT_FOR_TRIGGER);
    reasons.push('entry trigger not yet met');
  }

  // ── Missing critical data must not present as actionable ──
  if (ctx.dataQuality === DATA_QUALITY.MISSING && ACTION_RANK[ceiling] > ACTION_RANK[ACTION.WATCH_ONLY]) {
    ceiling = lower(ceiling, ACTION.WATCH_ONLY);
    reasons.push('critical data missing → watch only (no positive default granted)');
  }

  // ── Severe-loss risk (independent veto signal, reported separately from the ceiling) ──
  let severe = 'Low';
  const severeReasons = [];
  if (cap && (cap.state === S.PENDING_OFFERING || cap.state === S.ACTIVE_ATM || cap.state === S.SEVERE_DILUTION_RISK)) { severe = 'High'; severeReasons.push('dilution overhang'); }
  if (arch === A.BINARY_WATCH || (ctx.timing === 'Ahead' && !ctx.hasExitBefore)) { severe = 'High'; severeReasons.push('unresolved binary gap risk'); }
  if (f.lowPriced || (liq.price != null && liq.price < 2)) { severe = severe === 'High' ? 'High' : 'Medium'; severeReasons.push('sub-$2 delisting/reverse-split risk'); }
  if (overextended && severe === 'Low') { severe = 'Medium'; severeReasons.push('blow-off / fade risk'); }

  const actionability = ({
    [ACTION.PRIMARY_CONFIRMED]: 'actionable', [ACTION.ACTIONABLE]: 'actionable',
    [ACTION.WAIT_FOR_TRIGGER]: 'waiting', [ACTION.WAIT_FOR_FINANCING]: 'waiting',
    [ACTION.NEEDS_REVIEW]: 'review', [ACTION.WATCH_ONLY]: 'watch',
    [ACTION.BINARY_WATCH_ONLY]: 'binary', [ACTION.LATE]: 'late',
    [ACTION.NON_EXECUTABLE]: 'non-executable', [ACTION.AVOID]: 'avoid',
  })[ceiling] || 'watch';

  return {
    actionCeiling: ceiling, actionCeilingReasons: reasons, actionability,
    severeLossRisk: severe, severeLossReasons: severeReasons,
  };
}

module.exports = {
  applyGates, lower, SWING_LIQUIDITY_FLOOR, LOW_LIQUIDITY, MIN_REWARD_RISK, OVEREXTENDED_ATR, CONSUMED_RET5,
};
