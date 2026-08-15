'use strict';
// DAILY MARK-TO-MARKET NAV LEDGER — the portfolio-truth layer for a logged signal
// ledger (Core Momentum first; the machinery is sleeve-agnostic).
//
// WHY THIS EXISTS. The Core Performance headline used to compound per-quarter
// averages of RESOLVED trades only ("since inception (realized)"). While positions
// remain open, that number is not a portfolio return: early stop-outs resolve first,
// so the resolved-only compound systematically reflects a different book than the one
// actually held. This module computes the real thing — a daily NAV that carries cash,
// every open position marked at that day's close, every resolved position realized at
// its recorded exit, and explicit per-side costs — and FAILS CLOSED when a required
// mark is missing (the series truncates at the last fully-covered date and the exact
// gap is reported; a missing mark can never be silently dropped from the return).
//
// Accounting identities (asserted in reconciliation, tested in nav-ledger.test.js):
//   NAV(d)          = cash(d) + Σ_open shares_i × close_i(d)
//   NAV(end)−NAV(0) = Σ realized P&L + Σ unrealized P&L − Σ costs paid
//
// Raw historical records are never modified: signals and resolved outcomes are read
// as-is; exits realize at the price the outcome resolver recorded (entry×(1+r)).

const START_NAV = 1;
// Entry-day close vs logged entry price beyond this ratio ⇒ almost certainly a
// split/corporate-action basis mismatch between the ledger and the (adjusted)
// candle feed. The position cannot be honestly marked → fail closed for it.
const CORP_ACTION_RATIO = 2;

/** Trading-date axis: benchmark dates when present (one calendar for everyone),
 *  else the union of position-history dates. Restricted to >= firstDate. */
function buildAxis(histories, bench, firstDate) {
  const set = new Set();
  if (Array.isArray(bench) && bench.length) for (const c of bench) { if (c && c.date >= firstDate) set.add(c.date); }
  else for (const t in histories) for (const c of histories[t] || []) { if (c && c.date >= firstDate) set.add(c.date); }
  return [...set].sort();
}

function closeMap(candles) {
  const m = {};
  for (const c of candles || []) if (c && c.date && Number.isFinite(c.close) && c.close > 0) m[c.date] = c.close;
  return m;
}

/**
 * Build the daily NAV ledger.
 *  signals   — ledger rows [{ ticker, date, entry, weight?, quarter? }]
 *  resolved  — { "ticker|date": { outcome, r, exitDate } } (OPEN/absent ⇒ still held)
 *  histories — { ticker: [{date, close}, …] } daily candles per ticker
 *  opts      — { perSidePct  : cost per side in PERCENT of trade value (e.g. 0.35),
 *               bench       : benchmark candles [{date, close}] or null }
 * Returns { available, complete, throughDate, curve, totals, coverage, reconciliation, basis }.
 */
