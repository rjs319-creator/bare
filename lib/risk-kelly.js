'use strict';
// RISK KELLY — the ONE home for Kelly sizing arithmetic, vol targeting and a bootstrap Monte
// Carlo of a short trade plan's drawdown. Pure, deterministic (seeded), no network, no state.
//
// Before this module two Kelly implementations lived inline: lib/cern.js (continuous Kelly
// (mu − cost)/sd² at 0.25x) and lib/gapgo.js (discrete tier Kelly at 0.25x). Both now call
// here; test/risk-kelly-parity.test.js pins their numbers bit-for-bit to the old formulas.
//
// STANCE. A size is only ever a fraction of equity UNDER the same hard cap omega-sizing and
// position-sizing enforce (MAX_POSITION_FRACTION). Kelly ≤ 0 means the lane has no measured
// edge and the answer is `size: null` with a reason — never a small positive number. Kelly on
// a thin, noisy edge is wildly unstable, which is why the default is QUARTER Kelly and the
// drawdown band is reported next to it.

const { MAX_POSITION_PCT, VOL_TARGET_ANNUAL } = require('./omega-sizing');

const MAX_POSITION_FRACTION = MAX_POSITION_PCT;       // 0.20 of equity — same cap as omega-sizing
const DEFAULT_KELLY_FRACTION = 0.25;                  // quarter Kelly (gapgo's KELLY_FRACTION)
const VOL_TARGET_ANNUAL_PCT = VOL_TARGET_ANNUAL * 100; // 25% annualised, omega-sizing's anchor
const MIN_LANE_EPISODES = 20;                         // below this, no Kelly is published
const TRADING_DAYS = 252;
const DEFAULT_VOL_WINDOW = 20;
// CERN's continuous-Kelly conventions (unchanged from the inline original).
const CERN_MAX_LEVERAGE = 4;
const CERN_KELLY_UNIT = 0.01;
const CERN_MAX_SIZE = 0.05;
// Monte Carlo defaults: a 20-trade plan, 2000 bootstrap paths, fixed seed.
const MC_TRADES = 20;
const MC_PATHS = 2000;
const MC_SEED = 20261002;
const MC_QUANTILE_STEPS = 100;                        // percentiles 0..100 of max drawdown (R)
const DRAWDOWN_THRESHOLDS = [0.10, 0.20];             // P(maxDD > 10%), P(maxDD > 20%)

const finite = (x) => Number.isFinite(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Discrete Kelly for a win/loss bet. `avgWin` and `avgLoss` are payoffs in the SAME unit as
 * the stake (fractions of position notional, or R-multiples when the stake is 1R); the sign of
 * avgLoss is ignored. `cost` is a round-trip friction in that unit, charged to both legs.
 * Returns the full-Kelly fraction (may be ≤ 0 = no edge) or null when inputs are unusable.
 */
function kellyFraction({ winRate, avgWin, avgLoss, cost = 0 } = {}) {
  if (!finite(winRate) || winRate < 0 || winRate > 1) return null;
  if (!finite(avgWin) || !finite(avgLoss) || !finite(cost) || cost < 0) return null;
  const win = avgWin - cost;
  const loss = Math.abs(avgLoss) + cost;
  if (!(win > 0)) return 0;                            // a winner that nets nothing is no edge
  if (!(loss > 0)) return null;                        // a lossless bet has no finite Kelly
  return winRate / loss - (1 - winRate) / win;
}

/** Continuous (Gaussian) Kelly: (mu − cost) / sd², clamped to [0, maxLeverage]. CERN's form. */
function kellyContinuous({ mu, sd, cost = 0, maxLeverage = CERN_MAX_LEVERAGE } = {}) {
  if (!finite(mu) || !finite(sd) || !finite(cost) || !(sd > 0)) return null;
  return clamp((mu - cost) / (sd * sd), 0, maxLeverage);
}

/** Fractional Kelly: a non-negative scaled-down Kelly. Null in ⇒ null out. */
function fractionalKelly(kelly, { fraction = DEFAULT_KELLY_FRACTION } = {}) {
  if (!finite(kelly) || !finite(fraction) || fraction < 0) return null;
  return Math.max(0, kelly) * fraction;
}

/** CERN's size-of-capital convention: quarter Kelly × 1% unit, capped at 5% of capital. */
function cernSizeFraction(kelly) {
  if (!finite(kelly)) return 0;
  return clamp(fractionalKelly(kelly, { fraction: DEFAULT_KELLY_FRACTION }) * CERN_KELLY_UNIT, 0, CERN_MAX_SIZE);
}

/** Annualised close-to-close realised volatility (percent) over the trailing window. */
function realizedVolAnnualPct(candles, { window = DEFAULT_VOL_WINDOW } = {}) {
  if (!Array.isArray(candles) || candles.length < window + 1) return null;
  const closes = candles.slice(-(window + 1)).map(c => c && c.close);
  if (!closes.every(c => finite(c) && c > 0)) return null;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS) * 100;
}

/** Vol-target position: targetVol / realisedVol as a fraction of equity, under the hard cap. */
function volTargetSize({ targetVolPct = VOL_TARGET_ANNUAL_PCT, realizedVol20d } = {}) {
  if (!finite(realizedVol20d) || !(realizedVol20d > 0) || !finite(targetVolPct) || !(targetVolPct > 0)) return null;
  const raw = targetVolPct / realizedVol20d;
  return { fraction: Math.min(raw, MAX_POSITION_FRACTION), rawFraction: raw, capped: raw > MAX_POSITION_FRACTION, targetVolPct, realizedVol20d };
}

