'use strict';

// Pure, point-in-time building blocks for the frozen hedge-fund-style swing
// diagnostic. The research runner owns cohort construction and outcome grading.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function mean(xs) {
  const ok = (xs || []).filter(Number.isFinite);
  return ok.length ? ok.reduce((s, x) => s + x, 0) / ok.length : null;
}

function averageTieRanks(values) {
  const valid = values.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v));
  valid.sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(null);
  for (let lo = 0; lo < valid.length;) {
    let hi = lo + 1;
    while (hi < valid.length && valid[hi][0] === valid[lo][0]) hi++;
    const rank = valid.length === 1 ? 0.5 : ((lo + hi - 1) / 2) / (valid.length - 1);
    for (let i = lo; i < hi; i++) out[valid[i][1]] = rank;
    lo = hi;
  }
  return out;
}

function indexOnOrBefore(candles, date) {
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].date <= date) return i;
  return -1;
}

function pairedReturns(stock, benchmark, stockStart, stockEnd) {
  const benchByDate = new Map(benchmark.map((b, i) => [b.date, i]));
  const pairs = [];
  for (let i = Math.max(1, stockStart + 1); i <= stockEnd; i++) {
    const bi = benchByDate.get(stock[i].date);
    const bp = bi == null || bi < 1 ? null : benchmark[bi - 1];
    if (!bp || !(stock[i - 1].close > 0) || !(bp.close > 0)) continue;
    const sr = stock[i].close / stock[i - 1].close - 1;
    const br = benchmark[bi].close / bp.close - 1;
    if (Number.isFinite(sr) && Number.isFinite(br)) pairs.push([sr, br]);
  }
  return pairs;
}

function regressionBeta(pairs) {
  if (!pairs || pairs.length < 30) return null;
  const sx = mean(pairs.map(x => x[0])), bm = mean(pairs.map(x => x[1]));
  let cov = 0, variance = 0;
  for (const [s, b] of pairs) { cov += (s - sx) * (b - bm); variance += (b - bm) ** 2; }
  return variance > 1e-12 ? clamp(cov / variance, 0, 3) : null;
}

// Configurable skip-recent momentum, adjusted by a beta estimated over the same
// daily-return window. All endpoints are on/before the decision date.
function betaResidualMomentumWindow(stock, benchmark, decisionDate, { lookback = 126, skip = 21 } = {}) {
  const si = indexOnOrBefore(stock, decisionDate);
  const bi = indexOnOrBefore(benchmark, decisionDate);
  if (!(lookback > skip && skip >= 0) || si < lookback + 1 || bi < lookback + 1) return null;
  const s0 = si - lookback, s1 = si - skip;
  const b0 = bi - lookback, b1 = bi - skip;
  if (!(stock[s0].close > 0) || !(benchmark[b0].close > 0)) return null;
  const beta = regressionBeta(pairedReturns(stock, benchmark, s0, s1));
  if (!Number.isFinite(beta)) return null;
  const own = stock[s1].close / stock[s0].close - 1;
  const market = benchmark[b1].close / benchmark[b0].close - 1;
  return { beta, residualMomentum: own - beta * market, ownMomentum: own, marketMomentum: market };
}

// Original core: 126 sessions ago through 21 sessions ago.
function betaResidualMomentum(stock, benchmark, decisionDate) {
  return betaResidualMomentumWindow(stock, benchmark, decisionDate, { lookback: 126, skip: 21 });
}

function residualPathPersistence(stock, benchmark, decisionDate, beta, { blocks = 5, blockSize = 21, skip = 21 } = {}) {
  const si = indexOnOrBefore(stock, decisionDate);
  const endIndex = si - skip;
  if (endIndex < blocks * blockSize || !Number.isFinite(beta)) return null;
  const benchByDate = new Map(benchmark.map((b, i) => [b.date, i]));
  const residuals = [];
  for (let b = blocks; b >= 1; b--) {
    const start = endIndex - b * blockSize, end = start + blockSize;
    const bs = benchByDate.get(stock[start].date), be = benchByDate.get(stock[end].date);
    if (bs == null || be == null || !(stock[start].close > 0) || !(benchmark[bs].close > 0)) return null;
    const sr = stock[end].close / stock[start].close - 1;
    const br = benchmark[be].close / benchmark[bs].close - 1;
    residuals.push(sr - beta * br);
  }
  const positiveFraction = residuals.filter(x => x > 0).length / residuals.length;
  const avg = mean(residuals);
  const variance = mean(residuals.map(x => (x - avg) ** 2)) || 0;
  const consistency = positiveFraction - Math.sqrt(variance);
  return { residuals, positiveFraction, consistency };
}

