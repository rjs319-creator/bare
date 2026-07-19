// ORBIT feature engine (orbit-features-v1) — point-in-time continuous features
// from daily bars plus tradeable factor-proxy series. Every feature is a pure
// function of data at indices ≤ asOfIdx, so a snapshot never changes when future
// candles are appended (causal-invariance test in test/orbit-features.test.js).
//
// The engine returns RAW features. Winsorization / scaling are deliberately NOT
// applied here — they are fitted inside training folds by lib/orbit-model.js
// (fit-then-apply) so no test-fold statistic ever leaks into a transform.
//
// Factor inputs (`factorCloses`) are close arrays index-aligned to `candles`
// (same length, null where a factor bar is missing). The caller (backfill/route)
// aligns SPY (market), the sector ETF, IWM (size = small−market), and ^VIX (vol)
// to the stock's dates via alignByDate().

const M = require('./orbit-math');
const FM = require('./orbit-factor-model');
const State = require('./orbit-state');

const FEATURES_VERSION = 'orbit-features-v1';

// Map a stock's dates to a factor's closes (last factor bar on/before each date).
// Pure, causal per-date. Returns an array aligned to `dates` (null when unknown).
function alignByDate(dates, factorCandles) {
  if (!factorCandles || !factorCandles.length) return dates.map(() => null);
  const fdates = factorCandles.map(c => c.date);
  const closeAt = new Map(factorCandles.map(c => [c.date, c.close]));
  const out = new Array(dates.length).fill(null);
  let j = 0;
  for (let i = 0; i < dates.length; i++) {
    while (j + 1 < fdates.length && fdates[j + 1] <= dates[i]) j++;
    out[i] = fdates[j] <= dates[i] ? closeAt.get(fdates[j]) : null;
  }
  return out;
}

// Trailing simple return over k sessions ending at index i (null if not enough).
function trailingRet(closes, k, i) {
  const j = i - k;
  if (j < 0 || closes[j] == null || closes[i] == null || closes[j] <= 0) return null;
  return +(closes[i] / closes[j] - 1).toFixed(6);
}

// Cumulative sum of the last k finite values of `arr` ending at its tail.
function tailSum(arr, k) {
  const s = arr.slice(Math.max(0, arr.length - k)).filter(x => x != null && Number.isFinite(x));
  return s.length ? +s.reduce((a, b) => a + b, 0).toFixed(8) : null;
}

// Max drawdown of the cumulative sum of a residual series (≤0). Pure.
function residualDrawdown(res) {
  let cum = 0, peak = 0, mdd = 0;
  for (const r of res) { if (r == null) continue; cum += r; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum - peak); }
  return +mdd.toFixed(6);
}

// Lag-1 autocorrelation of a finite series.
function autocorr1(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(x));
  if (v.length < 5) return null;
  const a = v.slice(0, -1), b = v.slice(1);
  const c = M.pearson(a, b);
  return c == null ? null : +c.toFixed(4);
}

// On-Balance-Volume series over aligned closes/volumes.
function obvSeries(closes, vols) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const dir = closes[i] > closes[i - 1] ? 1 : closes[i] < closes[i - 1] ? -1 : 0;
    out[i] = out[i - 1] + dir * (vols[i] || 0);
  }
  return out;
}

// Close location value within the daily range, scaled to [-1,1] (Williams AD).
function clv(c) {
  const rng = c.high - c.low;
  if (rng <= 0) return 0;
  return M.clamp(((c.close - c.low) - (c.high - c.close)) / rng, -1, 1);
}

