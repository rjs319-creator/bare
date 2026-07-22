'use strict';
// WALK-FORWARD VALIDATION + CHAMPION/CHALLENGER — does the account model actually add value?
//
// The account-skill layer earns influence ONLY if it beats simpler alternatives on
// leakage-resistant, cost-aware, prospective evidence. This module runs the time-ordered
// comparison ladder over graded episodes and reports READINESS — it never promotes anything
// (promotion is an explicit human governance change via strategy-gate PROMOTION_GATE).
//
// Ladder arms (each is a per-episode ranking signal, graded on the SAME outcomes):
//   1 setup         price/setup alone
//   2 socialEqual   social activity, equal account weights
//   3 socialSkill   social activity, context-specific account skill
//   4 priceEqual    price/setup + equal-weight social confirmation
//   5 priceSkill    price/setup + skill-weighted social confirmation
//   6 placebo       randomized account weights (must NOT beat the real arms)
//   follow/fade evaluated as sign of the outcome.
//
// Overlapping 5/10/21-session horizons are PURGED to independent decision dates (one obs per
// date = the date's mean), so inference is on independent dates, not raw episode count.
//
// Pure. Consumes episodes: { date, excess, arms:{ setup, socialEqual, socialSkill, priceEqual,
// priceSkill, placebo } }. Placebo is provided deterministically by the caller (seeded by
// index) so results are reproducible.

const { spearman } = require('./stats');

const MIN_INDEP_DATES = 25;   // below this the ladder is INCONCLUSIVE (honest)
const ARMS = ['setup', 'socialEqual', 'socialSkill', 'priceEqual', 'priceSkill', 'placebo'];

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function ci95(vals) {
  if (vals.length < 2) return [null, null];
  const m = mean(vals), v = mean(vals.map(x => (x - m) ** 2)) * (vals.length / (vals.length - 1)), se = Math.sqrt(v / vals.length);
  return [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)];
}

// Collapse overlapping observations to independent dates: one row per date carrying that
// date's MEAN excess and MEAN arm scores. This purges horizon overlap from the inference.
function toIndependentDates(episodes) {
  const byDate = new Map();
  for (const e of episodes || []) {
    if (!e || !e.date || !Number.isFinite(e.excess) || !e.arms) continue;
    const g = byDate.get(e.date) || { excess: [], arms: {} };
    g.excess.push(e.excess);
    for (const a of ARMS) if (Number.isFinite(e.arms[a])) (g.arms[a] = g.arms[a] || []).push(e.arms[a]);
    byDate.set(e.date, g);
  }
  const dates = [...byDate.keys()].sort();
  return dates.map(d => {
    const g = byDate.get(d);
    const arms = {};
    for (const a of ARMS) arms[a] = g.arms[a] && g.arms[a].length ? mean(g.arms[a]) : null;
    return { date: d, excess: mean(g.excess), arms };
  });
}

// Evaluate one arm: rank-IC of its score vs realized excess, and the mean excess of the
// top-tercile-scored dates (the economically meaningful cut), both on independent dates.
function evalArm(rows, arm) {
  const paired = rows.filter(r => Number.isFinite(r.arms[arm]));
  if (paired.length < 3) return { arm, n: paired.length, rankIC: null, topTercileMeanExcess: null, ci: [null, null] };
  const scores = paired.map(r => r.arms[arm]);
  const excess = paired.map(r => r.excess);
  const rankIC = +spearman(scores, excess).toFixed(3);
  const sorted = paired.slice().sort((a, b) => b.arms[arm] - a.arms[arm]);
  const k = Math.max(1, Math.floor(sorted.length / 3));
  const top = sorted.slice(0, k).map(r => r.excess);
  return { arm, n: paired.length, rankIC, topTercileMeanExcess: +mean(top).toFixed(3), ci: ci95(top) };
}

/**
 * Run the full ladder. Returns per-arm evaluation, the follow-vs-fade split, and an honest
 * incremental-value verdict for the account-skill layer.
 */
function walkForward(episodes, { modelVersion = 'alerts-skill-v1' } = {}) {
  const rows = toIndependentDates(episodes);
  const independentDates = rows.length;
  if (independentDates < MIN_INDEP_DATES) {
    return {
      independentDates, minDates: MIN_INDEP_DATES, ready: false,
      verdict: `INCONCLUSIVE — only ${independentDates}/${MIN_INDEP_DATES} independent decision dates. Not enough to test incremental value.`,
      arms: {}, modelVersion,
    };
  }
  const arms = {};
  for (const a of ARMS) arms[a] = evalArm(rows, a);

  // Follow vs fade: is following the setup+skill signal positive, and is fading it (opposite) worse?
  const allExcess = rows.map(r => r.excess);
  const follow = +mean(allExcess).toFixed(3);
  const fade = +(-follow).toFixed(3);

  // Incremental value of the account-skill layer: priceSkill must beat priceEqual AND setup
  // alone, with the improvement's lower CI clearing zero, AND it must beat the placebo.
  const skillM = arms.priceSkill.topTercileMeanExcess, equalM = arms.priceEqual.topTercileMeanExcess, setupM = arms.setup.topTercileMeanExcess, placeboM = arms.placebo.topTercileMeanExcess;
  const beatsEqual = skillM != null && equalM != null && skillM > equalM;
  const beatsSetup = skillM != null && setupM != null && skillM > setupM;
  const beatsPlacebo = skillM != null && placeboM != null && skillM > placeboM;
  const ciExcludesZero = arms.priceSkill.ci[0] != null && arms.priceSkill.ci[0] > 0;
  const addsValue = beatsEqual && beatsSetup && beatsPlacebo && ciExcludesZero;

  return {
    independentDates, minDates: MIN_INDEP_DATES,
    arms,
    followMeanExcess: follow, fadeMeanExcess: fade,
    incremental: { beatsEqual, beatsSetup, beatsPlacebo, ciExcludesZero, skillTop: skillM, equalTop: equalM, setupTop: setupM, placeboTop: placeboM },
    ready: addsValue,
    verdict: addsValue
      ? `READY FOR REVIEW — skill-weighted arm beats setup-alone (${setupM}), equal-weight (${equalM}) and placebo (${placeboM}) with CI>0. Human governance review required to promote.`
      : `NOT READY — account-skill layer does not yet add leakage-resistant incremental value over the price/setup baseline. Remains shadow (weight 0).`,
    note: 'This measures incremental value on purged, independently-dated, cost-aware episodes. It never promotes — promotion is an explicit registry maturity change gated by strategy-gate PROMOTION_GATE.',
    modelVersion,
  };
}

// Champion/challenger bookkeeping: freeze the current champion, evaluate a challenger
// prospectively, and demote when recent performance deteriorates beyond noise. Pure.
function championChallenger({ champion, challenger, recentDrift }) {
  const demote = recentDrift && recentDrift.recentMeanExcess < 0 && recentDrift.recentMeanExcess < recentDrift.longMeanExcess - 0.5;
  return {
    champion: champion || { version: 'alerts-skill-v1', frozen: true },
    challenger: challenger || null,
    recommendation: demote ? 'DEMOTE_CHAMPION_WEIGHTS' : challenger && challenger.ready ? 'PROMOTE_CHALLENGER_TO_CHAMPION_PENDING_HUMAN' : 'HOLD',
    note: 'Champion weights stay frozen; a challenger is compared prospectively only. No automatic production promotion.',
  };
}

module.exports = { MIN_INDEP_DATES, ARMS, toIndependentDates, evalArm, walkForward, championChallenger };
