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

// Split-adjustment artifact guard. When a data feed lags a split, the un-rescaled bar
// shows a huge FALSE move (e.g. a 4:1 split → a ~+300% "gap"/change) that corrupts the
// whole candle for that name. The reliable tell is VOLUME: a real move of that size
// trades many multiples of average volume, whereas a data rescaling trades normal
// volume. Confirmed on the gap-event backtest — real ≥20% gaps have median RVOL ~7-12;
// filtering "≥25% move AND <2x RVOL" drops only ~0.05% of real events (edge unchanged).
const ARTIFACT_JUMP = 0.25;        // fractional open/close move vs prior close
const ARTIFACT_MIN_RELVOL = 2;     // a real move that large ALWAYS spikes volume

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
  // Relaxed "B-tier" of Momentum & Liquid — surfaces MORE picks (building movers) on
  // quiet days. Still positive forward drift in backtest, just weaker than the A-tier.
  // Widened slightly (relVol 1.2→1.15, pct 3.0→2.5) to broaden the funnel on calm tapes;
  // quality is preserved downstream because Best Opportunities ranks by honest carry odds.
  momentum_building: {
    key: 'momentum_building', label: '📈 Building Momentum',
    priceMin: 5, priceMax: 50,
    minAvgVol: 1_000_000, minDollarVol: 10_000_000,
    minRelVol: 1.15, minPct: 2.5,
  },
};

