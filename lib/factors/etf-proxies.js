'use strict';
// STYLE-ETF FACTOR PROXIES + FRENCH PSEUDO-CANDLES.
//
// French daily factors lag ~1 month, so a pick's live 1–20 session window has no FF row
// yet. Tradeable ETF spreads stand in for them over exactly the window the Scoreboard
// grades the pick on:
//   mkt = SPY · size = IWM−SPY · value = IWD−IWF · mom = MTUM−SPY · quality = QUAL−SPY
// (no tradeable CMA proxy exists; the FF fit carries CMA, the proxy fit does not).
//
// WINDOW RULER. `factorWindowReturn` reproduces lib/apex-routes spyForwardReturn EXACTLY
// (same anchoring, same entry bases) with a binary search instead of a linear scan — the
// factor regression must be measured on the ruler the excess it adjusts is measured on.
// test/etf-proxies.test.js pins parity against spyForwardReturn on every basis.
//
// French factors become candles by compounding the daily percent into an index, with
// `open` = the prior close, so a next-open window starts at the trigger-day close (the
// closest a close-only series can get to an open; the overnight gap rides in the factor).
const PROXY_FACTORS = Object.freeze({
  mkt: Object.freeze({ long: 'SPY', short: null }),
  size: Object.freeze({ long: 'IWM', short: 'SPY' }),
  value: Object.freeze({ long: 'IWD', short: 'IWF' }),
  mom: Object.freeze({ long: 'MTUM', short: 'SPY' }),
  quality: Object.freeze({ long: 'QUAL', short: 'SPY' }),
});
const PROXY_KEYS = Object.freeze(Object.keys(PROXY_FACTORS));
const PROXY_TICKERS = Object.freeze([...new Set(Object.values(PROXY_FACTORS).flatMap(f => [f.long, f.short]).filter(Boolean))]);
const FF_KEYS = Object.freeze(['mktRf', 'smb', 'hml', 'rmw', 'cma', 'mom']);
const PROXY_TO_FF = Object.freeze({ mkt: 'mktRf', size: 'smb', value: 'hml', mom: 'mom', quality: 'rmw' });
const INDEX_BASE = 100;
const PCT = 100;

// Index of the last candle whose date ≤ `date`, or -1. Binary search on the sorted axis.
function lastIndexAtOrBefore(candles, date) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const openOrClose = (bar) => ((bar.open != null && bar.open > 0) ? bar.open : bar.close);

// Forward return (%) of a series over the pick's graded window. Semantics identical to
// apex-routes.spyForwardReturn — see the module comment.
function factorWindowReturn(candles, pick, bars, opts = {}) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const idx = lastIndexAtOrBefore(candles, pick.date);
  if (idx < 0) return null;
  const tgt = idx + bars;
  if (tgt >= candles.length) return null;
  let start;
  if (opts.entryBasis === 'next-open') {
    const eBar = candles[idx + 1];
    if (!eBar) return null;
    start = openOrClose(eBar);
  } else if (opts.entryBasis === 'trigger-verified') {
    if (!opts.anchorDate) return null;
    const aIdx = lastIndexAtOrBefore(candles, opts.anchorDate);
    if (aIdx < 0) return null;
    const aBar = candles[aIdx];
    start = (opts.anchorAtOpen && aBar.open != null && aBar.open > 0) ? aBar.open : aBar.close;
  } else {
    start = candles[idx].close;
  }
  if (!start) return null;
  return ((candles[tgt].close - start) / start) * PCT;
}

function legReturn(hist, ticker, pick, bars, opts) {
  if (!ticker) return 0;
  const r = factorWindowReturn(hist.get(ticker), pick, bars, opts);
  return Number.isFinite(r) ? r : null;
}

// { mkt, size, value, mom, quality } in percent over the pick's window; a factor whose leg
// history is missing is null (the fitter drops rows with a null factor).
function proxyFactorReturns(hist, pick, bars, opts = {}) {
  const out = {};
  for (const k of PROXY_KEYS) {
    const { long, short } = PROXY_FACTORS[k];
    const a = legReturn(hist, long, pick, bars, opts), b = legReturn(hist, short, pick, bars, opts);
    out[k] = (a == null || b == null) ? null : a - b;
  }
  return out;
}

// Compound one French factor column into pseudo-candles. A null day is SKIPPED (the chain
// resumes from the last index) rather than zero-filled.
function ffPseudoCandles(doc, key) {
  const col = doc.factors.indexOf(key);
  if (col < 0) return [];
  let index = INDEX_BASE;
  const out = [];
  for (const row of doc.rows) {
    const v = row[col + 1];
    if (v == null || !Number.isFinite(v)) continue;
    const prev = index;
    index = prev * (1 + v / PCT);
    out.push({ date: row[0], open: prev, close: index });
  }
  return out;
}

function ffCandlesByKey(doc) {
  return Object.fromEntries([...FF_KEYS, 'rf'].map(k => [k, ffPseudoCandles(doc, k)]));
}

// { mktRf, smb, hml, rmw, cma, mom, rf } over the window, or null when the window runs past
// the published French data (the normal case for the newest month).
function ffFactorReturns(ffCandles, pick, bars, opts = {}) {
  if (!ffCandles) return null;
  const out = {};
  for (const k of [...FF_KEYS, 'rf']) {
    const r = factorWindowReturn(ffCandles[k], pick, bars, opts);
    if (!Number.isFinite(r)) return null;
    out[k] = r;
  }
  return out;
}

// Both vectors for one pick×horizon. Attached to each graded row as `r.fx`.
function factorWindowReturns({ proxyHist, ffCandles, pick, bars, benchOpts }) {
  const proxy = proxyHist && proxyHist.size ? proxyFactorReturns(proxyHist, pick, bars, benchOpts) : null;
  const anyProxy = proxy && PROXY_KEYS.some(k => Number.isFinite(proxy[k]));
  return { proxy: anyProxy ? proxy : null, ff: ffFactorReturns(ffCandles, pick, bars, benchOpts) };
}

module.exports = {
  PROXY_FACTORS, PROXY_KEYS, PROXY_TICKERS, FF_KEYS, PROXY_TO_FF,
  lastIndexAtOrBefore, factorWindowReturn, proxyFactorReturns, ffPseudoCandles, ffCandlesByKey, ffFactorReturns, factorWindowReturns,
};