// Build the ORBIT feature snapshot as-of `asOfIdx` (default = last bar).
function orbitFeatures(candles, factorCloses = {}, opts = {}) {
  const asOfIdx = opts.asOfIdx == null ? candles.length - 1 : opts.asOfIdx;
  if (asOfIdx < 0 || asOfIdx >= candles.length) return null;

  // Slice EVERYTHING to [0..asOfIdx] so no future bar can be read.
  const bars = candles.slice(0, asOfIdx + 1);
  const dates = bars.map(c => c.date);
  const closes = bars.map(c => c.close);
  const vols = bars.map(c => c.volume || 0);
  const n = bars.length;
  const sliceF = (a) => Array.isArray(a) ? a.slice(0, asOfIdx + 1) : null;
  const mkt = sliceF(factorCloses.marketCloses);
  const sec = sliceF(factorCloses.sectorCloses);
  const small = sliceF(factorCloses.smallCloses);   // IWM
  const vol = sliceF(factorCloses.volCloses);        // ^VIX

  const missing = {};
  const asOf = dates[n - 1];
  if (n < 30) return { version: FEATURES_VERSION, asOf, asOfIdx, sufficient: false, reason: `only ${n} bars`, features: {}, missing: { bars: true } };

  // ── Factor residualisation ─────────────────────────────────────────────
  const stockRet = FM.toReturns(closes);
  const mktRet = mkt ? FM.toReturns(mkt) : null;
  const secRet = sec ? FM.toReturns(sec) : null;
  const smallRet = small ? FM.toReturns(small) : null;
  // Size factor = small-cap minus market (SMB-style), only where both exist.
  const sizeRet = (smallRet && mktRet) ? smallRet.map((s, i) => (s != null && mktRet[i] != null) ? s - mktRet[i] : null) : null;
  const volRet = vol ? FM.toReturns(vol) : null;
  if (!mktRet) missing.market = true;
  if (!secRet) missing.sector = true;
  if (!sizeRet) missing.size = true;
  if (!volRet) missing.vol = true;

  const factor = FM.residualWindow(stockRet, { market: mktRet, sector: secRet, size: sizeRet, vol: volRet }, opts.factor || {});
  const res = factor.residuals;              // trailing residual window (may be empty)
  const state = State.estimateDrift(res, opts.state || {});

  // ── Return & residual features ─────────────────────────────────────────
  const f = {};
  for (const k of [1, 2, 5, 10, 21, 42, 63, 126, 252]) f[`ret${k}`] = trailingRet(closes, k, n - 1);
  // Market/sector-relative cumulative returns over 21/63.
  const relRet = (fac, k) => {
    if (!fac) return null;
    const facCloses = fac === 'mkt' ? mkt : sec;
    const a = trailingRet(closes, k, n - 1), b = trailingRet(facCloses, k, n - 1);
    return (a == null || b == null) ? null : +(a - b).toFixed(6);
  };
  f.mktRelRet21 = mkt ? relRet('mkt', 21) : null;
  f.mktRelRet63 = mkt ? relRet('mkt', 63) : null;
  f.secRelRet21 = sec ? relRet('sec', 21) : null;
  f.secRelRet63 = sec ? relRet('sec', 63) : null;

  if (factor.sufficient && res.length) {
    f.residMom21 = tailSum(res, 21);
    f.residMom63 = tailSum(res, 63);
    const last21 = res.slice(-21);
    f.residPosFrac = +(last21.filter(x => x > 0).length / last21.length).toFixed(4);
    f.residConsistency = +(res.filter(x => x > 0).length / res.length).toFixed(4);
    const m10 = M.mean(res.slice(-10)), p10 = M.mean(res.slice(-20, -10));
    f.residAccel = (m10 == null || p10 == null) ? null : +(m10 - p10).toFixed(8);
    f.residAutocorr = autocorr1(res);
    const neg = res.filter(x => x < 0);
    f.residDownDev = neg.length ? +Math.sqrt(M.mean(neg.map(x => x * x))).toFixed(6) : 0;
    f.residDrawdown = residualDrawdown(res);
  } else {
    Object.assign(f, { residMom21: null, residMom63: null, residPosFrac: null, residConsistency: null, residAccel: null, residAutocorr: null, residDownDev: null, residDrawdown: null });
    missing.residual = true;
  }

  // Recovery after market-down days: mean stock daily return on the session AFTER
  // a market-down session, minus its unconditional mean (relative recovery).
  if (mktRet) {
    const after = [], all = [];
    for (let i = 2; i < n; i++) { if (stockRet[i] != null) all.push(stockRet[i]); if (mktRet[i - 1] != null && mktRet[i - 1] < 0 && stockRet[i] != null) after.push(stockRet[i]); }
    const mAfter = M.mean(after), mAll = M.mean(all);
    f.recoveryAfterMktDown = (mAfter == null || mAll == null) ? null : +(mAfter - mAll).toFixed(6);
  } else { f.recoveryAfterMktDown = null; }

  // Return-path stability: 1/(1+σ_daily) over last 21 sessions (higher = smoother).
  const r21 = stockRet.slice(-21).filter(x => x != null);
  const sd = M.std(r21);
  f.returnPathStability = sd == null ? null : +(1 / (1 + sd * 100)).toFixed(4);

  // ── Demand-pressure features ───────────────────────────────────────────
  const dollarVol = closes.map((c, i) => c * (vols[i] || 0));
  const win = Math.min(21, n - 1);
  let upDol = 0, downDol = 0, totDol = 0;
  for (let i = n - win; i < n; i++) {
    const dv = dollarVol[i]; totDol += dv;
    if (stockRet[i] != null && stockRet[i] > 0) upDol += dv; else if (stockRet[i] != null && stockRet[i] < 0) downDol += dv;
  }
  f.udDollarImbalance = totDol > 0 ? +((upDol - downDol) / totDol).toFixed(4) : null;

  // Demand asymmetry via residual return per unit dollar volume (robust centre).
  if (factor.sufficient && res.length) {
    const idx = factor.residualIdx;   // stock indices for each residual
    const posR = [], negR = [];
    for (let k = 0; k < res.length; k++) {
      const i = idx[k]; const dv = dollarVol[i];
      if (dv <= 0) continue;
      const rpd = res[k] / Math.log10(dv + 10);  // scale by log dollar-volume magnitude
      if (res[k] > 0) posR.push(rpd); else if (res[k] < 0) negR.push(rpd);
    }
    const posC = M.median(posR), negC = M.median(negR);
    f.demandAsymmetry = (posC == null || negC == null) ? null : +(posC - Math.abs(negC)).toFixed(8);
  } else { f.demandAsymmetry = null; }

  const obv = obvSeries(closes, vols);
  f.obvSlope = M.slope(obv.slice(-21));
  f.obvAccel = (() => { const s1 = M.slope(obv.slice(-10)), s0 = M.slope(obv.slice(-21, -11)); return (s1 == null || s0 == null) ? null : +(s1 - s0).toFixed(2); })();
  f.volSurprise = +M.robustZ(vols[n - 1], vols.slice(-63, -1)).toFixed(4);
  f.dollarVolSurprise = +M.robustZ(dollarVol[n - 1], dollarVol.slice(-63, -1)).toFixed(4);
  f.closeLocation = +M.mean(bars.slice(-10).map(clv)).toFixed(4);
  // Accumulation on market-down days: mean CLV on sessions where the market fell.
  if (mktRet) {
    const clvDown = [];
    for (let i = n - win; i < n; i++) if (mktRet[i] != null && mktRet[i] < 0) clvDown.push(clv(bars[i]));
    f.accumOnMktDown = clvDown.length ? +M.mean(clvDown).toFixed(4) : null;
  } else { f.accumOnMktDown = null; }
  f.avgDollarVol = +M.mean(dollarVol.slice(-21)).toFixed(0);

  // Liquidity / data-quality indicators.
  const recentVols = vols.slice(-21);
  f.missingVol = recentVols.some(v => !v) ? 1 : 0;
  f.suspiciousVol = recentVols.some(v => v < 0) ? 1 : 0;

  // ── Latent-persistence inputs (from the drift state) ───────────────────
  f.drift = state.drift;
  f.driftSlope = state.acceleration;
  f.driftZ = state.driftZ;
  f.driftPersistence = state.persistence;
  f.driftHalfLife = state.halfLife;
  f.driftUncertainty = state.observationVariance;
  f.driftProbPositive = state.probabilityPositive;
  f.stateChangeProb = state.changeProbability;
  if (!state.sufficient) missing.state = true;

  // ── Name-level scenario/context (cross-sectional context added by caller) ─
  f.marketTrend = mkt ? trendScore(mkt) : null;
  f.sectorTrend = sec ? trendScore(sec) : null;
  f.volState = vol ? +M.robustZ(vol[n - 1], vol.slice(-252)).toFixed(4) : null;

  return {
    version: FEATURES_VERSION,
    asOf, asOfIdx,
    sufficient: factor.sufficient && state.sufficient,
    features: f,
    missing,
    factor: { version: factor.version, sufficient: factor.sufficient, exposures: factor.exposures, r2: factor.r2, nObs: factor.nObs, factorsUsed: factor.factorsUsed, reason: factor.reason || null },
    state: { version: state.version, sufficient: state.sufficient, drift: state.drift, probabilityPositive: state.probabilityPositive, halfLife: state.halfLife, changeProbability: state.changeProbability },
  };
}

// Signed trend read of a close series: +1 above both 50/200 SMA, −1 below both.
function trendScore(closes) {
  const i = closes.length - 1;
  const sma = (k) => { const s = closes.slice(Math.max(0, i - k + 1), i + 1).filter(x => x != null); return s.length >= Math.min(k, 30) ? M.mean(s) : null; };
  const s50 = sma(50), s200 = sma(200), px = closes[i];
  if (px == null || s50 == null) return null;
  let sc = 0;
  if (px > s50) sc += 0.5; else sc -= 0.5;
  if (s200 != null) { if (px > s200) sc += 0.5; else sc -= 0.5; }
  return +sc.toFixed(2);
}

module.exports = { FEATURES_VERSION, orbitFeatures, alignByDate, trendScore };
