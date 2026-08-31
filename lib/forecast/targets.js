'use strict';
// TARGET CONSTRUCTION & NEUTRALIZATION (forecast-target-v1)
//
// THE PRIMARY TARGET IS A RESIDUAL RETURN, NOT A PRICE.
//
// Default definition `residual-mkt-sector-v1`, with every beta estimated from TRAILING data
// available at the decision date t only, and orthogonalized so market exposure is not charged
// twice (once through the market term and again through the sector's own market beta):
//
//     b_m(i,t)  = OLS slope of r_i on r_m          over the trailing window ending at t
//     b_sm(s,t) = OLS slope of r_s on r_m          (the sector proxy's own market beta)
//     e_s       = r_s - b_sm * r_m                 the sector's market-residual series, ⊥ r_m
//     b_s(i,t)  = OLS slope of (r_i - b_m*r_m) on e_s
//
//     fwd_resid(i,t,h) = fwd_i - b_m*fwd_m - b_s*(fwd_s - b_sm*fwd_m)
//
// Because e_s is orthogonal to r_m by construction, this sequential fit reproduces the
// two-factor multivariate OLS while making the no-double-counting property visible.
//
// EXECUTION CONVENTION (shared with the whole repo — lib/execution-policy.js NEXT_OPEN):
//   decision session t (features from bars <= t's close)
//   entry fill  = OPEN of session t+1        -> labelStart
//   exit        = CLOSE of session t+h       -> labelEnd
// h = 1 therefore means "buy tomorrow's open, sell tomorrow's close".
//
// Every beta is shrunk toward its economic prior (market 1.0, sector 0.0) and clamped, because
// a 60-observation OLS slope on a thin name is mostly noise and an unclamped beta manufactures
// residual return out of estimation error.
//
// Pure: candles in, labels out. No clock, no network, no store.

const TARGET_VERSION = 'forecast-target-v1';

const DEFINITIONS = Object.freeze([
  'residual-mkt-sector-v1',   // default: market + orthogonalized sector residual
  'beta-market-residual-v1',  // fwd - b_m * fwd_m
  'market-relative-v1',       // fwd - fwd_m           (beta implicitly 1)
  'sector-relative-v1',       // fwd - fwd_s           (beta implicitly 1)
  'raw-v1',                   // fwd (no neutralization) — diagnostic only
]);

const UNOBSERVABLE = Object.freeze({
  NO_DECISION_BAR: 'no-decision-bar',
  NO_ENTRY_BAR: 'no-entry-bar',
  TRUNCATED_HISTORY: 'truncated-history',
  BAD_PRICES: 'bad-prices',
  EXTREME_MOVE: 'suspected-unadjusted-corporate-action',
  NO_BENCHMARK: 'benchmark-window-unavailable',
  NO_SECTOR: 'sector-proxy-unavailable',
  INSUFFICIENT_BETA_OBS: 'insufficient-observations-for-beta',
});

const isFin = Number.isFinite;

/** Daily close-to-close simple returns for bars (from, to] — trailing only. */
function trailingReturns(candles, endIdx, lookback) {
  const out = [];
  const start = Math.max(1, endIdx - lookback + 1);
  for (let i = start; i <= endIdx; i++) {
    const a = candles[i - 1], b = candles[i];
    if (a && b && a.close > 0 && isFin(b.close)) out.push({ date: b.date, r: b.close / a.close - 1 });
  }
  return out;
}

/** OLS slope of y on x through the means. Returns null when x has no variance. */
function olsSlope(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; num += dx * (ys[i] - my); den += dx * dx; }
  return den > 0 ? num / den : null;
}

/** Align two dated return series on their common dates, newest-last. */
function alignDated(a, b) {
  const m = new Map(b.map((p) => [p.date, p.r]));
  const xs = [], ys = [], dates = [];
  for (const p of a) { const q = m.get(p.date); if (q !== undefined) { ys.push(p.r); xs.push(q); dates.push(p.date); } }
  return { xs, ys, dates };
}

