'use strict';
// 🧬 BIOTECH FEATURES (Phase 5) — expanded, archetype-aware mechanical feature engineering.
//
// Pure over daily candles {date,open,high,low,close,volume}. Extends the legacy
// lib/biotech.js features (ADR, run maturity, spike-fade) with the swing structure the new
// archetypes need: event-anchored levels (gap, close-location, gap-retention, anchored VWAP),
// base tightness / volatility contraction, pullback geometry, participation/liquidity, and
// XBI-residual strength. Everything is null-safe: a feature that can't be computed returns
// null (never 0) so downstream gates can treat "missing" as missing, not as a neutral value.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = v => (v == null ? null : +v.toFixed(2));
const r3 = v => (v == null ? null : +v.toFixed(3));

function sma(candles, period, endIdx) {
  if (endIdx == null) endIdx = candles.length - 1;
  if (endIdx - period + 1 < 0) return null;
  let s = 0;
  for (let k = endIdx - period + 1; k <= endIdx; k++) s += candles[k].close;
  return s / period;
}

// True-range ATR% (Wilder-lite: simple mean of TR/close) over `period` ending at endIdx.
function atrPct(candles, period, endIdx) {
  if (endIdx == null) endIdx = candles.length - 1;
  if (endIdx - period < 0) return null;
  let s = 0, n = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!c || !p || !(c.close > 0)) continue;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    s += tr / c.close; n++;
  }
  return n ? s / n : null;
}

// Close-location value: 0 = closed on the low, 1 = closed on the high. A strong event bar
// closes in its upper third (buyers in control into the close).
function closeLocation(c) {
  if (!c || c.high == null || c.low == null || c.high <= c.low) return null;
  return clamp((c.close - c.low) / (c.high - c.low), 0, 1);
}

// Session % return ending at the last bar, `n` sessions back.
function retN(candles, n) {
  const i = candles.length - 1;
  const base = candles[i - n];
  if (!base || !(base.close > 0)) return null;
  return (candles[i].close - base.close) / base.close * 100;
}

// Anchored VWAP from an event bar forward to the last bar (typical-price × volume).
function anchoredVwap(candles, eventIdx) {
  if (eventIdx == null || eventIdx < 0 || eventIdx >= candles.length) return null;
  let pv = 0, vv = 0;
  for (let i = eventIdx; i < candles.length; i++) {
    const c = candles[i]; if (!c || !(c.volume > 0)) continue;
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume; vv += c.volume;
  }
  return vv > 0 ? pv / vv : null;
}

// Base tightness: mean |daily close-to-close %| over the last `win` sessions (lower = tighter
// coil). Volatility-contraction ratio = recent tightness vs the prior window (< 1 = contracting).
function baseStats(candles, win = 10) {
  const i = candles.length - 1;
  if (i - 2 * win < 0) return { tightness: null, contraction: null, volDryUp: null };
  const dispersion = (a, b) => {
    let s = 0, n = 0;
    for (let k = a + 1; k <= b; k++) {
      const c = candles[k], p = candles[k - 1];
      if (c && p && p.close > 0) { s += Math.abs(c.close - p.close) / p.close; n++; }
    }
    return n ? s / n : null;
  };
  const recent = dispersion(i - win, i);
  const prior = dispersion(i - 2 * win, i - win);
  // Volume dry-up: recent avg volume vs the prior window (< 1 = supply drying up in the base).
  const avgVol = (a, b) => { let s = 0, n = 0; for (let k = a; k <= b; k++) { if (candles[k]) { s += candles[k].volume; n++; } } return n ? s / n : null; };
  const vr = avgVol(i - win + 1, i), vp = avgVol(i - 2 * win + 1, i - win);
  return {
    tightness: r3(recent),
    contraction: recent != null && prior > 0 ? r2(recent / prior) : null,
    volDryUp: vr != null && vp > 0 ? r2(vr / vp) : null,
  };
}

