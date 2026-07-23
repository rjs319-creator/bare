'use strict';
// ATLAS-X — expected-utility waterfall, conformal uncertainty and abstention.
//
// This is the layer that turns a distributional/survival/prosecutor read into a
// SINGLE, INSPECTABLE decision: does this name clear the bar, or does ATLAS-X
// abstain and show nothing? Two honesty rules are enforced here mechanically:
//
//   1. The expected value is a WATERFALL of signed terms that literally sum to the
//      headline number — reward, minus every penalty — so nothing is hidden inside
//      an opaque score. You can read WHY the utility is what it is.
//   2. The confidence interval is CONFORMAL from out-of-fold residuals. When there
//      is no calibration evidence, we return a deliberately WIDE band flagged
//      'insufficient-calibration' — never a tight, false-precise number. A candidate
//      only becomes actionable when its CONSERVATIVE lower bound clears the hurdle,
//      so no-calibration ⇒ wide band ⇒ abstain.
//
// Pure functions, bps units, frozen outputs. Weight-0 shadow: nothing here can move
// a live trade.

const { HURDLES, CALIBRATION } = require('./atlasx-config');
const { displayNumber } = require('./atlasx-contracts');

// ── tunable constants (named, never magic) ──────────────────────────────────
const BPS = 10_000;                    // one whole return unit → basis points
const UNCERTAINTY_PENALTY_WEIGHT = 0.25; // fraction of the half-width charged as risk
const SHORTFALL_PENALTY_WEIGHT = 0.5;    // fraction of expected shortfall charged
const DEFAULT_ALPHA = 0.2;             // 80% conformal interval by default
const WIDE_HALF_FLOOR_BPS = 500;       // no-calibration band is at least this wide (± bps)
const WIDE_MULTIPLE = 3;               // …or 3× |point estimate|, whichever is wider

const round = (x) => Math.round(x * 1e4) / 1e4;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOr = (v, d = 0) => (isNum(v) ? v : d);
const toBps = (fraction) => numOr(fraction) * BPS;

// Best competing use of the capital, in bps. Cash/SPY/sector/next-best expected
// returns are the yardstick a name must beat; the largest is the opportunity cost.
function bestAlternativeBps(opportunity = {}) {
  const alts = ['cash', 'spy', 'sector', 'nextBest']
    .map((k) => opportunity && isNum(opportunity[k]) ? toBps(opportunity[k]) : null)
    .filter((v) => v != null);
  return alts.length ? Math.max(...alts) : 0;
}

// Empirical quantile with linear interpolation on a pre-sorted array.
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Conformal / bootstrap interval around a point estimate (bps), built from
 * out-of-fold residuals (also bps). Too few residuals → a WIDE band flagged
 * 'insufficient-calibration'. NEVER returns a tight/false-precise band without
 * enough evidence.
 * @returns {{lower,upper,uncertaintySource,calibrationSamples,alpha,wide}}
 */
function conformalInterval(pointEstimate, residualsOOF, alpha = DEFAULT_ALPHA) {
  const pe = numOr(pointEstimate);
  const a = isNum(alpha) && alpha > 0 && alpha < 1 ? alpha : DEFAULT_ALPHA;
  const res = Array.isArray(residualsOOF) ? residualsOOF.filter(isNum) : [];

  if (res.length < CALIBRATION.minSamplesForBands) {
    const half = Math.max(WIDE_HALF_FLOOR_BPS, Math.abs(pe) * WIDE_MULTIPLE);
    return Object.freeze({
      lower: round(pe - half),
      upper: round(pe + half),
      uncertaintySource: 'insufficient-calibration',
      calibrationSamples: res.length,
      alpha: a,
      wide: true,
    });
  }
  const sorted = [...res].sort((x, y) => x - y);
  const loQ = quantile(sorted, a / 2);
  const hiQ = quantile(sorted, 1 - a / 2);
  return Object.freeze({
    lower: round(pe + loQ),
    upper: round(pe + hiQ),
    uncertaintySource: 'conformal-oof',
    calibrationSamples: sorted.length,
    alpha: a,
    wide: false,
  });
}

