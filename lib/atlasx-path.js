'use strict';
// ATLAS-X — low-order path-shape features.
//
// PURE. Two names can post the same 20-day return via very different paths: a
// smooth accumulation vs a one-day spike that decays, higher-lows-on-quiet-volume
// vs erratic gap dependence. These features capture the SHAPE, not the endpoint.
//
// DELIBERATELY SMALL and regularized (a handful of bounded features), not hundreds
// of high-order path signatures — those overfit. `stabilityRequired` flags that no
// path feature may influence a PROMOTED model until it passes cross-fold stability.

const { VERSIONS } = require('./atlasx-config');
const { toBars, asOfSlice } = require('./atlasx-residual');

const DEFAULT_WINDOW = 20;
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const round4 = x => (x == null ? null : Math.round(x * 1e4) / 1e4);

/**
 * @param {object} p {candles, asOf?, window?}
 * @returns {object} frozen path-feature vector
 */
function pathFeatures({ candles, asOf, window = DEFAULT_WINDOW } = {}) {
  const all = asOfSlice(toBars(candles), asOf);
  const asOfDate = asOf || (all.length ? all[all.length - 1].date : null);
  const bars = all.slice(-(window + 1)); // need one extra for the first return
  if (bars.length < 6) {
    return freeze(asOfDate, null, false, 'insufficient-data');
  }

  const closes = bars.map(b => b.c);
  const dayRets = [];
  for (let i = 1; i < bars.length; i++) dayRets.push(closes[i] / closes[i - 1] - 1);
  const netRet = closes[closes.length - 1] / closes[0] - 1;

  // cumulative return path (from 0), for smoothness + drawdown
  const cum = [];
  let acc = 1;
  for (const r of dayRets) { acc *= (1 + r); cum.push(acc - 1); }

  // 1) smoothness = R^2 of a straight-line fit to the cumulative path. 1 = a
  //    perfectly steady drift; low = jagged/erratic.
  const smoothness = clamp01(lineR2(cum));

  // 2) spikeShare = largest single up-day's share of the summed positive moves.
  const upMoves = dayRets.filter(r => r > 0);
  const sumUp = upMoves.reduce((s, r) => s + r, 0);
  const maxUp = upMoves.length ? Math.max(...upMoves) : 0;
  const spikeShare = sumUp > 0 ? clamp01(maxUp / sumUp) : 0;

  // 3) decayAfterSpike = return AFTER the biggest up day relative to that day's
  //    move. Negative → the spike faded (one-day-spike-and-decay signature).
  const decayAfterSpike = decayAfter(closes, dayRets);

  // 4) gapDependence = share of net move explained by overnight gaps vs intraday.
  const gaps = [];
  for (let i = 1; i < bars.length; i++) gaps.push((bars[i].o - bars[i - 1].c) / (bars[i - 1].c || 1));
  const sumAbsGap = gaps.reduce((s, g) => s + Math.abs(g), 0);
  const sumAbsRet = dayRets.reduce((s, r) => s + Math.abs(r), 0);
  const gapDependence = sumAbsRet > 0 ? clamp01(sumAbsGap / sumAbsRet) : 0;

  // 5) higherLowStructure = fraction of non-lower lows (controlled uptrend).
  let hl = 0;
  for (let i = 1; i < bars.length; i++) if (bars[i].l >= bars[i - 1].l) hl++;
  const higherLowStructure = clamp01(hl / (bars.length - 1));

  // 6) volumeConcentration = biggest single-day volume share of window volume.
  const vols = bars.map(b => b.v);
  const totV = vols.reduce((s, v) => s + v, 0);
  const volumeConcentration = totV > 0 ? clamp01(Math.max(...vols) / totV) : 0;

  // 7) upDayFrac = monotonicity of the path (persistent drift vs chop).
  const upDayFrac = clamp01(dayRets.filter(r => r > 0).length / dayRets.length);

  // 8) maxDrawdownRatio = worst peak-to-trough dip on the path / |netRet|. High
  //    on a positive name = round-trip volatility (breakout-then-reject shape).
  const mdd = maxDrawdown(cum);
  const maxDrawdownRatio = Math.abs(netRet) > 1e-4 ? clamp01(mdd / Math.abs(netRet)) : clamp01(mdd * 5);

  const features = Object.freeze({
    netRet: round4(netRet),
    smoothness: round4(smoothness),
    spikeShare: round4(spikeShare),
    decayAfterSpike: round4(decayAfterSpike),
    gapDependence: round4(gapDependence),
    higherLowStructure: round4(higherLowStructure),
    volumeConcentration: round4(volumeConcentration),
    upDayFrac: round4(upDayFrac),
    maxDrawdownRatio: round4(maxDrawdownRatio),
  });

  // A coarse, INTERPRETABLE archetype label — for explanation only, never a score.
  const archetype = classifyArchetype(features);

  return freeze(asOfDate, features, true, null, archetype);
}

function decayAfter(closes, dayRets) {
  if (!dayRets.length) return 0;
  let maxI = 0;
  for (let i = 1; i < dayRets.length; i++) if (dayRets[i] > dayRets[maxI]) maxI = i;
  const spikeCloseIdx = maxI + 1; // dayRets[i] closes at bar i+1
  if (spikeCloseIdx >= closes.length - 1) return 0; // spike is the last bar → unknown
  const after = closes[closes.length - 1] / closes[spikeCloseIdx] - 1;
  const spikeMove = dayRets[maxI] || 1e-6;
  return Math.max(-2, Math.min(2, after / Math.abs(spikeMove)));
}

function lineR2(y) {
  const n = y.length;
  if (n < 3) return 0;
  const x = y.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  if (!(sxx > 0) || !(syy > 0)) return 0;
  const r = sxy / Math.sqrt(sxx * syy);
  return r * r;
}

function maxDrawdown(cum) {
  let peak = -Infinity, mdd = 0;
  for (const v of cum) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

function classifyArchetype(f) {
  if (f.spikeShare > 0.6 && f.decayAfterSpike < -0.15) return 'one-day-spike-and-fade';
  if (f.smoothness > 0.7 && f.upDayFrac > 0.55) return 'smooth-persistent-drift';
  if (f.higherLowStructure > 0.6 && f.volumeConcentration < 0.15) return 'controlled-accumulation';
  if (f.gapDependence > 0.6) return 'gap-dependent';
  if (f.maxDrawdownRatio > 1.2 && f.netRet > 0) return 'round-trip-choppy';
  return 'mixed';
}

function freeze(asOf, features, ok, reason, archetype = null) {
  return Object.freeze({
    version: VERSIONS.path,
    asOf,
    ok,
    reason: reason || null,
    features,
    archetype,
    stabilityRequired: true, // no path feature may drive a promoted model unproven
  });
}

module.exports = { pathFeatures, classifyArchetype };
