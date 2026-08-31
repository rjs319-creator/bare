'use strict';
// TRAILING PIT FEATURES (forecast-features-v1)
//
// One pure function computes the per-name feature vector at a decision bar. EVERY value reads
// bars at or before `idx` — a feature at bar T never touches bar T+1 — so training, backtest and
// serving cannot skew (there is no second implementation to drift).
//
// Rules this module enforces rather than trusts:
//   * A feature that cannot be computed is `null` AND named in `missing`. Nothing is imputed
//     here, nothing is back-filled, no window is centered.
//   * No global statistic is used. Cross-sectional transforms (ranks, robust z) happen later,
//     within a single decision date (lib/forecast/xsection.js); train-fitted scaling happens in
//     the model, on training rows only.
//   * Calendar features use only the decision date itself — genuinely known in advance.
//
// This complements lib/research/features.js (the 9-key research vector) rather than replacing
// it: that module keeps its own frozen-fixture parity contract and its consumers are untouched.

const FEATURES_VERSION = 'forecast-features-v1';

// Declared once so the manifest, the model and the importance report agree on order & identity.
const FEATURE_KEYS = Object.freeze([
  // trailing returns
  'ret1', 'ret3', 'ret5', 'ret10', 'ret21', 'ret63', 'ret126',
  'mom121',                 // 12-1 skip-month momentum
  'reversal5',              // -ret5 — short-term reversal, sign-oriented
  'residMom21', 'residMom63',
  'residMomVolAdj21',       // residMom21 / vol21 — a Sharpe-like momentum, not a raw one
  'dist52wHigh',            // close / max(high, 252) - 1 — proximity to the 52-week high
  // volatility & path
  'vol21', 'vol63', 'downsideVol21', 'volOfVol21', 'atrPct14',
  'trendSlope21', 'distSma50Atr', 'distSma200Pct', 'drawdown63', 'rangePct21', 'gap1',
  // volume & liquidity
  'logDollarVol20', 'volSurprise21', 'volTrend21', 'amihud21', 'spreadProxy21',
  // beta / co-movement
  'betaMarket', 'betaSector', 'corrMarket63', 'corrSector63',
  // calendar (known in advance)
  'dowSin', 'dowCos', 'monthSin', 'monthCos', 'turnOfMonth',
  // data quality
  'staleSessions', 'historyLog', 'featureCoverage',
]);

const CONTINUOUS_KEYS = Object.freeze(FEATURE_KEYS.filter((k) => !['dowSin', 'dowCos', 'monthSin', 'monthCos', 'turnOfMonth', 'staleSessions', 'historyLog', 'featureCoverage'].includes(k)));

// DATE-CONSTANT COLUMNS. These take the SAME value for every name on a decision date, so for a
// WITHIN-DATE ranking they carry no ordering information by construction — a linear model just
// shifts the whole cross-section by a constant, and a TREE can split on them to fit date-specific
// means, which is a pure overfitting channel and nothing else.
//
// This is not theoretical: five of the six highest-gain features in the first LightGBM
// meta-ranker were date-constant, its in-sample rank IC was 0.31 against 0.035 on an inner
// held-out block, and its out-of-sample rank IC was reliably NEGATIVE at every horizon.
// `modelFeatureKeys` therefore drops them from the model matrix by default. They stay in the
// feature vector (they are legitimate context for a human reader and for any future
// regime-conditional model) and can be re-enabled with `features.includeDateConstant`.
const DATE_CONSTANT_KEYS = Object.freeze(['dowSin', 'dowCos', 'monthSin', 'monthCos', 'turnOfMonth']);

const isFin = Number.isFinite;
const pctRet = (a, b) => (isFin(a) && isFin(b) && b > 0 ? a / b - 1 : null);

