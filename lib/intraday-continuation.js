'use strict';
// STAGE 2 — INTRADAY STRUCTURE. What the five-minute chart is actually saying.
//
// NO NETWORK. NO LLM. Bars in, structure out. That constraint is what makes this testable
// against fixtures and what keeps it out of the live-scoring prohibition on model calls.
//
// The job is to separate five things the old system could not tell apart:
//   early ignition · orderly continuation · failed breakout · distribution · exhaustion
// Those look similar on a daily bar (all "up a lot on volume") and completely different on a
// five-minute chart. Confusing them is the single biggest reason a screener shows names that
// then go straight down.
//
// THE COMPLETED-BAR RULE. Every confirmation here uses COMPLETED bars only. A forming bar
// trading above resistance is a BREAKOUT_ATTEMPT and can never become BREAKOUT_CONFIRMED
// until its interval closes. This is the difference between "the price touched $4.85" and
// "the five-minute bar closed at $4.85 on volume", and it is the difference between a trade
// and a wick.
//
// RESISTANCE IS POINT-IN-TIME. The level a breakout is measured against is computed from bars
// STRICTLY BEFORE the bar being judged — never from the session high including the breakout
// bar itself, which would make every up-bar a "breakout".

const { STRUCTURE, CONTINUATION_VERSION, SCHEMA_VERSION, ENTRY } = require('./lowfloat-config');
const feat = require('./intraday-features');

const STRUCTURE_STATES = Object.freeze({
  WATCH: 'WATCH',
  EARLY_IGNITION: 'EARLY_IGNITION',
  CONSTRUCTIVE_PULLBACK: 'CONSTRUCTIVE_PULLBACK',
  COMPRESSION: 'COMPRESSION',
  BREAKOUT_PENDING: 'BREAKOUT_PENDING',
  BREAKOUT_ATTEMPT: 'BREAKOUT_ATTEMPT',
  BREAKOUT_CONFIRMED: 'BREAKOUT_CONFIRMED',
  BREAKOUT_RETEST: 'BREAKOUT_RETEST',
  FAILED_BREAKOUT: 'FAILED_BREAKOUT',
  DISTRIBUTION: 'DISTRIBUTION',
  EXHAUSTED: 'EXHAUSTED',
  STALE_DATA: 'STALE_DATA',
});

// States that mean the setup is broken. Recovering out of one of these requires
// STRUCTURE.RECOVERY_CONFIRM_EVALS consecutive constructive evaluations (hysteresis), so a
// single green bar cannot un-fail a failed breakout.
const DESTRUCTIVE_STATES = new Set([
  STRUCTURE_STATES.FAILED_BREAKOUT, STRUCTURE_STATES.DISTRIBUTION, STRUCTURE_STATES.EXHAUSTED,
]);
const CONSTRUCTIVE_STATES = new Set([
  STRUCTURE_STATES.EARLY_IGNITION, STRUCTURE_STATES.CONSTRUCTIVE_PULLBACK, STRUCTURE_STATES.COMPRESSION,
  STRUCTURE_STATES.BREAKOUT_PENDING, STRUCTURE_STATES.BREAKOUT_CONFIRMED, STRUCTURE_STATES.BREAKOUT_RETEST,
]);

const finite = v => Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (a, b) => (finite(a) && finite(b) && b > 0 ? ((a / b) - 1) * 100 : null);

// ── Pivot detection (ATR-aware) ──────────────────────────────────────────────
// A "higher low" one cent above the last one is noise. Pivots must clear a NOISE FLOOR scaled
// to the name's own five-minute range, so the same rule works on a $3 biotech with 8% swings
// and a $40 industrial with 0.4% swings.
function noiseFloor(bars, atr5m) {
  if (finite(atr5m) && atr5m > 0) return atr5m * 0.25;
  if (!bars.length) return 0;
  const avgRange = bars.reduce((s, b) => s + Math.max(0, b.h - b.l), 0) / bars.length;
  return avgRange * 0.25;
}

// Swing pivots via a 1-bar fractal with a noise floor. Returns { highs:[{i,price}], lows:[...] }.
function findPivots(bars, floor) {
  const highs = [], lows = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const p = bars[i - 1], c = bars[i], n = bars[i + 1];
    if (c.h - Math.max(p.h, n.h) >= floor) highs.push({ i, price: c.h, t: c.t });
    if (Math.min(p.l, n.l) - c.l >= floor) lows.push({ i, price: c.l, t: c.t });
  }
  return { highs, lows };
}

// Average true range over five-minute bars — the volatility unit for every distance in this
// module (stops, extension, chase ceilings).
function atr5m(bars, period = 14) {
  if (!bars || bars.length < 2) return null;
  let sum = 0, n = 0;
  for (let i = Math.max(1, bars.length - period); i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    n++;
  }
  return n ? +(sum / n).toFixed(4) : null;
}

