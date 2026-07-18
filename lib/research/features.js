'use strict';
// CONTINUOUS RESEARCH FEATURE VECTOR (research-features-v1)
//
// ONE pure function, `computeFeatureVector`, computes the continuous feature vector from a candle
// series at a given bar index. Training, backtesting, and serving ALL call this same function on
// the same inputs, so train/serve parity holds by construction (there is no second, drifting
// implementation to skew against). See test/research-features.test.js for the frozen-fixture
// parity proof.
//
// Every feature is computed ONLY from bars at-or-before `idx` (point-in-time correct — a feature
// at bar T never reads bar T+1). Unavailable features are returned as null AND listed in
// `missing`; nothing is fabricated. Values are volatility-/benchmark-relative where that removes
// generic market/size exposure, so a ranker built on them isolates incremental information.

const FEATURE_VERSION = 'research-features-v1';

// Feature keys, declared once so the manifest and the ranker agree on order/identity.
const FEATURE_KEYS = Object.freeze([
  'ret5', 'ret21', 'ret63',       // trailing simple returns
  'residMom21',                    // ret21 minus benchmark ret21 (market-residual momentum)
  'trendSlope21',                  // OLS slope of log-price over 21 bars, in %/bar
  'distSma50Atr',                  // (close - SMA50) / ATR14  (distance from trend in vol units)
  'volSurprise',                   // (vol - rollMedian) / rollMAD over 21 bars (robust)
  'realizedVol21',                 // stdev of daily returns over 21 bars
  'drawdown63',                    // close / max(high,63) - 1  (depth below recent peak)
]);

const isFin = (v) => Number.isFinite(v);
const pctRet = (a, b) => (isFin(a) && isFin(b) && b > 0 ? a / b - 1 : null);

function median(xs) {
  const s = xs.filter(isFin).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(xs, med) {
  const dev = xs.filter(isFin).map((x) => Math.abs(x - med));
  return median(dev);
}
// OLS slope of y over x=0..n-1, returned per-bar.
function olsSlope(ys) {
  const n = ys.length;
  if (n < 2) return null;
  const mx = (n - 1) / 2;
  let my = 0; for (const y of ys) my += y; my /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = i - mx; num += dx * (ys[i] - my); den += dx * dx; }
  return den === 0 ? null : num / den;
}
function atr14(candles, idx) {
  if (idx < 14) return null;
  let sum = 0;
  for (let i = idx - 13; i <= idx; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!c || !p) return null;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (!isFin(tr)) return null;
    sum += tr;
  }
  return sum / 14;
}

// Compute the feature vector at bar `idx` of `candles` (oldest→newest).
//   opts.benchCloses : optional { date -> close } benchmark map (e.g. SPY) for residual momentum.
// Returns { values: {key->number|null}, missing: [key...], decisionTs, dataCutoffTs }.
function computeFeatureVector(candles, idx, opts = {}) {
  const values = {};
  const missing = [];
  const set = (k, v) => { if (isFin(v)) values[k] = +v.toFixed(6); else { values[k] = null; missing.push(k); } };

  const c = candles && candles[idx];
  if (!c) {
    for (const k of FEATURE_KEYS) { values[k] = null; missing.push(k); }
    return { version: FEATURE_VERSION, values, missing, decisionTs: null, dataCutoffTs: null };
  }
  const closeAt = (i) => (candles[i] && isFin(candles[i].close) ? candles[i].close : null);

  set('ret5', pctRet(c.close, closeAt(idx - 5)));
  set('ret21', pctRet(c.close, closeAt(idx - 21)));
  set('ret63', pctRet(c.close, closeAt(idx - 63)));

  // Market-residual 21-day momentum: strip the benchmark's move over the SAME window.
  const r21 = pctRet(c.close, closeAt(idx - 21));
  const bench = opts.benchCloses || null;
  let residMom = null;
  if (bench && r21 != null) {
    const bNow = bench[c.date];
    const prevBar = candles[idx - 21];
    const bPrev = prevBar ? bench[prevBar.date] : null;
    const bR = pctRet(bNow, bPrev);
    if (bR != null) residMom = r21 - bR;
  }
  if (residMom == null) missing.push('residMom21'), (values.residMom21 = null); else set('residMom21', residMom);

  // Trend slope of log price over 21 bars (%/bar).
  const logs = [];
  for (let i = idx - 20; i <= idx; i++) { const cl = closeAt(i); logs.push(cl != null && cl > 0 ? Math.log(cl) : NaN); }
  set('trendSlope21', logs.every(isFin) ? olsSlope(logs) * 100 : null);

  // Distance from SMA50 in ATR units.
  let sma50 = null;
  if (idx >= 49) { let s = 0, ok = true; for (let i = idx - 49; i <= idx; i++) { const cl = closeAt(i); if (cl == null) { ok = false; break; } s += cl; } sma50 = ok ? s / 50 : null; }
  const atr = atr14(candles, idx);
  set('distSma50Atr', (sma50 != null && atr && atr > 0) ? (c.close - sma50) / atr : null);

  // Robust volume surprise over 21 bars (median/MAD).
  const vols = [];
  for (let i = idx - 20; i <= idx; i++) { const v = candles[i] && candles[i].volume; vols.push(isFin(v) ? v : NaN); }
  const vClean = vols.filter(isFin);
  if (vClean.length >= 10 && isFin(c.volume)) {
    const med = median(vClean), m = mad(vClean, med);
    set('volSurprise', m && m > 0 ? (c.volume - med) / (1.4826 * m) : null);
  } else { values.volSurprise = null; missing.push('volSurprise'); }

  // Realized vol (stdev of daily returns) over 21 bars.
  const rets = [];
  for (let i = idx - 20; i <= idx; i++) { const r = pctRet(closeAt(i), closeAt(i - 1)); if (r != null) rets.push(r); }
  if (rets.length >= 10) { const mr = rets.reduce((a, b) => a + b, 0) / rets.length; const varr = rets.reduce((a, b) => a + (b - mr) ** 2, 0) / rets.length; set('realizedVol21', Math.sqrt(varr)); }
  else { values.realizedVol21 = null; missing.push('realizedVol21'); }

  // Drawdown vs 63-bar high.
  let hi = -Infinity;
  for (let i = Math.max(0, idx - 62); i <= idx; i++) { const h = candles[i] && candles[i].high; if (isFin(h)) hi = Math.max(hi, h); }
  set('drawdown63', hi > 0 && isFin(hi) ? c.close / hi - 1 : null);

  return { version: FEATURE_VERSION, values, missing: [...new Set(missing)], decisionTs: c.date, dataCutoffTs: c.date };
}

module.exports = { FEATURE_VERSION, FEATURE_KEYS, computeFeatureVector };
