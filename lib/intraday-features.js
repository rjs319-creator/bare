'use strict';
// STAGE-2 INTRADAY FEATURE BUILDER — point-in-time features from 5-minute session bars.
//
// Pure: bars in → features out. Uses ONLY bars at/before the evaluation instant (no future
// bars — enforced by an explicit slice, not a convention). This is what turns the daily-only
// lifecycle `ev` into a genuine current-session one: VWAP relationship, opening-range trigger
// and failure, intraday returns, residual strength vs SPY, SAME-TIME-OF-DAY relative volume
// (from the trailing-5d fetch — no extra storage), extension in ATRs, remaining reward:risk,
// consecutive-close-below-VWAP streak, and stall structure (no-new-high / lower-highs /
// fading volume). Honest fallbacks: any feature that lacks sufficient data is null, never a
// fabricated number, and callers gate on explicit presence.

const OPEN_MIN = 9 * 60 + 30;   // 09:30 ET
const CLOSE_MIN = 16 * 60;      // 16:00 ET

// ET clock-minutes since midnight for an ISO/Date (DST-safe via Intl).
function etMinutes(t) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(t));
  const get = ty => (parts.find(p => p.type === ty) || {}).value;
  let hh = parseInt(get('hour'), 10); if (hh === 24) hh = 0;
  return hh * 60 + parseInt(get('minute'), 10);
}
const minutesSinceOpen = t => etMinutes(t) - OPEN_MIN;
const etDate = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Raw Yahoo chart result → { 'YYYY-MM-DD': [{t,o,h,l,c,v}, …] } (regular hours only, sorted).
function sessionsFromResult(result) {
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const byDate = {};
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i] ?? 0;
    if (o == null || h == null || l == null || c == null) continue;
    const iso = new Date(ts[i] * 1000).toISOString();
    const m = etMinutes(iso);
    if (m < OPEN_MIN || m >= CLOSE_MIN) continue;   // regular hours only
    (byDate[etDate(iso)] ||= []).push({ t: iso, o: +o, h: +h, l: +l, c: +c, v: v || 0 });
  }
  for (const d of Object.keys(byDate)) byDate[d].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return byDate;
}

// ── Pure feature primitives ──────────────────────────────────────────────────
function vwap(bars) {
  let pv = 0, vol = 0;
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vol += b.v; }
  return vol > 0 ? pv / vol : null;
}

// Consecutive closes below the RUNNING (cumulative) VWAP, counted from the tail.
function closesBelowVwapStreak(bars) {
  let pv = 0, vol = 0; const below = [];
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vol += b.v; below.push(b.c < (vol > 0 ? pv / vol : b.c)); }
  let s = 0; for (let i = below.length - 1; i >= 0 && below[i]; i--) s++;
  return s;
}

function openingRange(bars, orMinutes) {
  const or = bars.filter(b => minutesSinceOpen(b.t) < orMinutes);
  if (!or.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of or) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
  return { high: hi, low: lo, mid: (hi + lo) / 2, width: hi - lo, bars: or.length };
}

// Fractional return over the last `minutes`, using the last close vs the close at/just before
// (now - minutes). Null if too little history.
function retOver(bars, minutes) {
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const cutoff = Date.parse(last.t) - minutes * 60000;
  let ref = null;
  for (const b of bars) { if (Date.parse(b.t) <= cutoff) ref = b; else break; }
  if (!ref) ref = bars[0];
  return ref.c > 0 ? (last.c / ref.c - 1) : null;
}

// Cumulative session volume up to `uptoMin` minutes since open.
function cumVolByTime(bars, uptoMin) {
  let s = 0; for (const b of bars) if (minutesSinceOpen(b.t) <= uptoMin) s += b.v; return s;
}