function ema(values, period) {
  if (!values || !values.length) return null;
  const k = 2 / (period + 1);
  const start = Math.max(0, values.length - period * 4);
  let e = values[start];
  for (let i = start + 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return +e.toFixed(4);
}

// Slope of an EMA over the last `look` bars, expressed per bar as a fraction of price.
function emaSlope(values, period, look = 3) {
  if (!values || values.length < look + 1) return null;
  const now = ema(values, period);
  const then = ema(values.slice(0, -look), period);
  if (!finite(now) || !finite(then) || !(then > 0)) return null;
  return +(((now - then) / then) / look).toFixed(6);
}

// ── PRIOR RESISTANCE (point-in-time) ─────────────────────────────────────────
// The level that must be broken, measured WITHOUT the bar being judged. Prefers the most
// recent meaningful swing high; falls back to the high of all bars before the last one.
function priorResistance(bars, floor) {
  if (bars.length < 3) return null;
  const before = bars.slice(0, -1);
  const { highs } = findPivots(before, floor);
  if (highs.length) {
    // The highest pivot in the recent window is the level the market is actually watching.
    const recent = highs.slice(-6);
    return +Math.max(...recent.map(h => h.price)).toFixed(4);
  }
  return +Math.max(...before.map(b => b.h)).toFixed(4);
}

// ── THE BREAKOUT BAR, AND THE LEVEL IT BROKE ─────────────────────────────────
// A retest must be measured against the level that was ACTUALLY broken, not against the new
// high the breakout itself printed. Using the current resistance for that is a subtle but
// fatal error: after a breakout, the "resistance" becomes the breakout bar's own high, and a
// perfectly normal retest of the old level then looks like a name 4% below resistance rather
// than one holding the level it just cleared.
//
// So: walk back through the recent bars for the most recent one that closed above the
// resistance computed from the bars BEFORE it. That bar is the breakout; the resistance it
// cleared is the retest level. Both are point-in-time by construction.
function findBreakoutBar(bars, floor, { lookback = 8 } = {}) {
  const start = Math.max(2, bars.length - lookback);
  for (let i = bars.length - 1; i >= start; i--) {
    const before = bars.slice(0, i);
    if (before.length < 3) continue;
    const level = priorResistance([...before, bars[i]], floor);
    if (level != null && bars[i].c > level) {
      return { index: i, level, bar: bars[i] };
    }
  }
  return null;
}

// ── FEATURES ─────────────────────────────────────────────────────────────────
// `bars` MUST already be completed regular-session bars for the current date (lib/intraday-data
// does that split). `context` carries the forming bar, freshness and the daily ATR.
function calculateIntradayFeatures(bars, context = {}) {
  const b = Array.isArray(bars) ? bars : [];
  const now = context.now ? new Date(context.now) : new Date();
  const forming = context.formingBar || null;

  if (b.length < 1) {
    return {
      hasStructure: false, bars: 0,
      reason: 'no completed current-session bars',
      minutesUntilClose: minutesUntilCloseAt(now),
      sessionWindow: sessionWindowAt(now),
    };
  }

  const closes = b.map(x => x.c);
  const last = b[b.length - 1];
  const price = last.c;
  const a5 = atr5m(b);
  const floor = noiseFloor(b, a5);

  // VWAP structure.
  const sessionVwap = feat.vwap(b);
  const vwapSlope = feat.vwapSlopeOver(b, 15);
  const barsAboveVwapRatio = (() => {
    let pv = 0, vol = 0, above = 0;
    for (const x of b) {
      const tp = (x.h + x.l + x.c) / 3; pv += tp * x.v; vol += x.v;
      if (vol > 0 && x.c > pv / vol) above++;
    }
    return b.length ? +(above / b.length).toFixed(3) : null;
  })();
  const vwapDistancePct = pct(price, sessionVwap);
  const vwapExtensionAtr = finite(sessionVwap) && finite(a5) && a5 > 0 ? +((price - sessionVwap) / a5).toFixed(2) : null;

  // EMA structure.
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const ema9Slope = emaSlope(closes, 9);
  const ema21Slope = emaSlope(closes, 21);
  const emaStacked = finite(e9) && finite(e21) ? price > e9 && e9 > e21 : null;

  // High/low of day and drawdown.
  const dayHigh = Math.max(...b.map(x => x.h));
  const dayLow = Math.min(...b.map(x => x.l));
  const distanceFromHighPct = pct(price, dayHigh);
  const drawdownFromHighPct = distanceFromHighPct;   // same quantity, named per the spec
  const barsSinceHigh = (() => {
    let idx = 0; b.forEach((x, i) => { if (x.h >= dayHigh - 1e-9) idx = i; });
    return b.length - 1 - idx;
  })();

  // Pivot structure.
  const { highs, lows } = findPivots(b, floor);
  const consecutiveHigherLows = (() => {
    let n = 0;
    for (let i = lows.length - 1; i > 0; i--) { if (lows[i].price > lows[i - 1].price) n++; else break; }
    return n;
  })();
  const higherLowRatio = lows.length > 1
    ? +(lows.slice(1).filter((l, i) => l.price > lows[i].price).length / (lows.length - 1)).toFixed(2)
    : null;
  const lowerHighCount = (() => {
    let n = 0;
    for (let i = highs.length - 1; i > 0; i--) { if (highs[i].price < highs[i - 1].price) n++; else break; }
    return n;
  })();
  const supportSlope = slopeOf(lows.slice(-3));
  const resistanceSlope = slopeOf(highs.slice(-3));

  // COMPRESSION RATIO = recent range ÷ earlier range. Below 1 means the range is CONTRACTING.
  // (feat.rangeExpansion returns exactly that ratio; inverting it would make a tightly coiled
  // name score as an expanding one, which is the opposite of what the state machine needs.)
  const compressionRatio = feat.rangeExpansion(b);

  // Volume.
  const volumeAcceleration = feat.volumeAccel(b);
  const recentAvgVol = b.length >= 4 ? b.slice(-4, -1).reduce((s, x) => s + x.v, 0) / 3 : null;
  const lastBarVolMult = finite(recentAvgVol) && recentAvgVol > 0 ? +(last.v / recentAvgVol).toFixed(2) : null;

  // Upper-wick rejection near resistance: the share of the last three bars that closed in the
  // bottom of their range while probing higher.
  const upperWickRisk = (() => {
    const recent = b.slice(-3);
    if (recent.length < 2) return false;
    const rejects = recent.filter(x => {
      const range = x.h - x.l;
      if (!(range > 0)) return false;
      return (x.h - x.c) / range >= STRUCTURE.UPPER_WICK_RATIO;
    }).length;
    return rejects >= 2;
  })();

  // Pullback quality: depth from the high, duration, whether volume contracted, and whether
  // it is holding structure.
  const pullback = assessPullback(b, { dayHigh, dayLow, sessionVwap, e9, floor });

  // Resistance the next breakout must clear (point-in-time).
  const resistance = priorResistance(b, floor);

  // Breakout geometry on the LAST COMPLETED bar.
  const brokeAbove = finite(resistance) ? last.c > resistance : false;
  const closedUpperHalf = last.h > last.l ? (last.c - last.l) / (last.h - last.l) >= STRUCTURE.BREAKOUT_UPPER_HALF : false;
  const volumeConfirmed = finite(lastBarVolMult) ? lastBarVolMult >= STRUCTURE.BREAKOUT_CONFIRM_VOL_MULT : false;
  const tradedAboveButClosedBelow = finite(resistance) ? (last.h > resistance && last.c <= resistance) : false;

  // The breakout that already happened, and the level it cleared — the anchor for a retest.
  const breakout = findBreakoutBar(b, floor);
  const retestLevel = breakout && breakout.index < b.length - 1 ? breakout.level : null;
  const barsSinceBreakout = breakout ? b.length - 1 - breakout.index : null;
  const priorBarClosedAbove = !!(breakout && breakout.index < b.length - 1);
  // Has price actually LOST the level it broke? A pullback that stays above the level is a
  // retest, not a failure — testing only "did a prior bar close above" would brand every
  // healthy pullback after a breakout as a failed breakout.
  const lostBrokenLevel = finite(retestLevel) ? price < retestLevel : false;
  // RETEST VOLUME must be compared against the BREAKOUT bar, not a rolling window that still
  // contains it. A window including the breakout bar always reads as "expanding", which would
  // reject every genuine low-volume retest.
  const postBreakoutBars = breakout ? b.slice(breakout.index + 1) : [];
  const retestVolumeContracted = breakout && postBreakoutBars.length
    ? (postBreakoutBars.reduce((s, x) => s + x.v, 0) / postBreakoutBars.length) < (breakout.bar.v || 0) * 0.75
    : null;

  // PARABOLIC RUN — the advance off the session low. This is the exhaustion measure that
  // survives when VWAP- and ATR-normalized ones do not: in a true parabola the newest bars
  // dominate BOTH the volume-weighted average price and the ATR, so extension measured
  // against either quietly shrinks exactly when the move is most extended.
  const sessionRunPct = finite(dayLow) && dayLow > 0 ? +(((price / dayLow) - 1) * 100).toFixed(2) : null;

  // The FORMING bar, labelled as provisional evidence only.
  const formingAboveResistance = forming && finite(resistance) ? forming.h > resistance : false;

  return {
    hasStructure: true,
    bars: b.length,
    price: +price.toFixed(4),
    lastBarAt: last.t,
    dayHigh: +dayHigh.toFixed(4),
    dayLow: +dayLow.toFixed(4),
    priorResistance: resistance,
    sessionVwap: finite(sessionVwap) ? +sessionVwap.toFixed(4) : null,
    ema9: e9, ema21: e21, emaStacked,
    atr5m: a5,
    distanceFromHighPct: finite(distanceFromHighPct) ? +distanceFromHighPct.toFixed(2) : null,
    drawdownFromHighPct: finite(drawdownFromHighPct) ? +drawdownFromHighPct.toFixed(2) : null,
    barsSinceHigh,
    higherLowRatio, consecutiveHigherLows, lowerHighCount,
    supportSlope, resistanceSlope,
    compressionRatio,
    volumeAcceleration, lastBarVolMult,
    barsAboveVwapRatio, vwapSlope, vwapDistancePct, vwapExtensionAtr,
    ema9Slope, ema21Slope,
    upperWickRisk,
    pullbackQuality: pullback.quality,
    pullbackDetail: pullback,
    brokeAbove, closedUpperHalf, volumeConfirmed, tradedAboveButClosedBelow, priorBarClosedAbove,
    retestLevel, barsSinceBreakout, lostBrokenLevel, retestVolumeContracted, sessionRunPct,
    formingAboveResistance,
    formingBarPresent: !!forming,
    minutesUntilClose: minutesUntilCloseAt(now),
    minutesSinceOpen: feat.minutesSinceOpen(now.toISOString()),
    sessionWindow: sessionWindowAt(now),
    dailyAtr: context.dailyAtr ?? null,
  };
}

// Least-squares slope of pivot prices against their bar index, normalized by price.
function slopeOf(points) {
  if (!points || points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.i, 0) / n;
  const my = points.reduce((s, p) => s + p.price, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.i - mx) * (p.price - my); den += (p.i - mx) ** 2; }
  if (!(den > 0) || !(my > 0)) return null;
  return +((num / den) / my).toFixed(5);
}

