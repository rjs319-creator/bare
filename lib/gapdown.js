// GAP-DOWN CONTINUATION — unscheduled gap-down SHORT screener (SSOT engine).
//
// VALIDATED (research/44-shortside-continuation + 45-gapdown-rigor, 2026-07-10; the
// mirror of Gap & Go). An overnight gap-DOWN on a liquid name CONTINUES lower —
// clean monotone dose-response at the tradeable next-open entry (short excess vs SPY,
// h=3): gap ≤ −3% +0.53% → ≤ −5% +1.01% → ≤ −7% +1.50%, win 54-57%, positive all
// three years. Robust where Gap & Go's long was fragile: broad-based (top-5 trades
// only 5.4% of P&L, positive median +0.76%), and survives in liquid names ($150M+
// still +0.35%). Trade = short the break of the opening-range LOW, 2.5×ATR stop
// (above the OR), 1:2 target, ≤3-session hold.
//
// TWO HONEST CAVEATS baked into the UI:
//  • SHORT FRICTIONS. Net of realistic round-trip cost the edge thins: 0% +1.01% →
//    0.4% +0.61% → 0.8% +0.21%. The biggest gross edge is in $25–50M names — exactly
//    the hardest/priciest to borrow. Prefer liquid names you can actually short.
//  • IDIOSYNCRATIC, NOT A DOWN-DAY TOOL. The edge is STRONGER on non-red days (a name
//    gapping down on its own bad news keeps falling) and choppy on broad red days
//    (many bounce with the market). So this is its own lane, not part of Down-Day Mode.
//  • EARNINGS-SKIP is applied in the route (like Gap & Go) — earnings gap-downs may be
//    a one-time repricing that doesn't continue; the unscheduled subset is the edge.
//
// Pure: candles in → signal out. Reuses daytrade.dayMetrics + atr. Network/state
// (skip-earnings, ledger) live in the route, never here.

const { dayMetrics, atr } = require('./daytrade');

const GAP_STRONG = 5.0;              // validated PRIMARY threshold (gap ≤ −5%)
const GAP_MODERATE = 3.0;           // secondary tier — positive but weaker (gap ≤ −3%)
const MIN_DOLLAR_VOL = 10_000_000;  // tradeable liquidity floor (borrow gets easier the more liquid)

// FAIL-CLOSED SHORT-EXECUTABILITY GATE. A short is only real if you can actually borrow the
// name. This repo has NO borrow feed, so by default borrow is UNKNOWN → the signal is
// RESEARCH/WATCH only, never an actionable short (you cannot honestly recommend shorting a
// name you may be unable to borrow, at a fee you can't see). If a caller later wires a real
// borrow feed, pass `borrow` and an actionable short is unlocked only when it clears the gate.
//   borrow shape (all optional): { shortable:bool, available:bool, feeBps:number }
const MAX_BORROW_FEE_BPS = 2000;    // 20%/yr — above this the thin gross edge is eaten alive
function assessShortExecution(borrow) {
  if (!borrow || typeof borrow !== 'object') {
    return { borrowKnown: false, executable: false, reason: 'borrow/execution data unavailable — research/watch only' };
  }
  const shortable = borrow.shortable !== false && borrow.available !== false;
  if (!shortable) return { borrowKnown: true, executable: false, reason: 'not shortable / no borrow available' };
  if (typeof borrow.feeBps === 'number' && borrow.feeBps > MAX_BORROW_FEE_BPS) {
    return { borrowKnown: true, executable: false, reason: `borrow fee ${borrow.feeBps}bps exceeds ${MAX_BORROW_FEE_BPS}bps ceiling`, feeBps: borrow.feeBps };
  }
  return { borrowKnown: true, executable: true, reason: 'borrow confirmed within fee ceiling', feeBps: borrow.feeBps ?? null };
}

// ORB-LOW breakdown SHORT plan — the mirror of daytrade.orbLevels. Enter on a break
// BELOW the gap day's low next session; stop 2.5×ATR ABOVE (above the opening range);
// target 1:2 below. side='short'.
function orbLowLevels(candles, { stopAtrMult = 2.5, rr = 2 } = {}) {
  const i = candles.length - 1;
  const a = atr(candles);
  const trigger = candles[i].low;                 // must break today's low next session to confirm
  if (!(a > 0) || !(trigger > 0)) return null;
  const stop = trigger + stopAtrMult * a;
  const risk = stop - trigger;
  if (!(risk > 0)) return null;
  return {
    trigger: +trigger.toFixed(2), stop: +stop.toFixed(2),
    target: +Math.max(0.01, trigger - rr * risk).toFixed(2), rr, riskPct: +((risk / trigger) * 100).toFixed(1),
    atr: +a.toFixed(2), side: 'short',
  };
}

// CONTINUATION SCORE (0-100) — the validated rank is gap SIZE (dose-response, monotone),
// with a mild volume-confirmation nudge. Deliberately simple: no Kelly sizing or
// meta-label (short frictions make precise sizing claims dishonest on a thin edge).
function continuationScore(gapPct, relVol) {
  const gapN = Math.max(0, Math.min(1, (Math.abs(gapPct || 0) - GAP_MODERATE) / 12));   // −3%→0, −15%→1
  const rvN = Math.max(0, Math.min(1, ((relVol || 1) - 1) / 5));                        // 1x→0, 6x→1
  return Math.round(100 * (0.7 * gapN + 0.3 * rvN));
}

// Score one name's daily candles into a gap-down-continuation SHORT signal, or null.
// Does NOT apply the skip-earnings filter — that needs a network lookup (in the route).
// `opts.borrow` (optional) carries real borrow/execution data if a caller has it; without
// it the short is emitted as RESEARCH/WATCH only (fail-closed), never as an actionable short.
function scoreGapDown(candles, spyByDate, opts = {}) {
  const m = dayMetrics(candles, spyByDate);
  if (!m || m.gapPct == null) return null;
  if (m.gapPct > -GAP_MODERATE) return null;         // not a big enough gap-down
  if (m.avgDollarVol < MIN_DOLLAR_VOL) return null;  // not tradeable
  const plan = orbLowLevels(candles);
  if (!plan) return null;
  const execution = assessShortExecution(opts.borrow);
  return {
    last: m.last, gapPct: m.gapPct, relVol: m.relVol, pctChange: m.pctChange,
    excessPct: m.excessPct, avgDollarVol: m.avgDollarVol, avgVol: m.avgVol,
    tier: m.gapPct <= -GAP_STRONG ? 'STRONG' : 'MODERATE',
    side: 'short', plan,
    continuationScore: continuationScore(m.gapPct, m.relVol),
    // Fail-closed execution honesty: a short is only ACTIONABLE if borrow is confirmed.
    execution,
    actionability: execution.executable ? 'actionable-short' : 'research-watch',
    actionable: execution.executable,
  };
}

module.exports = {
  scoreGapDown, orbLowLevels, continuationScore, assessShortExecution,
  GAP_STRONG, GAP_MODERATE, MIN_DOLLAR_VOL, MAX_BORROW_FEE_BPS,
};