// SAME-TIME-OF-DAY relative volume: today's cumulative volume so far ÷ the AVERAGE cumulative
// volume at this same minute-of-session across prior sessions. This is the real time-of-day
// curve (not linear pacing), computed from the trailing-5d fetch. Null when there is no prior
// session to calibrate against (conservative — the caller then can't assert relVolOk).
function timeOfDayRelVol(todayBars, priorSessions, uptoMin) {
  const todayCum = cumVolByTime(todayBars, uptoMin);
  const priors = priorSessions.map(s => cumVolByTime(s, uptoMin)).filter(v => v > 0);
  if (!priors.length) return null;
  const exp = priors.reduce((a, b) => a + b, 0) / priors.length;
  return exp > 0 ? +(todayCum / exp).toFixed(2) : null;
}

// High-of-day, bars since it, distance from it (fractional, ≤ 0).
function hodStats(bars) {
  let hod = -Infinity, idx = -1;
  bars.forEach((b, i) => { if (b.h > hod) { hod = b.h; idx = i; } });
  const last = bars[bars.length - 1];
  return { hod, barsSinceHigh: bars.length - 1 - idx, distFromHod: hod > 0 ? +(last.c / hod - 1).toFixed(4) : null };
}

// Consecutive lower-highs from the tail (bar-over-bar).
function lowerHighsTail(bars) {
  let c = 0; for (let i = bars.length - 1; i > 0; i--) { if (bars[i].h < bars[i - 1].h) c++; else break; }
  return c;
}

// Volume fading: mean volume of the last 3 bars materially below the prior 3.
function volumeFading(bars) {
  if (bars.length < 6) return false;
  const avg = a => a.reduce((s, b) => s + b.v, 0) / a.length;
  return avg(bars.slice(-3)) < 0.7 * avg(bars.slice(-6, -3));
}

// Volume ACCELERATION: mean volume of the last 3 bars ÷ the prior 3 (null < 6 bars —
// honest missingness, never a fabricated 1.0). `weigh` lets dollarVolAccel reuse the math.
function volumeAccel(bars, weigh = b => b.v) {
  if (bars.length < 6) return null;
  const avg = a => a.reduce((s, b) => s + weigh(b), 0) / a.length;
  const prior = avg(bars.slice(-6, -3));
  return prior > 0 ? +(avg(bars.slice(-3)) / prior).toFixed(2) : null;
}

// Range expansion: mean high-low range of the last 3 bars ÷ the prior 10-bar mean range.
// > 1 = expanding out of compression (a release precursor); null when too little history.
function rangeExpansion(bars) {
  if (bars.length < 13) return null;
  const avgRange = a => a.reduce((s, b) => s + Math.max(0, b.h - b.l), 0) / a.length;
  const base = avgRange(bars.slice(-13, -3));
  return base > 0 ? +(avgRange(bars.slice(-3)) / base).toFixed(2) : null;
}

// Per-minute VWAP drift over roughly the last `minutes` (running-VWAP now vs running-VWAP
// then, per minute). A rising VWAP with price above it is sustained accumulation.
function vwapSlopeOver(bars, minutes = 15) {
  if (bars.length < 2) return null;
  const lastT = Date.parse(bars[bars.length - 1].t);
  const cutoff = lastT - minutes * 60000;
  let refIdx = -1;
  for (let i = 0; i < bars.length; i++) { if (Date.parse(bars[i].t) <= cutoff) refIdx = i; else break; }
  if (refIdx < 0) return null;
  const vNow = vwap(bars), vThen = vwap(bars.slice(0, refIdx + 1));
  if (vNow == null || vThen == null || !(vThen > 0)) return null;
  const elapsedMin = (lastT - Date.parse(bars[refIdx].t)) / 60000;
  return elapsedMin > 0 ? +(((vNow - vThen) / vThen) / elapsedMin).toFixed(6) : null;
}

// Slice bars to those at/before `now` — the point-in-time guard (no future bars).
function upto(bars, now) {
  const nMs = Date.parse(now);
  return bars.filter(b => Date.parse(b.t) <= nMs);
}