function stdev(xs) {
  const v = xs.filter(isFin);
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1));
}
function median(xs) {
  const s = xs.filter(isFin).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function olsSlope(ys) {
  const n = ys.length;
  if (n < 2) return null;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const dx = i - mx; num += dx * (ys[i] - my); den += dx * dx; }
  return den === 0 ? null : num / den;
}
function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
}
function dailyReturns(candles, idx, n) {
  const out = [];
  for (let i = Math.max(1, idx - n + 1); i <= idx; i++) {
    const a = candles[i - 1], b = candles[i];
    if (a && b && a.close > 0 && isFin(b.close)) out.push({ date: b.date, r: b.close / a.close - 1 });
  }
  return out;
}
function atr(candles, idx, n) {
  if (idx < n) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!c || !p || !isFin(c.high) || !isFin(c.low) || !isFin(p.close)) return null;
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / n;
}

/**
 * Compute the trailing feature vector at bar `idx`.
 *   ctx.benchReturns  dated market returns aligned to the same calendar (for residual momentum)
 *   ctx.sectorReturns dated sector-proxy returns (optional)
 *   ctx.betaMarket / ctx.betaSector  trailing betas from lib/forecast/targets.js
 *   ctx.staleSessions sessions between the decision date and this name's last bar
 * Returns { values, missing, coverage, maxSourceDate }.
 */
