// EVOLVE — TRIPLE-BARRIER EVENT LABELS
//
// The prediction target. NOT next-day direction (which the app's research shows is a
// coin flip), but a path-aware event: does a name reach an upside barrier BEFORE a
// downside barrier within a horizon window? This is the López de Prado triple-barrier
// method, adapted to the app's honest priors and its free/EOD daily-candle data.
//
//   FAST     +8% before −4% within  5 trading days
//   SWING    +15% before −7% within 21 trading days
//   POSITION +25% before −10% within 63 trading days
//
// Barriers are configurable and volatility-adjustable (scale to ATR so a quiet name and
// a jumpy name are judged on comparable, tradeable moves — a flat ±8% over-rewards
// high-vol names and never triggers on low-vol ones).
//
// Everything here is PURE and operates ONLY on candles strictly AFTER the prediction
// timestamp — point-in-time correct by construction (the caller slices; `sliceForward`
// enforces it). No label can ever peek at a bar at/before the prediction date.
//
// Stored per label: the barrier hit, time-to-barrier, terminal return, max favorable
// excursion (MFE), max adverse excursion (MAE), SPY-relative and sector-relative
// terminal return, and a liquidity/slippage estimate. Never fabricates: a missing
// benchmark or too-few forward bars yields `null`/`pending`, not a made-up number.

'use strict';

// v2 (review 2026-10, Prompt 5.3): the benchmark leg is MATCHED to the label's own interval and
// aligned by DATE — a day-1 barrier exit is compared with SPY to day 1, not to the end of the
// window by array position; a missing benchmark bar on the entry or exit date is unavailable
// with a reason; gap-through barriers fill at the session open. Rows labelled under v1 are
// kept as they are and carry no `labelsVersion` (or 'evolve-labels-v1'); nothing rewrites them.
const LABELS_VERSION = 'evolve-labels-v2';

// The three EVOLVE horizons. `metric` is the decision-engine scoreboard key this
// horizon's outcome is comparable to (see lib/decision.js HORIZON_METRIC).
const EVOLVE_HORIZONS = ['micro', 'fast', 'swing', 'position'];
const HORIZON_META = {
  // MICRO (2 trading days) — NEXT-OPEN POSITIONING, not intraday entry. This stack is
  // EOD-only (one cron/day, no live quotes, no bid/ask feed — see lib/provenance.js), so a
  // 2-day call is honestly "position at the next open, judge two sessions later". Its
  // barriers are deliberately scaled DOWN (+3/−1.5%) because ±8% in two sessions is a
  // different, much rarer event than ±8% in a week — reusing the fast barriers would make
  // the horizon resolve almost entirely to timeouts and teach the ensemble nothing.
  // Reward:risk is held at 2.0 (identical to fast), so `breakevenProb` stays 1/3 and the
  // horizon is directly comparable to the others rather than a rescaled special case.
  // WARNING: at 2 days the costs.js round-trip haircut (16bps liquid → 150bps micro-cap)
  // is a large fraction of the 3% target. Treat micro as measurement, not as a trade bar.
  micro:    { label: 'Micro (2d, next-open)', window: 2, up: 0.03, down: 0.015, metric: '1d' },
  fast:     { label: 'Fast (≤1wk)',    window: 5,  up: 0.08, down: 0.04, metric: '1w' },
  swing:    { label: 'Swing (≤1mo)',   window: 21, up: 0.15, down: 0.07, metric: '1m' },
  position: { label: 'Position (≤3mo)', window: 63, up: 0.25, down: 0.10, metric: '3m' },
};
// Map a decision-engine horizon (intraday/swing/position/portfolio) → an EVOLVE horizon.
const DECISION_TO_EVOLVE = { intraday: 'fast', swing: 'swing', position: 'position', portfolio: 'position' };
const toEvolveHorizon = (h) => DECISION_TO_EVOLVE[h] || 'swing';

// Volatility-adjust a horizon's barriers to a name's ATR%. `k` up-multiples and the
// down-barrier keep the same reward:risk ratio as the fixed defaults, but scaled so the
// move is meaningful for THIS name's volatility. Clamped so a wildly volatile or dead
// name can't produce absurd barriers. When atrPct is unknown we return the fixed defaults
// (honest — no fabricated volatility).
function barriersFor(horizon, { atrPct = null, volAdjust = false } = {}) {
  const m = HORIZON_META[horizon] || HORIZON_META.swing;
  if (!volAdjust || !Number.isFinite(atrPct) || atrPct <= 0) {
    return { up: m.up, down: m.down, window: m.window, volAdjusted: false };
  }
  // Target the upside barrier at ~ (window^0.5 · ATR%) — a random-walk scale for the
  // horizon — but never let it drift more than 2× away from the fixed default.
  const scale = Math.sqrt(m.window) * atrPct;
  const up = Math.max(m.up * 0.5, Math.min(m.up * 2, scale));
  const rr = m.up / m.down;                    // preserve the horizon's reward:risk
  const down = up / rr;
  return { up: +up.toFixed(4), down: +down.toFixed(4), window: m.window, volAdjusted: true };
}