// ── Orchestrator: build the full point-in-time feature set ────────────────────
// Inputs are PRE-GROUPED so the math stays independent of the Yahoo shape (the route uses
// sessionsFromResult to produce todayBars/priorSessions/spyTodayBars).
//   plan     — the daily trade plan { entry, stop, target } for remaining-R:R (optional)
//   dailyAtr — the daily ATR for extension-in-ATRs (optional)
function buildIntradayFeatures({ todayBars = [], priorSessions = [], spyTodayBars = [], sectorTodayBars = [], now, dailyAtr = null, plan = null, orMinutes = 30, expireMin = 120 } = {}) {
  const nowIso = now || new Date().toISOString();
  const bars = upto(todayBars, nowIso);
  const spy = upto(spyTodayBars, nowIso);
  const nowSinceOpen = minutesSinceOpen(nowIso);

  if (bars.length < 1) {
    return { hasIntraday: false, bars: 0, nowSinceOpen, dataQuality: { reason: 'no current-session bars' } };
  }

  const last = bars[bars.length - 1];
  const vw = vwap(bars);
  const or = openingRange(bars, orMinutes);
  const orComplete = nowSinceOpen >= orMinutes && !!or;
  const openingRangeForming = nowSinceOpen < orMinutes;
  const brokeAboveOr = or ? bars.some(b => b.h > or.high) : false;
  const triggerConfirmed = !!(orComplete && or && last.c > or.high);
  const breakoutFailed = !!(orComplete && or && brokeAboveOr && last.c < or.mid);

  const mom5 = retOver(bars, 5), mom10 = retOver(bars, 10), mom15 = retOver(bars, 15), mom30 = retOver(bars, 30);
  const spy15 = retOver(spy, 15), spy30 = retOver(spy, 30);
  const residual15 = mom15 != null && spy15 != null ? +(mom15 - spy15).toFixed(4) : null;
  const residual30 = mom30 != null && spy30 != null ? +(mom30 - spy30).toFixed(4) : null;
  // Sector-benchmark residual — capability-gated: null without a sector series.
  const sector = upto(sectorTodayBars, nowIso);
  const sector15 = retOver(sector, 15);
  const residualSector15 = mom15 != null && sector15 != null ? +(mom15 - sector15).toFixed(4) : null;
  // Momentum acceleration: last-5-min pace vs the preceding 10-min pace; jerk = its change
  // vs one bar earlier (computed on the same formula over bars minus the newest).
  const momAccel = mom5 != null && mom15 != null ? +(mom5 - (mom15 - mom5) / 2).toFixed(4) : null;
  let momJerk = null;
  if (bars.length >= 2) {
    const prevBars = bars.slice(0, -1);
    const pm5 = retOver(prevBars, 5), pm15 = retOver(prevBars, 15);
    const prevAccel = pm5 != null && pm15 != null ? pm5 - (pm15 - pm5) / 2 : null;
    if (momAccel != null && prevAccel != null) momJerk = +(momAccel - prevAccel).toFixed(4);
  }

  const todRelVol = timeOfDayRelVol(bars, priorSessions, Math.min(nowSinceOpen, CLOSE_MIN - OPEN_MIN));
  const hod = hodStats(bars);
  const extensionAtr = vw != null && dailyAtr > 0 ? +((last.c - vw) / dailyAtr).toFixed(2) : null;
  const volAccel = volumeAccel(bars);
  const dollarVolAccel = volumeAccel(bars, b => b.c * b.v);
  const rangeExp = rangeExpansion(bars);
  const vwapSlope = vwapSlopeOver(bars, 15);
  const vwapDist = vw != null && vw > 0 ? +((last.c / vw) - 1).toFixed(4) : null;

  // ── SHADOW ENTRY ARCHETYPES — point-in-time structure states. These are RESEARCH/WATCH
  // annotations captured for later evaluation; NONE of them is a validated entry and none
  // may carry buy language (only the conservative 30-min ORB feeds the actionable gate
  // until an archetype passes its own evidence gate). Premarket-high breakout requires
  // premarket bars the RTH-only session grouping does not carry → capability-gated null.
  const or5 = openingRange(bars, 5);
  const or15 = openingRange(bars, 15);
  const dayRange = hod.hod > 0 ? hod.hod - bars.reduce((lo, b) => Math.min(lo, b.l), Infinity) : 0;
  const archetypes = {
    orb5: or5 && nowSinceOpen >= 5 ? { triggered: last.c > or5.high, high: +or5.high.toFixed(4) } : null,
    orb15: or15 && nowSinceOpen >= 15 ? { triggered: last.c > or15.high, high: +or15.high.toFixed(4) } : null,
    orb30: or && nowSinceOpen >= orMinutes ? { triggered: last.c > or.high, high: +or.high.toFixed(4) } : null,
    premarketHighBreak: null,   // capability-gated: no premarket bars on this feed
    vwapReclaim: vw != null && bars.length >= 3
      ? { triggered: last.c > vw && bars[bars.length - 2].c > 0 && bars.slice(0, -2).some(b => b.c < vw) && bars[bars.length - 2].c <= vw }
      : null,
    firstPullback: (hod.barsSinceHigh >= 1 && hod.barsSinceHigh <= 6 && vw != null && last.c > vw
      && dayRange > 0 && hod.distFromHod != null && Math.abs(hod.distFromHod) * last.c <= 0.5 * dayRange)
      ? { triggered: true, barsSinceHigh: hod.barsSinceHigh } : { triggered: false },
    compressionRelease: rangeExp != null ? { triggered: rangeExp >= 1.8 && (volAccel ?? 0) >= 1.5, rangeExpansion: rangeExp } : null,
  };
  const remainingRR = plan && plan.target != null && plan.stop != null && last.c - plan.stop > 0
    ? +((plan.target - last.c) / (last.c - plan.stop)).toFixed(2) : null;
  const expired = !triggerConfirmed && !brokeAboveOr && nowSinceOpen > expireMin;

  return {
    hasIntraday: true,
    bars: bars.length,
    nowSinceOpen,
    asOf: last.t,                       // timestamp of the newest bar used — current-session proof
    dailyAtr: dailyAtr > 0 ? dailyAtr : null,   // carried through so callers can ATR-normalize the loss from detection
    last: +last.c.toFixed(4),
    vwap: vw != null ? +vw.toFixed(4) : null,
    aboveVwap: vw != null ? last.c > vw : null,
    openingRange: or,
    orComplete,
    openingRangeForming,
    triggerConfirmed,
    breakoutFailed,
    // mom1/mom2 are genuinely unavailable on 5-minute bars — explicit null, never derived.
    mom1: null, mom2: null,
    mom5, mom10, mom15, mom30, momAccel, momJerk,
    residual15, residual30, residualSector15,
    timeOfDayRelVol: todRelVol,
    volAccel, dollarVolAccel,
    rangeExpansion: rangeExp,
    vwapDist, vwapSlope,
    distFromHod: hod.distFromHod,
    barsSinceHigh: hod.barsSinceHigh,
    lowerHighs: lowerHighsTail(bars),
    volumeFading: volumeFading(bars),
    closesBelowVwapStreak: closesBelowVwapStreak(bars),
    extensionAtr,
    remainingRR,
    expired,
    archetypes,
    schemaVersion: require('./intraday-schema').FEATURE_SCHEMA_VERSION,
    dataQuality: {
      spyMatched: residual15 != null,
      sectorMatched: residualSector15 != null,
      timeOfDayRelVolAvailable: todRelVol != null,
      priorSessions: priorSessions.length,
      barIntervalMin: 5,
      subFiveMinReturnsAvailable: false,   // mom1/mom2 capability flag
    },
  };
}

module.exports = {
  OPEN_MIN, CLOSE_MIN, etMinutes, minutesSinceOpen, etDate,
  sessionsFromResult, vwap, closesBelowVwapStreak, openingRange, retOver,
  timeOfDayRelVol, hodStats, lowerHighsTail, volumeFading, volumeAccel, rangeExpansion,
  vwapSlopeOver, upto, buildIntradayFeatures,
};
