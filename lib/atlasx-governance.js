'use strict';
// ATLAS-X — model-health / drift monitor and the promotion VIEW.
//
// Three guardrails on a shadow challenger:
//   • modelHealth() reads ROLLING PROSPECTIVE metrics and returns a lifecycle state.
//     Few episodes ⇒ INSUFFICIENT_DATA / BUILDING (you cannot call a model broken on
//     a handful of trades). Deterioration ⇒ DEGRADING. Negative IC or broken
//     calibration ⇒ BROKEN. A degrading SHADOW model STAYS shadow — this function
//     never promotes and never triggers aggressive retraining from a small sample.
//   • promotionView() reports which PROMOTION_GATE criteria are met, fail-closed:
//     eligible only when EVERY criterion is met, and even then promotion needs an
//     explicit, reviewable registry `maturity` flip — code can never auto-promote.
//   • assertShadow() guards the invariant that atlasx is not registered production.
//
// Pure, frozen outputs.

const { HEALTH_STATES, HURDLES } = require('./atlasx-config');
const { PROMOTION_GATE, statusOf } = require('./strategy-gate');

// ── health thresholds (named; prospective, rolling) ──────────────────────────
const MIN_EPISODES_INSUFFICIENT = 10; // below → cannot judge at all
const MIN_EPISODES_BUILDING = 30;     // below → still accruing, don't call broken

const RANK_IC_HEALTHY = 0.03;         // healthy prospective rank IC floor
const CAL_ERR_BROKEN = 0.25;          // calibration error above → broken
const CAL_ERR_DEGRADE = 0.12;         // …elevated → degrading
const DUD_RATE_BROKEN = 0.6;          // fraction of picks that are duds → broken
const DUD_RATE_DEGRADE = 0.4;         // …elevated → degrading
const FEATURE_DRIFT_DEGRADE = 0.3;    // input distribution shift → degrading
const EXPERT_DISAGREE_DEGRADE = 0.7;  // router/expert disagreement → degrading
const PRECISION_DEGRADE = 0.4;        // top-k precision floor → degrading
const REGIME_COVERAGE_DEGRADE = 0.5;  // fraction of regimes seen → degrading

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Lifecycle state from rolling prospective metrics.
 * @param {object} metrics {rankIC,precision,netUtility,dudRate,calibrationError,
 *   featureDrift,expertDisagreement,regimeCoverage,dataFreshness,nEpisodes}
 * @returns {{state,reasons:string[]}} frozen
 */
