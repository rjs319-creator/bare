// POINT-IN-TIME BACKFILL for the dual-read self-tuner.
//
// The live ledger (op=dualreadlog) accrues slowly. This warm-starts the learner by
// REPLAYING the long-term read over each stock's own price history: at each past
// date it reconstructs the read using ONLY bars up to that date, then measures the
// realized forward excess-vs-SPY. That yields thousands of resolved {signals, group,
// fwd} rows immediately — the exact rows championChallenger/byGroup learn on.
//
// Why this is faithful, not synthetic: the tuner learns from the per-factor SIGNALS
// (each factor's ±1 vote), which are WEIGHT-INDEPENDENT and fully reconstructable
// from daily bars. The short-term intraday action (not reconstructable far back) is
// NOT used by the learner, so nothing is faked. Mirrors lib/backfill.js /
// ghost-backtest.js point-in-time slicing; no lookahead — the forward window is
// strictly after the read date.

const { longTermRead } = require('./longterm');
const { groupOf } = require('./dualread-group');

const MIN_LOOKBACK = 200;   // need ~200 bars for the 200-day line before a read is valid

// Replay one ticker's history → resolved rows. `candles`/`spyCandles` are daily bars
// (chronological). Samples every `step` sessions, leaving an `horizon`-session forward
// window for resolution.
function replayTicker(candles, spyCandles, opts = {}) {
  const H = opts.horizon || 21;
  const step = opts.step || H;                 // default: non-overlapping forward windows (independent samples)
  const minLB = opts.minLookback || MIN_LOOKBACK;
  const rows = [];
  if (!candles || candles.length < minLB + H + 2 || !spyCandles || !spyCandles.length) return rows;

  const spyIdxAtOrAfter = date => spyCandles.findIndex(c => c.date >= date);

  for (let i = minLB; i + H < candles.length; i += step) {
    const d = candles[i].date;
    const si = spyIdxAtOrAfter(d);
    if (si < 0 || si + H >= spyCandles.length) continue;   // need an aligned SPY forward window

    // Read reconstructed from bars up to and including i only (no lookahead).
    const lt = longTermRead(candles.slice(0, i + 1), spyCandles.slice(0, si + 1));
    if (!lt || !lt.signals || Object.keys(lt.signals).length === 0) continue;
    const group = groupOf(candles.slice(0, i + 1));

    const sRet = (candles[i + H].close - candles[i].close) / candles[i].close;
    const mRet = (spyCandles[si + H].close - spyCandles[si].close) / spyCandles[si].close;
    rows.push({ signals: lt.signals, group, date: d, fwd: (sRet - mRet) * 100, ticker: opts.ticker || null });
  }
  return rows;
}

module.exports = { replayTicker, MIN_LOOKBACK };
