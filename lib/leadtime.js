// LEAD-TIME / EARLY-DETECTION MODEL (spec §7)
//
// Forward return alone can't tell you whether an algorithm found a move EARLY or just found
// a move. Two screeners can both catch the same +30% run and post the same 63-day return
// while one flagged it in quiet accumulation and the other only after it had already broken
// out. This module measures earliness against an OBJECTIVE, versioned event definition and —
// critically — refuses to call a screener "early" on lead time alone: it must also CONVERT
// its early signals into real moves and not tie up capital forever waiting (the §7 acceptance
// test). Pure: first-appearance picks + a per-ticker candle map in → an aggregate table out.
// No network, no clock.

'use strict';

const LEADTIME_VERSION = 'leadtime-v1';

// The event criteria — versioned & reproducible (spec §7). "Breakout/acceleration" = the first
// forward bar where the move from detection reaches BREAKOUT_PCT in the signal's direction,
// within WINDOW trading bars. Deliberately price-only so the marker is exactly reconstructable
// from candles; volume/vol-normalization are a future v2. Verdict gates below decide whether a
// screener's earliness is USEFUL, not merely first.
const CONFIG = {
  WINDOW: 63,            // forward trading bars to search (≈ one quarter, matches MAX_HOLD)
  BREAKOUT_PCT: 8,       // % move from detection that marks "the move got going"
  MIN_N: 12,             // per-algorithm sample floor before a verdict is offered
  MIN_BREAKOUT_RATE: 0.4, // ≥40% of early signals must convert into a real move
  MIN_EARLY_SHARE: 0.2,  // ≥20% of the eventual move must be captured BEFORE confirmation
  MAX_MEDIAN_WAIT: 21,   // median bars-to-breakout must be tradeable (≤ ~1 month)
};