function downsideRisk(stock, benchmark, decisionDate, beta, sessions = 63) {
  const si = indexOnOrBefore(stock, decisionDate);
  if (si < sessions || !Number.isFinite(beta)) return null;
  const pairs = pairedReturns(stock, benchmark, si - sessions, si);
  if (pairs.length < 30) return null;
  const residuals = pairs.map(([s, b]) => s - beta * b);
  const downside = residuals.map(x => Math.min(0, x));
  return Math.sqrt(mean(downside.map(x => x * x)) || 0);
}

function sma(candles, end, n) {
  if (end + 1 < n) return null;
  return mean(candles.slice(end - n + 1, end + 1).map(x => x.close));
}

function atr(candles, end, n = 14) {
  if (end < n) return null;
  const tr = [];
  for (let i = end - n + 1; i <= end; i++) {
    const x = candles[i], p = candles[i - 1];
    tr.push(Math.max(x.high - x.low, Math.abs(x.high - p.close), Math.abs(x.low - p.close)));
  }
  return mean(tr);
}

function entryFeatures(candles, decisionDate) {
  const i = indexOnOrBefore(candles, decisionDate);
  if (i < 100) return null;
  const c = candles[i].close, s20 = sma(candles, i, 20), s50 = sma(candles, i, 50), s100 = sma(candles, i, 100);
  const a14 = atr(candles, i, 14);
  if (!(c > 0) || !(s20 > 0) || !(s50 > 0) || !(s100 > 0) || !(a14 > 0)) return null;
  let upVol = 0, downVol = 0;
  for (let k = i - 19; k <= i; k++) {
    if (candles[k].close >= candles[k - 1].close) upVol += candles[k].volume || 0;
    else downVol += candles[k].volume || 0;
  }
  const avgPriorVolume = mean(candles.slice(i - 20, i).map(x => x.volume || 0));
  const volumeConfirmation = avgPriorVolume > 0 ? (candles[i].volume || 0) / avgPriorVolume : null;
  const accumulation = upVol / Math.max(1, downVol);
  const extensionInAtr = (c - s20) / a14;
  const trend = (c > s20 ? .25 : 0) + (s20 > s50 ? .35 : 0) + (s50 > s100 ? .40 : 0);
  const extensionQuality = clamp(1 - Math.max(0, extensionInAtr - 1.5) / 3.5, 0, 1);
  const entryQuality = .40 * trend + .25 * clamp(accumulation / 2, 0, 1)
    + .20 * clamp((volumeConfirmation || 0) / 1.5, 0, 1) + .15 * extensionQuality;
  return { entryQuality, volumeConfirmation, accumulation, extensionInAtr, trend };
}

function regimeMultiplier(benchmark, decisionDate) {
  const i = indexOnOrBefore(benchmark, decisionDate);
  if (i < 200) return null;
  const s200 = sma(benchmark, i, 200);
  const returns = [];
  for (let k = i - 19; k <= i; k++) returns.push(benchmark[k].close / benchmark[k - 1].close - 1);
  const mu = mean(returns);
  const dailyVol = Math.sqrt(mean(returns.map(x => (x - mu) ** 2)) || 0);
  const aboveTrend = benchmark[i].close >= s200;
  const highVolatility = dailyVol > .025;
  const multiplier = aboveTrend && !highVolatility ? 1
    : aboveTrend && highVolatility ? .75
      : !aboveTrend && !highVolatility ? .60 : .35;
  return { multiplier, aboveTrend, highVolatility, dailyVol };
}

const FORMULA = Object.freeze({
  momentum: .55,
  entry: .25,
  fundamental: .20,
  conditionalNews: .10,
  costPenalty: .10,
  aggregateRiskPenalty: .15,
  downsideWeight: .50,
  extensionWeight: .30,
  consumedNewsWeight: .20,
  downsideDenominatorFloor: .75,
  downsideDenominatorSlope: .50,
});

function scoreFormula(r, { includeNews = true, riskAdjust = true } = {}) {
  const base = FORMULA.momentum * r.momentum + FORMULA.entry * r.entry
    + FORMULA.fundamental * r.fundamental;
  const newsBoost = includeNews && r.conditionalNews
    ? FORMULA.conditionalNews * r.news : 0;
  if (!riskAdjust) return base + newsBoost;
  const aggregateRisk = FORMULA.downsideWeight * r.downside
    + FORMULA.extensionWeight * r.extension + FORMULA.consumedNewsWeight * r.consumed;
  const numerator = base + newsBoost - FORMULA.costPenalty * r.cost
    - FORMULA.aggregateRiskPenalty * aggregateRisk;
  return numerator / (FORMULA.downsideDenominatorFloor + FORMULA.downsideDenominatorSlope * r.downside);
}

module.exports = {
  FORMULA, mean, averageTieRanks, betaResidualMomentumWindow, betaResidualMomentum,
  residualPathPersistence, downsideRisk,
  entryFeatures, regimeMultiplier, scoreFormula,
};
