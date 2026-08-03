'use strict';
// PATTERN STRUCTURE — pivot/trendline/level primitives for family-specific detectors.
//
// THE POINT-IN-TIME CONTRACT (closes the "current candle defines its own trigger" defect):
//   • Every structural level (neckline, boundary, rim, pivot, base high…) is constructed
//     from FORMATION bars only — bars 0..t-1. splitFormation() is the one place that cut
//     happens, so a detector physically cannot see the confirmation bar while building
//     the level it will later be tested against.
//   • The bar at t (the confirmation bar) is evaluated AGAINST those frozen levels by
//     assessBarVsLevel(), which distinguishes an intraday penetration from a closing
//     confirmation — ordinary OHLC data supports both, and they are not the same thing.
//   • Every level records the pivot/bar identifiers used to construct it, so a frozen
//     episode can prove where its trigger came from.
//
// All functions are pure; candles are the app's daily object form (see geometry.toDaily).

const G = require('./geometry');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

// ---- formation / confirmation split -------------------------------------------

// The one canonical t-1/t cut. Detectors build structure on `formation`; the caller
// evaluates `confirmBar` against the frozen levels. With fewer than 3 bars there is no
// meaningful split.
function splitFormation(candles) {
  const cs = G.toDaily(candles);
  if (cs.length < 3) return null;
  return { formation: cs.slice(0, -1), confirmBar: cs[cs.length - 1], confirmIdx: cs.length - 1 };
}

// ---- robust line fitting -------------------------------------------------------

// Theil–Sen estimator: median of pairwise slopes, intercept from median residual.
// Robust to a single bad pivot in a way least-squares is not. points: [{x, y}].
function fitLine(points) {
  const pts = (points || []).filter(p => p && isNum(p.x) && isNum(p.y));
  if (pts.length < 2) return null;
  const slopes = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (pts[j].x !== pts[i].x) slopes.push((pts[j].y - pts[i].y) / (pts[j].x - pts[i].x));
    }
  }
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const slope = slopes[Math.floor(slopes.length / 2)];
  const intercepts = pts.map(p => p.y - slope * p.x).sort((a, b) => a - b);
  const intercept = intercepts[Math.floor(intercepts.length / 2)];
  return { slope, intercept, at: x => slope * x + intercept, points: pts.length };
}

// Fit a trendline through pivots of one kind and measure how the formation respects it.
//   pivots  : zigzag/fractal pivots [{idx, price, kind}]
//   kind    : 'H' (resistance line through swing highs) | 'L' (support through swing lows)
//   atr     : for touch tolerance
// Returns { slope, intercept, at, touches, maxViolationAtr, pivotIdxs } or null.
function fitTrendline(pivots, kind, atr, { touchTolAtr = 0.5 } = {}) {
  const pts = (pivots || []).filter(p => p && p.kind === kind).map(p => ({ x: p.idx, y: p.price, idx: p.idx }));
  if (pts.length < 2 || !isNum(atr) || atr <= 0) return null;
  const line = fitLine(pts);
  if (!line) return null;
  let touches = 0;
  let maxViolation = 0;
  for (const p of pts) {
    const d = p.y - line.at(p.x);
    if (Math.abs(d) <= touchTolAtr * atr) touches++;
    // A violation is a pivot on the WRONG side of the line (above resistance / below support).
    const viol = kind === 'H' ? d : -d;
    if (viol > maxViolation) maxViolation = viol;
  }
  return {
    slope: round(line.slope, 6),
    intercept: round(line.intercept, 4),
    at: line.at,
    touches,
    maxViolationAtr: round(maxViolation / atr, 3),
    pivotIdxs: pts.map(p => p.idx),
  };
}

// Fit a horizontal level to a set of pivots (neckline / flat top / flat bottom / rim).
// Returns { price, flatnessAtr, touches, pivotIdxs } — flatness is the pivot dispersion
// in ATR units (small = genuinely flat).
function fitHorizontal(pivots, atr, { touchTolAtr = 0.5 } = {}) {
  const pts = (pivots || []).filter(p => p && isNum(p.price));
  if (!pts.length || !isNum(atr) || atr <= 0) return null;
  const prices = pts.map(p => p.price);
  const level = prices.reduce((a, b) => a + b, 0) / prices.length;
  const disp = Math.sqrt(prices.reduce((a, b) => a + (b - level) ** 2, 0) / prices.length);
  const touches = pts.filter(p => Math.abs(p.price - level) <= touchTolAtr * atr).length;
  return { price: round(level, 4), flatnessAtr: round(disp / atr, 3), touches, pivotIdxs: pts.map(p => p.idx) };
}

// ---- impulse ("pole") detection ------------------------------------------------