// Higher-high / higher-low structure over the last `win` sessions vs the prior window.
function trendStructure(candles, win = 10) {
  const i = candles.length - 1;
  if (i - 2 * win < 0) return { higherHigh: null, higherLow: null };
  const hi = (a, b) => Math.max(...candles.slice(a, b + 1).map(c => c.high));
  const lo = (a, b) => Math.min(...candles.slice(a, b + 1).map(c => c.low));
  return {
    higherHigh: hi(i - win + 1, i) > hi(i - 2 * win + 1, i - win),
    higherLow: lo(i - win + 1, i) > lo(i - 2 * win + 1, i - win),
  };
}

// Distance (%) to the nearest overhead swing high in the last `look` sessions that is ABOVE
// the current price — the supply a breakout must clear. null when price is already at highs.
function overheadSupply(candles, look = 63) {
  const i = candles.length - 1;
  const last = candles[i].close;
  let hi = null;
  for (let k = Math.max(0, i - look); k < i; k++) {
    const h = candles[k].high;
    if (h > last && (hi == null || h < hi)) hi = h;
  }
  return hi == null ? null : r2((hi - last) / last * 100);
}

// Median of an array (participation stat).
function median(arr) {
  const a = arr.filter(x => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Participation / execution features. Float unavailable on free data → floatTurnover null.
function participation(candles, win = 20) {
  const i = candles.length - 1;
  const dv = [];
  for (let k = Math.max(0, i - win + 1); k <= i; k++) { const c = candles[k]; if (c && c.close > 0) dv.push(c.close * c.volume); }
  if (!dv.length) return { avgDollarVol: null, medDollarVol: null, volConcentration: null };
  const avg = dv.reduce((s, x) => s + x, 0) / dv.length;
  const med = median(dv);
  // Concentration: today's dollar volume vs the median (a single freak print vs steady participation).
  const today = dv[dv.length - 1];
  return {
    avgDollarVol: Math.round(avg),
    medDollarVol: med == null ? null : Math.round(med),
    volConcentration: med > 0 ? r2(today / med) : null,
  };
}

/**
 * Full biotech feature vector.
 * @param {Array} candles ascending daily candles
 * @param {object} opts { eventIdx?: index of the catalyst bar, xbi?: XBI candles }
 */
function computeFeatures(candles, opts = {}) {
  const n = candles ? candles.length : 0;
  if (n < 30) return null;
  const i = n - 1;
  const last = candles[i].close;
  if (!(last > 0)) return null;

  const sma20 = sma(candles, 20, i), sma50 = sma(candles, 50, i), sma200 = n >= 200 ? sma(candles, 200, i) : null;
  const atr = atrPct(candles, 14, i);
  const base = baseStats(candles, 10);
  const trend = trendStructure(candles, 10);
  const part = participation(candles, 20);

  const feat = {
    last: r2(last),
    // Multi-horizon returns (Phase 5).
    ret1: r2(retN(candles, 1)), ret3: r2(retN(candles, 3)), ret5: r2(retN(candles, 5)),
    ret10: r2(retN(candles, 10)), ret21: r2(retN(candles, 21)), ret63: n > 63 ? r2(retN(candles, 63)) : null,
    // Moving-average structure.
    distSma20: sma20 ? r2((last - sma20) / sma20 * 100) : null,
    distSma50: sma50 ? r2((last - sma50) / sma50 * 100) : null,
    distSma200: sma200 ? r2((last - sma200) / sma200 * 100) : null,
    aboveSma20: sma20 != null && last > sma20, aboveSma50: sma50 != null && last > sma50,
    aboveSma200: sma200 != null && last > sma200,
    atrPct: r3(atr),
    // ATR-normalized extension of the last session (blow-off risk).
    extAtr: atr && atr > 0 ? r2(((last - candles[i - 1].close) / candles[i - 1].close) / atr) : null,
    // Base / contraction / structure.
    baseTightness: base.tightness, volContraction: base.contraction, volDryUp: base.volDryUp,
    higherHigh: trend.higherHigh, higherLow: trend.higherLow,
    overheadSupplyPct: overheadSupply(candles, 63),
    ...part,
  };

  // Event-anchored features (Phase 4/5) — only when the catalyst bar is identified.
  const ev = opts.eventIdx;
  if (ev != null && ev >= 1 && ev < n) {
    const evBar = candles[ev], prevBar = candles[ev - 1];
    const gap = prevBar && prevBar.close > 0 ? (evBar.open - prevBar.close) / prevBar.close * 100 : null;
    const evClose = evBar.close, evHigh = evBar.high, evLow = evBar.low;
    const sessionsSince = i - ev;
    // Gap retention: fraction of the event-day close held after 1/2/3 sessions (>1 = extended past it).
    const retention = k => { const c = candles[ev + k]; return c && evClose > 0 ? r2(c.close / evClose) : null; };
    feat.event = {
      sessionsSince,
      gapPct: r2(gap),
      closeLocation: r3(closeLocation(evBar)),
      gapRetain1: retention(1), gapRetain2: retention(2), gapRetain3: retention(3),
      anchoredVwap: r2(anchoredVwap(candles, ev)),
      aboveAnchoredVwap: (() => { const v = anchoredVwap(candles, ev); return v == null ? null : last >= v; })(),
      distEventHigh: evHigh > 0 ? r2((last - evHigh) / evHigh * 100) : null,
      distEventLow: evLow > 0 ? r2((last - evLow) / evLow * 100) : null,
      holdsEventLow: evLow > 0 ? last >= evLow : null,
      // First pullback depth from the post-event high (how deep the dip that followed the spike).
      pullbackDepthPct: (() => {
        let hi = evClose; for (let k = ev; k <= i; k++) hi = Math.max(hi, candles[k].high);
        return hi > 0 ? r2((last - hi) / hi * 100) : null;
      })(),
    };
  }

  // XBI-residual strength (Phase 5) — the move net of biotech beta. Missing XBI → null (a
  // data-quality warning upstream), never a silent zero benchmark.
  if (Array.isArray(opts.xbi) && opts.xbi.length > 6) {
    const x = opts.xbi;
    const xr5 = x.length > 5 && x[x.length - 6].close > 0 ? (x[x.length - 1].close - x[x.length - 6].close) / x[x.length - 6].close * 100 : null;
    feat.xbiRet5 = r2(xr5);
    feat.residual5 = feat.ret5 != null && xr5 != null ? r2(feat.ret5 - xr5) : null;
  } else {
    feat.xbiRet5 = null; feat.residual5 = null;
  }

  return feat;
}

// Locate the catalyst ("event") bar in the last `look` sessions: the session whose combined
// gap + intraday range on elevated volume most dominates its neighbourhood. Returns the index
// or null. This is a MECHANICAL proxy — it marks the price event, not the news; the event
// ledger supplies the factual catalyst that (may) explain it.
function findEventBar(candles, look = 15) {
  const n = candles ? candles.length : 0;
  if (n < 25) return null;
  const i = n - 1;
  let bestIdx = null, bestScore = 0;
  const avgVol = (() => { let s = 0, k = 0; for (let j = i - 20; j <= i; j++) if (candles[j]) { s += candles[j].volume; k++; } return k ? s / k : 0; })();
  for (let j = Math.max(1, i - look + 1); j <= i; j++) {
    const c = candles[j], p = candles[j - 1];
    if (!c || !p || !(p.close > 0)) continue;
    const gap = Math.abs(c.open - p.close) / p.close;
    const move = Math.abs(c.close - p.close) / p.close;
    const rvol = avgVol > 0 ? c.volume / avgVol : 1;
    const score = (gap + move) * Math.min(3, Math.max(1, rvol));
    if (score > bestScore) { bestScore = score; bestIdx = j; }
  }
  // Require a meaningful event (≥6% combined move on ≥1.3× volume) else it's just drift.
  return bestScore >= 0.06 ? bestIdx : null;
}

module.exports = {
  computeFeatures, findEventBar, sma, atrPct, closeLocation, anchoredVwap, baseStats,
  trendStructure, overheadSupply, participation, retN, median,
};