// Seeded LCG (same generator lib/research/stats-v3 uses) so an artifact is reproducible.
function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function maxDrawdownR(path) {
  let peak = 0, equity = 0, dd = 0;
  for (const r of path) {
    equity += r;
    if (equity > peak) peak = equity;
    if (peak - equity > dd) dd = peak - equity;
  }
  return dd;
}

/**
 * Bootstrap Monte Carlo of a `trades`-long plan drawn (with replacement) from resolved
 * R-multiples. Drawdown is measured in R (non-compounding), so a reader risking f of equity
 * per trade has maxDD ≈ f × maxDD_R — the percentile table rescales exactly to any budget.
 * Returns null below MIN_LANE_EPISODES resolved R-multiples.
 */
function monteCarloDrawdown({ rMultiples, trades = MC_TRADES, paths = MC_PATHS, seed = MC_SEED, riskPerTradeFrac = 0.01, thresholds = DRAWDOWN_THRESHOLDS } = {}) {
  const rs = (rMultiples || []).filter(finite);
  if (rs.length < MIN_LANE_EPISODES || !(trades > 0) || !(paths > 0)) return null;
  const rnd = lcg(seed);
  const dds = new Array(paths);
  for (let p = 0; p < paths; p++) {
    const path = new Array(trades);
    for (let t = 0; t < trades; t++) path[t] = rs[Math.floor(rnd() * rs.length)];
    dds[p] = maxDrawdownR(path);
  }
  dds.sort((a, b) => a - b);
  const quantilesR = Array.from({ length: MC_QUANTILE_STEPS + 1 },
    (_, i) => +dds[Math.min(paths - 1, Math.floor((i / MC_QUANTILE_STEPS) * paths))].toFixed(3));
  const probabilities = thresholds.map(threshold => ({
    threshold, riskPerTradeFrac, p: drawdownExceedProbability(quantilesR, threshold, riskPerTradeFrac),
  }));
  return { trades, paths, seed, n: rs.length, quantilesR, probabilities };
}

/** P(maxDD > threshold) from a percentile table of maxDD in R, for a given risk per trade. */
function drawdownExceedProbability(quantilesR, thresholdFrac, riskPerTradeFrac) {
  if (!Array.isArray(quantilesR) || !quantilesR.length || !(riskPerTradeFrac > 0) || !(thresholdFrac > 0)) return null;
  const limitR = thresholdFrac / riskPerTradeFrac;
  const exceeding = quantilesR.filter(q => q > limitR).length;
  return +(exceeding / quantilesR.length).toFixed(3);
}

function refuse(reason, extra = {}) {
  return { size: null, reason, maxPositionFraction: MAX_POSITION_FRACTION, ...extra };
}

/**
 * The composed recommendation, fail-closed: a fraction of equity under the hard cap, or
 * `{ size: null, reason }`. Inputs are fractions (avgWin/avgLoss/cost of position notional).
 */
function sizeRecommendation({ winRate, avgWin, avgLoss, cost = 0, n = 0, rMultiples = null, realizedVol20d = null, fraction = DEFAULT_KELLY_FRACTION, riskPerTradeFrac = 0.01 } = {}) {
  if (!finite(n) || n < MIN_LANE_EPISODES) return refuse(`insufficient resolved episodes (${finite(n) ? n : 0} < ${MIN_LANE_EPISODES})`);
  const kelly = kellyFraction({ winRate, avgWin, avgLoss, cost });
  if (kelly == null) return refuse('lane statistics unusable — Kelly undefined');
  if (kelly <= 0) return refuse('no measured edge', { kelly: +kelly.toFixed(4) });
  const kellyFractional = fractionalKelly(kelly, { fraction });
  const volTarget = volTargetSize({ realizedVol20d });
  const drawdown = monteCarloDrawdown({ rMultiples, riskPerTradeFrac });
  const caps = [['kelly', kellyFractional], ['max-position', MAX_POSITION_FRACTION]];
  if (volTarget) caps.push(['vol-target', volTarget.fraction]);
  const binding = caps.reduce((m, c) => (c[1] < m[1] ? c : m), caps[0]);
  const size = clamp(binding[1], 0, MAX_POSITION_FRACTION);
  return {
    size, bindingConstraint: binding[0], kelly, kellyFractional, kellyFractionUsed: fraction,
    maxPositionFraction: MAX_POSITION_FRACTION, volTarget, drawdown, n,
  };
}

module.exports = {
  MAX_POSITION_FRACTION, DEFAULT_KELLY_FRACTION, VOL_TARGET_ANNUAL_PCT, MIN_LANE_EPISODES,
  CERN_MAX_LEVERAGE, CERN_KELLY_UNIT, CERN_MAX_SIZE, MC_TRADES, MC_PATHS, MC_SEED, DRAWDOWN_THRESHOLDS,
  kellyFraction, kellyContinuous, fractionalKelly, cernSizeFraction,
  realizedVolAnnualPct, volTargetSize, monteCarloDrawdown, drawdownExceedProbability, sizeRecommendation,
};
