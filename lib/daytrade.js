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

// Average True Range over the last `period` bars — the move's typical daily range,
// used to size a sensible stop distance.
function atr(candles, period = 14) {
  const n = candles.length;
  if (n < 2) return 0;
  let sum = 0, cnt = 0;
  for (let i = Math.max(1, n - period); i < n; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// Exponential moving average of `values` over `period` (short-term dynamic support).
function ema(values, period) {
  const n = values.length;
  if (!n) return null;
  const k = 2 / (period + 1);
  const start = Math.max(0, n - period * 4);   // seed a few periods back for stability
  let e = values[start];
  for (let i = start + 1; i < n; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Suggested mechanical trade levels. Returns TWO entry plans:
//   • breakout (top-level entry/stop/target): buy the continuation at the current
//     price — simplest, but you're chasing an already-extended move.
//   • pullback: wait for a dip back toward the rising 9-EMA / a 40% retrace of
//     today's range — a LOWER entry with a tighter stop & better reward:risk, but
//     it may not fill if the name keeps running.
// For each: stop = the TIGHTER of "just under today's low" (invalidation) and a
// 1.5×ATR risk cap; target = 1:2 reward:risk. RISK-MANAGEMENT references, not
// predictions. riskPct is the input to position sizing.
function tradeLevels(candles, { stopAtrMult = 1.5, rr = 2, pullbackFrac = 0.4 } = {}) {
  const i = candles.length - 1;
  const entry = candles[i].close;
  const a = atr(candles);
  if (!(a > 0) || !(entry > 0)) return null;
  const todayLow = candles[i].low;

  const plan = (e) => {
    const stop = Math.max(todayLow - 0.1 * a, e - stopAtrMult * a);   // tighter (higher) of the two
    const risk = e - stop;
    if (!(risk > 0)) return null;
    return { entry: +e.toFixed(2), stop: +stop.toFixed(2), target: +(e + rr * risk).toFixed(2), rr, riskPct: +((risk / e) * 100).toFixed(1) };
  };

  const breakout = plan(entry);
  if (!breakout) return null;

  // Pullback entry: dip back toward the 9-EMA, but never below ~40% of today's range
  // (a deeper drop means the move is failing, not pulling back). Clamp strictly below
  // the close and at/above today's low.
  const e9 = ema(candles.map(c => c.close), 9);
  const retrace = entry - pullbackFrac * (entry - todayLow);
  let pbEntry = Math.max(e9 != null ? e9 : retrace, retrace);
  pbEntry = Math.min(Math.max(pbEntry, todayLow), entry * 0.999);
  const pullback = plan(+pbEntry.toFixed(2));

  return { ...breakout, atr: +a.toFixed(2), pullback };
}

module.exports = { AVG_VOL_WINDOW, SCANS, dayMetrics, passesScan, rankScore, atr, ema, tradeLevels };
