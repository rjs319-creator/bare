'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — return-path continuity. PURE.
//
// Works on ANY daily-return path: absolute, market-relative, sector-relative
// or residual (the caller supplies the series). Zero/negative denominators
// return null with availability flags — never a fabricated 0.
//
// Information discreteness follows Da/Gurun/Warachka:
//   ID = sign(formationReturn) × (negDayPct − posDayPct)
// For a positive formation, MORE NEGATIVE ID ⇒ gradual accumulation.
// Theil–Sen slope is reused from lib/patterns/structure.fitLine (the repo's
// single robust regression) — not re-implemented.
// ═══════════════════════════════════════════════════════════════════════════

const { fitLine } = require('../patterns/structure');

const isNum = (x) => Number.isFinite(x);

/** ID over a window of daily returns; formationReturn compounded from them. */
function informationDiscreteness(rets) {
  const r = (rets || []).filter(isNum);
  const n = r.length;
  if (n < 10) return { available: false, n };
  let pos = 0, neg = 0, cum = 1;
  for (const x of r) { if (x > 0) pos++; else if (x < 0) neg++; cum *= 1 + x; }
  const formationReturn = cum - 1;
  if (formationReturn === 0) return { available: false, n, formationReturn };
  const id = Math.sign(formationReturn) * (neg / n - pos / n);
  return {
    available: true,
    n,
    formationReturn,
    id,
    // 0..1, higher = more continuous, defined for positive formations.
    continuity: formationReturn > 0 ? Math.max(0, Math.min(1, (1 - id) / 2 + 0.25)) : null,
    posDayPct: pos / n,
    negDayPct: neg / n,
  };
}

/** Kaufman-style efficiency plus an upside-only variant (declines score 0). */
function efficiency(rets) {
  const r = (rets || []).filter(isNum);
  if (r.length < 5) return { available: false };
  let net = 0, gross = 0, upNet = 0;
  for (const x of r) { net += x; gross += Math.abs(x); if (x > 0) upNet += x; }
  if (!(gross > 0)) return { available: false };
  return {
    available: true,
    efficiency: Math.abs(net) / gross,
    upsideEfficiency: net > 0 ? net / gross : 0,
  };
}

/** Concentration of the positive returns: top-1/top-3 share + Herfindahl. */
function concentration(rets) {
  const pos = (rets || []).filter((x) => isNum(x) && x > 0).sort((a, b) => b - a);
  const sum = pos.reduce((s, x) => s + x, 0);
  if (!(sum > 0)) return { available: false };
  const top1 = pos[0] / sum;
  const top3 = pos.slice(0, 3).reduce((s, x) => s + x, 0) / sum;
  const hhi = pos.reduce((s, x) => s + (x / sum) ** 2, 0);
  return { available: true, top1Share: top1, top3Share: top3, herfindahl: hhi, positiveDays: pos.length };
}

/**
 * Overnight-gap dependence from BARS (needs open+prior close), over the last
 * `win` sessions: share of gross movement due to gaps, plus the largest and
 * top-3 positive-gap contributions to the summed positive gaps+intraday moves.
 */
function gapStats(bars, win) {
  const w = (bars || []).slice(-(win + 1));
  if (w.length < 11) return { available: false };
  let gapAbs = 0, grossAbs = 0;
  const posMoves = [];
  const posGaps = [];
  for (let i = 1; i < w.length; i++) {
    const pc = w[i - 1].c, o = w[i].o, c = w[i].c;
    if (!(pc > 0) || !(o > 0) || !(c > 0)) continue;
    const gap = o / pc - 1;
    const day = c / pc - 1;
    gapAbs += Math.abs(gap);
    grossAbs += Math.abs(day);
    if (day > 0) posMoves.push(day);
    if (gap > 0) posGaps.push(gap);
  }
  if (!(grossAbs > 0)) return { available: false };
  const posSum = posMoves.reduce((s, x) => s + x, 0);
  posGaps.sort((a, b) => b - a);
  return {
    available: true,
    gapDependence: Math.min(1, gapAbs / grossAbs),
    largestGapContribution: posSum > 0 && posGaps.length ? posGaps[0] / posSum : null,
    top3GapContribution: posSum > 0 && posGaps.length
      ? Math.min(1, posGaps.slice(0, 3).reduce((s, x) => s + x, 0) / posSum) : null,
  };
}