function buildNavLedger(signals, resolved, histories, opts) {
  resolved = resolved || {}; histories = histories || {}; opts = opts || {};
  const perSide = Number.isFinite(opts.perSidePct) ? opts.perSidePct / 100 : 0;
  const rows = (signals || []).filter(s => s && s.ticker && s.date && Number.isFinite(s.entry) && s.entry > 0);
  if (!rows.length) return { available: false, reason: 'no valid signals (need ticker, date, entry > 0)', coverage: { positions: 0, gaps: [] } };

  const firstDate = rows.reduce((m, s) => (s.date < m ? s.date : m), rows[0].date);
  const axis = buildAxis(histories, opts.bench, firstDate);
  if (axis.length < 2) return { available: false, reason: 'no trading axis (no benchmark or position history covers the signal dates)', coverage: { positions: rows.length, gaps: [] } };

  // Position table. Exit price is reconstructed from the resolver's recorded return —
  // the ledger realizes exactly what the outcome record says, never a re-derived barrier.
  const positions = rows.map(s => {
    const o = resolved[`${s.ticker}|${s.date}`];
    const isClosed = !!(o && o.outcome && o.outcome !== 'OPEN');
    return {
      key: `${s.ticker}|${s.date}`, ticker: s.ticker, signalDate: s.date,
      weight: Number.isFinite(s.weight) && s.weight > 0 ? s.weight : null,
      entryPrice: s.entry, closed: isClosed,
      exitDate: isClosed ? (o.exitDate || null) : null,
      exitPrice: isClosed ? s.entry * (1 + (o.r || 0)) : null,
      cm: closeMap(histories[s.ticker]),
      shares: 0, entered: false, exited: false,
    };
  });
  // Closed outcomes missing an exitDate cannot be placed on the axis → fail closed for them.
  const gaps = [];
  for (const p of positions) if (p.closed && !p.exitDate) { gaps.push({ ticker: p.ticker, signalDate: p.signalDate, missingOn: null, why: 'resolved outcome has no exitDate — cannot be placed on the daily axis' }); }
  if (gaps.length) return { available: false, reason: `${gaps.length} resolved position(s) carry no exitDate`, coverage: { positions: positions.length, gaps } };

  // Default weight: equal-weight within each signal-date cohort when the ledger row has none.
  const cohortN = {};
  for (const p of positions) cohortN[p.signalDate] = (cohortN[p.signalDate] || 0) + 1;
  for (const p of positions) if (p.weight == null) p.weight = 1 / cohortN[p.signalDate];

  let cash = START_NAV, costPaid = 0, realizedPnl = 0;
  const curve = [];
  let benchShares = null;
  const benchCm = closeMap(opts.bench);
  let truncated = null;   // { date, gaps: [...] } — first day a required mark was missing

  for (const D of axis) {
    // 1. exits first (an exit and a same-day entry both settle through cash)
    for (const p of positions) {
      if (p.entered && !p.exited && p.closed && p.exitDate <= D) {
        const proceeds = p.shares * p.exitPrice;
        const fee = proceeds * perSide;
        cash += proceeds - fee; costPaid += fee;
        realizedPnl += p.shares * (p.exitPrice - p.entryPrice);
        p.exited = true;
      }
    }
    // 2. entries: invest weight × current NAV-so-far at the logged entry price.
    //    Cash-capped: if the cohort asks for more than available cash, scale down pro-rata.
    const entering = positions.filter(p => !p.entered && p.signalDate <= D);
    if (entering.length) {
      const navNow = cash + positions.reduce((a, p) => (p.entered && !p.exited && p.cm[D] ? a + p.shares * p.cm[D] : a), 0);
      const want = entering.reduce((a, p) => a + p.weight * navNow, 0);
      const scale = want > cash && want > 0 ? cash / want : 1;
      for (const p of entering) {
        // Corporate-action guard: entry price wildly off the adjusted close series ⇒ unmarkable.
        const c0 = p.cm[D];
        if (c0 && (p.entryPrice / c0 > CORP_ACTION_RATIO || c0 / p.entryPrice > CORP_ACTION_RATIO)) {
          if (!truncated) truncated = { date: D, gaps: [] };
          truncated.gaps.push({ ticker: p.ticker, signalDate: p.signalDate, missingOn: D, why: `entry ${p.entryPrice} vs adjusted close ${c0} — corporate-action basis mismatch, position cannot be honestly marked` });
          continue;
        }
        const spend = p.weight * navNow * scale;
        const fee = spend * perSide;
        p.shares = (spend - fee) / p.entryPrice;
        cash -= spend; costPaid += fee;
        p.entered = true;
      }
      if (truncated) break;   // fail closed at the first unmarkable entry
    }
    // 3. mark every held position at today's close — a missing mark ends the series HERE.
    const held = positions.filter(p => p.entered && !p.exited);
    const missing = held.filter(p => !p.cm[D]);
    if (missing.length) {
      truncated = { date: D, gaps: missing.map(p => ({ ticker: p.ticker, signalDate: p.signalDate, missingOn: D, why: 'no close available to mark the open position' })) };
      break;
    }
    const invested = held.reduce((a, p) => a + p.shares * p.cm[D], 0);
    const nav = cash + invested;
    if (benchShares == null && benchCm[D]) benchShares = START_NAV / benchCm[D];
    // curve values are rounded for serving; exact values are kept on the row for the
    // reconciliation below (rounding must never register as an accounting error).
    curve.push({
      date: D, nav: +nav.toFixed(6), cash: +cash.toFixed(6), invested: +invested.toFixed(6),
      positions: held.length, bench: benchShares != null && benchCm[D] ? +(benchShares * benchCm[D]).toFixed(6) : null,
      _navExact: nav, _benchExact: benchShares != null && benchCm[D] ? benchShares * benchCm[D] : null,
    });
  }

  if (!curve.length) {
    return { available: false, reason: 'no fully-covered day: the first required mark is already missing', coverage: { positions: positions.length, gaps: truncated ? truncated.gaps : [] } };
  }

  const last = curve[curve.length - 1];
  const lastNav = last._navExact, lastBench = last._benchExact;
  let peak = -Infinity, mdd = 0;
  for (const c of curve) { peak = Math.max(peak, c._navExact); mdd = Math.min(mdd, (c._navExact - peak) / peak); }
  // Open positions owe an exit-side fee that has not been paid yet; report the accrual
  // explicitly instead of hiding it inside the marks.
  const pendingExitCost = positions.filter(p => p.entered && !p.exited).reduce((a, p) => a + p.shares * (p.cm[last.date] || 0) * perSide, 0);
  // Identity check: ΔNAV must equal realized + unrealized P&L − costs paid.
  const unrealized = positions.filter(p => p.entered && !p.exited).reduce((a, p) => a + p.shares * ((p.cm[last.date] || 0) - p.entryPrice), 0);
  const reconError = Math.abs((lastNav - START_NAV) - (realizedPnl + unrealized - costPaid));
  for (const c of curve) { delete c._navExact; delete c._benchExact; }

  return {
    available: true,
    complete: !truncated,
    throughDate: last.date,
    curve,
    totals: {
      navReturn: +(lastNav / START_NAV - 1).toFixed(6),
      navReturnNetPendingExit: +((lastNav - pendingExitCost) / START_NAV - 1).toFixed(6),
      benchReturn: lastBench != null ? +(lastBench / START_NAV - 1).toFixed(6) : null,
      excess: lastBench != null ? +((lastNav - lastBench) / START_NAV).toFixed(6) : null,
      maxDrawdown: +mdd.toFixed(6),
      costPaid: +costPaid.toFixed(6),
      pendingExitCost: +pendingExitCost.toFixed(6),
      openPositions: positions.filter(p => p.entered && !p.exited).length,
      closedPositions: positions.filter(p => p.exited).length,
    },
    coverage: {
      positions: positions.length,
      entered: positions.filter(p => p.entered).length,
      gaps: truncated ? truncated.gaps : [],
    },
    reconciliation: { maxAbsError: +reconError.toExponential(2), identity: 'ΔNAV = realized + unrealized − costsPaid', holds: reconError < 1e-9 },
    basis: 'daily close marks; entries at logged reference price (basis disclosed by the route); exits at the outcome-recorded price; one per-side cost each leg; open positions carry an unpaid exit-cost accrual reported separately',
  };
}

module.exports = { buildNavLedger, START_NAV, CORP_ACTION_RATIO };
