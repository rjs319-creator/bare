'use strict';
// PATTERN UNIVERSE SCAN — resource-bounded two-stage discovery, resumable + observable.
//
// Replaces the 16-name default shortlist. Stage 1 is cheap (liquidity, price, history,
// volatility state, proximity to meaningful levels); only survivors pay for Stage 2
// (family-specific pivot extraction and full structural validation via analyzeTicker).
//
// The scan is a CURSOR over the full universe that persists across cron ticks: each tick
// advances as far as its time budget allows and records exactly what it covered —
// eligible / scanned / rejected (with reasons) / data failures / coverage by band. A
// 16-stock day can never silently masquerade as market-wide discovery.

const G = require('./geometry');

const isNum = v => typeof v === 'number' && isFinite(v);

const STAGE1 = Object.freeze({
  minBars: 80,
  minPrice: 3,
  minAvgDollarVol: 1e6,
  maxAtrDistanceToLevel: 6,   // within N ATRs of the 60d high or low = "approaching a level"
});

// Stage 1: cheap eligibility from daily candles alone. Returns { eligible, reasons }.
function stagePrefilter(candles, cfg = STAGE1) {
  const cs = G.toDaily(candles);
  const reasons = [];
  if (cs.length < cfg.minBars) reasons.push('insufficient-history');
  const last = cs[cs.length - 1];
  if (!last || last.close < cfg.minPrice) reasons.push('price-below-floor');
  const tail = cs.slice(-20);
  const avgDollar = tail.length ? tail.reduce((a, c) => a + c.close * (c.volume || 0), 0) / tail.length : 0;
  if (avgDollar < cfg.minAvgDollarVol) reasons.push('illiquid');
  if (reasons.length) return { eligible: false, reasons };

  const win = cs.slice(-60);
  const atr = G.atrOf(win);
  if (!isNum(atr) || atr <= 0) return { eligible: false, reasons: ['no-atr'] };
  const hi = Math.max(...win.map(c => c.high));
  const lo = Math.min(...win.map(c => c.low));
  const nearHigh = (hi - last.close) / atr <= cfg.maxAtrDistanceToLevel;
  const nearLow = (last.close - lo) / atr <= cfg.maxAtrDistanceToLevel;
  // Volatility state: contracting ranges also qualify (bases form before they break).
  const third = Math.max(5, Math.floor(win.length / 3));
  const recentRange = avgRange(win.slice(-third));
  const priorRange = avgRange(win.slice(0, third));
  const contracting = priorRange > 0 && recentRange / priorRange < 0.85;
  if (!nearHigh && !nearLow && !contracting) return { eligible: false, reasons: ['mid-range-no-structure'] };
  return { eligible: true, reasons: [] };
}

function avgRange(cs) { return cs.length ? cs.reduce((a, c) => a + (c.high - c.low), 0) / cs.length : 0; }

function emptyStats() {
  return {
    universe: 0, eligible: 0, scanned: 0, rejectedStage1: 0, detections: 0,
    rejectionReasons: {}, dataFailures: 0, coverage: {},
  };
}

// One resumable scan pass.
//   tickers    : full universe with band labels [{ ticker, band }]
//   state      : prior scan state { cursor, date, stats } (null = fresh)
//   fetchDaily : async ticker → candles
//   analyze    : async (ticker, candles) → analysis report (stage 2)
//   opts       : { budgetMs, date, nowMs() }
// Returns { state, results: [{ ticker, report }] , done }
async function scanPass({ tickers, state = null, fetchDaily, analyze, budgetMs = 35000, date, nowMs = () => Date.now() }) {
  const sameDay = !!state && state.date === date && isNum(state.cursor);
  // A new day resets the per-day stats but CARRIES the cursor forward: with one bounded
  // tick per day, restarting at 0 would re-walk the head of the universe forever and the
  // tail bands would never be scanned. The cursor wraps to 0 once a sweep completes.
  const carriedCursor = !sameDay && state && isNum(state.cursor) && state.cursor < tickers.length ? state.cursor : 0;
  const st = sameDay
    ? { ...state, stats: { ...emptyStats(), ...state.stats, universe: tickers.length } }
    : { cursor: carriedCursor, date, startedAt: new Date(nowMs()).toISOString(), stats: { ...emptyStats(), universe: tickers.length } };

  const t0 = nowMs();
  const results = [];
  while (st.cursor < tickers.length && nowMs() - t0 < budgetMs) {
    const { ticker, band = 'unknown' } = tickers[st.cursor];
    st.cursor++;
    let candles = null;
    try { candles = await fetchDaily(ticker); } catch { candles = null; }
    if (!Array.isArray(candles) || !candles.length) {
      st.stats.dataFailures++;
      continue;
    }
    const pre = stagePrefilter(candles);
    st.stats.coverage[band] = st.stats.coverage[band] || { scanned: 0, eligible: 0 };
    st.stats.coverage[band].scanned++;
    if (!pre.eligible) {
      st.stats.rejectedStage1++;
      for (const r of pre.reasons) st.stats.rejectionReasons[r] = (st.stats.rejectionReasons[r] || 0) + 1;
      continue;
    }
    st.stats.eligible++;
    st.stats.coverage[band].eligible++;
    try {
      const report = await analyze(ticker, candles);
      st.stats.scanned++;
      if (report && Array.isArray(report.detections) && report.detections.length) {
        st.stats.detections += report.detections.length;
        results.push({ ticker, report });
      }
    } catch {
      st.stats.dataFailures++;
    }
  }
  st.updatedAt = new Date(nowMs()).toISOString();
  return { state: st, results, done: st.cursor >= tickers.length };
}

module.exports = { stagePrefilter, scanPass, STAGE1 };