// Find the strongest directional impulse inside the formation: the largest net move
// (in ATR units) achieved over a short run of bars. Returns null when nothing impulsive.
//   direction +1 (up-pole for bull flags) / -1 (down-pole for bear flags)
function findPole(formation, atr, { direction = 1, maxRunBars = 15, minMoveAtr = 3 } = {}) {
  const cs = formation;
  if (!Array.isArray(cs) || cs.length < 4 || !isNum(atr) || atr <= 0) return null;
  let best = null;
  for (let i = 0; i < cs.length - 2; i++) {
    for (let j = i + 2; j < Math.min(cs.length, i + maxRunBars); j++) {
      const move = direction > 0 ? cs[j].high - cs[i].low : cs[i].high - cs[j].low;
      const moveAtr = move / atr;
      if (moveAtr >= minMoveAtr && (!best || moveAtr > best.moveAtr)) {
        best = {
          startIdx: i, endIdx: j, moveAtr: round(moveAtr, 3),
          startPrice: direction > 0 ? cs[i].low : cs[i].high,
          endPrice: direction > 0 ? cs[j].high : cs[j].low,
          bars: j - i,
        };
      }
    }
  }
  return best;
}

// ---- contraction sequence (VCP) ------------------------------------------------

// Measure the sequence of swing contractions from zigzag pivots: each leg from a swing
// high down to the following swing low (depth in ATR units, and as % of the high). A VCP
// requires each successive contraction to be SMALLER than the last.
function contractionLegs(pivots, atr) {
  if (!Array.isArray(pivots) || pivots.length < 3 || !isNum(atr) || atr <= 0) return [];
  const legs = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const a = pivots[i];
    const b = pivots[i + 1];
    if (a.kind === 'H' && b.kind === 'L') {
      legs.push({ fromIdx: a.idx, toIdx: b.idx, depthAtr: round((a.price - b.price) / atr, 3), depthPct: a.price > 0 ? round((a.price - b.price) / a.price, 4) : null, high: a.price, low: b.price });
    }
  }
  return legs;
}

// Are the legs progressively smaller? Requires ≥ minLegs and each leg ≤ shrink × previous.
function isContracting(legs, { minLegs = 2, shrink = 0.85 } = {}) {
  if (!Array.isArray(legs) || legs.length < minLegs) return false;
  for (let i = 1; i < legs.length; i++) {
    if (!(legs[i].depthAtr <= legs[i - 1].depthAtr * shrink)) return false;
  }
  return true;
}

// ---- confirmation-bar assessment ----------------------------------------------

// Evaluate ONE bar against a frozen level. This is the only sanctioned way to test a
// trigger: the bar being tested never contributed to the level.
//   direction: 'LONG' means the trigger is broken UPWARD; 'SHORT' downward.
// Returns { penetrated, closedThrough, gapThrough, distanceAtr }:
//   penetrated  — the bar's range touched/exceeded the level (intraday penetration)
//   closedThrough — the CLOSE finished beyond the level (closing confirmation)
//   gapThrough  — the bar OPENED beyond the level (gap through the trigger)
//   distanceAtr — signed close-to-level distance in ATR (positive = beyond the level)
function assessBarVsLevel(bar, level, direction, atr) {
  if (!bar || !isNum(level) || !isNum(atr) || atr <= 0) return null;
  const long = direction !== 'SHORT';
  const penetrated = long ? bar.high >= level : bar.low <= level;
  const closedThrough = long ? bar.close > level : bar.close < level;
  const gapThrough = long ? bar.open > level : bar.open < level;
  const distanceAtr = round((long ? bar.close - level : level - bar.close) / atr, 3);
  return { penetrated, closedThrough, gapThrough, distanceAtr };
}

// ---- level provenance ----------------------------------------------------------

// Wrap a price level with the identifiers of the bars/pivots that constructed it, so a
// frozen episode can always show where its trigger came from.
function levelWithProvenance(price, type, sourceIdxs, formation) {
  if (!isNum(price)) return null;
  const dates = (sourceIdxs || [])
    .filter(i => isNum(i) && formation && formation[i])
    .map(i => formation[i].date)
    .filter(Boolean);
  return { price: round(price, 4), type, sourceBarIdxs: (sourceIdxs || []).slice(0, 12), sourceBarDates: dates.slice(0, 12) };
}

// Reward:risk from actual structural levels — never a forced constant.
function structuralRR(trigger, stop, target) {
  if (![trigger, stop, target].every(isNum)) return null;
  const risk = Math.abs(trigger - stop);
  if (risk <= 0) return null;
  return round(Math.abs(target - trigger) / risk, 2);
}

module.exports = {
  splitFormation,
  fitLine, fitTrendline, fitHorizontal,
  findPole, contractionLegs, isContracting,
  assessBarVsLevel, levelWithProvenance, structuralRR,
};