/** Largest 5-session block's share of the summed positive weekly returns. */
function largestWeekContribution(rets) {
  const r = (rets || []).filter(isNum);
  if (r.length < 15) return null;
  const weeks = [];
  for (let i = r.length; i - 5 >= 0; i -= 5) {
    let cum = 1;
    for (const x of r.slice(i - 5, i)) cum *= 1 + x;
    weeks.push(cum - 1);
  }
  const pos = weeks.filter((x) => x > 0);
  const sum = pos.reduce((s, x) => s + x, 0);
  return sum > 0 ? Math.max(...pos) / sum : null;
}

/**
 * Robust fit of a LEVEL path (prices or a cumulative-residual index):
 * Theil–Sen slope (per session, normalized by median level), OLS R², robust
 * fit share (% of points within half a channel width of the robust line),
 * and the channel width itself (max |residual| around the robust line,
 * normalized). O(n²) pairwise slopes — callers cap n (≤ ~130) for the full
 * universe and use longer windows only on the candidate buffer.
 */
function robustPathFit(levels) {
  const ys = (levels || []).filter((v) => isNum(v));
  const n = ys.length;
  if (n < 8) return { available: false };
  const pts = ys.map((y, i) => ({ x: i, y }));
  const line = fitLine(pts);
  if (!line) return { available: false };
  const med = ys.slice().sort((a, b) => a - b)[Math.floor(n / 2)];
  const scale = Math.abs(med) > 1e-9 ? Math.abs(med) : 1;
  let maxAbs = 0;
  const resid = pts.map((p) => {
    const e = p.y - line.at(p.x);
    if (Math.abs(e) > maxAbs) maxAbs = Math.abs(e);
    return e;
  });
  const channelWidth = (2 * maxAbs) / scale;
  const tol = maxAbs / 2;
  const near = resid.filter((e) => Math.abs(e) <= tol).length / n;
  // OLS R² against the same points for a comparable goodness-of-fit.
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const denom = n * sxx - sx * sx;
  let r2 = null;
  if (denom > 0) {
    const b1 = (n * sxy - sx * sy) / denom;
    const my = sy / n, b0 = my - b1 * (sx / n);
    let ssT = 0, ssR = 0;
    for (let i = 0; i < n; i++) { ssT += (ys[i] - my) ** 2; ssR += (ys[i] - (b0 + b1 * i)) ** 2; }
    r2 = ssT > 0 ? 1 - ssR / ssT : null;
  }
  return {
    available: true,
    robustSlope: line.slope / scale,   // per-session, level-normalized
    olsR2: r2,
    channelWidth,
    pctNearTrend: near,
    n,
  };
}

/**
 * Continuity bundle for one path over one window.
 * `rets` = daily returns of the path; `levels` = the path's level series
 * (same window); `bars` optional for gap stats (absolute paths only).
 */
function continuityBundle({ rets, levels, bars = null, window }) {
  const r = (rets || []).slice(-window);
  const lv = (levels || []).slice(-(window + 1));
  return {
    window,
    discreteness: informationDiscreteness(r),
    efficiency: efficiency(r),
    concentration: concentration(r),
    gaps: bars ? gapStats(bars, window) : { available: false, reason: 'no-bars' },
    largestWeekContribution: largestWeekContribution(r),
    fit: robustPathFit(lv),
  };
}

module.exports = {
  informationDiscreteness, efficiency, concentration, gapStats,
  largestWeekContribution, robustPathFit, continuityBundle,
};