// Pullback assessment: depth, duration, volume contraction, recovery, structural support.
function assessPullback(bars, { dayHigh, dayLow, sessionVwap, e9, floor }) {
  const last = bars[bars.length - 1];
  const range = dayHigh - dayLow;
  if (!(range > 0)) return { quality: null, reason: 'no session range' };
  const depthPct = +(((dayHigh - last.c) / range) * 100).toFixed(1);
  // Bars since the high = duration of the pullback.
  let hiIdx = 0; bars.forEach((b, i) => { if (b.h >= dayHigh - 1e-9) hiIdx = i; });
  const duration = bars.length - 1 - hiIdx;
  if (duration === 0) return { quality: null, depthPct: 0, duration: 0, reason: 'at the high — not a pullback' };

  const since = bars.slice(hiIdx + 1);
  const beforeWindow = bars.slice(Math.max(0, hiIdx - since.length), hiIdx + 1);
  const avg = arr => (arr.length ? arr.reduce((s, b) => s + b.v, 0) / arr.length : 0);
  const volContracted = avg(beforeWindow) > 0 ? avg(since) < 0.8 * avg(beforeWindow) : null;
  const holdingVwap = Number.isFinite(sessionVwap) ? last.c > sessionVwap : null;
  const holdingEma = Number.isFinite(e9) ? last.c > e9 - floor : null;
  const recovering = since.length >= 2 ? last.c > since[since.length - 2].c : null;

  // 0-100. A shallow, short, low-volume dip that holds VWAP and is turning up is the ideal.
  let q = 100;
  q -= clamp(depthPct - 15, 0, 60);                        // depth beyond 15% of range costs
  q -= clamp((duration - 3) * 5, 0, 25);                    // long grinding pullbacks cost
  if (volContracted === false) q -= 20;
  if (holdingVwap === false) q -= 25;
  if (holdingEma === false) q -= 10;
  if (recovering === true) q += 10;
  return {
    quality: Math.round(clamp(q, 0, 100)),
    depthPct, duration, volContracted, holdingVwap, holdingEma, recovering,
    tooDeep: depthPct > STRUCTURE.PULLBACK_MAX_DEPTH_PCT,
  };
}