// MULTI-DAY momentum-RUN scan — the FCEL archetype. The single-day scans above
// catch the individual spike DAYS, but a sustained run (FCEL: +20% then +22% then
// +25% over ~2 weeks) can slip under a single-day rel-vol gate on its continuation
// days. This scan admits names on SUSTAINED strength: a big multi-day move, REPEATED
// unusual-volume days (real participation, not one freak print), still trading near
// the run high (not faded). HONEST: this is reactive momentum-CONTINUATION (catches a
// move already underway), not predictive alpha — recall over precision, expect chop.
const RUN_SCAN = {
  key: 'momentum_run', label: '🌊 Momentum Run (multi-day)',
  priceMin: 2, priceMax: 100,
  minAvgVol: 500_000, minDollarVol: 5_000_000,
  minPct5d: 20,            // ≥20% over the last 5 sessions = a real run, not noise
  minHighVolDays: 2,       // ≥2 of the last 5 days had unusual volume (≥1.5× the 20d avg)
  nearHighFrac: 0.92,      // close within 8% of the 5-day high (still strong, not faded)
};
const RUN_WINDOW = 5;          // sessions in the "run"
const RUN_HIVOL_MULT = 1.5;    // a day counts as unusual-volume at ≥1.5× its trailing-20d avg

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

  // Reject split-adjustment artifacts (see ARTIFACT_JUMP above): a large open/close
  // move vs the prior close that volume did NOT confirm is a corrupt (re-scaled) bar,
  // not a real gap — skip the name entirely so no screener scores the bogus data.
  const relVol = todayVol / avgVol;
  const jump = Math.max(todayOpen > 0 ? Math.abs(todayOpen - prev) / prev : 0, Math.abs(last - prev) / prev);
  if (jump > ARTIFACT_JUMP && relVol < ARTIFACT_MIN_RELVOL) return null;

  let spyPct = null;
  if (spyByDate) {
    const d = candles[i].date, dp = candles[i - 1].date;
    if (spyByDate[d] != null && spyByDate[dp] != null && spyByDate[dp] > 0) {
      spyPct = (spyByDate[d] / spyByDate[dp] - 1) * 100;
    }
  }
  const pctChange = (last - prev) / prev * 100;

  // ── Multi-day run fields (for the momentum-run scan). Null if not enough history. ──
  let pct5d = null, highVolDays5 = null, nearHighFrac5 = null;
  if (i - RUN_WINDOW - avgWindow >= 0) {
    const base = candles[i - RUN_WINDOW].close;
    if (base > 0) pct5d = +(((last - base) / base) * 100).toFixed(2);
    // # of the last RUN_WINDOW sessions with unusual volume vs each day's own trailing-20d avg.
    let hv = 0, runHigh = 0;
    for (let k = i - RUN_WINDOW + 1; k <= i; k++) {
      let a = 0; for (let j = k - avgWindow; j < k; j++) a += (candles[j].volume || 0);
      a /= avgWindow;
      if (a > 0 && (candles[k].volume || 0) / a >= RUN_HIVOL_MULT) hv++;
      const hi = candles[k].high != null ? candles[k].high : candles[k].close;
      if (hi > runHigh) runHigh = hi;
    }
    highVolDays5 = hv;
    nearHighFrac5 = runHigh > 0 ? +(last / runHigh).toFixed(3) : null;
  }

  return {
    last: +last.toFixed(2),
    avgVol: Math.round(avgVol),
    avgDollarVol: Math.round(avgVol * last),
    relVol: +relVol.toFixed(2),
    pctChange: +pctChange.toFixed(2),
    gapPct: gapPct != null ? +gapPct.toFixed(2) : null,
    excessPct: spyPct != null ? +(pctChange - spyPct).toFixed(2) : null,   // momentum vs market
    pct5d, highVolDays5, nearHighFrac5,                                     // multi-day run
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

// Does a metrics object pass the multi-day momentum-run filters?
function passesRunScan(m, params = RUN_SCAN) {
  return m.last >= params.priceMin && m.last <= params.priceMax
    && m.avgVol >= params.minAvgVol
    && m.avgDollarVol >= params.minDollarVol
    && m.pct5d != null && m.pct5d >= params.minPct5d
    && m.highVolDays5 != null && m.highVolDays5 >= params.minHighVolDays
    && m.nearHighFrac5 != null && m.nearHighFrac5 >= params.nearHighFrac;
}

// Run-scan ranking — favor a bigger move, more unusual-volume days, and proximity to
// the high (conviction), capped so one field can't dominate. Ordering only.
function runRankScore(m) {
  return +(Math.min(m.pct5d || 0, 120) + (m.highVolDays5 || 0) * 15 + (m.nearHighFrac5 || 0) * 20).toFixed(1);
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
// `stopAtrMult`×ATR risk cap; target = 1:2 reward:risk. RISK-MANAGEMENT references,
// not predictions. riskPct is the input to position sizing.
//
// `useLowFloor` (default true) keeps the legacy tighter-of-two stop used by the
// Breakout/Confluence screeners. Set it false for a PURE `stopAtrMult`×ATR stop —
// the intraday research found the tight today's-low stop is the worst out-of-sample
// (it whipsaws) and that a wider ~2.5×ATR stop roughly halves the bleed.
function tradeLevels(candles, { stopAtrMult = 1.5, rr = 2, pullbackFrac = 0.4, useLowFloor = true } = {}) {
  const i = candles.length - 1;
  const entry = candles[i].close;
  const a = atr(candles);
  if (!(a > 0) || !(entry > 0)) return null;
  const todayLow = candles[i].low;

  const plan = (e) => {
    const stop = useLowFloor
      ? Math.max(todayLow - 0.1 * a, e - stopAtrMult * a)   // tighter (higher) of the two
      : e - stopAtrMult * a;                                // pure ATR stop (wider, no low-floor)
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

// OPENING-RANGE-BREAKOUT plan for the NEXT session. The intraday research found that
// buying the close/opening gap is the leak; the single biggest improvement was waiting
// for the next session's opening range and entering only on a break of its high (a
// continuation CONFIRMATION, not a chase). EOD candles can't see tomorrow's opening
// range, so we surface the RULE plus a reference trigger (a break above today's high)
// with a wide `stopAtrMult`×ATR stop and a 1:2 target. Reference levels, not predictions.
function orbLevels(candles, { stopAtrMult = 2.5, rr = 2 } = {}) {
  const i = candles.length - 1;
  const a = atr(candles);
  const trigger = candles[i].high;        // must break today's high next session to confirm
  if (!(a > 0) || !(trigger > 0)) return null;
  const stop = trigger - stopAtrMult * a;
  const risk = trigger - stop;
  if (!(risk > 0)) return null;
  return {
    trigger: +trigger.toFixed(2), stop: +stop.toFixed(2),
    target: +(trigger + rr * risk).toFixed(2), rr, riskPct: +((risk / trigger) * 100).toFixed(1),
    atr: +a.toFixed(2),
  };
}

module.exports = { AVG_VOL_WINDOW, SCANS, RUN_SCAN, dayMetrics, passesScan, passesRunScan, rankScore, runRankScore, atr, ema, tradeLevels, orbLevels };
