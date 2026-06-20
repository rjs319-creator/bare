// DAY-TRADE MOMENTUM / RELATIVE-VOLUME screener — the EOD (daily-bar) realization
// of the two Finviz "day trading scanner" setups (Whitman): a high-momentum-liquid
// scan and an explosive small-cap scan. Pure: candles in, metrics + classification
// out (no network, no state) so it runs in both the live op and the backtest harness.
//
// Core signal (shared by both scans): a RELATIVE-VOLUME spike + price momentum.
// App-specific improvements layered on top of the raw Finviz idea:
//   • market-RELATIVE momentum (excess vs SPY) — the app's proven "vs benchmark" lens
//   • average DOLLAR volume liquidity gate (price-agnostic, beats raw share count)
//   • overnight GAP %
//   • a composite rank score; per-stock self-learning + regime gating live elsewhere

const AVG_VOL_WINDOW = 20;   // Finviz "Average Volume" = 20-day

// Scan parameter sets. Scan 1 runs on the LARGE (liquid/established) universe,
// Scan 2 on SMALL+MICRO (the small-cap proxy for "low float / explosive").
const SCANS = {
  momentum_liquid: {
    key: 'momentum_liquid', label: '🚀 Momentum & Liquid',
    priceMin: 5, priceMax: 50,
    minAvgVol: 1_000_000, minDollarVol: 10_000_000,   // deep, tradeable liquidity
    minRelVol: 1.5, minPct: 5.0,                       // unusual volume + real momentum
  },
  explosive_small: {
    key: 'explosive_small', label: '💥 Explosive Small-Cap',
    priceMin: 1, priceMax: 20,
    minAvgVol: 500_000, minDollarVol: 2_000_000,
    minRelVol: 2.0, minPct: 8.0,                       // harder bars = real ignition
  },
};

// Compute the day-trade metrics from a ticker's daily candles. `spyByDate` (optional)
// maps date→SPY close so we can express momentum RELATIVE to the market. null if the
// ticker lacks enough history to be meaningful.
function dayMetrics(candles, spyByDate, avgWindow = AVG_VOL_WINDOW) {
  if (!candles || candles.length < avgWindow + 1) return null;
  const i = candles.length - 1;
  const last = candles[i].close, prev = candles[i - 1].close;
  if (!(last > 0) || !(prev > 0)) return null;

  const todayVol = candles[i].volume || 0;
  let avgVol = 0;
  for (let k = i - avgWindow; k < i; k++) avgVol += (candles[k].volume || 0);   // prior 20 days, excl. today
  avgVol /= avgWindow;
  if (!(avgVol > 0)) return null;

  const todayOpen = candles[i].open;
  const gapPct = todayOpen > 0 ? (todayOpen - prev) / prev * 100 : null;

  let spyPct = null;
  if (spyByDate) {
    const d = candles[i].date, dp = candles[i - 1].date;
    if (spyByDate[d] != null && spyByDate[dp] != null && spyByDate[dp] > 0) {
      spyPct = (spyByDate[d] / spyByDate[dp] - 1) * 100;
    }
  }
  const pctChange = (last - prev) / prev * 100;

  return {
    last: +last.toFixed(2),
    avgVol: Math.round(avgVol),
    avgDollarVol: Math.round(avgVol * last),
    relVol: +(todayVol / avgVol).toFixed(2),
    pctChange: +pctChange.toFixed(2),
    gapPct: gapPct != null ? +gapPct.toFixed(2) : null,
    excessPct: spyPct != null ? +(pctChange - spyPct).toFixed(2) : null,   // momentum vs market
  };
}

// Does a metrics object pass a scan's filters?
function passesScan(m, params) {
  return m.last >= params.priceMin && m.last <= params.priceMax
    && m.avgVol >= params.minAvgVol
    && m.avgDollarVol >= params.minDollarVol
    && m.relVol >= params.minRelVol
    && m.pctChange >= params.minPct;
}

// Composite rank score — relative volume is weighted most (the core anomaly), then
// raw momentum, then a small gap kicker. Capped so a single freak rel-vol print can't
// dominate. Used only for ordering, not as a probability.
function rankScore(m) {
  const rv = Math.min(m.relVol, 10);
  return +(rv * 10 + m.pctChange + (m.gapPct || 0) * 0.5).toFixed(1);
}

module.exports = { AVG_VOL_WINDOW, SCANS, dayMetrics, passesScan, rankScore };
