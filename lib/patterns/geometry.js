// PATTERN GEOMETRY — objective, scale-invariant, ATR-adaptive shape primitives.
//
// This is the ONE source of truth for pattern shape math in the pattern-intelligence
// layer. It reuses the app's canonical ATR (lib/signal.calcATR) and never re-implements
// indicators that already have a home. Everything here is pure and point-in-time: given a
// candle array it looks only at those bars, never into the future.
//
// Candle shape accepted: the app's daily object form {date,open,high,low,close,volume}.
// (Intraday {t,o,h,l,c,v} callers should map to this shape first — see toDaily below.)

const { calcATR } = require('../signal');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

// Accept both the daily object form and the short intraday {t,o,h,l,c,v} form.
function toDaily(bars = []) {
  return (bars || [])
    .map(b => {
      if (b == null) return null;
      const open = b.open ?? b.o;
      const high = b.high ?? b.h;
      const low = b.low ?? b.l;
      const close = b.close ?? b.c;
      const volume = b.volume ?? b.v ?? 0;
      const date = b.date ?? b.t ?? null;
      if (![open, high, low, close].every(isNum)) return null;
      return { date, open, high, low, close, volume: isNum(volume) ? volume : 0 };
    })
    .filter(Boolean);
}

function closesOf(candles) { return candles.map(c => c.close); }

// Trailing ATR scalar (the app's Wilder ATR). Falls back to a range-based estimate on
// short series so geometry never divides by null.
function atrOf(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const series = calcATR(candles, Math.min(period, candles.length - 1));
  const last = series[series.length - 1];
  if (isNum(last) && last > 0) return last;
  // Fallback: mean high-low range.
  const ranges = candles.map(c => c.high - c.low).filter(isNum);
  if (!ranges.length) return null;
  const m = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  return m > 0 ? m : null;
}

function sma(vals, period, endIdx = vals.length - 1) {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += vals[i];
  return s / period;
}

function stdev(vals) {
  const n = vals.length;
  if (n < 2) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / n;
  const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return Math.sqrt(v);
}

// ---- Normalized paths (scale-invariant) ---------------------------------------

// Log-return path relative to the first close. Scale-invariant by construction: any
// positive scalar multiple of the price series produces the identical path.
function logPath(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return [];
  const base = closes[0];
  if (!isNum(base) || base <= 0) return [];
  return closes.map(c => (isNum(c) && c > 0 ? Math.log(c / base) : 0));
}

// Min-max normalized path in [0,1] — used for template geometry matching.
function unitPath(closes) {
  const xs = closes.filter(isNum);
  if (xs.length < 2) return [];
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  if (hi - lo <= 0) return closes.map(() => 0.5);
  return closes.map(c => (isNum(c) ? (c - lo) / (hi - lo) : 0.5));
}

// Linear resample of a series to exactly n points (for comparing paths of unequal length).
function resample(series, n) {
  if (!Array.isArray(series) || series.length === 0 || n < 2) return [];
  if (series.length === n) return series.slice();
  const out = [];
  const last = series.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = (i / (n - 1)) * last;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, last);
    const frac = pos - lo;
    out.push(series[lo] * (1 - frac) + series[hi] * frac);
  }
  return out;
}

// ---- ATR-adaptive pivots / zigzag --------------------------------------------

