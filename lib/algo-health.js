'use strict';

// Algorithm Effectiveness Monitor (algo-health-v1)
// ------------------------------------------------
// Pure statistics + classification for "which algorithms are working NOW". Given each
// algorithm's resolved, genuinely-out-of-sample record (a series of per-decision-date
// SPY-relative excess returns) plus optional long-term skill, regime compatibility,
// calibration and independence, it emits a health verdict on the seven-state ladder the
// spec requires — each verdict carrying an estimate, a confidence interval, an effective
// sample size, and a plain reason.
//
// Deliberately I/O-free and clock-free: the route (lib/algo-router-routes.js) assembles the
// inputs from cached ledgers/artifacts and stamps timestamps. This module only reasons, so
// every classification is deterministic and unit-testable.
//
// Reuses (never reimplements): the Wilson interval from lib/stats.js — the same CI the
// evidence-maturity grader already trusts — so a "STRONG" here is comparable to a
// "Validated" there, not a second, incompatible notion of significance.

const { wilson } = require('./stats');

const HEALTH_VERSION = 'algo-health-v1';

// Seven-state ladder (spec). Ordered best→worst for display; `weight` is the *health*
// multiplier the router applies (long-term skill, regime fit, etc. are separate factors).
const HEALTH_STATES = {
  STRONG:       { rank: 0, weight: 1.00, label: 'Strong',       blurb: 'Positive recent AND long-term OOS edge, acceptable calibration.' },
  SUPPORTED:    { rank: 1, weight: 0.70, label: 'Supported',    blurb: 'Historically valid and compatible with current conditions.' },
  WATCH:        { rank: 2, weight: 0.30, label: 'Watch',        blurb: 'Promising but statistically uncertain.' },
  DEGRADING:    { rank: 3, weight: 0.15, label: 'Degrading',    blurb: 'Recent deterioration beyond expected noise.' },
  INCOMPATIBLE: { rank: 4, weight: 0.05, label: 'Incompatible', blurb: 'Current regime differs materially from where it worked.' },
  BROKEN:       { rank: 5, weight: 0.00, label: 'Broken',       blurb: 'Persistent negative OOS evidence or calibration failure.' },
  UNKNOWN:      { rank: 6, weight: 0.00, label: 'Unknown',      blurb: 'Insufficient independent data to judge.' },
};

// Rolling/expanding windows, in DISTINCT decision dates (not raw picks — overlapping
// same-date picks are not independent observations).
const WINDOWS = Object.freeze({ veryRecent: 20, recent: 60, medium: 126, long: 252 });

// Evidence gates.
const MIN_EFF_N = 8;      // below this → UNKNOWN (can't tell)
const MIN_STRONG_N = 20;  // STRONG requires at least this many independent dates
const BREAKEVEN = 0.5;    // beat-rate breakeven (excess>0 half the time = coin flip)
const REGIME_INCOMPAT = 0.35; // current-regime compatibility below this ⇒ INCOMPATIBLE (if long-term was good)
const SUPPORT_COMPAT = 0.45;  // compatibility a SUPPORTED verdict needs when recent data is thin

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Sorted list of the distinct decision dates present in a resolved series.
function distinctDates(series) {
  const s = new Set();
  for (const r of series) if (r && r.date && isNum(r.excess)) s.add(r.date);
  return [...s].sort();
}

// Slice a series down to the rows falling on the most recent `nDates` distinct dates.
function windowSlice(series, nDates) {
  const dates = distinctDates(series);
  if (!dates.length) return [];
  const keep = new Set(dates.slice(Math.max(0, dates.length - nDates)));
  return series.filter((r) => r && keep.has(r.date) && isNum(r.excess));
}

