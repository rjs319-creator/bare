'use strict';

// Frozen, point-in-time daily-chart pattern definitions for research. These are
// deliberately simple enough to reproduce from OHLCV data; no visual hindsight.

const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

function indexOnOrBefore(candles, date) {
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].date <= date) return i;
  return -1;
}

function sma(candles, end, n, field = 'close') {
  if (end + 1 < n) return null;
  return mean(candles.slice(end - n + 1, end + 1).map(x => x[field]).filter(Number.isFinite));
}

function atr(candles, end, n) {
  if (end < n) return null;
  const values = [];
  for (let i = end - n + 1; i <= end; i++) {
    const b = candles[i], p = candles[i - 1];
    values.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  return mean(values);
}

function failedBreakouts(candles, end, lookback = 63) {
  let count = 0;
  for (let i = Math.max(21, end - lookback + 1); i <= end; i++) {
    let priorHigh = -Infinity;
    for (let j = i - 20; j < i; j++) priorHigh = Math.max(priorHigh, candles[j].high);
    if (candles[i - 1].close <= priorHigh && candles[i].close > priorHigh) {
      for (let j = i + 1; j <= Math.min(end, i + 3); j++) {
        if (candles[j].close < priorHigh) { count++; break; }
      }
    }
  }
  return count;
}

function relativeStrengthNearHigh(stock, benchmark, stockEnd, sessions = 63, tolerance = .98) {
  const benchByDate = new Map(benchmark.map(x => [x.date, x.close]));
  const line = [];
  for (let i = Math.max(0, stockEnd - sessions); i <= stockEnd; i++) {
    const b = benchByDate.get(stock[i].date);
    if (stock[i].close > 0 && b > 0) line.push(stock[i].close / b);
  }
  if (line.length < Math.floor(sessions * .75)) return null;
  const current = line.at(-1), priorHigh = Math.max(...line.slice(0, -1));
  return { current, priorHigh, ratioToHigh: current / priorHigh, confirmed: current >= tolerance * priorHigh };
}

function dailyChartPatterns({ stock = [], benchmark = [], decisionDate } = {}) {
  const i = indexOnOrBefore(stock, decisionDate);
  if (i < 200 || stock[i].date !== decisionDate) return null;
  const close = stock[i].close;
  const s20 = sma(stock, i, 20), s50 = sma(stock, i, 50), s200 = sma(stock, i, 200);
  const a10 = atr(stock, i, 10), a14 = atr(stock, i, 14), a40 = atr(stock, i, 40);
  if (!(close > 0 && s20 > 0 && s50 > 0 && s200 > 0 && a10 > 0 && a14 > 0 && a40 > 0)) return null;
  const last20 = stock.slice(i - 19, i + 1);
  const high20 = Math.max(...last20.map(x => x.high)), low20 = Math.min(...last20.map(x => x.low));
  const range20 = (high20 - low20) / close;
  const atrContraction = a10 / a40;
  const volume5 = sma(stock, i, 5, 'volume'), volume20 = sma(stock, i, 20, 'volume');
  const volumeDryUp = volume20 > 0 ? volume5 / volume20 : null;
  const drawdown20 = high20 > 0 ? 1 - close / high20 : null;
  const extensionAtr = (close - s20) / a14;
  const return20 = stock[i - 20].close > 0 ? close / stock[i - 20].close - 1 : null;
  let distributionDays20 = 0;
  for (let k = i - 19; k <= i; k++) {
    const avgPriorVolume = sma(stock, k - 1, 20, 'volume');
    if (stock[k].close < stock[k - 1].close && avgPriorVolume > 0 && stock[k].volume > avgPriorVolume) distributionDays20++;
  }
  const fails = failedBreakouts(stock, i, 63);
  const rs = relativeStrengthNearHigh(stock, benchmark, i, 63, .98);
  const trend = close > s50 && s50 > s200;
  const tightBase = trend && range20 <= .15 && atrContraction <= .90 && close >= .92 * high20;
  const orderlyPullback = trend && drawdown20 >= .03 && drawdown20 <= .12
    && close >= s50 && volumeDryUp != null && volumeDryUp <= .90;
  const rsBreakout = trend && !!(rs && rs.confirmed);
  const exhaustionVeto = extensionAtr > 4 || return20 > .30 || fails > 2 || distributionDays20 >= 5;
  const confirmedSetup = (tightBase || orderlyPullback) && rsBreakout && !exhaustionVeto;
  return {
    tightBase, orderlyPullback, rsBreakout, exhaustionVeto, confirmedSetup,
    metrics: { close, sma20: s20, sma50: s50, sma200: s200, range20, atrContraction,
      volumeDryUp, drawdown20, extensionAtr, return20, distributionDays20,
      failedBreakouts63: fails, rsRatioToHigh: rs && rs.ratioToHigh },
  };
}

module.exports = { indexOnOrBefore, sma, atr, failedBreakouts, relativeStrengthNearHigh, dailyChartPatterns };