// ATR-adaptive zigzag: alternating swing highs/lows where each leg reverses by at least
// `atrMult` ATRs. Adapts automatically to a penny stock vs a mega-cap (threshold is in
// ATR units, not fixed dollars/percent). Returns pivots in time order:
//   [{ idx, price, kind:'H'|'L', date }]
function zigzag(candles, { atrMult = 1.5 } = {}) {
  const cs = toDaily(candles);
  if (cs.length < 3) return [];
  const atr = atrOf(cs);
  if (!isNum(atr) || atr <= 0) return [];
  const thresh = atr * atrMult;

  const pivots = [];
  let dir = 0; // +1 seeking high, -1 seeking low, 0 undecided
  let extIdx = 0;
  let extPrice = cs[0].close;

  for (let i = 1; i < cs.length; i++) {
    const hi = cs[i].high;
    const lo = cs[i].low;
    if (dir >= 0 && hi > extPrice) { extPrice = hi; extIdx = i; }
    if (dir <= 0 && lo < extPrice) { extPrice = lo; extIdx = i; }

    if (dir >= 0) {
      // Look for a downside reversal from the running high.
      if (extPrice - lo >= thresh) {
        pivots.push({ idx: extIdx, price: extPrice, kind: 'H', date: cs[extIdx].date });
        dir = -1; extPrice = lo; extIdx = i;
      }
    }
    if (dir <= 0) {
      if (hi - extPrice >= thresh) {
        pivots.push({ idx: extIdx, price: extPrice, kind: 'L', date: cs[extIdx].date });
        dir = 1; extPrice = hi; extIdx = i;
      }
    }
    if (dir === 0) dir = 1;
  }
  // Close the final in-progress leg as a provisional pivot.
  pivots.push({ idx: extIdx, price: extPrice, kind: dir >= 0 ? 'H' : 'L', date: cs[extIdx].date });
  // De-dup consecutive same-kind pivots keeping the more extreme.
  const cleaned = [];
  for (const p of pivots) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.kind === p.kind) {
      if ((p.kind === 'H' && p.price >= prev.price) || (p.kind === 'L' && p.price <= prev.price)) cleaned[cleaned.length - 1] = p;
    } else cleaned.push(p);
  }
  return cleaned;
}

// Confirmed local extrema (fractal pivots) with a ±k window — a simpler alternative to
// zigzag, useful for double-bottom/top symmetry checks.
function fractals(candles, k = 3) {
  const cs = toDaily(candles);
  const highs = [];
  const lows = [];
  for (let i = k; i < cs.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (cs[j].high >= cs[i].high) isHigh = false;
      if (cs[j].low <= cs[i].low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: cs[i].high, date: cs[i].date });
    if (isLow) lows.push({ idx: i, price: cs[i].low, date: cs[i].date });
  }
  return { highs, lows };
}

// ---- Geometric feature vector -------------------------------------------------

// Slope of a best-fit line through a series, normalized per-bar as a fraction of the
// mean level (so it is scale-invariant). Positive = rising.
function normSlope(series) {
  const n = series.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = series.reduce((a, b) => a + b, 0) / n;
  if (ym === 0) return 0;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (series[i] - ym); den += (i - xm) ** 2; }
  if (den === 0) return 0;
  return (num / den) / Math.abs(ym);
}