// Candles strictly AFTER `afterDate` (exclusive), capped at maxBars. The single guard
// that makes labels point-in-time correct — a label is computed only from these bars.
function sliceForward(candles, afterDate, maxBars) {
  const fwd = (candles || []).filter(c => c && c.date > afterDate);
  return maxBars ? fwd.slice(0, maxBars) : fwd;
}

// The core path walk. Given forward candles and an entry price, find which barrier is
// touched first. Same-bar ambiguity (a bar whose high hits the upper AND low hits the
// lower) is resolved CONSERVATIVELY as the loss — for an upside-hunting long, assuming
// the favorable touch on an ambiguous bar would optimistically inflate the win rate.
// Returns barrier ∈ {upper, lower, time}, bars-to-hit, MFE/MAE, terminal, exit price.
function tripleBarrier(forward, entry, { up, down, window }) {
  if (!Number.isFinite(entry) || entry <= 0 || !forward || !forward.length) {
    return { resolved: false, pending: true, barrier: null, reason: 'no-forward-bars' };
  }
  const upPx = entry * (1 + up), downPx = entry * (1 - down);
  let mfe = 0, mae = 0, barrier = 'time', bars = 0, exitPx = entry, sameBar = false, gapThrough = false;
  const n = Math.min(window, forward.length);
  for (let i = 0; i < n; i++) {
    const c = forward[i];
    const hi = Number.isFinite(c.high) ? c.high : c.close;
    const lo = Number.isFinite(c.low) ? c.low : c.close;
    mfe = Math.max(mfe, (hi - entry) / entry);
    mae = Math.min(mae, (lo - entry) / entry);
    const hitUp = hi >= upPx, hitDown = lo <= downPx;
    if (hitUp || hitDown) {
      bars = i + 1;
      sameBar = hitUp && hitDown;
      barrier = (hitDown && (!hitUp || sameBar)) ? 'lower' : 'upper'; // conservative on same-bar
      // GAP-THROUGH (same policy as lib/outcome.js / lib/paper-portfolio): a bar that OPENS
      // beyond the barrier cannot fill at the barrier price — the open is the first price.
      const open = Number.isFinite(c.open) ? c.open : null;
      const barrierPx = barrier === 'upper' ? upPx : downPx;
      exitPx = open != null && (barrier === 'upper' ? open > upPx : open < downPx) ? open : barrierPx;
      gapThrough = exitPx !== barrierPx;
      break;
    }
    exitPx = c.close;
  }
  // Whether the horizon has fully elapsed (enough bars to have seen a time-out). If the
  // window hasn't elapsed and no barrier hit, the outcome is still PENDING (not a timeout).
  const elapsed = forward.length >= window;
  if (barrier === 'time' && !elapsed) {
    return { resolved: false, pending: true, barrier: null, mfe: +mfe.toFixed(4), mae: +mae.toFixed(4),
      barsObserved: forward.length, windowNeeded: window, reason: 'window-not-elapsed' };
  }
  const terminal = (exitPx - entry) / entry;
  // Exact index of the resolving bar in the forward slice: the barrier-touch bar for
  // upper/lower, else the last bar of the elapsed window for a time exit. Its DATE is the
  // label-end timestamp — the ground truth for purging overlapping labels (superseding the
  // 1.4×-calendar-day approximation in lib/evolve-walkforward.js).
  const endIdx = barrier === 'time' ? n - 1 : bars - 1;
  const labelEndDate = (forward[endIdx] && forward[endIdx].date) || null;
  // A profitable time-exit is NOT a loss. `won` stays barrier==='upper' for backward
  // compatibility (the ensemble's hit-rate target), but `profitable` records the honest
  // sign of the realized return so downstream can treat a positive timeout correctly.
  return {
    resolved: true, pending: false,
    barrier,                                    // upper | lower | time
    won: barrier === 'upper',
    profitable: terminal > 0,                   // true realized sign (incl. profitable timeouts)
    label: barrier === 'upper' ? 1 : barrier === 'lower' ? -1 : 0,
    barsToBarrier: barrier === 'time' ? null : bars,
    labelEndDate,                               // exact date the label resolved (for exact purge)
    windowUsed: n, sameBarAmbiguous: sameBar, gapThrough,
    entry, exitPrice: +exitPx.toFixed(4),
    terminalReturn: +terminal.toFixed(4),
    mfe: +mfe.toFixed(4), mae: +mae.toFixed(4),  // both as fractions of entry
  };
}

// Terminal return of a benchmark over the same forward window (for SPY-/sector-relative).
// Returns null when the benchmark series is unavailable — never zero (which would read
// as "matched the market" when we simply don't know).
function benchmarkReturn(benchForward, window) {
  if (!benchForward || !benchForward.length) return null;
  const n = Math.min(window, benchForward.length);
  if (n < 1) return null;
  const first = benchForward[0], last = benchForward[n - 1];
  const p0 = Number.isFinite(first.open) ? first.open : first.close;
  const p1 = last.close;
  if (!Number.isFinite(p0) || p0 <= 0 || !Number.isFinite(p1)) return null;
  return +((p1 - p0) / p0).toFixed(4);
}