// Reduce a set of resolved rows to a conservative summary. `effN` is the count of DISTINCT
// dates, not rows: two picks on the same day share the day's market shock and are not two
// independent bets, so the Wilson CI is taken over independent dates, never inflated row
// counts. `beatRate` is measured over rows (the per-pick hit rate) but its interval is
// widened to the independent-date sample.
function summarize(rows) {
  const resolved = rows.filter((r) => r && isNum(r.excess));
  const n = resolved.length;
  if (!n) return { n: 0, effN: 0, avgExcess: null, beatRate: null, ci: { lo: 0, hi: 0 }, ready: false };
  const effN = new Set(resolved.map((r) => r.date)).size;
  const avgExcess = resolved.reduce((a, r) => a + r.excess, 0) / n;
  const beats = resolved.filter((r) => r.excess > 0).length;
  const beatRate = beats / n;
  // CI on the beat-rate over INDEPENDENT dates (round the fractional win count to the
  // effective sample so a 30-pick/6-date algo isn't scored as 30 independent trials).
  const winEff = Math.round(beatRate * effN);
  const ci = wilson(winEff, effN);
  return { n, effN, avgExcess: +avgExcess.toFixed(4), beatRate: +beatRate.toFixed(3), ci, ready: effN >= MIN_EFF_N };
}

// Recent-vs-long drift verdict. Deliberately conservative: we only call something
// DEGRADING when the recent independent-date interval sits clearly below breakeven while
// the long-term interval was clearly above it — i.e. the deterioration is larger than the
// sample noise, not a short losing streak. Mirror logic flags 'improving'.
function driftVerdict(recent, long) {
  if (!recent || !long || !recent.ready || !long.ready) return 'unknown';
  const recentBad = recent.ci.hi < BREAKEVEN || (isNum(recent.avgExcess) && recent.avgExcess < 0 && recent.ci.hi < BREAKEVEN + 0.05);
  const longGood = long.ci.lo > BREAKEVEN || (isNum(long.avgExcess) && long.avgExcess > 0 && long.ci.lo > BREAKEVEN - 0.05);
  if (recentBad && longGood) return 'degrading';
  const recentGood = recent.ci.lo > BREAKEVEN;
  const longWeak = long.ci.lo <= BREAKEVEN;
  if (recentGood && longWeak) return 'improving';
  return 'stable';
}

// Width of a Wilson interval → an uncertainty penalty in (0,1]. A tight interval (lots of
// consistent evidence) → ~1; a wide one (thin/noisy) → small. Used by the router.
function certaintyFrom(summary) {
  if (!summary || !summary.ready) return 0.2;
  const width = clamp01(summary.ci.hi - summary.ci.lo);
  return clamp01(1 - width); // width 0 → 1, width 1 → 0
}

// Calibration quality → (0..1]. Accepts { brier, slope } where slope≈1 is well-calibrated.
// null ⇒ neutral-unknown (0.7) and a limitation is recorded by the caller.
function calibrationQuality(cal) {
  if (!cal) return null;
  let q = 1;
  if (isNum(cal.brier)) q *= clamp01(1 - cal.brier); // brier 0 → 1, 0.25 → 0.75
  if (isNum(cal.slope)) q *= clamp01(1 - Math.min(1, Math.abs(cal.slope - 1))); // slope 1 → 1
  return +clamp01(q).toFixed(3);
}