function minutesUntilCloseAt(now) {
  return Math.max(0, feat.CLOSE_MIN - feat.etMinutes(new Date(now).toISOString()));
}

function sessionWindowAt(now) {
  const m = feat.etMinutes(new Date(now).toISOString());
  if (m < 9 * 60 + 30) return 'PRE_OPEN';
  if (m < 10 * 60) return 'OPENING_NOISE';
  if (m < 11 * 60 + 30) return 'PRIME_MORNING';
  if (m < 13 * 60 + 30) return 'MIDDAY';
  if (m < 15 * 60 + 15) return 'PRIME_AFTERNOON';
  if (m < 16 * 60) return 'LATE_SESSION';
  return 'AFTER_CLOSE';
}

// ── STATE MACHINE ────────────────────────────────────────────────────────────
// Exactly one state. Order of evaluation IS the precedence: data integrity first, then
// destructive states (a failed breakout must not be reported as "pending"), then confirmed
// structure, then constructive states, then WATCH.
//
// `priorState` enables hysteresis: leaving a destructive state requires consecutive
// constructive evaluations, tracked by the caller in `priorConstructiveStreak`.
function classifyContinuationState(f, { priorState = null, priorConstructiveStreak = 0, stale = false } = {}) {
  if (stale) return { structureState: STRUCTURE_STATES.STALE_DATA, reasonCodes: ['STALE_DATA'], constructiveStreak: 0 };
  if (!f || !f.hasStructure) return { structureState: STRUCTURE_STATES.WATCH, reasonCodes: ['INSUFFICIENT_BARS'], constructiveStreak: 0 };

  const reasonCodes = [];
  const S = STRUCTURE_STATES;

  // ── Destructive reads first ────────────────────────────────────────────────
  // EXHAUSTED — parabolic extension with a volume climax and no room left.
  //
  // Extension is tested in BOTH ATR units and percent, and either can trip it. That matters:
  // in a genuine parabola the ATR is inflated by the parabolic bars themselves, so an
  // ATR-normalized measure quietly stops detecting the very condition it exists to detect.
  // A stock 27% above its own session VWAP is extended whatever its ATR says.
  const climax = finite(f.lastBarVolMult) && f.lastBarVolMult >= STRUCTURE.EXHAUSTION_VOLUME_CLIMAX;
  const overExtended = (finite(f.vwapExtensionAtr) && f.vwapExtensionAtr >= STRUCTURE.EXHAUSTION_EXTENSION_ATR)
    || (finite(f.vwapDistancePct) && f.vwapDistancePct >= ENTRY.MAX_VWAP_EXTENSION_PCT);
  // A run of this size off the session low, printed into a volume climax, is exhaustion
  // regardless of what the (self-inflated) VWAP and ATR measures say about it.
  const parabolic = finite(f.sessionRunPct) && f.sessionRunPct >= STRUCTURE.PARABOLIC_RUN_PCT;
  if ((overExtended && (climax || (finite(f.drawdownFromHighPct) && f.drawdownFromHighPct <= -3)))
      || (parabolic && climax)) {
    reasonCodes.push('PARABOLIC_EXTENSION', climax ? 'VOLUME_CLIMAX' : 'REVERSING_FROM_EXTREME');
    if (parabolic) reasonCodes.push('SESSION_RUN_EXTREME');
    return { structureState: S.EXHAUSTED, reasonCodes, constructiveStreak: 0 };
  }

  // FAILED_BREAKOUT — traded above the level and closed back under it, or lost a level a
  // prior bar had closed above.
  if (f.tradedAboveButClosedBelow) {
    reasonCodes.push('TRADED_ABOVE_CLOSED_BELOW');
    return { structureState: S.FAILED_BREAKOUT, reasonCodes, constructiveStreak: 0 };
  }
  if (f.lostBrokenLevel && finite(f.lastBarVolMult) && f.lastBarVolMult >= 1.2) {
    reasonCodes.push('LOST_LEVEL_ON_VOLUME');
    return { structureState: S.FAILED_BREAKOUT, reasonCodes, constructiveStreak: 0 };
  }

  // DISTRIBUTION — meaningful drawdown plus repeated lower highs plus weak participation.
  const bigDrawdown = finite(f.drawdownFromHighPct) && f.drawdownFromHighPct <= -STRUCTURE.DISTRIBUTION_DRAWDOWN_PCT;
  const lowerHighs = (f.lowerHighCount || 0) >= STRUCTURE.DISTRIBUTION_LOWER_HIGHS;
  const vwapWeak = f.vwapDistancePct != null && f.vwapDistancePct < 0;
  if (bigDrawdown && (lowerHighs || vwapWeak || f.upperWickRisk)) {
    if (bigDrawdown) reasonCodes.push('DRAWDOWN_FROM_HIGH');
    if (lowerHighs) reasonCodes.push('REPEATED_LOWER_HIGHS');
    if (vwapWeak) reasonCodes.push('BELOW_VWAP');
    if (f.upperWickRisk) reasonCodes.push('UPPER_WICK_REJECTION');
    return { structureState: S.DISTRIBUTION, reasonCodes, constructiveStreak: 0 };
  }

  // ── Hysteresis gate ────────────────────────────────────────────────────────
  // A name that was destructive must earn its way back. Until the streak is met it is WATCH,
  // never immediately BREAKOUT_PENDING on one good bar.
  const wasDestructive = priorState && DESTRUCTIVE_STATES.has(priorState);
  const streak = priorConstructiveStreak + 1;
  if (wasDestructive && streak < STRUCTURE.RECOVERY_CONFIRM_EVALS) {
    reasonCodes.push('AWAITING_RECOVERY_CONFIRMATION');
    return { structureState: S.WATCH, reasonCodes, constructiveStreak: streak };
  }

  // ── Confirmed structure ────────────────────────────────────────────────────
  // BREAKOUT_CONFIRMED — a COMPLETED bar closed above the point-in-time resistance, with
  // volume, an upper-half close, above VWAP, and not already blown out.
  if (f.brokeAbove && f.volumeConfirmed && f.closedUpperHalf
      && (f.vwapDistancePct == null || f.vwapDistancePct >= 0) && !overExtended) {
    reasonCodes.push('COMPLETED_CLOSE_ABOVE_RESISTANCE', 'VOLUME_CONFIRMED', 'UPPER_HALF_CLOSE');
    return { structureState: S.BREAKOUT_CONFIRMED, reasonCodes, constructiveStreak: streak };
  }

  // BREAKOUT_RETEST — a prior bar confirmed the break, price has come back toward THE LEVEL
  // THAT WAS BROKEN (not the new high the breakout printed), retest volume contracted, and
  // the level held or was reclaimed.
  if (f.priorBarClosedAbove && finite(f.retestLevel) && f.retestLevel > 0) {
    const nearLevel = Math.abs(f.price - f.retestLevel) / f.retestLevel <= 0.03;
    const held = f.price >= f.retestLevel * 0.995;
    const contracted = f.retestVolumeContracted;
    if (nearLevel && held && contracted !== false && (f.lowerHighCount || 0) < STRUCTURE.DISTRIBUTION_LOWER_HIGHS) {
      reasonCodes.push('RETEST_HELD_LEVEL', contracted ? 'RETEST_VOLUME_CONTRACTED' : 'RETEST_VOLUME_UNKNOWN');
      return { structureState: S.BREAKOUT_RETEST, reasonCodes, constructiveStreak: streak };
    }
  }

  // BREAKOUT_ATTEMPT — the FORMING bar is above resistance. Explicitly NOT confirmation.
  if (f.formingAboveResistance) {
    reasonCodes.push('FORMING_BAR_ABOVE_RESISTANCE', 'NOT_CONFIRMED_UNTIL_BAR_CLOSES');
    return { structureState: S.BREAKOUT_ATTEMPT, reasonCodes, constructiveStreak: streak };
  }

  // ── Constructive states ────────────────────────────────────────────────────
  const nearHigh = finite(f.distanceFromHighPct) && f.distanceFromHighPct >= -STRUCTURE.NEAR_HIGH_PCT;
  const higherLows = (f.consecutiveHigherLows || 0) >= 1;
  const aboveVwap = f.vwapDistancePct != null && f.vwapDistancePct >= 0;
  const compressed = finite(f.compressionRatio) && f.compressionRatio <= STRUCTURE.COMPRESSION_RATIO_MAX;

  // BREAKOUT_PENDING — coiled at the level with the structure to break it.
  if (nearHigh && (higherLows || compressed) && aboveVwap && !overExtended) {
    if (compressed) reasonCodes.push('COMPRESSION_AT_HIGHS');
    if (higherLows) reasonCodes.push('HIGHER_LOWS');
    reasonCodes.push('NEAR_SESSION_HIGH', 'ABOVE_VWAP');
    return { structureState: S.BREAKOUT_PENDING, reasonCodes, constructiveStreak: streak };
  }

  // COMPRESSION — range contracting but not yet at the high.
  if (compressed && aboveVwap) {
    reasonCodes.push('RANGE_COMPRESSION', 'ABOVE_VWAP');
    return { structureState: S.COMPRESSION, reasonCodes, constructiveStreak: streak };
  }

  // CONSTRUCTIVE_PULLBACK — an orderly dip holding structure.
  if (finite(f.pullbackQuality) && f.pullbackQuality >= 60 && aboveVwap
      && !(f.pullbackDetail && f.pullbackDetail.tooDeep)) {
    reasonCodes.push('ORDERLY_PULLBACK', 'HOLDING_VWAP');
    return { structureState: S.CONSTRUCTIVE_PULLBACK, reasonCodes, constructiveStreak: streak };
  }

  // EARLY_IGNITION — participation accelerating and price expanding, before a tradeable
  // structure has formed. This is a WATCH annotation, never a buy state.
  if (finite(f.volumeAcceleration) && f.volumeAcceleration >= STRUCTURE.EARLY_IGNITION_VOL_ACCEL
      && (!finite(f.vwapExtensionAtr) || f.vwapExtensionAtr < STRUCTURE.EARLY_IGNITION_MAX_EXTENSION_ATR)) {
    reasonCodes.push('VOLUME_ACCELERATING', 'PRICE_EXPANDING', 'NO_TRADEABLE_STRUCTURE_YET');
    return { structureState: S.EARLY_IGNITION, reasonCodes, constructiveStreak: streak };
  }

  reasonCodes.push('NO_QUALIFYING_STRUCTURE');
  return { structureState: S.WATCH, reasonCodes, constructiveStreak: CONSTRUCTIVE_STATES.has(priorState) ? streak : 0 };
}

