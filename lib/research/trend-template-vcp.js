'use strict';

// Frozen, point-in-time detectors for the 2026-08 "trend and catalyst" diagnostic:
// the strict Minervini-style trend template and a literal multi-contraction VCP
// (2-5 successively smaller pullbacks with volume dry-up). Research-only.

const TEMPLATE_MIN_BARS = 252;
const SMA200_RISING_SESSIONS = 21;
const LOW_CLEARANCE = 1.30;          // close must be >= 130% of the 52-week low
const HIGH_PROXIMITY = 0.75;         // close must be >= 75% of the 52-week high

const VCP_LOOKBACK = 130;
const VCP_ZIGZAG_THRESHOLD = 0.03;
const VCP_MIN_CONTRACTIONS = 2;
const VCP_MAX_CONTRACTIONS = 5;
const VCP_MAX_FINAL_DEPTH = 0.10;    // the last contraction must be tight
const VCP_MAX_DIST_FROM_PIVOT = 0.10;
const VCP_MAX_VOLUME_RATIO = 0.90;   // recent volume must sit below the base average
const VCP_RECENT_VOLUME_BARS = 10;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function sma(candles, end, n) {
  if (end + 1 < n) return null;
  return mean(candles.slice(end - n + 1, end + 1).map(x => x.close));
}

// Strict trend template as of bar `i` (all inputs on/before i). Null if history is short.
function minerviniTemplate(candles, i) {
  if (i + 1 < TEMPLATE_MIN_BARS) return null;
  const close = candles[i].close;
  const s50 = sma(candles, i, 50), s150 = sma(candles, i, 150), s200 = sma(candles, i, 200);
  const s200Prior = sma(candles, i - SMA200_RISING_SESSIONS, 200);
  if (!(close > 0) || !(s50 > 0) || !(s150 > 0) || !(s200 > 0) || !(s200Prior > 0)) return null;
  const window = candles.slice(i + 1 - TEMPLATE_MIN_BARS, i + 1);
  const high52 = Math.max(...window.map(x => x.close));
  const low52 = Math.min(...window.map(x => x.close));
  const checks = {
    aboveSma50: close > s50,
    aboveSma150: close > s150,
    aboveSma200: close > s200,
    sma50AboveSma150: s50 > s150,
    sma150AboveSma200: s150 > s200,
    sma200Rising: s200 > s200Prior,
    above52wLowBy30pct: close >= LOW_CLEARANCE * low52,
    within25pctOf52wHigh: close >= HIGH_PROXIMITY * high52,
  };
  return {
    ...checks,
    pass: Object.values(checks).every(Boolean),
    distFromHigh: high52 > 0 ? close / high52 - 1 : null,
    distFromLow: low52 > 0 ? close / low52 - 1 : null,
  };
}

// Close-based zigzag pivots over [start..end]; alternating H/L extremes.
function zigzagPivots(candles, start, end, threshold) {
  const pivots = [];
  let dir = 1, ext = candles[start].close, extIdx = start;
  for (let i = start + 1; i <= end; i++) {
    const c = candles[i].close;
    if (!(c > 0)) continue;
    if (dir > 0) {
      if (c > ext) { ext = c; extIdx = i; continue; }
      if ((ext - c) / ext >= threshold) { pivots.push({ type: 'H', idx: extIdx, price: ext }); dir = -1; ext = c; extIdx = i; }
    } else {
      if (c < ext) { ext = c; extIdx = i; continue; }
      if ((c - ext) / ext >= threshold) { pivots.push({ type: 'L', idx: extIdx, price: ext }); dir = 1; ext = c; extIdx = i; }
    }
  }
  return pivots;
}

