// ORBIT executable labels (orbit-labels-v1) — the SAME engine drives historical
// backtesting and prospective resolution, so train and serve measure one thing.
//
// A prediction derived from a COMPLETED daily bar fills no earlier than the next
// tradable session (reuses lib/execution-policy `planFill`, next-open + slippage).
// For each 5/21/63-session horizon we resolve a long triple-barrier (upper /
// lower / timeout) via lib/outcome `resolveTrade` — which starts the barrier scan
// the bar AFTER entry, resolves same-bar high/low ambiguity to the STOP
// (conservative), and reports a PROFITABLE timeout honestly (EXPIRED with r>0 is
// not a loss). Costs come from lib/costs (cost-v1). No fabricated bars: when the
// window runs past the data we return `resolved:false` with a reason.

const { planFill, POLICIES, EXECUTION_POLICY_VERSION } = require('./execution-policy');
const { resolveTrade } = require('./outcome');
const { roundTripCostPct, netReturn, COST_MODEL_VERSION } = require('./costs');

const LABELS_VERSION = 'orbit-labels-v1';
const HORIZONS = Object.freeze({ days5: 5, days21: 21, days63: 63 });
const DEFAULT_SEVERE_LOSS_PCT = 0.08;   // net loss ≥8% is a "severe loss"