// Benchmark return over a label's OWN interval, aligned BY DATE: from the open of the bar on
// `startDate` (the first forward session — the entry) to the close of the bar on `endDate`
// (the label's resolving session). Either bar missing ⇒ unavailable with a reason, never a
// value computed off neighbouring bars. `benchmarkReturn` above keeps its fixed-window,
// array-position semantics for callers whose label always spans the full window.
function matchedBenchmarkReturn(benchCandles, { startDate, endDate } = {}) {
  if (!benchCandles || !benchCandles.length) return { ret: null, reason: 'benchmark-unavailable', startDate: startDate || null, endDate: endDate || null };
  if (!startDate || !endDate) return { ret: null, reason: 'missing-benchmark-date', startDate: startDate || null, endDate: endDate || null };
  const first = benchCandles.find(c => c && c.date === startDate);
  const last = benchCandles.find(c => c && c.date === endDate);
  if (!first || !last) return { ret: null, reason: 'missing-benchmark-date', startDate, endDate };
  const p0 = Number.isFinite(first.open) ? first.open : first.close;
  const p1 = last.close;
  if (!Number.isFinite(p0) || p0 <= 0 || !Number.isFinite(p1)) return { ret: null, reason: 'missing-benchmark-date', startDate, endDate };
  return { ret: +((p1 - p0) / p0).toFixed(4), reason: null, startDate, endDate };
}

// Rough per-trade slippage estimate (%). The app's validated tradeable floor is ~$3M
// average dollar-volume; below it, spread/impact dominates. Volatility (ATR%) widens it.
// A coarse, honest heuristic — surfaced as a warning, never as precision.
function estimateSlippagePct({ dollarVol = null, atrPct = null, price = null } = {}) {
  let bps = 5;                                   // ~5bps baseline for a liquid large-cap
  if (Number.isFinite(dollarVol) && dollarVol > 0) {
    if (dollarVol < 5e5) bps += 120;
    else if (dollarVol < 3e6) bps += 45;
    else if (dollarVol < 2e7) bps += 15;
  } else { bps += 20; }                          // unknown liquidity → mild penalty
  if (Number.isFinite(atrPct) && atrPct > 0) bps += Math.min(60, atrPct * 100 * 3);
  if (Number.isFinite(price) && price > 0 && price < 3) bps += 40;
  return +(bps / 100).toFixed(3);                // → percent
}

// High-level: label ONE (ticker, horizon) prediction. Ties the pieces together.
//   entry       : the prediction's entry price (point-in-time, at prediction date)
//   candles     : the ticker's FULL candle series (will be sliced forward of predDate)
//   predDate    : YYYY-MM-DD prediction date (labels use only bars strictly after it)
//   spyCandles  : SPY full series (optional → SPY-relative terminal)
//   sectorCandles: sector ETF full series (optional → sector-relative terminal)
//   barrierOpts : { atrPct, volAdjust } for barriersFor
// Returns a resolved label, or { pending:true } if the window hasn't elapsed yet.
function labelEvent({ entry, candles, predDate, horizon = 'swing', spyCandles = null, sectorCandles = null,
  atrPct = null, volAdjust = false, dollarVol = null, price = null } = {}) {
  const b = barriersFor(horizon, { atrPct, volAdjust });
  const fwd = sliceForward(candles, predDate, b.window + 5);     // small buffer for holidays
  const core = tripleBarrier(fwd, entry, b);
  const base = { version: LABELS_VERSION, horizon, barriers: b, predDate };
  if (!core.resolved) return { ...base, ...core };

  // MATCHED holding period: entry session = the first forward bar, exit = the resolving bar.
  const dates = { startDate: fwd[0] && fwd[0].date, endDate: core.labelEndDate };
  const spy = matchedBenchmarkReturn(spyCandles, dates);
  const sec = matchedBenchmarkReturn(sectorCandles, dates);
  return {
    ...base, ...core,
    spyRelReturn: spy.ret == null ? null : +(core.terminalReturn - spy.ret).toFixed(4),
    sectorRelReturn: sec.ret == null ? null : +(core.terminalReturn - sec.ret).toFixed(4),
    spyReturn: spy.ret, sectorReturn: sec.ret,
    benchmarkReason: spy.reason, sectorBenchmarkReason: sec.reason,
    benchmarkStartDate: dates.startDate || null, benchmarkEndDate: dates.endDate || null,
    slippageEst: estimateSlippagePct({ dollarVol, atrPct, price }),
  };
}

module.exports = {
  LABELS_VERSION, EVOLVE_HORIZONS, HORIZON_META, DECISION_TO_EVOLVE, toEvolveHorizon,
  barriersFor, sliceForward, tripleBarrier, benchmarkReturn, matchedBenchmarkReturn, estimateSlippagePct, labelEvent,
};
