// Macro risk-regime layer — VIX (volatility) + credit spreads (HYG vs LQD).
//
// The app's prior research found ONE durable lever: regime avoidance (don't go
// long into risk-off). The SPY-vs-200DMA read is slow. VIX and credit lead: vol
// spikes and high-yield credit cracking show stress BEFORE the index rolls over.
// This layer turns those into an inspectable macro-risk read (0-100) + a regime
// tilt, used both live (sharpen the Ghost regime/kill-switch) and point-in-time
// in the backtest harness. No black box — every threshold is explicit.
//
// HYG = high-yield corporate bonds, LQD = investment-grade. In risk-off, junk
// falls faster than IG, so the HYG/LQD ratio drops below its trend → credit stress.
const { fetchDailyHistory } = require('./screener');

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function pctRank(arr, x) {
  const v = arr.filter(n => n != null && !isNaN(n));
  if (!v.length) return 50;
  return Math.round((v.filter(n => n <= x).length / v.length) * 100);
}

// Build a date-aligned series [{ date, vix, ratio }] from the three feeds.
function buildSeries(vixC, hygC, lqdC) {
  const v = {}, h = {}, l = {};
  vixC.forEach(x => { v[x.date] = x.close; });
  hygC.forEach(x => { h[x.date] = x.close; });
  lqdC.forEach(x => { l[x.date] = x.close; });
  return Object.keys(v).filter(d => h[d] != null && l[d] != null && l[d] > 0)
    .sort().map(d => ({ date: d, vix: v[d], ratio: h[d] / l[d] }));
}

// Macro state as-of index `i` in the aligned series. Pure + inspectable.
function stateAt(series, i) {
  if (!series || i < 0 || i >= series.length) return null;
  const s = series[i];
  const win = series.slice(Math.max(0, i - 251), i + 1);   // trailing ~1y
  const vixPctile = pctRank(win.map(x => x.vix), s.vix);
  const vix10 = series[Math.max(0, i - 10)].vix;
  const vixRising = s.vix > vix10;
  const sma50 = mean(series.slice(Math.max(0, i - 49), i + 1).map(x => x.ratio));
  const belowSma = s.ratio < sma50;
  const ratio20 = series[Math.max(0, i - 20)].ratio;
  const creditTrend = ratio20 > 0 ? +((s.ratio / ratio20 - 1) * 100).toFixed(2) : 0; // % over 20d; <0 = junk weakening
  // Credit stress (0-100): how far the ratio sits below its 50d trend. A ~5%
  // shortfall is severe (HYG/LQD is normally very stable), so scale ×2000.
  const creditStress = belowSma ? clamp(((sma50 - s.ratio) / sma50) * 2000, 0, 100) : 0;

  // Macro risk 0-100 — VIX percentile leads, credit stress confirms.
  const macroRisk = Math.round(clamp(0.6 * vixPctile + 0.4 * creditStress, 0, 100));
  // Magnitude-based regime — avoid tripping on trivial sub-SMA noise. Risk-off on
  // a high blended score, a panic VIX level, or a fast vol spike at the extreme.
  const riskOff = macroRisk >= 55 || s.vix >= 28 || (vixPctile >= 90 && vixRising);
  const riskOn = !riskOff && macroRisk <= 28 && s.vix < 19;
  const regime = riskOff ? 'risk-off' : riskOn ? 'risk-on' : 'neutral';
  return {
    asOf: s.date,
    vix: { level: +s.vix.toFixed(2), pctile: vixPctile, rising: vixRising },
    credit: { ratio: +s.ratio.toFixed(4), sma50: +sma50.toFixed(4), belowSma, trend20: creditTrend },
    macroRisk, regime, riskOff, riskOn,
  };
}

// LIVE macro read (latest bar). Returns null if any feed is unavailable.
async function fetchMacro() {
  try {
    const [vix, hyg, lqd] = await Promise.all([
      fetchDailyHistory('^VIX', '2y'), fetchDailyHistory('HYG', '2y'), fetchDailyHistory('LQD', '2y'),
    ]);
    if (!vix || !hyg || !lqd) return null;
    const series = buildSeries(vix.candles, hyg.candles, lqd.candles);
    if (series.length < 60) return null;
    return stateAt(series, series.length - 1);
  } catch { return null; }
}

// Point-in-time macro for the harness: fetch once, return a { at(date) } closure
// that gives the macro state as-of any historical date (last bar ≤ date).
async function buildMacroLookup() {
  try {
    const [vix, hyg, lqd] = await Promise.all([
      fetchDailyHistory('^VIX', '2y'), fetchDailyHistory('HYG', '2y'), fetchDailyHistory('LQD', '2y'),
    ]);
    if (!vix || !hyg || !lqd) return null;
    const series = buildSeries(vix.candles, hyg.candles, lqd.candles);
    if (series.length < 60) return null;
    const idxOf = {}; series.forEach((s, i) => { idxOf[s.date] = i; });
    const dates = series.map(s => s.date);
    return {
      at(date) {
        let i = idxOf[date];
        if (i == null) { // last bar on/before date
          let lo = 0, hi = dates.length - 1, found = -1;
          while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= date) { found = m; lo = m + 1; } else hi = m - 1; }
          i = found;
        }
        return stateAt(series, i);
      },
    };
  } catch { return null; }
}

module.exports = { fetchMacro, buildMacroLookup, buildSeries, stateAt };