// Long triple-barrier widths for a horizon. ATR-scaled (random-walk √H) when the
// daily ATR% is known; otherwise fixed per-horizon fallbacks. Reward:risk ≈ 1.5.
function barriersFor(hDays, atrPct) {
  if (atrPct != null && atrPct > 0) {
    const scale = atrPct * Math.sqrt(hDays);
    return { up: clamp(2.0 * scale, 0.03, 0.60), down: clamp(1.3 * scale, 0.02, 0.40) };
  }
  const fb = { 5: { up: 0.06, down: 0.04 }, 21: { up: 0.12, down: 0.08 }, 63: { up: 0.20, down: 0.13 } };
  return fb[hDays];
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Build a date→close map for a benchmark candle series (SPY / sector ETF).
function closeMap(candles) {
  const m = new Map();
  if (candles) for (const c of candles) m.set(c.date, c.close);
  return m;
}
// Benchmark return between two dates using the last bar on/before each.
function benchReturn(mapDates, sortedDates, fromDate, toDate) {
  const at = (d) => {
    let lo = 0, hi = sortedDates.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (sortedDates[mid] <= d) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found >= 0 ? mapDates.get(sortedDates[found]) : null;
  };
  const a = at(fromDate), b = at(toDate);
  return (a != null && b != null && a > 0) ? (b / a - 1) : null;
}

// Max favorable / adverse excursion between the bar after entry and the exit bar.
function excursions(candles, fillIdx, exitDate, entry) {
  let mfe = 0, mae = 0;
  for (let k = fillIdx + 1; k < candles.length; k++) {
    const c = candles[k];
    mfe = Math.max(mfe, (c.high - entry) / entry);
    mae = Math.min(mae, (c.low - entry) / entry);
    if (c.date >= exitDate) break;
  }
  return { mfe: +mfe.toFixed(4), mae: +mae.toFixed(4) };
}

// Compute labels for one signal.
//   opts: { side='long', tier='liquid', atrPct, severeLossPct, exposures,
//           marketCandles, sectorCandles, slippagePct, policy }
// exposures (optional) = { market, sector, size, vol } from the factor model, used
// to form the factor-residual forward return.
function orbitLabels(candles, signalDate, opts = {}) {
  const side = opts.side === 'short' ? 'short' : 'long';
  const tier = opts.tier || 'liquid';
  const severePct = opts.severeLossPct != null ? opts.severeLossPct : DEFAULT_SEVERE_LOSS_PCT;
  const costPct = roundTripCostPct(tier);

  const fill = planFill(candles, signalDate, {
    policy: opts.policy || POLICIES.NEXT_OPEN_PLUS_SLIPPAGE,
    side, tier, slippagePct: opts.slippagePct,
  });

  const base = {
    version: LABELS_VERSION, executionVersion: EXECUTION_POLICY_VERSION, costVersion: COST_MODEL_VERSION,
    signalDate, side, tier, costPct,
    fill: { filled: fill.filled, fillPrice: fill.fillPrice, fillDate: fill.earliestFillDate, fillIdx: fill.fillIdx, reason: fill.fillReason, policy: fill.policy },
  };
  if (!fill.filled || fill.fillPrice == null) {
    return { ...base, resolvable: false, reason: fill.fillReason || 'no-fill', horizons: null };
  }

  const entry = fill.fillPrice;
  const fillIdx = fill.fillIdx;
  const fillDate = fill.earliestFillDate;
  const atrPct = opts.atrPct;

  // Benchmarks for market/sector-relative & residual forward returns.
  const mMap = closeMap(opts.marketCandles), sMap = closeMap(opts.sectorCandles);
  const mDates = opts.marketCandles ? opts.marketCandles.map(c => c.date) : [];
  const sDates = opts.sectorCandles ? opts.sectorCandles.map(c => c.date) : [];
  const exp = opts.exposures || null;

  const horizons = {};
  for (const [key, hDays] of Object.entries(HORIZONS)) {
    const b = barriersFor(hDays, atrPct);
    const target = entry * (1 + b.up), stop = entry * (1 - b.down);
    const r = resolveTrade(candles, fillDate, entry, stop, target, hDays, side === 'short');

    if (r.outcome === 'OPEN') {
      horizons[key] = { resolved: false, reason: 'insufficient-forward-bars', upBarrier: +b.up.toFixed(4), downBarrier: +b.down.toFixed(4) };
      continue;
    }
    const barrier = r.outcome === 'WIN' ? 'upper' : r.outcome === 'LOSS' ? 'lower' : 'timeout';
    const grossReturn = +(r.r).toFixed(4);                 // realized fraction at the level
    const net = netReturn(grossReturn * 100, tier);        // percent, cost-adjusted
    const netFrac = net == null ? null : +(net / 100).toFixed(4);
    const exitDate = r.exitDate;
    const mktFwd = benchReturn(mMap, mDates, fillDate, exitDate);
    const secFwd = benchReturn(sMap, sDates, fillDate, exitDate);
    const marketRel = mktFwd == null ? null : +(grossReturn - mktFwd).toFixed(4);
    const sectorRel = secFwd == null ? null : +(grossReturn - secFwd).toFixed(4);
    // Factor-residual forward return = stock fwd − Σ β_k · factor_k fwd (market+sector legs
    // where betas & benchmark forwards are available). Honest null when inputs missing.
    let residual = null;
    if (exp && mktFwd != null) {
      let pred = (exp.market || 0) * mktFwd;
      if (secFwd != null && exp.sector != null) pred += exp.sector * secFwd;
      residual = +(grossReturn - pred).toFixed(4);
    }
    const { mfe, mae } = excursions(candles, fillIdx, exitDate, entry);

    horizons[key] = {
      resolved: true,
      barrier, outcome: r.outcome, holdDays: r.hold, exitDate,
      grossReturn, netReturn: netFrac,
      marketRelReturn: marketRel, sectorRelReturn: sectorRel, residualReturn: residual,
      positiveRaw: netFrac == null ? null : (netFrac > 0 ? 1 : 0),
      positiveResidual: residual == null ? null : (residual > 0 ? 1 : 0),
      mfe, mae,
      severeLoss: netFrac == null ? null : (netFrac <= -severePct ? 1 : 0),
      upBarrier: +b.up.toFixed(4), downBarrier: +b.down.toFixed(4),
    };
  }

  const anyResolved = Object.values(horizons).some(h => h.resolved);
  return { ...base, resolvable: anyResolved, horizons };
}

module.exports = { LABELS_VERSION, HORIZONS, DEFAULT_SEVERE_LOSS_PCT, barriersFor, orbitLabels };
