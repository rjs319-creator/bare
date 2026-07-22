'use strict';
// OPTIONS EPISODE GRADING — realistic, leakage-resistant outcome measurement.
//
// A decision episode is decided on day T (from that day's close/EOD data). Grading must
// therefore enter at the NEXT session's OPEN (T+1), never the same close that generated
// the decision — otherwise the "entry" leaks the information that produced it. Returns are
// measured over multiple session horizons, made SPY-relative and (when available)
// sector-relative to strip beta, cost/slippage-adjusted, and reported with MFE/MAE.
//
// Direction: a bullish thesis profits from a rise, a bearish thesis from a fall — bearish
// returns are inverted so a "correct" episode always scores positive. NEUTRAL episodes are
// context, not directional predictions, and are not graded here.
//
// Pure functions — candles are passed in (no network). A candle = {date, open, high,
// low, close} with ISO date. Series are assumed ascending by date.

const DEFAULT_HORIZONS = [1, 3, 5, 10, 21];
const DEFAULT_COST_BPS = 10;   // per side; round trip = 2x (slippage + fees proxy)

const ret = (from, to) => (from > 0 ? (to - from) / from : null);

// First candle STRICTLY AFTER the decision date — its OPEN is the realistic entry.
function nextOpenEntry(candles, decisionDate) {
  if (!Array.isArray(candles) || !decisionDate) return null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c && c.date > decisionDate && c.open != null && c.open > 0) {
      return { entryDate: c.date, entryPx: c.open, entryIdx: i };
    }
  }
  return null;
}

// Close-to-close return from the entry price at each horizon (in sessions past entry).
function horizonReturns(candles, entryIdx, entryPx, horizons = DEFAULT_HORIZONS) {
  const out = {};
  for (const h of horizons) {
    const c = candles[entryIdx + h];
    out[h] = c && c.close != null ? ret(entryPx, c.close) : null;
  }
  return out;
}

// Max favorable / adverse excursion over the window [entry, entry+maxH] (unsigned, from
// entry price). Caller applies direction sign.
function mfeMae(candles, entryIdx, entryPx, maxH) {
  let hi = entryPx, lo = entryPx;
  for (let i = entryIdx + 1; i <= entryIdx + maxH && i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    if (c.high != null) hi = Math.max(hi, c.high);
    if (c.low != null) lo = Math.min(lo, c.low);
  }
  return { up: ret(entryPx, hi), down: ret(entryPx, lo) };
}

// Return of a benchmark series over the same calendar window [entryDate, exit at horizon h].
function benchReturn(bench, entryDate, exitDate) {
  if (!Array.isArray(bench) || !entryDate || !exitDate) return null;
  let entry = null, exit = null;
  for (const c of bench) {
    if (c.date >= entryDate && entry == null && c.open != null) entry = c.open;
    if (c.date <= exitDate && c.close != null) exit = c.close;
  }
  return entry != null && exit != null ? ret(entry, exit) : null;
}

// Grade one directional episode. `series` = { candles, spy?, sector? }. Returns a graded
// record, or { graded:false, reason } when it can't be graded (neutral / no entry /
// insufficient forward data).
function gradeEpisode(episode, series = {}, opts = {}) {
  const horizons = opts.horizons || DEFAULT_HORIZONS;
  const costBps = opts.costBps != null ? opts.costBps : DEFAULT_COST_BPS;
  const dir = episode && episode.side === 'bullish' ? 1 : episode && episode.side === 'bearish' ? -1 : 0;
  if (dir === 0) return { graded: false, reason: 'non-directional' };

  const candles = series.candles || [];
  const entry = nextOpenEntry(candles, episode.firstSeenDate);
  if (!entry) return { graded: false, reason: 'no-next-open-entry' };

  const maxH = Math.max(...horizons);
  if (entry.entryIdx + 1 >= candles.length) return { graded: false, reason: 'no-forward-data' };

  const rawH = horizonReturns(candles, entry.entryIdx, entry.entryPx, horizons);
  const roundTripCost = (2 * costBps) / 10_000;   // fraction

  const horizonGrades = {};
  for (const h of horizons) {
    const raw = rawH[h];
    if (raw == null) { horizonGrades[h] = null; continue; }
    const exitCandle = candles[entry.entryIdx + h];
    const exitDate = exitCandle ? exitCandle.date : null;
    const spyR = benchReturn(series.spy, entry.entryDate, exitDate);
    const secR = benchReturn(series.sector, entry.entryDate, exitDate);
    // Directional, cost-aware economic return; excess strips SPY (and sector when present).
    const directional = dir * raw - roundTripCost;
    const vsSpy = spyR == null ? null : dir * (raw - spyR) - roundTripCost;
    const vsSector = secR == null ? null : dir * (raw - secR) - roundTripCost;
    horizonGrades[h] = {
      rawReturn: +(raw * 100).toFixed(2),
      directional: +(directional * 100).toFixed(2),
      excessVsSpy: vsSpy == null ? null : +(vsSpy * 100).toFixed(2),
      excessVsSector: vsSector == null ? null : +(vsSector * 100).toFixed(2),
    };
  }

  const exc = mfeMae(candles, entry.entryIdx, entry.entryPx, maxH);
  return {
    graded: true,
    episodeId: episode.id,
    ticker: episode.ticker,
    side: episode.side,
    decisionDate: episode.firstSeenDate,
    entryDate: entry.entryDate,
    entryPx: +entry.entryPx.toFixed(2),
    costBps,
    horizons: horizonGrades,
    mfe: +((dir === 1 ? exc.up : -exc.down) * 100).toFixed(2),   // favorable excursion, signed to thesis
    mae: +((dir === 1 ? exc.down : -exc.up) * 100).toFixed(2),   // adverse excursion, signed to thesis
  };
}

// ── Aggregate summary at one horizon (economic usefulness ≠ direction accuracy) ──
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

function summarizeEpisodes(graded, { horizon = 21, metric = 'excessVsSpy' } = {}) {
  const rows = (graded || []).filter(g => g && g.graded && g.horizons[horizon] && g.horizons[horizon][metric] != null);
  const vals = rows.map(g => g.horizons[horizon][metric]);
  if (!vals.length) return { n: 0, independentDates: 0, note: 'insufficient graded episodes' };
  const m = mean(vals);
  const wins = vals.filter(v => v > 0);
  const losses = vals.filter(v => v <= 0);
  const variance = vals.length > 1 ? mean(vals.map(v => (v - m) ** 2)) * (vals.length / (vals.length - 1)) : 0;
  const se = Math.sqrt(variance / vals.length);
  const worst = Math.min(...vals);
  return {
    n: vals.length,
    independentDates: new Set(rows.map(g => g.decisionDate)).size,
    hitRate: +((wins.length / vals.length) * 100).toFixed(1),
    meanExcess: +m.toFixed(3),
    avgWin: wins.length ? +mean(wins).toFixed(3) : null,
    avgLoss: losses.length ? +mean(losses).toFixed(3) : null,
    worstEpisode: +worst.toFixed(3),
    ci95: [+(m - 1.96 * se).toFixed(3), +(m + 1.96 * se).toFixed(3)],
    horizon, metric,
  };
}

module.exports = {
  DEFAULT_HORIZONS, DEFAULT_COST_BPS,
  nextOpenEntry, horizonReturns, mfeMae, benchReturn, gradeEpisode, summarizeEpisodes,
};