// ── actionability gate (fail closed) ─────────────────────────────────────────
// Ordered early-returns: the FIRST failing hurdle is the abstention reason. Missing
// data fails closed (defaults are the disqualifying value, not the passing one) so a
// gap in the feed can never manufacture a pick.
function isActionable(candidate = {}) {
  const expectedValue = numOr(candidate.expectedValue);
  const lower = numOr(candidate.lower, -Infinity);
  const failureScore = numOr(candidate.failureScore, 1);
  const remainingRR = numOr(candidate.remainingRR, 0);
  const staleSessions = numOr(candidate.dataStaleSessions, HURDLES.maxDataStaleSessions + 1);
  const applicability = numOr(candidate.expertApplicability, 0);
  const liquidity = numOr(candidate.liquidityDollarVol, 0);
  const regimePermitted = candidate.regimePermitted === true;

  if (!(expectedValue > 0)) return abstain('negative-expected-utility');
  if (!(lower >= HURDLES.minNetUtilityBps)) return abstain('below-net-utility-hurdle');
  if (!(failureScore <= HURDLES.maxFailureScore)) return abstain('prosecutor-failure-score');
  if (!(remainingRR >= HURDLES.minRemainingRR)) return abstain('insufficient-remaining-rr');
  if (!(staleSessions <= HURDLES.maxDataStaleSessions)) return abstain('stale-data');
  if (!(applicability >= HURDLES.minExpertApplicability)) return abstain('expert-not-applicable');
  if (!(liquidity >= HURDLES.minLiquidityDollarVol)) return abstain('insufficient-liquidity');
  if (!regimePermitted) return abstain('regime-not-permitted');
  return Object.freeze({ actionable: true, reason: null });
}

function abstain(reason) {
  return Object.freeze({ actionable: false, reason });
}

/**
 * Build the expected-utility waterfall and the actionable/abstain verdict.
 * @param {{distribution,survival,prosecutor,costs,opportunity,ctx}} input
 * @returns frozen decision record
 */
function computeUtility({ distribution, survival, prosecutor, costs, opportunity, ctx } = {}) {
  const dist = distribution || {};

  // Each waterfall term is a SIGNED contribution in bps; they sum to expectedValue.
  const netResidualBps = round(toBps(dist.median));
  const halfWidthBps = Math.abs(toBps(dist.p90) - toBps(dist.p10)) / 2;
  const uncertaintyPenalty = round(-UNCERTAINTY_PENALTY_WEIGHT * halfWidthBps);
  const shortfallPenalty = round(-SHORTFALL_PENALTY_WEIGHT * Math.abs(toBps(dist.expectedShortfall)));
  const transactionCosts = round(-Math.abs(numOr(costs && costs.roundTripBps)));
  const opportunityCost = round(-Math.max(0, bestAlternativeBps(opportunity)));
  const concentrationPenalty = round(-Math.abs(numOr(ctx && ctx.concentrationPenaltyBps)));

  const waterfall = [
    { term: 'expectedNetResidualReturn', value: netResidualBps },
    { term: 'uncertaintyPenalty', value: uncertaintyPenalty },
    { term: 'expectedShortfallPenalty', value: shortfallPenalty },
    { term: 'transactionCosts', value: transactionCosts },
    { term: 'opportunityCost', value: opportunityCost },
    { term: 'concentrationPenalty', value: concentrationPenalty },
  ].map(Object.freeze);

  const expectedValue = round(waterfall.reduce((s, t) => s + t.value, 0));

  const interval = conformalInterval(
    expectedValue,
    ctx && ctx.residualsOOF,
    ctx && ctx.alpha,
  );

  const candidate = {
    expectedValue,
    lower: interval.lower,
    failureScore: prosecutor && prosecutor.failureScore,
    remainingRR: ctx && ctx.remainingRR,
    dataStaleSessions: ctx && ctx.dataStaleSessions,
    expertApplicability: ctx && ctx.expertApplicability,
    liquidityDollarVol: ctx && ctx.liquidityDollarVol,
    regimePermitted: ctx ? ctx.regimePermitted === true : false,
  };
  const verdict = isActionable(candidate);

  // Any probability-like number routes through displayNumber: an uncalibrated
  // survival read is a qualitative band, never a percentage.
  const probabilityDisplay = displayNumber(
    survival && survival.pTargetBeforeStop,
    survival && survival.calibrationStatus,
    'probability',
  );

  return Object.freeze({
    waterfall: Object.freeze(waterfall),
    expectedValue,
    lower: interval.lower,
    upper: interval.upper,
    uncertaintySource: interval.uncertaintySource,
    calibrationSamples: interval.calibrationSamples,
    uncertainty: round(interval.upper - interval.lower),
    actionable: verdict.actionable,
    abstentionReason: verdict.reason,
    probabilityDisplay,
  });
}

module.exports = {
  BPS,
  UNCERTAINTY_PENALTY_WEIGHT,
  SHORTFALL_PENALTY_WEIGHT,
  DEFAULT_ALPHA,
  computeUtility,
  conformalInterval,
  isActionable,
  bestAlternativeBps,
};