function modelHealth(metrics = {}) {
  const m = metrics || {};
  const n = isNum(m.nEpisodes) ? m.nEpisodes : 0;

  // 1. Not enough evidence to judge — this dominates. You cannot declare a model
  //    broken (or healthy) on a handful of episodes.
  if (n < MIN_EPISODES_INSUFFICIENT) {
    return frozenHealth('INSUFFICIENT_DATA', [`only ${n} resolved episodes (<${MIN_EPISODES_INSUFFICIENT})`]);
  }
  if (n < MIN_EPISODES_BUILDING) {
    return frozenHealth('BUILDING', [`${n} episodes — still accruing toward ${MIN_EPISODES_BUILDING}`]);
  }

  // 2. Hard failures (broken).
  const broken = [];
  if (isNum(m.rankIC) && m.rankIC < 0) broken.push(`rank IC is negative (${m.rankIC})`);
  if (isNum(m.calibrationError) && m.calibrationError > CAL_ERR_BROKEN) {
    broken.push(`calibration error ${m.calibrationError} > ${CAL_ERR_BROKEN}`);
  }
  if (isNum(m.dudRate) && m.dudRate > DUD_RATE_BROKEN) {
    broken.push(`dud rate ${m.dudRate} > ${DUD_RATE_BROKEN}`);
  }
  if (broken.length) return frozenHealth('BROKEN', broken);

  // 3. Deterioration (degrading).
  const degrading = [];
  if (isNum(m.rankIC) && m.rankIC < RANK_IC_HEALTHY) {
    degrading.push(`rank IC ${m.rankIC} below healthy floor ${RANK_IC_HEALTHY}`);
  }
  if (isNum(m.netUtility) && m.netUtility <= 0) degrading.push(`net utility ${m.netUtility} <= 0`);
  if (isNum(m.calibrationError) && m.calibrationError > CAL_ERR_DEGRADE) {
    degrading.push(`calibration error ${m.calibrationError} > ${CAL_ERR_DEGRADE}`);
  }
  if (isNum(m.dudRate) && m.dudRate > DUD_RATE_DEGRADE) degrading.push(`dud rate ${m.dudRate} > ${DUD_RATE_DEGRADE}`);
  if (isNum(m.featureDrift) && m.featureDrift > FEATURE_DRIFT_DEGRADE) {
    degrading.push(`feature drift ${m.featureDrift} > ${FEATURE_DRIFT_DEGRADE}`);
  }
  if (isNum(m.expertDisagreement) && m.expertDisagreement > EXPERT_DISAGREE_DEGRADE) {
    degrading.push(`expert disagreement ${m.expertDisagreement} > ${EXPERT_DISAGREE_DEGRADE}`);
  }
  if (isNum(m.precision) && m.precision < PRECISION_DEGRADE) {
    degrading.push(`precision ${m.precision} < ${PRECISION_DEGRADE}`);
  }
  if (isNum(m.regimeCoverage) && m.regimeCoverage < REGIME_COVERAGE_DEGRADE) {
    degrading.push(`regime coverage ${m.regimeCoverage} < ${REGIME_COVERAGE_DEGRADE}`);
  }
  if (isNum(m.dataFreshness) && m.dataFreshness > HURDLES.maxDataStaleSessions) {
    degrading.push(`data ${m.dataFreshness} sessions stale > ${HURDLES.maxDataStaleSessions}`);
  }
  if (degrading.length) return frozenHealth('DEGRADING', degrading);

  return frozenHealth('HEALTHY', ['all rolling metrics within healthy ranges']);
}

function frozenHealth(state, reasons) {
  // state must be one of the declared lifecycle states (defensive).
  const safe = HEALTH_STATES.includes(state) ? state : 'INSUFFICIENT_DATA';
  return Object.freeze({ state: safe, reasons: Object.freeze(reasons.slice()) });
}

/**
 * Which PROMOTION_GATE criteria are met — fail-closed eligibility.
 * @param {object} evidence {resolvedEpisodes,independentDates,incrementalExcessReturn,
 *   calibrationBeatsBaseRate,costAware,regimeRobust,confidenceInterval}
 * @returns {{gate,met,unmet,eligible,note}} frozen
 */
function promotionView(evidence = {}) {
  const e = evidence || {};
  const met = {
    minResolvedEpisodes: isNum(e.resolvedEpisodes) && e.resolvedEpisodes >= PROMOTION_GATE.minResolvedEpisodes,
    minIndependentDates: isNum(e.independentDates) && e.independentDates >= PROMOTION_GATE.minIndependentDates,
    incrementalExcessReturn: e.incrementalExcessReturn === true,
    calibrationBeatsBaseRate: e.calibrationBeatsBaseRate === true,
    costAware: e.costAware === true,
    regimeRobust: e.regimeRobust === true,
    confidenceInterval: e.confidenceInterval === true,
  };
  const unmet = Object.keys(met).filter((k) => !met[k]);
  return Object.freeze({
    gate: PROMOTION_GATE,
    met: Object.freeze(met),
    unmet: Object.freeze(unmet),
    // Fail-closed: eligible ONLY when every criterion is met.
    eligible: unmet.length === 0,
    note: 'Even when eligible, promotion requires an explicit, reviewable registry maturity flip — code never auto-promotes.',
  });
}

/**
 * Guard the invariant: atlasx must NOT be registered as production. Returns its
 * current status; throws if the registry ever flips it to production unexpectedly.
 */
function assertShadow() {
  const status = statusOf('atlasx');
  if (status === 'production') {
    throw new Error('ATLAS-X invariant violated: strategy is registered production but must be shadow/weight-0');
  }
  return status;
}

module.exports = {
  MIN_EPISODES_INSUFFICIENT,
  MIN_EPISODES_BUILDING,
  modelHealth,
  promotionView,
  assertShadow,
};