// ── SCORES ───────────────────────────────────────────────────────────────────
// continuationScore — how well the chart supports the move CONTINUING.
function scoreContinuation(f, ctx = {}) {
  if (!f || !f.hasStructure) return 0;
  let s = 0;
  // Trend structure (35)
  if (f.emaStacked === true) s += 12;
  if (finite(f.ema9Slope) && f.ema9Slope > 0) s += 8;
  if ((f.consecutiveHigherLows || 0) >= 2) s += 10;
  else if ((f.consecutiveHigherLows || 0) === 1) s += 5;
  if (finite(f.supportSlope) && f.supportSlope > 0) s += 5;
  // VWAP structure (25)
  if (f.vwapDistancePct != null && f.vwapDistancePct >= 0) s += 10;
  if (finite(f.vwapSlope) && f.vwapSlope > 0) s += 8;
  if (finite(f.barsAboveVwapRatio)) s += clamp(f.barsAboveVwapRatio, 0, 1) * 7;
  // Position and participation (25)
  if (finite(f.distanceFromHighPct)) s += clamp(1 + f.distanceFromHighPct / 5, 0, 1) * 12;
  if (finite(f.volumeAcceleration)) s += clamp((f.volumeAcceleration - 0.8) / 1.5, 0, 1) * 13;
  // Quality deductions (15 available)
  s += 15;
  if (f.upperWickRisk) s -= 8;
  if ((f.lowerHighCount || 0) >= 2) s -= 7;
  if (f.pullbackDetail && f.pullbackDetail.tooDeep) s -= 8;
  if (ctx.stale) s = 0;
  return Math.round(clamp(s, 0, 100));
}

