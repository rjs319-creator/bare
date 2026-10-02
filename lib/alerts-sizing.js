'use strict';
// ALERTS SIZING INPUTS — per-lane Kelly / drawdown evidence for the Trade Alerts risk-budget
// widget, built ON THE CRON (op=alertsgrade) from the graded-episode ledger and persisted on
// the decisions doc, so the read path (op=alerts) serves it with no extra Blob read and the
// browser never recomputes statistics it cannot verify.
//
// A LANE is side × graded horizon ('long:5' = long swing at the 5-session grade), the same
// normalisation lib/alerts-grade applies when it grades. Each lane carries the raw inputs
// (win rate, average win / loss as fractions, the most recent resolved R-multiples) AND the
// composed lib/risk-kelly recommendation, fail-closed: thin lanes and lanes with Kelly ≤ 0
// publish `size: null` with a reason, never a small positive number.
//
// Pure. Never mutates its rows.

const { horizonSessions } = require('./alerts-grade');
const RK = require('./risk-kelly');

const ALERTS_SIZING_VERSION = 'alerts-sizing-v1';
const RECENT_R_CAP = 100;                 // most recent resolved R-multiples served per lane
const PCT_TO_FRACTION = 1 / 100;          // graded `excess` is a percent of position
const REFERENCE_RISK_PER_TRADE = 0.01;    // the drawdown probabilities' reference budget

const finite = (x) => Number.isFinite(x);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** 'long:5' — side × graded horizon sessions. Null for non-directional episodes. */
function laneKeyOf(side, intendedHorizon) {
  if (side !== 'long' && side !== 'short') return null;
  return `${side}:${horizonSessions(intendedHorizon)}`;
}

function usableRow(g) {
  return !!(g && g.graded && laneKeyOf(g.side, g.intendedHorizon) && finite(g.excess));
}

function groupByLane(rows) {
  const lanes = new Map();
  for (const g of rows) {
    const key = laneKeyOf(g.side, g.intendedHorizon);
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(g);
  }
  return lanes;
}

const byDecisionDate = (a, b) => String(a.decisionDate || '').localeCompare(String(b.decisionDate || ''));

// Inputs for one lane. excess is percent, cost-adjusted and SPY-relative at the grade; the
// Kelly unit is "fraction of position notional", so percents become fractions here and cost
// is 0 (already inside the excess).
function laneInputs(rows) {
  const excess = rows.map(g => g.excess);
  const wins = excess.filter(x => x > 0);
  const losses = excess.filter(x => x <= 0);
  const allR = rows.slice().sort(byDecisionDate).map(g => g.rMultiple).filter(finite);
  return {
    n: rows.length,
    winRate: wins.length / rows.length,
    avgWin: mean(wins) * PCT_TO_FRACTION,
    avgLoss: mean(losses) * PCT_TO_FRACTION,
    cost: 0,
    rMultiples: allR.slice(-RECENT_R_CAP),
    rN: allR.length,
  };
}

function laneRecord(rows) {
  const inputs = laneInputs(rows);
  const rec = RK.sizeRecommendation({ ...inputs, riskPerTradeFrac: REFERENCE_RISK_PER_TRADE });
  return {
    inputs,
    size: rec.size,
    reason: rec.size === null ? rec.reason : null,
    kelly: finite(rec.kelly) ? +rec.kelly.toFixed(4) : null,
    kellyFractional: finite(rec.kellyFractional) ? +rec.kellyFractional.toFixed(4) : null,
    kellyFractionUsed: RK.DEFAULT_KELLY_FRACTION,
    bindingConstraint: rec.bindingConstraint || null,
    maxPositionFraction: RK.MAX_POSITION_FRACTION,
    drawdown: rec.drawdown || null,
  };
}

/**
 * Build the per-lane sizing doc from the graded-episode list.
 * @param {Array} gradedList  values of alerts/graded.json
 * @param {{now?:number}} opts
 */
function buildLaneSizing(gradedList, { now = Date.now() } = {}) {
  const rows = (Array.isArray(gradedList) ? gradedList : []).filter(usableRow);
  const lanes = {};
  for (const [key, laneRows] of groupByLane(rows)) lanes[key] = laneRecord(laneRows);
  return {
    version: ALERTS_SIZING_VERSION,
    generatedAt: new Date(now).toISOString(),
    minEpisodes: RK.MIN_LANE_EPISODES,
    referenceRiskPerTrade: REFERENCE_RISK_PER_TRADE,
    note: 'Arithmetic over the graded Trade Alerts record (cost-adjusted, SPY-relative). Quarter Kelly under the shared hard cap; Kelly ≤ 0 publishes no size. Not a recommendation and not evidence the lane has an edge.',
    lanes,
  };
}

/** Per-decision stamp: lane key, 20d realised vol (annualised %) and the capped vol-target. */
function decisionSizingStamp(episode, candles) {
  const realizedVol20d = RK.realizedVolAnnualPct(candles);
  const vol = finite(realizedVol20d) ? +realizedVol20d.toFixed(2) : null;
  return {
    sizingLane: laneKeyOf(episode && episode.side, episode && episode.intendedHorizon),
    realizedVol20d: vol,
    volTarget: vol == null ? null : RK.volTargetSize({ realizedVol20d: vol }),
  };
}

module.exports = { ALERTS_SIZING_VERSION, RECENT_R_CAP, REFERENCE_RISK_PER_TRADE, laneKeyOf, buildLaneSizing, decisionSizingStamp };
