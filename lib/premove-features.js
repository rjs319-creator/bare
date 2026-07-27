'use strict';
// PRE-MOVE FEATURE SCHEMA (premove-features-v1) — Phase 6 of the redesign
// (docs/premove-transition-v2.md). ONE versioned feature vector shared by
// historical research and live scoring (train/serve skew is a bug class, not a
// nuance). Groups: compression trajectory, residual transition, turnover-
// conditioned momentum, absorption/price-impact proxies (EXPERIMENTAL OHLCV
// reads, not institutional order flow), structure/remaining opportunity, and
// catalyst/risk.
//
// Honesty rules:
//   - Missing inputs stay missing: every absent feature lands in `missing` and
//     its value is null — NEVER imputed to a bullish default.
//   - All features are computed from candles dated ≤ the decision cutoff; the
//     caller passes decision-time slices (asOf) and this module re-checks.
//   - Catalyst features consume ONLY a structured, timestamped record.
//
// Pure: candles in, frozen FeatureSnapshot-compatible object out.

const { coilFeatures } = require('./coil');

const PREMOVE_FEATURE_VERSION = 'premove-features-v1';

// The complete ordered key list — the schema contract research trains against.
const FEATURE_KEYS = Object.freeze([
  // compression trajectory
  'bbPctile', 'hvPctile', 'atrRatio', 'rangeTight', 'compressionDelta1', 'compressionDelta2', 'expansionRatio',
  // residual transition
  'resid3', 'resid5', 'resid10', 'resid20', 'residAccel', 'residInflection', 'residConsistency',
  // turnover-conditioned momentum
  'ret5', 'ret20', 'ret63', 'turnoverPct', 'retXTurnover', 'turnoverAccel', 'abnormalDollarVol',
  // absorption / price-impact asymmetry (EXPERIMENTAL OHLCV proxies)
  'downImpact', 'upImpact', 'absorptionTrend', 'closeLocTrend', 'wickAsym', 'supplyDryUp',
  // structure / remaining opportunity
  'distToPivotAtr', 'higherLowFrac', 'pivotAgeSessions', 'breakoutAttempts', 'consumedShare',
  'distAboveSma50', 'gapShare', 'parabolicShare', 'remainingRR',
  // catalyst / risk
  'catalystAgeDays', 'catalystInWindow', 'earningsSurprise', 'liquidityTrend',
]);

const num = (v) => (Number.isFinite(v) ? v : null);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function sliceAsOf(candles, asOf) {
  if (!asOf) return candles;
  return candles.filter(c => c && c.date <= asOf);
}

function sma(closes, win, i) {
  if (i + 1 < win) return null;
  let s = 0;
  for (let k = i - win + 1; k <= i; k++) s += closes[k];
  return s / win;
}

function atrOf(cs, win) {
  if (cs.length < win + 1) return null;
  const seg = cs.slice(-(win + 1));
  let s = 0, n = 0;
  for (let i = 1; i < seg.length; i++) {
    const tr = Math.max(seg[i].high - seg[i].low, Math.abs(seg[i].high - seg[i - 1].close), Math.abs(seg[i].low - seg[i - 1].close));
    if (Number.isFinite(tr)) { s += tr; n++; }
  }
  return n ? s / n : null;
}

function retOver(cs, k) {
  const n = cs.length;
  if (n <= k || !(cs[n - 1 - k].close > 0)) return null;
  return cs[n - 1].close / cs[n - 1 - k].close - 1;
}

function benchRetOver(bench, fromDate, toDate) {
  if (!Array.isArray(bench) || !bench.length) return null;
  let a = null, b = null;
  for (const c of bench) {
    if (c.date <= fromDate) a = c.close;
    if (c.date <= toDate) b = c.close;
  }
  return a > 0 && b != null ? b / a - 1 : null;
}

/**
 * @param {object} p
 * @param {Array} p.candles       daily candles [{date,open,high,low,close,volume}]
 * @param {Array} [p.benchCandles]   market benchmark (SPY)
 * @param {Array} [p.sectorCandles]  sector ETF (null → market-only residual, labeled)
 * @param {string} [p.asOf]       decision cutoff date (features never use later bars)
 * @param {object} [p.catalyst]   structured { type, tsUnix, surprise } or null
 * @param {object} [p.plan]       { entry, stop, target } decision-time plan or null
 */
