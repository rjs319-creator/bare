'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — absolute multi-horizon trend features. PURE: bars in, numbers out.
//
// Bars are normalized ascending [{date,o,h,l,c,v}] (atlasx-residual.toBars
// shape; adjusted close preferred upstream). A horizon whose history is not
// fully present returns null features with available:false — short history is
// a support downgrade, never imputed.
// ═══════════════════════════════════════════════════════════════════════════

const { HORIZONS } = require('./config');

const isNum = (x) => Number.isFinite(x);

function closes(bars) { return bars.map((b) => b.c); }

function dailyReturns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1].c, c = bars[i].c;
    if (p > 0 && c > 0) out.push(c / p - 1);
  }
  return out;
}

// OLS slope + R² on log closes, slope normalized to %/session.
function trendFit(values) {
  const ys = values.filter((v) => v > 0).map(Math.log);
  const n = ys.length;
  if (n < 3) return { slope: null, r2: null };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; sxx += i * i; sxy += i * ys[i]; }
  const denom = n * sxx - sx * sx;
  if (!(denom > 0)) return { slope: null, r2: null };
  const slope = (n * sxy - sx * sy) / denom;
  const my = sy / n, mx = sx / n;
  const b0 = my - slope * mx;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - my) ** 2;
    ssRes += (ys[i] - (b0 + slope * i)) ** 2;
  }
  return { slope, r2: ssTot > 0 ? 1 - ssRes / ssTot : null };
}

// Max drawdown (as a negative fraction) and max recovery off the trough.
function drawdownStats(values) {
  let peak = -Infinity, trough = Infinity, maxDD = 0, maxRec = 0;
  for (const v of values) {
    if (!(v > 0)) continue;
    if (v > peak) { peak = v; trough = v; }
    if (v < trough) trough = v;
    if (peak > 0) maxDD = Math.min(maxDD, v / peak - 1);
    if (trough > 0) maxRec = Math.max(maxRec, v / trough - 1);
  }
  return { maxDrawdown: peak === -Infinity ? null : maxDD, maxRecovery: peak === -Infinity ? null : maxRec };
}

// Weekly (5-session block) positive fraction over the window.
function positiveWeekPct(rets) {
  if (rets.length < 5) return null;
  let pos = 0, n = 0;
  for (let i = rets.length; i - 5 >= 0; i -= 5) {
    let cum = 1;
    for (const r of rets.slice(i - 5, i)) cum *= 1 + r;
    if (cum - 1 > 0) pos++;
    n++;
  }
  return n ? pos / n : null;
}

/** Features for one horizon h. Requires h+1 bars; else available:false. */
function horizonFeatures(bars, h) {
  if (!bars || bars.length < h + 1) {
    return { available: false, h };
  }
  const win = bars.slice(-(h + 1));
  const cl = closes(win);
  const rets = dailyReturns(win);
  const start = cl[0], end = cl[cl.length - 1];
  if (!(start > 0) || !(end > 0)) return { available: false, h };

  const totalReturn = end / start - 1;
  const logReturn = Math.log(end / start);
  const m = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
  const sd = rets.length > 2
    ? Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1))
    : null;
  const volAdjReturn = sd > 0 ? totalReturn / (sd * Math.sqrt(h)) : null;

  // Acceleration: recent-half per-session pace minus full-window pace.
  const half = Math.max(2, Math.floor(h / 2));
  const halfWin = cl.slice(-(half + 1));
  const halfRet = halfWin[0] > 0 ? halfWin[halfWin.length - 1] / halfWin[0] - 1 : null;
  const accel = halfRet != null ? halfRet / half - totalReturn / h : null;

  const hi = Math.max(...cl);
  const hiIdx = cl.lastIndexOf(hi);
  const fit = trendFit(cl);
  const dd = drawdownStats(cl);
  const posDays = rets.filter((r) => r > 0).length;

  return {
    available: true,
    h,
    totalReturn,
    logReturn,
    volAdjReturn,
    accel,                                   // >0 accelerating, <0 decelerating
    maxDrawdown: dd.maxDrawdown,
    maxRecovery: dd.maxRecovery,
    posDayPct: rets.length ? posDays / rets.length : null,
    posWeekPct: positiveWeekPct(rets),
    slope: fit.slope,
    fit: fit.r2,
    distFromHigh: hi > 0 ? end / hi - 1 : null,
    daysSinceHigh: cl.length - 1 - hiIdx,
  };
}

/** Traditional skip-period momentum: bar −252 → bar −21. Needs 253 bars. */
function skipMomentum(bars) {
  if (!bars || bars.length < 253) return null;
  const cl = closes(bars);
  const a = cl[cl.length - 1 - 252], b = cl[cl.length - 1 - 21];
  return a > 0 && b > 0 ? b / a - 1 : null;
}