// remainingEdgeScore — how much of the move is LEFT. High continuation with low remaining
// edge is exactly the "great chart, terrible entry" case the app previously could not express.
function calculateRemainingEdge(f, ctx = {}) {
  if (!f || !f.hasStructure) return 0;
  let s = 100;
  // Extension consumed
  if (finite(f.vwapExtensionAtr)) s -= clamp(f.vwapExtensionAtr / ENTRY.MAX_VWAP_EXTENSION_ATR, 0, 1) * 40;
  if (finite(f.vwapDistancePct)) s -= clamp(f.vwapDistancePct / ENTRY.MAX_VWAP_EXTENSION_PCT, 0, 1) * 20;
  // Day move already realized
  if (finite(ctx.dayChangePct)) s -= clamp(ctx.dayChangePct / 60, 0, 1) * 20;
  // Time remaining
  if (finite(f.minutesUntilClose)) s -= clamp(1 - f.minutesUntilClose / 300, 0, 1) * 20;
  return Math.round(clamp(s, 0, 100));
}

// exhaustionScore — the affirmative case that the move is over.
function scoreExhaustion(f) {
  if (!f || !f.hasStructure) return 0;
  let s = 0;
  if (finite(f.vwapExtensionAtr)) s += clamp(f.vwapExtensionAtr / STRUCTURE.EXHAUSTION_EXTENSION_ATR, 0, 1) * 35;
  if (finite(f.lastBarVolMult)) s += clamp(f.lastBarVolMult / STRUCTURE.EXHAUSTION_VOLUME_CLIMAX, 0, 1) * 25;
  if (finite(f.drawdownFromHighPct)) s += clamp(-f.drawdownFromHighPct / 10, 0, 1) * 20;
  if (f.upperWickRisk) s += 10;
  if ((f.lowerHighCount || 0) >= 2) s += 10;
  return Math.round(clamp(s, 0, 100));
}