function computePremoveFeatures({ candles, benchCandles = null, sectorCandles = null, asOf = null, catalyst = null, plan = null } = {}) {
  const missing = [];
  const v = {};
  const cs = sliceAsOf(Array.isArray(candles) ? candles : [], asOf);
  const n = cs.length;
  if (n < 63) {
    return Object.freeze({ version: PREMOVE_FEATURE_VERSION, values: Object.freeze({}), missing: Object.freeze(['insufficient-history']), asOf: asOf || null });
  }
  const last = cs[n - 1];
  const closes = cs.map(c => c.close);
  const decisionDate = last.date;

  // ── compression trajectory ─────────────────────────────────────────────────
  const cf = coilFeatures(cs, n - 1);
  const cfPrev5 = n > 66 ? coilFeatures(cs, n - 6) : null;
  const cfPrev10 = n > 71 ? coilFeatures(cs, n - 11) : null;
  v.bbPctile = cf ? num(cf.bbPctile) : null;
  v.hvPctile = cf ? num(cf.hvPctile) : null;
  v.atrRatio = cf ? num(cf.atrRatio) : null;
  v.rangeTight = cf ? num(cf.rangeTight) : null;
  // first + second differences of compression (falling bbPctile = tightening)
  v.compressionDelta1 = cf && cfPrev5 && cf.bbPctile != null && cfPrev5.bbPctile != null ? +(cf.bbPctile - cfPrev5.bbPctile).toFixed(4) : null;
  v.compressionDelta2 = v.compressionDelta1 != null && cfPrev5 && cfPrev10 && cfPrev5.bbPctile != null && cfPrev10.bbPctile != null
    ? +((cf.bbPctile - cfPrev5.bbPctile) - (cfPrev5.bbPctile - cfPrev10.bbPctile)).toFixed(4) : null;
  {
    const recentRange = Math.max(...cs.slice(-5).map(c => c.high)) - Math.min(...cs.slice(-5).map(c => c.low));
    const baseRange = Math.max(...cs.slice(-25, -5).map(c => c.high)) - Math.min(...cs.slice(-25, -5).map(c => c.low));
    v.expansionRatio = baseRange > 0 ? +(recentRange / (baseRange / 4)).toFixed(4) : null;
  }

  // ── residual transition ────────────────────────────────────────────────────
  const benchFor = (k) => {
    const from = cs[n - 1 - k] ? cs[n - 1 - k].date : null;
    if (!from) return null;
    const sec = sectorCandles ? benchRetOver(sectorCandles, from, decisionDate) : null;
    return sec != null ? sec : benchRetOver(benchCandles, from, decisionDate);
  };
  const residOver = (k) => {
    const raw = retOver(cs, k);
    const b = benchFor(k);
    return raw != null && b != null ? +(raw - b).toFixed(5) : null;
  };
  v.resid3 = residOver(3); v.resid5 = residOver(5); v.resid10 = residOver(10); v.resid20 = residOver(20);
  v.residAccel = v.resid5 != null && v.resid20 != null ? +(v.resid5 - v.resid20 / 4).toFixed(5) : null;
  v.residInflection = v.resid5 != null && v.resid20 != null ? ((v.resid20 <= 0.005 && v.resid5 > 0.005) ? 1 : 0) : null;
  {
    // share of the last 10 sessions with a positive 1-bar residual
    let pos = 0, cnt = 0;
    for (let k = n - 10; k < n; k++) {
      if (!(cs[k - 1] && cs[k - 1].close > 0)) continue;
      const raw = cs[k].close / cs[k - 1].close - 1;
      const b = benchRetOver(sectorCandles || benchCandles, cs[k - 1].date, cs[k].date);
      if (b == null) continue;
      cnt++; if (raw - b > 0) pos++;
    }
    v.residConsistency = cnt >= 5 ? +(pos / cnt).toFixed(3) : null;
  }

  // ── turnover-conditioned momentum ──────────────────────────────────────────
  v.ret5 = num(retOver(cs, 5)); v.ret20 = num(retOver(cs, 20)); v.ret63 = num(retOver(cs, 63));
  {
    const vols = cs.map(c => c.volume).filter(Number.isFinite);
    const v20 = vols.slice(-20), vAll = vols.slice(-63);
    const m20 = v20.length ? v20.reduce((a, b) => a + b, 0) / v20.length : null;
    if (m20 != null && vAll.length >= 40) {
      const sorted = vAll.slice().sort((a, b) => a - b);
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= m20) lo = m + 1; else hi = m; }
      v.turnoverPct = +(lo / sorted.length).toFixed(3);
    } else v.turnoverPct = null;
    v.retXTurnover = v.ret20 != null && v.turnoverPct != null ? +(v.ret20 * v.turnoverPct).toFixed(5) : null;
    const m5 = vols.slice(-5).length ? vols.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, vols.length) : null;
    v.turnoverAccel = m5 != null && m20 > 0 ? +(m5 / m20).toFixed(3) : null;
    const dv20 = m20 != null ? m20 * last.close : null;
    const dv63 = vAll.length ? (vAll.reduce((a, b) => a + b, 0) / vAll.length) * last.close : null;
    v.abnormalDollarVol = dv20 != null && dv63 > 0 ? +(dv20 / dv63).toFixed(3) : null;
  }

  // ── absorption / price-impact asymmetry (EXPERIMENTAL proxies) ─────────────
  {
    const volsMean = cs.slice(-50).map(c => c.volume).filter(Number.isFinite);
    const vBase = volsMean.length ? volsMean.reduce((a, b) => a + b, 0) / volsMean.length : null;
    const impact = (seg, dir) => {
      let s = 0, m = 0;
      for (let i = 1; i < seg.length; i++) {
        const r = seg[i - 1].close > 0 ? seg[i].close / seg[i - 1].close - 1 : null;
        if (r == null || !(vBase > 0) || !Number.isFinite(seg[i].volume)) continue;
        if (dir === 'down' ? r >= 0 : r <= 0) continue;
        s += Math.abs(r) / Math.max(0.2, seg[i].volume / vBase); m++;
      }
      return m ? s / m : null;
    };
    v.downImpact = num(impact(cs.slice(-11), 'down'));
    v.upImpact = num(impact(cs.slice(-11), 'up'));
    const priorDown = impact(cs.slice(-31, -10), 'down');
    v.absorptionTrend = v.downImpact != null && priorDown > 0 ? +(1 - v.downImpact / priorDown).toFixed(4) : null;
    const cloc = (seg) => {
      let s = 0, m = 0;
      for (const b of seg) { const r = b.high - b.low; if (r > 0) { s += (b.close - b.low) / r; m++; } }
      return m ? s / m : null;
    };
    const clocNow = cloc(cs.slice(-5)), clocPrev = cloc(cs.slice(-15, -5));
    v.closeLocTrend = clocNow != null && clocPrev != null ? +(clocNow - clocPrev).toFixed(4) : null;
    {
      let up = 0, dn = 0, m = 0;
      for (const b of cs.slice(-10)) {
        const r = b.high - b.low;
        if (r > 0) { up += (b.high - Math.max(b.open, b.close)) / r; dn += (Math.min(b.open, b.close) - b.low) / r; m++; }
      }
      v.wickAsym = m ? +((dn - up) / m).toFixed(4) : null;
    }
    // supply dry-up: heavy down-volume phase followed by shrinking volume
    const downVol = (seg) => {
      let s = 0;
      for (let i = 1; i < seg.length; i++) if (seg[i].close < seg[i - 1].close && Number.isFinite(seg[i].volume)) s += seg[i].volume;
      return s;
    };
    const dvPrior = downVol(cs.slice(-40, -10)), dvNow = downVol(cs.slice(-10));
    v.supplyDryUp = dvPrior > 0 ? +(1 - Math.min(2, (dvNow * 3) / dvPrior)).toFixed(4) : null;
  }

  // ── structure / remaining opportunity ──────────────────────────────────────
  {
    const atr14 = atrOf(cs, 14);
    const pivotWin = cs.slice(-40, -1);
    const pivot = pivotWin.length ? Math.max(...pivotWin.map(c => c.high)) : null;
    v.distToPivotAtr = pivot != null && atr14 > 0 ? +((pivot - last.close) / atr14).toFixed(3) : null;
    let pivotIdx = null;
    if (pivot != null) for (let i = n - 41 < 0 ? 0 : n - 41; i < n - 1; i++) if (cs[i].high === pivot) pivotIdx = i;
    v.pivotAgeSessions = pivotIdx != null ? n - 1 - pivotIdx : null;
    // breakout attempts: bars in the last 40 tagging within 1% of the pivot without closing above
    v.breakoutAttempts = pivot != null ? cs.slice(-40).filter(c => c.high >= pivot * 0.99 && c.close < pivot).length : null;
    const lows5 = [];
    for (let k = 4; k >= 0; k--) {
      const seg = cs.slice(n - (k + 1) * 4, n - k * 4);
      if (seg.length) lows5.push(Math.min(...seg.map(c => c.low)));
    }
    let hl = 0;
    for (let i = 1; i < lows5.length; i++) if (lows5[i] >= lows5[i - 1]) hl++;
    v.higherLowFrac = lows5.length > 1 ? +(hl / (lows5.length - 1)).toFixed(3) : null;
    const lo63 = Math.min(...cs.slice(-63).map(c => c.low));
    const hi63 = Math.max(...cs.slice(-63).map(c => c.high));
    v.consumedShare = hi63 > lo63 ? +((last.close - lo63) / (hi63 - lo63)).toFixed(3) : null;
    const s50 = sma(closes, 50, n - 1);
    v.distAboveSma50 = s50 > 0 ? +((last.close - s50) / s50).toFixed(4) : null;
    {
      let gaps = 0, para = 0, cnt = 0;
      for (let i = n - 20; i < n; i++) {
        if (!cs[i - 1]) continue;
        cnt++;
        if (cs[i].open > cs[i - 1].close * 1.02) gaps++;
        if (cs[i - 1].close > 0 && cs[i].close / cs[i - 1].close - 1 > 0.06) para++;
      }
      v.gapShare = cnt ? +(gaps / cnt).toFixed(3) : null;
      v.parabolicShare = cnt ? +(para / cnt).toFixed(3) : null;
    }
    v.remainingRR = plan && plan.entry > 0 && plan.stop > 0 && plan.target > plan.entry && plan.entry > plan.stop
      ? +(((plan.target - last.close) / Math.max(1e-9, last.close - plan.stop))).toFixed(3) : null;
  }

  // ── catalyst / risk (structured only — never inferred from text) ───────────
  if (catalyst && Number.isFinite(Number(catalyst.tsUnix))) {
    const ageDays = (Date.parse(decisionDate + 'T00:00:00Z') / 1000 - Number(catalyst.tsUnix)) / 86400;
    v.catalystAgeDays = Number.isFinite(ageDays) ? +ageDays.toFixed(1) : null;
    v.catalystInWindow = v.catalystAgeDays != null ? (v.catalystAgeDays >= -21 && v.catalystAgeDays <= 21 ? 1 : 0) : null;
    v.earningsSurprise = catalyst.surprise != null && isFinite(Number(catalyst.surprise)) ? Number(catalyst.surprise) : null;
  } else {
    v.catalystAgeDays = null; v.catalystInWindow = null; v.earningsSurprise = null;
  }
  {
    const dvOf = (seg) => {
      const xs = seg.map(c => Number.isFinite(c.volume) ? c.volume * c.close : null).filter(Number.isFinite);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    const dNow = dvOf(cs.slice(-10)), dPrev = dvOf(cs.slice(-40, -10));
    v.liquidityTrend = dNow != null && dPrev > 0 ? +(dNow / dPrev - 1).toFixed(4) : null;
  }

  for (const k of FEATURE_KEYS) {
    if (!(k in v)) v[k] = null;
    if (v[k] == null) missing.push(k);
  }
  if (!sectorCandles) missing.push('sector-benchmark(market-only-residual)');

  return Object.freeze({
    version: PREMOVE_FEATURE_VERSION,
    asOf: decisionDate,
    values: Object.freeze(v),
    missing: Object.freeze(missing),
    residualBasis: sectorCandles ? 'sector-then-market' : (benchCandles ? 'market-only' : 'none'),
  });
}

module.exports = { PREMOVE_FEATURE_VERSION, FEATURE_KEYS, computePremoveFeatures };