function computeFeatures(candles, idx, ctx = {}) {
  const values = Object.create(null);
  const missing = [];
  const set = (k, v) => { if (isFin(v)) values[k] = +v.toFixed(8); else { values[k] = null; missing.push(k); } };

  const c = candles && candles[idx];
  if (!c) {
    for (const k of FEATURE_KEYS) { values[k] = null; missing.push(k); }
    return { version: FEATURES_VERSION, values, missing, coverage: 0, maxSourceDate: null };
  }
  const closeAt = (i) => (candles[i] && isFin(candles[i].close) ? candles[i].close : null);

  // ── trailing returns ─────────────────────────────────────────────────────
  for (const n of [1, 3, 5, 10, 21, 63, 126]) set(`ret${n}`, pctRet(c.close, closeAt(idx - n)));
  set('mom121', pctRet(closeAt(idx - 21), closeAt(idx - 252)));
  set('reversal5', values.ret5 == null ? null : -values.ret5);

  // ── residual momentum: strip beta * market over the SAME window ───────────
  const benchRet = ctx.benchReturns || null;   // Map(date -> r)
  const bm = isFin(ctx.betaMarket) ? ctx.betaMarket : 1;
  const windowMarketReturn = (n) => {
    if (!benchRet) return null;
    let cum = 1, seen = 0;
    for (let i = idx - n + 1; i <= idx; i++) {
      const d = candles[i] && candles[i].date;
      const r = d != null ? benchRet.get(d) : undefined;
      if (r === undefined) continue;
      cum *= 1 + r; seen++;
    }
    return seen >= Math.max(2, Math.floor(n * 0.6)) ? cum - 1 : null;
  };
  for (const n of [21, 63]) {
    const own = pctRet(c.close, closeAt(idx - n));
    const mkt = windowMarketReturn(n);
    set(`residMom${n}`, own != null && mkt != null ? own - bm * mkt : null);
  }

  // ── volatility & path ────────────────────────────────────────────────────
  // (residMomVolAdj21 and dist52wHigh are filled below, once vol21 and the 252-bar high exist.)
  const r21 = dailyReturns(candles, idx, 21).map((p) => p.r);
  const r63 = dailyReturns(candles, idx, 63).map((p) => p.r);
  set('vol21', stdev(r21) != null ? stdev(r21) * Math.sqrt(252) : null);
  set('vol63', stdev(r63) != null ? stdev(r63) * Math.sqrt(252) : null);
  const down = r21.filter((x) => x < 0);
  set('downsideVol21', down.length >= 3 ? Math.sqrt(down.reduce((a, b) => a + b * b, 0) / down.length) * Math.sqrt(252) : null);
  // vol-of-vol: dispersion of 5-day rolling vol inside the 63-day window
  const rollVols = [];
  for (let e = idx; e > idx - 40 && e - 5 >= 0; e -= 5) { const s = stdev(dailyReturns(candles, e, 5).map((p) => p.r)); if (s != null) rollVols.push(s); }
  set('volOfVol21', rollVols.length >= 3 ? stdev(rollVols) : null);

  const a14 = atr(candles, idx, 14);
  set('atrPct14', a14 != null && c.close > 0 ? a14 / c.close : null);

  const logs = [];
  for (let i = Math.max(0, idx - 20); i <= idx; i++) { const cl = closeAt(i); if (cl > 0) logs.push(Math.log(cl)); }
  const slope = logs.length >= 10 ? olsSlope(logs) : null;
  set('trendSlope21', slope);

  let sma50 = 0, n50 = 0;
  for (let i = Math.max(0, idx - 49); i <= idx; i++) { const cl = closeAt(i); if (cl != null) { sma50 += cl; n50++; } }
  set('distSma50Atr', n50 >= 40 && a14 > 0 ? (c.close - sma50 / n50) / a14 : null);
  let sma200 = 0, n200 = 0;
  for (let i = Math.max(0, idx - 199); i <= idx; i++) { const cl = closeAt(i); if (cl != null) { sma200 += cl; n200++; } }
  set('distSma200Pct', n200 >= 150 && sma200 > 0 ? c.close / (sma200 / n200) - 1 : null);

  let peak = -Infinity;
  for (let i = Math.max(0, idx - 62); i <= idx; i++) { const h = candles[i] && candles[i].high; if (isFin(h) && h > peak) peak = h; }
  set('drawdown63', peak > 0 ? c.close / peak - 1 : null);

  // 52-week-high proximity (George & Hwang): a long-documented cross-sectional predictor,
  // DECLARED before the run rather than discovered by searching. Needs a full year of bars —
  // otherwise null, never a shorter-window proxy standing in for it.
  let peak252 = -Infinity, seen252 = 0;
  for (let i = Math.max(0, idx - 251); i <= idx; i++) { const h = candles[i] && candles[i].high; if (isFin(h)) { seen252++; if (h > peak252) peak252 = h; } }
  set('dist52wHigh', seen252 >= 200 && peak252 > 0 ? c.close / peak252 - 1 : null);

  // Volatility-adjusted residual momentum: the same signal per unit of risk. Also pre-declared.
  set('residMomVolAdj21', (isFin(values.residMom21) && isFin(values.vol21) && values.vol21 > 1e-6) ? values.residMom21 / values.vol21 : null);

  const ranges = [];
  for (let i = Math.max(0, idx - 20); i <= idx; i++) { const b = candles[i]; if (b && isFin(b.high) && isFin(b.low) && b.close > 0) ranges.push((b.high - b.low) / b.close); }
  set('rangePct21', ranges.length >= 10 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : null);
  const prev = candles[idx - 1];
  set('gap1', prev && prev.close > 0 && isFin(c.open) ? c.open / prev.close - 1 : null);

  // ── volume & liquidity ───────────────────────────────────────────────────
  const dvs = [];
  for (let i = Math.max(0, idx - 19); i <= idx; i++) { const b = candles[i]; if (b && isFin(b.close) && isFin(b.volume)) dvs.push(b.close * b.volume); }
  const meanDv = dvs.length ? dvs.reduce((a, b) => a + b, 0) / dvs.length : null;
  set('logDollarVol20', meanDv > 0 ? Math.log(meanDv) : null);

  const vols = [];
  for (let i = Math.max(0, idx - 20); i <= idx; i++) { const b = candles[i]; if (b && isFin(b.volume)) vols.push(b.volume); }
  const medV = median(vols);
  const madV = medV != null ? median(vols.map((v) => Math.abs(v - medV))) : null;
  set('volSurprise21', (medV != null && madV > 0 && isFin(c.volume)) ? (c.volume - medV) / (1.4826 * madV) : null);
  const recentV = vols.slice(-5), olderV = vols.slice(0, Math.max(1, vols.length - 5));
  const mr = recentV.length ? recentV.reduce((a, b) => a + b, 0) / recentV.length : null;
  const mo = olderV.length ? olderV.reduce((a, b) => a + b, 0) / olderV.length : null;
  set('volTrend21', (mr != null && mo > 0) ? mr / mo - 1 : null);

  // Amihud illiquidity: mean |daily return| / daily dollar volume, log-scaled for range.
  const amihud = [];
  for (let i = Math.max(1, idx - 20); i <= idx; i++) {
    const a = candles[i - 1], b = candles[i];
    if (a && b && a.close > 0 && isFin(b.close) && isFin(b.volume) && b.close * b.volume > 0) {
      amihud.push(Math.abs(b.close / a.close - 1) / (b.close * b.volume));
    }
  }
  const amMean = amihud.length >= 10 ? amihud.reduce((a, b) => a + b, 0) / amihud.length : null;
  set('amihud21', amMean != null && amMean > 0 ? Math.log(amMean) : null);
  // Corwin-Schultz-style crude spread proxy: mean high-low range is a monotone stand-in for
  // the effective spread this vendor's daily bars can support. NOT a quoted spread.
  set('spreadProxy21', ranges.length >= 10 ? median(ranges) : null);

  // ── beta / co-movement ───────────────────────────────────────────────────
  set('betaMarket', ctx.betaMarket);
  set('betaSector', ctx.betaSector);
  const own63 = dailyReturns(candles, idx, 63);
  const pull = (m) => (m ? own63.map((p) => m.get(p.date)).map((v) => (v === undefined ? NaN : v)) : []);
  const alignedCorr = (m) => {
    if (!m) return null;
    const xs = [], ys = [];
    const other = pull(m);
    for (let i = 0; i < own63.length; i++) if (isFin(other[i])) { xs.push(other[i]); ys.push(own63[i].r); }
    return xs.length >= 20 ? correlation(xs, ys) : null;
  };
  set('corrMarket63', alignedCorr(ctx.benchReturns));
  set('corrSector63', alignedCorr(ctx.sectorReturns));

  // ── calendar (known in advance) ──────────────────────────────────────────
  const dt = new Date(`${c.date}T00:00:00Z`);
  if (!Number.isNaN(dt.getTime())) {
    const dow = dt.getUTCDay(), mon = dt.getUTCMonth();
    set('dowSin', Math.sin((2 * Math.PI * dow) / 7));
    set('dowCos', Math.cos((2 * Math.PI * dow) / 7));
    set('monthSin', Math.sin((2 * Math.PI * mon) / 12));
    set('monthCos', Math.cos((2 * Math.PI * mon) / 12));
    const dom = dt.getUTCDate();
    set('turnOfMonth', dom <= 3 || dom >= 26 ? 1 : 0);
  } else {
    for (const k of ['dowSin', 'dowCos', 'monthSin', 'monthCos', 'turnOfMonth']) set(k, null);
  }

  // ── data quality ─────────────────────────────────────────────────────────
  set('staleSessions', isFin(ctx.staleSessions) ? ctx.staleSessions : 0);
  set('historyLog', Math.log(idx + 1));

  const nonQuality = FEATURE_KEYS.filter((k) => k !== 'featureCoverage');
  const present = nonQuality.filter((k) => values[k] !== null).length;
  const coverage = present / nonQuality.length;
  values.featureCoverage = +coverage.toFixed(6);

  return {
    version: FEATURES_VERSION,
    values, missing: missing.filter((k) => k !== 'featureCoverage'),
    coverage: +coverage.toFixed(6),
    maxSourceDate: c.date,          // the latest datum this vector touched — the PIT audit key
  };
}

module.exports = { FEATURES_VERSION, FEATURE_KEYS, CONTINUOUS_KEYS, DATE_CONSTANT_KEYS, computeFeatures, dailyReturns, correlation, stdev, median, olsSlope };