// Full ATR-normalized geometry for the last `window` bars. All depth/height measures are
// in ATR units so thresholds transfer across price regimes.
function geometryFeatures(candles, { window = candles.length } = {}) {
  const all = toDaily(candles);
  const cs = all.slice(-window);
  if (cs.length < 3) return null;
  const atr = atrOf(all) || atrOf(cs);
  const closes = closesOf(cs);
  const highs = cs.map(c => c.high);
  const lows = cs.map(c => c.low);
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const last = cs[cs.length - 1];

  const piv = zigzag(cs, { atrMult: 1.0 });
  const swingHighs = piv.filter(p => p.kind === 'H');
  const swingLows = piv.filter(p => p.kind === 'L');

  // Higher-lows / lower-highs sequence structure.
  const higherLows = countMonotone(swingLows.map(p => p.price), +1);
  const lowerHighs = countMonotone(swingHighs.map(p => p.price), -1);

  // Base depth (peak-to-trough) and duration.
  const baseDepthAtr = atr ? (hi - lo) / atr : null;
  const baseDepthPct = hi > 0 ? (hi - lo) / hi : null;

  // Contraction: dispersion of the recent third vs the prior third of the window.
  const third = Math.max(2, Math.floor(cs.length / 3));
  const recentDisp = stdev(closes.slice(-third));
  const priorDisp = stdev(closes.slice(0, third));
  const contraction = priorDisp > 0 ? recentDisp / priorDisp : null; // <1 = tightening

  // Candle body / wick structure (means over the window).
  const bodyRatios = cs.map(c => {
    const range = c.high - c.low;
    return range > 0 ? Math.abs(c.close - c.open) / range : 0;
  });
  const upperWicks = cs.map(c => {
    const range = c.high - c.low;
    return range > 0 ? (c.high - Math.max(c.open, c.close)) / range : 0;
  });
  const lowerWicks = cs.map(c => {
    const range = c.high - c.low;
    return range > 0 ? (Math.min(c.open, c.close) - c.low) / range : 0;
  });

  // Gaps (open vs prior close) in ATR units.
  const gaps = [];
  for (let i = 1; i < cs.length; i++) {
    if (atr) gaps.push((cs[i].open - cs[i - 1].close) / atr);
  }
  const maxGapAtr = gaps.length ? Math.max(...gaps.map(Math.abs)) : 0;

  // Distance from window high/low in ATR units (extension / position-in-range).
  const distFromHighAtr = atr ? (hi - last.close) / atr : null;
  const distFromLowAtr = atr ? (last.close - lo) / atr : null;
  const posInRange = hi - lo > 0 ? (last.close - lo) / (hi - lo) : 0.5;

  return {
    bars: cs.length,
    atr: round(atr),
    baseDepthAtr: round(baseDepthAtr),
    baseDepthPct: round(baseDepthPct),
    contraction: round(contraction),
    trendSlope: round(normSlope(closes)),      // scale-invariant per-bar slope
    higherLows,
    lowerHighs,
    swingHighs: swingHighs.length,
    swingLows: swingLows.length,
    pivots: piv,
    meanBody: round(mean(bodyRatios)),
    meanUpperWick: round(mean(upperWicks)),
    meanLowerWick: round(mean(lowerWicks)),
    maxGapAtr: round(maxGapAtr),
    distFromHighAtr: round(distFromHighAtr),
    distFromLowAtr: round(distFromLowAtr),
    posInRange: round(posInRange),
    windowHigh: round(hi),
    windowLow: round(lo),
    lastClose: round(last.close),
  };
}

// Volume geometry: contraction during a base + expansion on the latest bar(s), plus
// up/down volume balance. Returns ratios (scale-invariant).
function volumeFeatures(candles, { window = candles.length } = {}) {
  const cs = toDaily(candles).slice(-window);
  if (cs.length < 4) return null;
  const vols = cs.map(c => c.volume);
  const third = Math.max(2, Math.floor(cs.length / 3));
  const avgAll = mean(vols);
  const recentAvg = mean(vols.slice(-third));
  const priorAvg = mean(vols.slice(0, third));

  let upVol = 0;
  let downVol = 0;
  for (let i = 1; i < cs.length; i++) {
    if (cs[i].close >= cs[i - 1].close) upVol += cs[i].volume;
    else downVol += cs[i].volume;
  }
  const last = cs[cs.length - 1];
  return {
    dryUp: priorAvg > 0 ? round(recentAvg / priorAvg) : null,       // <1 = volume drying up in the base
    lastRelVol: avgAll > 0 ? round(last.volume / avgAll) : null,     // latest bar vs window mean
    upDownRatio: downVol > 0 ? round(upVol / downVol) : (upVol > 0 ? 3 : null),
    expansion: recentAvg > 0 && priorAvg > 0 ? round(recentAvg / priorAvg) : null,
  };
}

// ---- small helpers ------------------------------------------------------------

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

// Count the length of the run of monotone moves in `dir` (+1 rising, -1 falling).
function countMonotone(seq, dir) {
  let count = 0;
  for (let i = 1; i < seq.length; i++) {
    if ((dir > 0 && seq[i] > seq[i - 1]) || (dir < 0 && seq[i] < seq[i - 1])) count++;
  }
  return count;
}

module.exports = {
  toDaily, closesOf, atrOf, sma, stdev,
  logPath, unitPath, resample, normSlope,
  zigzag, fractals,
  geometryFeatures, volumeFeatures,
  countMonotone, mean,
};