// ── PLAN ─────────────────────────────────────────────────────────────────────
// Mechanical reference levels. `trigger` is where the setup becomes valid; `invalidation` is
// where the thesis is wrong. Stops are STRUCTURAL (below the level that defines the setup)
// and floored by an ATR minimum — never tightened to make the reward:risk look better.
function buildContinuationPlan(f, ctx = {}) {
  if (!f || !f.hasStructure || !finite(f.price)) return null;
  const a = finite(f.atr5m) && f.atr5m > 0 ? f.atr5m : Math.max(0.01, f.price * 0.004);
  const state = ctx.structureState;

  // Trigger: the level a completed bar must close above.
  let trigger = finite(f.priorResistance) ? f.priorResistance : f.dayHigh;
  if (state === STRUCTURE_STATES.CONSTRUCTIVE_PULLBACK && finite(f.ema9)) {
    // On a pullback the trigger is the recovery: a close back above the recent swing high.
    trigger = Math.max(f.price, f.ema9);
  }
  if (!finite(trigger) || trigger <= 0) return null;

  // STRUCTURAL INVALIDATION — the price at which the reason for the trade stops being true.
  // For a breakout that is just under the structure that launched it (the recent swing low /
  // base low), NOT an arbitrary multiple of ATR: a stop three ATRs below a breakout is not
  // "conservative", it is a different trade with a much worse reward:risk.
  //
  // Two floors then apply, in this order:
  //   • never TIGHTER than MIN_STOP_ATR (a stop inside the noise is a fake reward:risk), and
  //   • never WIDER than MAX_STOP_DISTANCE_PCT — but a plan that needs a wider stop is not
  //     silently tightened to fit; it keeps the honest stop and lets the actionability gate
  //     reject it on STOP_TOO_WIDE.
  const swingWindow = (ctx.bars || []).slice(-4);
  const swingLow = swingWindow.length ? Math.min(...swingWindow.map(x => x.l))
    : (finite(f.dayLow) ? f.dayLow : f.price - 2 * a);
  let invalidation = Math.min(
    swingLow - 0.15 * a,                    // just under the defining structure
    f.price - ENTRY.MIN_STOP_ATR * a,       // never inside the noise
  );
  if (!(invalidation > 0)) invalidation = f.price * 0.9;

  const entryRef = Math.max(f.price, trigger);
  const risk = entryRef - invalidation;
  if (!(risk > 0)) return null;

  // TARGETS ARE STRUCTURAL, NOT R-MULTIPLES. Deriving target1 as "1.5×risk" would make the
  // reward:risk gate circular — the plan would manufacture whatever ratio the gate demanded.
  // Instead target1 is the classic MEASURED MOVE: the height of the base being broken,
  // projected above the trigger. The reward:risk check then asks a real question — does this
  // structure offer enough room relative to where the stop genuinely has to sit? A tight base
  // under a level with a distant stop will (correctly) fail it.
  const baseWindow = (ctx.bars || []).slice(-9, -1);
  const baseLow = baseWindow.length ? Math.min(...baseWindow.map(x => x.l)) : f.dayLow;
  const baseHeight = finite(baseLow) && finite(trigger) ? Math.max(0, trigger - baseLow) : 0;
  // A TIGHT base is not a small opportunity. Projecting only the flag's own height would put
  // target1 barely above the trigger — and, because the stop still has to sit below the base,
  // would make every well-formed coil fail the reward:risk test. The move a flag resolves into
  // is the advance that BUILT it, so the projection also considers the leg from the session
  // low up to the level (the "pole"), and takes the larger of the two.
  const pole = finite(f.dayLow) && finite(trigger) ? Math.max(0, trigger - f.dayLow) : 0;
  let measuredMove = Math.max(baseHeight, pole * 0.5);
  // Degenerate structure (one explosive bar, no consolidation at all) → fall back to ATR so a
  // plan still exists rather than silently vanishing.
  if (!(measuredMove > a * 0.5)) measuredMove = a * 2;

  const target1 = +(trigger + measuredMove).toFixed(2);
  const target2 = +(trigger + 2 * measuredMove).toFixed(2);

  return {
    trigger: +trigger.toFixed(2),
    entryReference: +entryRef.toFixed(2),
    invalidation: +invalidation.toFixed(2),
    target1, target2,
    measuredMove: +measuredMove.toFixed(4),
    baseHeight: +baseHeight.toFixed(4),
    pole: +pole.toFixed(4),
    riskPerShare: +risk.toFixed(4),
    stopDistancePct: +((risk / entryRef) * 100).toFixed(2),
    // Measured against the ENTRY REFERENCE, so chasing mechanically degrades the ratio —
    // exactly as it does in a real account.
    riskReward: +((target1 - entryRef) / risk).toFixed(2),
    atr5m: a,
    basis: 'structural stop below the level that defines the setup (floored at MIN_STOP_ATR), and a measured-move target projected from the base height / the leg that built it — neither is derived from the other, so reward:risk is a real test rather than a tautology',
  };
}