const median = (a) => {
  const x = a.filter(v => Number.isFinite(v)).sort((p, q) => p - q);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : +(((x[m - 1] + x[m]) / 2)).toFixed(3);
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Per-pick earliness. Returns null when there isn't enough forward data to evaluate — so the
// sample self-limits to picks whose window has actually elapsed (no look-ahead, no padding).
function pickLeadTime(pick, candles, cfg = CONFIG) {
  if (!Array.isArray(candles) || !candles.length || !pick || !pick.date) return null;
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null;
  const detect = (pick.entry != null && pick.entry > 0) ? pick.entry : candles[idx].close;
  if (!detect) return null;
  const isShort = pick.short === true || pick.tier === 'StrongSell';
  const end = Math.min(idx + cfg.WINDOW, candles.length - 1);
  if (end <= idx) return null; // window hasn't elapsed at all → not yet evaluable

  const fav = (c) => {
    const hi = c.high != null ? c.high : c.close;
    const lo = c.low != null ? c.low : c.close;
    const px = isShort ? lo : hi;
    return isShort ? ((detect - lo) / detect) * 100 : ((hi - detect) / detect) * 100;
  };
  const favClose = (c) => (isShort ? ((detect - c.close) / detect) * 100 : ((c.close - detect) / detect) * 100);

  // Eventual move = Maximum Favorable Excursion over the window (the size of the run the
  // detector was early to). Walk once for MFE, its bar, breakout bar, and pre-breakout heat.
  let mfe = 0, mfeBar = idx, breakoutBar = null, maeBeforeBreakout = 0;
  for (let k = idx + 1; k <= end; k++) {
    const c = candles[k];
    const f = fav(c);
    if (f > mfe) { mfe = f; mfeBar = k; }
    if (breakoutBar == null) {
      // still waiting for the move to get going — track the heat taken while early.
      const adverse = isShort ? ((c.high != null ? c.high : c.close) - detect) / detect * 100
        : (detect - (c.low != null ? c.low : c.close)) / detect * 100;
      if (adverse > maeBeforeBreakout) maeBeforeBreakout = adverse;
      if (f >= cfg.BREAKOUT_PCT) breakoutBar = k;
    }
  }
  const reached = breakoutBar != null;
  const daysToBreakout = reached ? breakoutBar - idx : null;
  const daysToPeak = mfeBar - idx;
  const preBreakout = reached ? favClose(candles[breakoutBar]) : null;   // move captured by entering at detection vs confirmation
  const postBreakout = reached ? favClose(candles[end]) - favClose(candles[breakoutBar]) : null; // what a confirmation entrant gets after
  const resolved = favClose(candles[end]);                                // detection→window-end return (direction-aware)
  // Fraction of the eventual move captured ONLY by being early (before the breakout marker).
  const earlyShare = (reached && mfe > 0) ? clamp(preBreakout / mfe, 0, 1) : null;
  // Capital efficiency: eventual move per bar of capital tied up to the peak.
  const capitalEff = daysToPeak > 0 ? +(mfe / daysToPeak).toFixed(3) : null;

  return {
    ticker: pick.ticker, date: pick.date, section: pick.section, tier: pick.tier,
    reached, daysToBreakout, daysToPeak,
    mfe: +mfe.toFixed(2),
    preBreakout: preBreakout == null ? null : +preBreakout.toFixed(2),
    postBreakout: postBreakout == null ? null : +postBreakout.toFixed(2),
    resolved: +resolved.toFixed(2),
    maeBeforeBreakout: reached ? +maeBeforeBreakout.toFixed(2) : null,
    earlyShare: earlyShare == null ? null : +earlyShare.toFixed(3),
    capitalEff,
  };
}

// Aggregate a group of per-pick results into one algorithm row + an honest verdict.
function aggregate(key, rows, cfg = CONFIG) {
  const n = rows.length;
  const reached = rows.filter(r => r.reached);
  const breakoutRate = n ? +(reached.length / n).toFixed(3) : 0;
  const medWait = median(reached.map(r => r.daysToBreakout));
  const medEarlyShare = median(reached.map(r => r.earlyShare));
  const row = {
    key, n,
    breakoutRate,
    falseEarlyRate: +(1 - breakoutRate).toFixed(3),
    medianDaysToBreakout: medWait,
    medianDaysToPeak: median(rows.map(r => r.daysToPeak)),
    medianEarlyShare: medEarlyShare,
    medianPreBreakout: median(reached.map(r => r.preBreakout)),
    medianPostBreakout: median(reached.map(r => r.postBreakout)),
    medianMfe: median(rows.map(r => r.mfe)),
    medianResolved: median(rows.map(r => r.resolved)),
    medianMaeBeforeBreakout: median(reached.map(r => r.maeBeforeBreakout)),
    medianCapitalEff: median(rows.map(r => r.capitalEff)),
  };
  // VERDICT (the §7 discipline): "early" is earned only when the signals CONVERT into real
  // moves (breakoutRate), the earliness actually captured a meaningful slice of the move
  // (earlyShare), and the wait was tradeable (medWait). First-but-fruitless is NOT early.
  if (n < cfg.MIN_N) { row.verdict = 'insufficient'; row.early = false; return row; }
  const converts = breakoutRate >= cfg.MIN_BREAKOUT_RATE;
  const capturesEarly = medEarlyShare != null && medEarlyShare >= cfg.MIN_EARLY_SHARE;
  const tradeableWait = medWait != null && medWait <= cfg.MAX_MEDIAN_WAIT;
  row.early = converts && capturesEarly && tradeableWait;
  row.verdict = row.early ? 'genuinely-early'
    : !converts ? 'low-conversion'          // fires early but few signals become moves
      : !capturesEarly ? 'late-detector'    // by the time it fires the move is mostly done
        : 'slow-to-pay';                    // converts, captures early, but the wait is long
  return row;
}

// picks: first-appearance rows [{date,ticker,section,tier,entry,short}]. histMap: Map<ticker,
// candles[]>. groupBy: 'section' (default) or 'sectionTier'. Returns the algorithm table + a
// per-category leaderboard drawn ONLY from rows that earned the 'early'/qualifying gate.
function computeLeadTime(picks, histMap, { groupBy = 'section', config = CONFIG } = {}) {
  const cfg = { ...CONFIG, ...config };
  const groups = new Map();
  let evaluated = 0;
  for (const p of picks || []) {
    const candles = histMap && (histMap.get ? histMap.get(p.ticker) : histMap[p.ticker]);
    const lt = pickLeadTime(p, candles, cfg);
    if (!lt) continue;
    evaluated++;
    const key = groupBy === 'sectionTier' ? `${p.section}:${p.tier}` : p.section;
    (groups.get(key) || groups.set(key, []).get(key)).push(lt);
  }
  const table = [...groups.entries()].map(([k, rows]) => aggregate(k, rows, cfg))
    .sort((a, b) => (b.early - a.early) || ((a.medianDaysToBreakout ?? 1e9) - (b.medianDaysToBreakout ?? 1e9)));

  // Leaderboards — each drawn from the algos that MET the sample floor (and, where the metric
  // implies usefulness, the conversion gate), so "earliest" can never win on a dead signal.
  const rated = table.filter(r => r.n >= cfg.MIN_N);
  const converting = rated.filter(r => r.breakoutRate >= cfg.MIN_BREAKOUT_RATE);
  const best = (arr, sel, dir = 'max') => {
    const withVal = arr.filter(r => sel(r) != null);
    if (!withVal.length) return null;
    return withVal.slice().sort((a, b) => dir === 'max' ? sel(b) - sel(a) : sel(a) - sel(b))[0].key;
  };
  const leaderboard = {
    earliestDetector: best(converting, r => r.medianDaysToBreakout, 'min'),   // fewest bars, but only among converters
    bestMoveCaptured: best(converting, r => r.medianEarlyShare, 'max'),
    bestPostEntryReturn: best(converting, r => r.medianPostBreakout, 'max'),
    bestCapitalEfficiency: best(rated, r => r.medianCapitalEff, 'max'),
    lowestFalseEarly: best(rated, r => r.falseEarlyRate, 'min'),
  };
  return {
    version: LEADTIME_VERSION, config: cfg, groupBy,
    algorithms: table, leaderboard,
    coverage: { picks: (picks || []).length, evaluated, algorithms: table.length },
  };
}

module.exports = { LEADTIME_VERSION, CONFIG, median, pickLeadTime, aggregate, computeLeadTime };