function sma(cl, n, endIdx) {
  if (endIdx + 1 < n) return null;
  let s = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) s += cl[i];
  return s / n;
}

/** SMA ladder: level, distance, slope (10-session), alignment, time-above. */
function smaLadder(bars) {
  const cl = closes(bars);
  const last = cl.length - 1;
  const out = { available: cl.length >= 20, byN: {}, aligned: null, alignScore: null, pctAboveRising20: null, pctAboveRising50: null };
  const ns = [5, 10, 20, 50, 100, 200];
  for (const n of ns) {
    const now = sma(cl, n, last);
    const prev = sma(cl, n, last - 10);
    out.byN[n] = {
      value: now,
      dist: now > 0 ? cl[last] / now - 1 : null,
      slope: now != null && prev > 0 ? now / prev - 1 : null,
    };
  }
  const l = out.byN;
  if (l[20].value != null && l[50].value != null) {
    const chain = [cl[last], l[5].value, l[10].value, l[20].value, l[50].value, l[100].value, l[200].value]
      .filter((v) => v != null);
    let ok = 0;
    for (let i = 1; i < chain.length; i++) if (chain[i - 1] >= chain[i]) ok++;
    out.alignScore = chain.length > 1 ? ok / (chain.length - 1) : null;
    out.aligned = out.alignScore != null ? out.alignScore >= 0.99 : null;
  }
  // % of the last 63 sessions spent above a rising SMA(n).
  for (const [n, key] of [[20, 'pctAboveRising20'], [50, 'pctAboveRising50']]) {
    if (cl.length < n + 63 + 10) continue;
    let hit = 0, tot = 0;
    for (let i = last - 62; i <= last; i++) {
      const s0 = sma(cl, n, i), s1 = sma(cl, n, i - 5);
      if (s0 == null || s1 == null) continue;
      tot++;
      if (cl[i] > s0 && s0 > s1) hit++;
    }
    out[key] = tot ? hit / tot : null;
  }
  return out;
}

/** Higher-high / higher-low structure using rolling 3-bar extremes. */
function hhhlStructure(bars, win = 63) {
  const w = bars.slice(-(win + 3));
  if (w.length < 12) return { available: false };
  let hh = 0, hl = 0, n = 0;
  for (let i = 6; i < w.length; i += 3) {
    const curH = Math.max(w[i - 2].h, w[i - 1].h, w[i].h);
    const prvH = Math.max(w[i - 5].h, w[i - 4].h, w[i - 3].h);
    const curL = Math.min(w[i - 2].l, w[i - 1].l, w[i].l);
    const prvL = Math.min(w[i - 5].l, w[i - 4].l, w[i - 3].l);
    if (isNum(curH) && isNum(prvH)) { n++; if (curH > prvH) hh++; }
    if (isNum(curL) && isNum(prvL) && curL > prvL) hl++;
  }
  return n ? { available: true, higherHighPct: hh / n, higherLowPct: hl / n } : { available: false };
}

/**
 * Inspectable horizon agreement over a byHorizon map of horizonFeatures.
 * signAgreement: fraction of available horizons with positive total return.
 * orderly: fraction of adjacent available pairs where the shorter horizon's
 * per-session pace ≥ the longer one's (a fresh trend front-loads).
 */
function horizonAgreement(byHorizon, horizons = HORIZONS) {
  const avail = horizons.map((h) => byHorizon[h]).filter((f) => f && f.available);
  if (avail.length < 2) return { available: false };
  const pos = avail.filter((f) => f.totalReturn > 0).length;
  let ord = 0, pairs = 0;
  for (let i = 1; i < avail.length; i++) {
    const a = avail[i - 1], b = avail[i];
    pairs++;
    if (a.totalReturn / a.h >= b.totalReturn / b.h) ord++;
  }
  return {
    available: true,
    horizonsUsed: avail.map((f) => f.h),
    signAgreement: pos / avail.length,
    paceOrdering: pairs ? ord / pairs : null,
    score: 0.7 * (pos / avail.length) + 0.3 * (pairs ? ord / pairs : 0),
  };
}

/** Full absolute-trend bundle for one name. */
function absoluteTrend(bars) {
  const byHorizon = {};
  for (const h of HORIZONS) byHorizon[h] = horizonFeatures(bars, h);
  return {
    byHorizon,
    skipMomentum: skipMomentum(bars),
    sma: smaLadder(bars),
    structure: hhhlStructure(bars),
    agreement: horizonAgreement(byHorizon),
  };
}

module.exports = {
  absoluteTrend, horizonFeatures, skipMomentum, smaLadder, hhhlStructure,
  horizonAgreement, trendFit, drawdownStats, dailyReturns,
};