// Literal VCP as of bar `i`: a trailing run of 2-5 strictly shrinking high→low
// contractions, a tight final contraction, price near the last pivot high, and
// recent volume below the base average. Null when undecidable.
function detectVcp(candles, i) {
  const start = Math.max(1, i - VCP_LOOKBACK + 1);
  if (i - start < 40) return null;
  const pivots = zigzagPivots(candles, start, i, VCP_ZIGZAG_THRESHOLD);
  const depths = [];
  let lastHigh = null;
  for (const p of pivots) {
    if (p.type === 'H') { lastHigh = p; continue; }
    if (lastHigh && lastHigh.price > 0) depths.push({ depth: (lastHigh.price - p.price) / lastHigh.price, high: lastHigh });
    lastHigh = null;
  }
  if (!depths.length) return null;
  let runStart = depths.length - 1;
  while (runStart > 0 && depths[runStart].depth < depths[runStart - 1].depth
    && depths.length - runStart < VCP_MAX_CONTRACTIONS) runStart--;
  const run = depths.slice(runStart);
  const contractions = run.map(d => d.depth);
  const pivotHigh = run[run.length - 1].high.price;
  const close = candles[i].close;
  const windowVolumes = candles.slice(start, i + 1).map(x => x.volume || 0);
  const recentVolumes = windowVolumes.slice(-VCP_RECENT_VOLUME_BARS);
  const baseVolume = mean(windowVolumes);
  const volumeContraction = baseVolume > 0 ? mean(recentVolumes) / baseVolume : null;
  const isVcp = contractions.length >= VCP_MIN_CONTRACTIONS
    && contractions.length <= VCP_MAX_CONTRACTIONS
    && contractions[contractions.length - 1] <= VCP_MAX_FINAL_DEPTH
    && pivotHigh > 0 && close >= (1 - VCP_MAX_DIST_FROM_PIVOT) * pivotHigh
    && volumeContraction != null && volumeContraction <= VCP_MAX_VOLUME_RATIO;
  return { isVcp, contractions, volumeContraction, pivotHigh, distFromPivot: pivotHigh > 0 ? close / pivotHigh - 1 : null };
}

// Faithful port of the Gemini-suggested VCP screener (2026-08): SMA stack + 1-year
// return > 20%, within 15% of the 52-week HIGH-based high, ATR14/close < 5%,
// ATR14 < ATR50, and a 21-session high-low range under 10% of price. Signal-only
// in the original (no outcomes); outcomes are supplied by the research runner.
const GEMINI_MIN_BARS = 253;
const GEMINI_ONE_YEAR = 252;
const GEMINI_MIN_YEAR_RETURN = 0.20;
const GEMINI_MAX_DIST_FROM_HIGH = 0.15;
const GEMINI_MAX_ATR_FRAC = 0.05;
const GEMINI_MONTH_BARS = 21;
const GEMINI_MAX_MONTH_RANGE = 0.10;

function smaAtr(candles, end, n) {
  if (end < n) return null;
  const trs = [];
  for (let i = end - n + 1; i <= end; i++) {
    const b = candles[i], p = candles[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  return mean(trs);
}

function geminiVcpScreen(candles, i) {
  if (i + 1 < GEMINI_MIN_BARS) return null;
  const close = candles[i].close;
  const s50 = sma(candles, i, 50), s150 = sma(candles, i, 150), s200 = sma(candles, i, 200);
  const yearAgoClose = candles[i - GEMINI_ONE_YEAR].close;
  const atr14 = smaAtr(candles, i, 14), atr50 = smaAtr(candles, i, 50);
  if (!(close > 0) || !(s50 > 0) || !(s150 > 0) || !(s200 > 0) || !(yearAgoClose > 0) || !(atr14 > 0) || !(atr50 > 0)) return null;
  const yearWindow = candles.slice(i + 1 - GEMINI_ONE_YEAR, i + 1);
  const high52 = Math.max(...yearWindow.map(x => x.high));
  const monthWindow = candles.slice(i + 1 - GEMINI_MONTH_BARS, i + 1);
  const monthHigh = Math.max(...monthWindow.map(x => x.high));
  const monthLow = Math.min(...monthWindow.map(x => x.low));
  const trendCondition = close > s50 && s50 > s150 && s150 > s200
    && close / yearAgoClose - 1 > GEMINI_MIN_YEAR_RETURN;
  const proximityCondition = high52 > 0 && (high52 - close) / high52 < GEMINI_MAX_DIST_FROM_HIGH;
  const volatilityCondition = atr14 / close < GEMINI_MAX_ATR_FRAC && atr14 < atr50
    && (monthHigh - monthLow) / close < GEMINI_MAX_MONTH_RANGE;
  return {
    trendCondition, proximityCondition, volatilityCondition,
    signal: trendCondition && proximityCondition && volatilityCondition,
    atrFrac: atr14 / close, monthRange: (monthHigh - monthLow) / close,
    distFromHigh: high52 > 0 ? (high52 - close) / high52 : null,
  };
}

module.exports = { minerviniTemplate, detectVcp, zigzagPivots, sma, geminiVcpScreen };