// ── ORCHESTRATOR ─────────────────────────────────────────────────────────────
function analyzeIntradayContinuation(bars, context = {}) {
  const stale = context.stale === true;
  const f = calculateIntradayFeatures(bars, context);
  const cls = classifyContinuationState(f, {
    priorState: context.priorState || null,
    priorConstructiveStreak: context.priorConstructiveStreak || 0,
    stale,
  });
  const plan = stale ? null : buildContinuationPlan(f, { structureState: cls.structureState, bars: Array.isArray(bars) ? bars : [] });
  const continuationScore = scoreContinuation(f, { stale });
  const remainingEdgeScore = stale ? 0 : calculateRemainingEdge(f, { dayChangePct: context.dayChangePct });
  const exhaustionScore = stale ? 0 : scoreExhaustion(f);

  const warnings = [];
  if (context.temporalResolutionRisk) warnings.push('FIVE_MINUTE_RESOLUTION_ONLY');
  if (f.formingBarPresent) warnings.push('FORMING_BAR_EXCLUDED_FROM_CONFIRMATIONS');
  if (stale) warnings.push('STALE_DATA');

  return {
    version: CONTINUATION_VERSION,
    schemaVersion: SCHEMA_VERSION,
    scoringVersion: CONTINUATION_VERSION,
    structureState: cls.structureState,
    constructiveStreak: cls.constructiveStreak,
    continuationScore, remainingEdgeScore, exhaustionScore,
    price: f.price ?? null,
    dayHigh: f.dayHigh ?? null,
    dayLow: f.dayLow ?? null,
    priorResistance: f.priorResistance ?? null,
    sessionVwap: f.sessionVwap ?? null,
    ema9: f.ema9 ?? null, ema21: f.ema21 ?? null,
    distanceFromHighPct: f.distanceFromHighPct ?? null,
    drawdownFromHighPct: f.drawdownFromHighPct ?? null,
    higherLowRatio: f.higherLowRatio ?? null,
    consecutiveHigherLows: f.consecutiveHigherLows ?? null,
    lowerHighCount: f.lowerHighCount ?? null,
    compressionRatio: f.compressionRatio ?? null,
    volumeAcceleration: f.volumeAcceleration ?? null,
    barsAboveVwapRatio: f.barsAboveVwapRatio ?? null,
    vwapSlope: f.vwapSlope ?? null,
    vwapDistancePct: f.vwapDistancePct ?? null,
    vwapExtensionAtr: f.vwapExtensionAtr ?? null,
    ema9Slope: f.ema9Slope ?? null,
    upperWickRisk: f.upperWickRisk ?? null,
    pullbackQuality: f.pullbackQuality ?? null,
    atr5m: f.atr5m ?? null,
    minutesUntilClose: f.minutesUntilClose ?? null,
    sessionWindow: f.sessionWindow ?? null,
    nearHigh: finite(f.distanceFromHighPct) ? f.distanceFromHighPct >= -STRUCTURE.NEAR_HIGH_PCT : null,
    aboveVwap: f.vwapDistancePct != null ? f.vwapDistancePct >= 0 : null,
    trigger: plan ? plan.trigger : null,
    invalidation: plan ? plan.invalidation : null,
    target1: plan ? plan.target1 : null,
    target2: plan ? plan.target2 : null,
    riskReward: plan ? plan.riskReward : null,
    riskPerShare: plan ? plan.riskPerShare : null,
    stopDistancePct: plan ? plan.stopDistancePct : null,
    plan,
    reasonCodes: cls.reasonCodes,
    warnings,
    features: f,
  };
}

module.exports = {
  STRUCTURE_STATES, DESTRUCTIVE_STATES, CONSTRUCTIVE_STATES, CONTINUATION_VERSION,
  atr5m, ema, emaSlope, findPivots, noiseFloor, priorResistance, slopeOf, assessPullback,
  calculateIntradayFeatures, classifyContinuationState, scoreContinuation,
  calculateRemainingEdge, scoreExhaustion, buildContinuationPlan, analyzeIntradayContinuation,
  sessionWindowAt, minutesUntilCloseAt,
};