const shrinkClamp = (b, prior, shrink, [lo, hi]) => {
  if (!isFin(b)) return null;
  const s = (1 - shrink) * b + shrink * prior;
  return Math.max(lo, Math.min(hi, s));
};

/**
 * Trailing betas for one name at decision date t.
 * `nameCandles`/`benchCandles`/`sectorCandles` are ascending series; the *Idx arguments are the
 * bar index at-or-before t in each. Returns { betaMarket, betaSector, betaSectorMarket, obs }.
 */
function trailingBetas(nameCandles, nameIdx, benchCandles, benchIdx, sectorCandles, sectorIdx, cfg) {
  const t = cfg.target;
  const rn = trailingReturns(nameCandles, nameIdx, t.betaLookback);
  const rm = trailingReturns(benchCandles, benchIdx, t.betaLookback);
  const nm = alignDated(rn, rm);
  if (nm.xs.length < t.betaMinObs) {
    return { betaMarket: null, betaSector: null, betaSectorMarket: null, obs: nm.xs.length, reason: UNOBSERVABLE.INSUFFICIENT_BETA_OBS };
  }
  const betaMarketRaw = olsSlope(nm.xs, nm.ys);
  const betaMarket = shrinkClamp(betaMarketRaw, 1, t.betaShrink, t.betaClamp.market);

  let betaSector = null, betaSectorMarket = null, sectorObs = 0;
  if (sectorCandles && sectorIdx >= 0) {
    const rs = trailingReturns(sectorCandles, sectorIdx, t.betaLookback);
    const sm = alignDated(rs, rm);
    if (sm.xs.length >= t.betaMinObs) {
      betaSectorMarket = olsSlope(sm.xs, sm.ys);           // sector proxy's own market beta — NOT shrunk (it is an index, well estimated)
      if (isFin(betaSectorMarket)) {
        // Sector residual series e_s, then regress the name's market-residual on it.
        const eMap = new Map(sm.dates.map((d, i) => [d, sm.ys[i] - betaSectorMarket * sm.xs[i]]));
        const xs = [], ys = [];
        for (let i = 0; i < nm.dates.length; i++) {
          const e = eMap.get(nm.dates[i]);
          if (e !== undefined) { xs.push(e); ys.push(nm.ys[i] - betaMarket * nm.xs[i]); }
        }
        sectorObs = xs.length;
        if (sectorObs >= t.betaMinObs) betaSector = shrinkClamp(olsSlope(xs, ys), 0, t.betaShrink, t.betaClamp.sector);
      }
    }
  }
  return { betaMarket, betaMarketRaw: isFin(betaMarketRaw) ? betaMarketRaw : null, betaSector, betaSectorMarket: isFin(betaSectorMarket) ? betaSectorMarket : null, obs: nm.xs.length, sectorObs, reason: null };
}

/**
 * Forward window from the next-open fill.
 * Returns { ret, labelStart, labelEnd, maxDrawdown, realizedVol, reason }.
 * `reason` non-null means UNOBSERVABLE — the caller must drop the row, never coerce it to 0.
 */