// The core classifier for one algorithm.
//
// inputs:
//   id                 stable algorithm id
//   series             [{ date, excess }] resolved OOS records (excess = SPY-relative return)
//   longTerm           optional pre-aggregated long-term skill {effN, avgExcess, ci:{lo,hi}}
//                      (e.g. from the persisted Scoreboard); if omitted, the long window of
//                      `series` is used.
//   regimeCompatibility  0..1 similarity of the CURRENT regime to where this algo worked
//                        (null = unknown → not penalised, but flagged)
//   calibration        { brier, slope } | null
//   independence       0..1 fraction of this algo's evidence that is NOT a restatement of a
//                      correlated sibling (null = unknown → 0.7)
function classifyAlgo(input) {
  const {
    id = null, series = [], longTerm = null,
    regimeCompatibility = null, calibration = null, independence = null,
  } = input || {};

  const limitations = [];
  const w = {
    veryRecent: summarize(windowSlice(series, WINDOWS.veryRecent)),
    recent: summarize(windowSlice(series, WINDOWS.recent)),
    medium: summarize(windowSlice(series, WINDOWS.medium)),
    long: summarize(windowSlice(series, WINDOWS.long)),
  };
  // Long-term skill: prefer an externally supplied aggregate (larger history than the
  // 252-date price series we can cheaply reconstruct), else the long window.
  const longSkill = (longTerm && isNum(longTerm.effN)) ? longTerm : w.long;
  const effectiveSampleSize = longSkill.effN || 0;
  const drift = driftVerdict(w.recent, longSkill);
  const calQ = calibrationQuality(calibration);
  if (calibration == null) limitations.push('calibration unmeasured');
  if (regimeCompatibility == null) limitations.push('regime compatibility unmeasured');
  if (independence == null) limitations.push('independence unmeasured');

  const longPositive = isNum(longSkill.avgExcess) && longSkill.avgExcess > 0 && longSkill.ci.lo > BREAKEVEN - 0.05;
  const longClearlyGood = longSkill.ci && longSkill.ci.lo > BREAKEVEN && isNum(longSkill.avgExcess) && longSkill.avgExcess > 0;
  const longClearlyBad = longSkill.ci && longSkill.ci.hi < BREAKEVEN && isNum(longSkill.avgExcess) && longSkill.avgExcess < 0;
  const calFailure = isNum(calQ) && calQ < 0.4;

  let health, reason;
  if (effectiveSampleSize < MIN_EFF_N) {
    health = 'UNKNOWN';
    reason = `Only ${effectiveSampleSize} independent decision dates (< ${MIN_EFF_N}); not enough to judge.`;
  } else if (longClearlyBad || calFailure) {
    health = 'BROKEN';
    reason = calFailure
      ? `Calibration failure (quality ${calQ}); predictions are not trustworthy.`
      : `Long-term edge is negative with the interval below breakeven (avg ${longSkill.avgExcess}).`;
  } else if (regimeCompatibility != null && regimeCompatibility < REGIME_INCOMPAT && longPositive) {
    health = 'INCOMPATIBLE';
    reason = `Worked historically but the current regime resembles its successful conditions only ${(regimeCompatibility * 100).toFixed(0)}%.`;
  } else if (drift === 'degrading') {
    health = 'DEGRADING';
    reason = `Recent ${w.recent.effN}-date window fell below breakeven while the long record was positive.`;
  } else if (longClearlyGood && effectiveSampleSize >= MIN_STRONG_N && drift !== 'degrading' && !(isNum(calQ) && calQ < 0.5)) {
    health = 'STRONG';
    reason = `Long-term beat-rate interval clears breakeven (${longSkill.ci.lo.toFixed(2)}–${longSkill.ci.hi.toFixed(2)}) over ${effectiveSampleSize} dates; recent not degrading.`;
  } else if (longPositive && (regimeCompatibility == null || regimeCompatibility >= SUPPORT_COMPAT)) {
    health = 'SUPPORTED';
    reason = `Positive long-term edge and compatible with current conditions, but evidence is not yet strong enough for STRONG.`;
  } else {
    health = 'WATCH';
    reason = `Edge is uncertain — positive signs but the interval straddles breakeven.`;
  }

  return {
    version: HEALTH_VERSION,
    id,
    health,
    estimate: { avgExcess: longSkill.avgExcess ?? null, beatRate: longSkill.beatRate ?? null },
    ci: longSkill.ci || { lo: 0, hi: 0 },
    effectiveSampleSize,
    windows: w,
    drift,
    expectedNetEdge: longSkill.avgExcess ?? null,
    calibrationQuality: calQ,
    regimeCompatibility: regimeCompatibility != null ? +clamp01(regimeCompatibility).toFixed(3) : null,
    independentContribution: independence != null ? +clamp01(independence).toFixed(3) : null,
    certainty: +certaintyFrom(longSkill).toFixed(3),
    reason,
    limitations,
  };
}

module.exports = {
  HEALTH_VERSION, HEALTH_STATES, WINDOWS,
  MIN_EFF_N, MIN_STRONG_N, BREAKEVEN, REGIME_INCOMPAT,
  distinctDates, windowSlice, summarize, driftVerdict,
  certaintyFrom, calibrationQuality, classifyAlgo,
};