function forwardWindow(candles, idx, h, { extremeOneDayMove = 0.5 } = {}) {
  if (idx < 0) return { reason: UNOBSERVABLE.NO_DECISION_BAR };
  const entryIdx = idx + 1, exitIdx = idx + h;
  if (exitIdx > candles.length - 1) return { reason: UNOBSERVABLE.TRUNCATED_HISTORY };
  const entry = candles[entryIdx], exit = candles[exitIdx];
  if (!entry || !(entry.open > 0)) return { reason: UNOBSERVABLE.NO_ENTRY_BAR };
  if (!exit || !(exit.close > 0)) return { reason: UNOBSERVABLE.BAD_PRICES };

  // An unadjusted split inside the window would fabricate the label; refuse it.
  for (let k = idx; k < exitIdx; k++) {
    const a = candles[k], b = candles[k + 1];
    if (a && b && a.close > 0 && b.close > 0 && Math.abs(b.close / a.close - 1) > extremeOneDayMove) {
      return { reason: UNOBSERVABLE.EXTREME_MOVE };
    }
  }

  const fill = entry.open;
  // True peak-to-trough drawdown of the held path, starting from the fill.
  //
  // Daily bars do not say whether a session's high came before or after its low, so the running
  // peak includes the CURRENT bar's high before that bar's low is measured against it. That is
  // the conservative reading for a long — it can only widen the measured drawdown — and it means
  // the drawdown label never understates the risk a stop would have seen.
  let peak = fill, maxDd = 0;
  const rets = [];
  for (let k = entryIdx; k <= exitIdx; k++) {
    const c = candles[k];
    if (!c) continue;
    if (isFin(c.high) && c.high > peak) peak = c.high;
    if (isFin(c.low) && peak > 0) maxDd = Math.max(maxDd, (peak - c.low) / peak);
    const prevClose = k === entryIdx ? fill : candles[k - 1].close;
    if (prevClose > 0 && isFin(c.close)) rets.push(c.close / prevClose - 1);
  }
  let realizedVol = null;
  if (rets.length >= 2) {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - m) * (b - m), 0) / (rets.length - 1);
    realizedVol = Math.sqrt(Math.max(0, v)) * Math.sqrt(252);
  }

  return {
    ret: exit.close / fill - 1,
    labelStart: entry.date, labelEnd: exit.date,
    fillPrice: fill, exitPrice: exit.close,
    maxDrawdown: maxDd, realizedVol,
    reason: null,
  };
}

/** Apply one neutralization definition. Returns null when a required leg is missing. */
function neutralize(definition, { fwd, fwdMarket, fwdSector, betaMarket, betaSector, betaSectorMarket }) {
  if (!isFin(fwd)) return null;
  switch (definition) {
    case 'raw-v1':
      return fwd;
    case 'market-relative-v1':
      return isFin(fwdMarket) ? fwd - fwdMarket : null;
    case 'sector-relative-v1':
      return isFin(fwdSector) ? fwd - fwdSector : null;
    case 'beta-market-residual-v1':
      return (isFin(fwdMarket) && isFin(betaMarket)) ? fwd - betaMarket * fwdMarket : null;
    case 'residual-mkt-sector-v1': {
      if (!isFin(fwdMarket) || !isFin(betaMarket)) return null;
      const mktLeg = betaMarket * fwdMarket;
      // No sector leg available → fall back to the market-only residual and SAY SO via the
      // caller's `sectorApplied` flag; never silently pretend the sector was neutralized.
      if (!isFin(fwdSector) || !isFin(betaSector) || !isFin(betaSectorMarket)) return fwd - mktLeg;
      return fwd - mktLeg - betaSector * (fwdSector - betaSectorMarket * fwdMarket);
    }
    default:
      return null;
  }
}

/**
 * Build every label for one (name, decision date) across all configured horizons.
 * Returns { labels: { h -> label|null }, betas, unobservable: { h -> reason } }.
 */
function buildLabels({ panel, ticker, date, cfg }) {
  const entry = panel.dataset.get(ticker);
  const out = { labels: {}, betas: null, unobservable: {}, sectorApplied: false, sectorEtf: null };
  if (!entry) { for (const h of cfg.horizons) out.unobservable[h] = UNOBSERVABLE.NO_DECISION_BAR; return out; }

  const idx = entry.idx.get(date);
  const bIdx = panel.bench.idx.get(date);
  if (idx == null) { for (const h of cfg.horizons) out.unobservable[h] = UNOBSERVABLE.NO_DECISION_BAR; return out; }
  if (bIdx == null) { for (const h of cfg.horizons) out.unobservable[h] = UNOBSERVABLE.NO_BENCHMARK; return out; }

  const etf = panel.sectorEtfOf(ticker);
  const sectorEntry = etf ? panel.sectorSeries.get(etf) : null;
  const sIdx = sectorEntry ? (sectorEntry.idx.get(date) ?? -1) : -1;
  out.sectorEtf = etf;

  const betas = trailingBetas(entry.candles, idx, panel.bench.candles, bIdx, sectorEntry ? sectorEntry.candles : null, sIdx, cfg);
  out.betas = betas;
  if (betas.betaMarket == null) { for (const h of cfg.horizons) out.unobservable[h] = betas.reason || UNOBSERVABLE.INSUFFICIENT_BETA_OBS; return out; }
  out.sectorApplied = betas.betaSector != null && betas.betaSectorMarket != null;

  const opts = { extremeOneDayMove: cfg.universe.extremeOneDayMove };
  for (const h of cfg.horizons) {
    const w = forwardWindow(entry.candles, idx, h, opts);
    if (w.reason) { out.unobservable[h] = w.reason; continue; }
    const wm = forwardWindow(panel.bench.candles, bIdx, h, opts);
    if (wm.reason) { out.unobservable[h] = UNOBSERVABLE.NO_BENCHMARK; continue; }
    const ws = (sectorEntry && sIdx >= 0) ? forwardWindow(sectorEntry.candles, sIdx, h, opts) : { reason: UNOBSERVABLE.NO_SECTOR };

    const residual = neutralize(cfg.target.definition, {
      fwd: w.ret, fwdMarket: wm.ret, fwdSector: ws.reason ? null : ws.ret,
      betaMarket: betas.betaMarket, betaSector: betas.betaSector, betaSectorMarket: betas.betaSectorMarket,
    });
    if (residual == null) { out.unobservable[h] = UNOBSERVABLE.NO_BENCHMARK; continue; }

    out.labels[h] = Object.freeze({
      schema: 'ForecastLabel', version: TARGET_VERSION,
      ticker, decisionDate: date, horizon: h,
      definition: cfg.target.definition,
      benchmark: panel.benchmark, sectorProxy: etf,
      betaMethod: cfg.target.betaMethod, betaLookback: cfg.target.betaLookback,
      betaMarket: betas.betaMarket, betaSector: betas.betaSector, betaSectorMarket: betas.betaSectorMarket,
      sectorApplied: !ws.reason && betas.betaSector != null,
      labelStart: w.labelStart, labelEnd: w.labelEnd,
      rawReturn: w.ret, marketReturn: wm.ret, sectorReturn: ws.reason ? null : ws.ret,
      residualReturn: residual,
      maxDrawdown: w.maxDrawdown, realizedVol: w.realizedVol,
      // Threshold classes. `up{X}` are on the RESIDUAL; `dd` is on the raw held path (a stop is
      // hit by the price, not by the residual).
      classes: Object.freeze({
        ...Object.fromEntries(cfg.returnThresholds.map((th) => [String(th), residual > th ? 1 : 0])),
        drawdown: w.maxDrawdown > cfg.drawdownThreshold ? 1 : 0,
      }),
    });
  }
  return out;
}

/** Class prevalence by horizon and threshold — reported, never hidden. */
function classPrevalence(rows, cfg) {
  const out = {};
  for (const h of cfg.horizons) {
    const hs = rows.filter((r) => r.horizon === h && r.classes);
    const n = hs.length;
    const keys = [...cfg.returnThresholds.map(String), 'drawdown'];
    out[h] = { n, prevalence: Object.fromEntries(keys.map((k) => [k, n ? +(hs.reduce((a, r) => a + (r.classes[k] || 0), 0) / n).toFixed(5) : null])) };
  }
  return out;
}

module.exports = {
  TARGET_VERSION, DEFINITIONS, UNOBSERVABLE,
  trailingReturns, olsSlope, alignDated, trailingBetas, forwardWindow, neutralize,
  buildLabels, classPrevalence,
};
