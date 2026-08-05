'use strict';
// STAGE 1 — LOW-FLOAT IGNITION: EXPLOSION POTENTIAL vs TRADE QUALITY.
//
// The central idea this module exists to express: **how far a stock might move and whether
// you should touch it are different questions.** The old system conflated them, which is why
// it surfaced clean-looking, low-volatility names that never moved, and why it had no way to
// say "this will probably run 40% and you still should not buy it here."
//
// So every candidate gets TWO independent 0-100 scores:
//   explosionPotentialScore — how much supply/demand pressure is actually present
//   tradeQualityScore       — whether an entry can be executed and defended right now
//
// NEITHER IS A PROBABILITY. They are interpretable, family-capped rankings built from
// pre-registered weights. There is no fitted model here and none is implied: presenting a
// hand-weighted sum as a calibrated probability would be the exact dishonesty the rest of
// this app's research record was built to avoid.
//
// FAMILY CAPS are the structural honesty device. Each evidence family contributes at most its
// cap (lowfloat-config EXPLOSION_FAMILIES / TRADE_QUALITY_FAMILIES), so no single input —
// however extreme — can manufacture a high score on its own. A 900× relative volume print
// still only earns the participation cap.

const {
  EXPLOSION_FAMILIES, TRADE_QUALITY_FAMILIES, LOW_FLOAT_IGNITION_VERSION, SCHEMA_VERSION,
  ENTRY, SESSION_WINDOWS, FLOAT_TIERS,
} = require('./lowfloat-config');

const IGNITION_STATES = Object.freeze({
  NO_IGNITION: 'NO_IGNITION',
  EARLY_IGNITION: 'EARLY_IGNITION',
  SUSTAINED_IGNITION: 'SUSTAINED_IGNITION',
  LATE_IGNITION: 'LATE_IGNITION',
  CLIMAX: 'CLIMAX',
  FADING: 'FADING',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = v => Number.isFinite(v);

// Saturating ramp: 0 below `lo`, `cap` at/above `hi`, linear between. Used everywhere so a
// score contribution is always bounded and monotone in its input.
function ramp(value, lo, hi, cap) {
  if (!finite(value)) return 0;
  if (hi === lo) return value >= hi ? cap : 0;
  return clamp((value - lo) / (hi - lo), 0, 1) * cap;
}

// ── Session window helper ────────────────────────────────────────────────────
function sessionWindowAt(minutesSinceOpen) {
  const abs = 9 * 60 + 30 + (Number(minutesSinceOpen) || 0);
  for (const w of SESSION_WINDOWS) if (abs >= w.startMin && abs < w.endMin) return w.key;
  return 'AFTER_CLOSE';
}

function minutesUntilClose(minutesSinceOpen) {
  if (!finite(minutesSinceOpen)) return null;
  return Math.max(0, 390 - minutesSinceOpen);
}

// ── FEATURE CALCULATION ──────────────────────────────────────────────────────
// Pure. `input` carries the Stage-0 candidate fields plus (optionally) completed 5-minute
// bars and float/catalyst/supply context. Bars, when present, produce the higher-fidelity
// acceleration measures; without them the snapshot-derived Stage-0 values are used and the
// record says which basis was used.
//
// FLOAT TURNOVER IS ONLY COMPUTED WHEN THE FLOAT IS RELIABLE. An UNKNOWN or unusable float
// yields null turnover, never a turnover computed against a market-cap-derived guess.
function calculateIgnitionFeatures(input = {}) {
  const {
    price = null, sessionVolume = null, sessionDollarVolume = null,
    floatShares = null, floatUsable = false, sharesOutstanding = null,
    bars = null, minutesSinceOpen = null, relativeVolume = null,
    dayChangePct = null, fiveMinChange = null, fifteenMinChange = null, thirtyMinChange = null,
    volumeAcceleration = null, dailyAtr = null, prevClose = null,
  } = input;

  const completed = Array.isArray(bars) ? bars : [];
  const hasBars = completed.length >= 2;
  const basis = hasBars ? 'completed-5m-bars' : 'quote-snapshot';

  // FLOAT TURNOVER — cumulative and recent. Guarded on float reliability.
  const floatOk = !!floatUsable && finite(floatShares) && floatShares > 0;
  const floatTurnover = floatOk && finite(sessionVolume) && sessionVolume >= 0
    ? +(sessionVolume / floatShares).toFixed(4) : null;

  // Volume in the most recent completed 15 minutes (3 bars) → recent float turnover.
  const recentVolume = hasBars ? completed.slice(-3).reduce((s, b) => s + (b.v || 0), 0) : null;
  const recentFloatTurnover = floatOk && finite(recentVolume)
    ? +(recentVolume / floatShares).toFixed(5) : null;

  // VOLUME ACCELERATION from bars: the last completed 5-minute bar against the average of the
  // six completed bars before it (the spec's definition), and the last three bars against the
  // equivalent earlier window.
  let volumeAcceleration5m = null, volumeAcceleration15m = null;
  if (completed.length >= 7) {
    const last = completed[completed.length - 1];
    const priorSix = completed.slice(-7, -1);
    const avgPrior = priorSix.reduce((s, b) => s + (b.v || 0), 0) / priorSix.length;
    if (avgPrior > 0) volumeAcceleration5m = +((last.v || 0) / avgPrior).toFixed(2);
  }
  if (completed.length >= 6) {
    const recent3 = completed.slice(-3).reduce((s, b) => s + (b.v || 0), 0);
    const prior3 = completed.slice(-6, -3).reduce((s, b) => s + (b.v || 0), 0);
    if (prior3 > 0) volumeAcceleration15m = +(recent3 / prior3).toFixed(2);
  }
  // Fall back to the snapshot-interval acceleration when bars are unavailable.
  if (volumeAcceleration5m == null && finite(volumeAcceleration)) volumeAcceleration5m = volumeAcceleration;

  // PRICE ACCELERATION over 5/15/30 minutes, from bars when available.
  const barRet = mins => {
    if (!hasBars) return null;
    const last = completed[completed.length - 1];
    const cutoff = Date.parse(last.t) - mins * 60_000;
    let ref = null;
    for (const b of completed) { if (Date.parse(b.t) <= cutoff) ref = b; else break; }
    if (!ref || !(ref.c > 0)) return null;
    return +(((last.c / ref.c) - 1) * 100).toFixed(2);
  };
  const priceAcceleration5m = hasBars ? barRet(5) : fiveMinChange;
  const priceAcceleration15m = hasBars ? barRet(15) : fifteenMinChange;
  const priceAcceleration30m = hasBars ? barRet(30) : thirtyMinChange;

  // Is the move BUILDING or DECAYING? A 15-minute move where the last 5 minutes carried more
  // than a third of it is still accelerating. This is what separates early ignition from the
  // tail of a completed move.
  const accelerating = finite(priceAcceleration5m) && finite(priceAcceleration15m) && priceAcceleration15m > 0
    ? priceAcceleration5m / priceAcceleration15m > 1 / 3
    : null;

  // Recent DOLLAR volume — the real tradeability measure for a name with no useful history.
  const dollarVolume5m = hasBars ? Math.round((completed[completed.length - 1].c || 0) * (completed[completed.length - 1].v || 0)) : null;
  const dollarVolume15m = hasBars
    ? Math.round(completed.slice(-3).reduce((s, b) => s + (b.c || 0) * (b.v || 0), 0)) : null;

  // Extension context.
  const sessionHigh = hasBars ? Math.max(...completed.map(b => b.h)) : null;
  const sessionLow = hasBars ? Math.min(...completed.map(b => b.l)) : null;
  const drawdownFromHighPct = finite(sessionHigh) && sessionHigh > 0 && finite(price)
    ? +(((price / sessionHigh) - 1) * 100).toFixed(2) : null;

  return {
    basis,
    barCount: completed.length,
    price, prevClose,
    sessionVolume, sessionDollarVolume,
    floatShares: floatOk ? floatShares : null,
    floatUsable: floatOk,
    sharesOutstanding,
    floatTurnover, recentFloatTurnover,
    volumeAcceleration5m, volumeAcceleration15m,
    priceAcceleration5m, priceAcceleration15m, priceAcceleration30m,
    accelerating,
    relativeVolume,
    dayChangePct,
    dollarVolume5m, dollarVolume15m,
    sessionHigh, sessionLow, drawdownFromHighPct,
    dailyAtr,
    minutesSinceOpen,
    minutesUntilClose: minutesUntilClose(minutesSinceOpen),
    sessionWindow: sessionWindowAt(minutesSinceOpen),
  };
}

// ── EXPLOSION POTENTIAL ──────────────────────────────────────────────────────
// Seven capped families. Returns the score, the per-family breakdown (so the UI can show WHY,
// not just a number) and the reason codes.
function scoreExplosionPotential(f = {}, ctx = {}) {
  const F = EXPLOSION_FAMILIES;
  const reasonCodes = [];
  const penalties = [];

  // SUPPLY_CONSTRAINT — actual float tier, confidence, and how much of it has traded.
  // An UNKNOWN float scores ZERO here. That is the whole point of the module: absence of
  // float data must never look like the presence of a small float.
  let supply = 0;
  if (f.floatUsable && finite(f.floatShares)) {
    const tierPoints = f.floatShares < FLOAT_TIERS.ULTRA_LOW.max ? 1.0
      : f.floatShares < FLOAT_TIERS.LOW.max ? 0.8
      : f.floatShares < FLOAT_TIERS.MODERATELY_LOW.max ? 0.55
      : f.floatShares < FLOAT_TIERS.SMALL_SUPPLY.max ? 0.3
      : 0.05;
    supply += tierPoints * F.SUPPLY_CONSTRAINT * 0.6;
    // Turnover: 100% of the float changing hands in a session is extreme demand.
    supply += ramp(f.floatTurnover, 0.1, 1.5, F.SUPPLY_CONSTRAINT * 0.4);
    if (tierPoints >= 0.8) reasonCodes.push('SUPPLY_TIGHT_FLOAT');
    if ((f.floatTurnover || 0) >= 0.5) reasonCodes.push('SUPPLY_HIGH_FLOAT_TURNOVER');
    const conf = ctx.floatConfidence || 'LOW';
    if (conf === 'MEDIUM') { supply *= 0.75; penalties.push('FLOAT_STALE_OR_UNDATED'); }
    if (conf === 'LOW') { supply *= 0.4; penalties.push('FLOAT_LOW_CONFIDENCE'); }
  } else {
    reasonCodes.push('FLOAT_UNKNOWN_NO_SUPPLY_CREDIT');
  }
  supply = clamp(supply, 0, F.SUPPLY_CONSTRAINT);

  // PARTICIPATION — dollars actually changing hands and whether that is rising.
  let participation = 0;
  participation += ramp(f.relativeVolume, 1.5, 20, F.PARTICIPATION * 0.35);
  participation += ramp(f.volumeAcceleration5m, 1.5, 6, F.PARTICIPATION * 0.25);
  participation += ramp(f.volumeAcceleration15m, 1.2, 4, F.PARTICIPATION * 0.15);
  // Dollar volume on a log scale: $1M → $200M spans the meaningful range.
  if (finite(f.sessionDollarVolume) && f.sessionDollarVolume > 0) {
    participation += ramp(Math.log10(f.sessionDollarVolume), 6, 8.3, F.PARTICIPATION * 0.25);
  }
  if ((f.relativeVolume || 0) >= 5) reasonCodes.push('PARTICIPATION_EXTREME_RVOL');
  if ((f.volumeAcceleration5m || 0) >= 3) reasonCodes.push('PARTICIPATION_ACCELERATING');
  participation = clamp(participation, 0, F.PARTICIPATION);

  // PRICE_ACCELERATION — three horizons, with a genuine bonus for building rather than decaying.
  let accel = 0;
  accel += ramp(f.priceAcceleration5m, 0.5, 6, F.PRICE_ACCELERATION * 0.4);
  accel += ramp(f.priceAcceleration15m, 1, 12, F.PRICE_ACCELERATION * 0.35);
  accel += ramp(f.priceAcceleration30m, 2, 20, F.PRICE_ACCELERATION * 0.25);
  if (f.accelerating === true) { accel = Math.min(F.PRICE_ACCELERATION, accel * 1.15); reasonCodes.push('PRICE_STILL_ACCELERATING'); }
  if (f.accelerating === false) { accel *= 0.75; penalties.push('PRICE_MOMENTUM_DECAYING'); }
  accel = clamp(accel, 0, F.PRICE_ACCELERATION);

  // CATALYST — tier, freshness, source, novelty. Already folded into `materiality` by
  // lib/catalyst-context; this family simply scales it and adds a freshness kicker.
  let catalyst = 0;
  const cat = ctx.catalyst || null;
  if (cat && cat.catalystPresent) {
    catalyst += (cat.materiality || 0) * F.CATALYST * 0.8;
    if (finite(cat.freshnessMinutes)) catalyst += ramp(240 - cat.freshnessMinutes, 0, 240, F.CATALYST * 0.2);
    if (cat.catalystTier === 1) reasonCodes.push('CATALYST_TIER1');
    if (cat.isRecycled) { catalyst *= 0.5; penalties.push('CATALYST_RECYCLED'); }
    if (cat.catalystTier >= 4) { catalyst = 0; penalties.push('CATALYST_NOT_CREDITWORTHY'); }
  } else {
    penalties.push('NO_IDENTIFIABLE_CATALYST');
  }
  catalyst = clamp(catalyst, 0, F.CATALYST);

  // INTRADAY_STRUCTURE — supplied by Stage 2 when it has run. Absent → no credit (never a
  // default half-score, which would let an unanalyzed name outrank an analyzed weak one).
  let structure = 0;
  const st = ctx.structure || null;
  if (st) {
    if (finite(st.continuationScore)) structure += (st.continuationScore / 100) * F.INTRADAY_STRUCTURE * 0.7;
    if (st.nearHigh) structure += F.INTRADAY_STRUCTURE * 0.15;
    if (st.aboveVwap) structure += F.INTRADAY_STRUCTURE * 0.15;
    if (['DISTRIBUTION', 'FAILED_BREAKOUT', 'EXHAUSTED'].includes(st.structureState)) {
      structure *= 0.3;
      penalties.push(`STRUCTURE_${st.structureState}`);
    }
  }
  structure = clamp(structure, 0, F.INTRADAY_STRUCTURE);

  // REMAINING_RUNWAY — time left, how much of the move is already spent, room in ATR terms.
  // A +180% name at 15:50 has enormous realized energy and almost no remaining runway.
  let runway = 0;
  const mtc = f.minutesUntilClose;
  runway += ramp(mtc, 15, 240, F.REMAINING_RUNWAY * 0.5);
  // Extension penalty: the further the day change has already gone, the less is left.
  const dc = finite(f.dayChangePct) ? f.dayChangePct : 0;
  runway += clamp(1 - dc / 60, 0, 1) * F.REMAINING_RUNWAY * 0.3;
  // Room below the session high (a name pinned at the high has less immediate overhead).
  if (finite(f.drawdownFromHighPct)) runway += clamp(1 + f.drawdownFromHighPct / 10, 0, 1) * F.REMAINING_RUNWAY * 0.2;
  else runway += F.REMAINING_RUNWAY * 0.1;
  if (finite(mtc) && mtc < 30) penalties.push('LITTLE_TIME_REMAINING');
  if (dc > 80) penalties.push('MOVE_LARGELY_COMPLETE');
  runway = clamp(runway, 0, F.REMAINING_RUNWAY);

  // MARKET_CONTEXT — regime and sector tone. Small by design: the app has no Day-Trade-
  // specific evidence that intraday regime gating helps (see daytrade-config REGIME).
  let market = F.MARKET_CONTEXT * 0.5;
  if (ctx.regime === 'risk-on') market = F.MARKET_CONTEXT;
  if (ctx.regime === 'risk-off') { market = F.MARKET_CONTEXT * 0.2; penalties.push('RISK_OFF_TAPE'); }
  if (ctx.sectorStrong === true) market = Math.min(F.MARKET_CONTEXT, market + F.MARKET_CONTEXT * 0.2);
  market = clamp(market, 0, F.MARKET_CONTEXT);

  // Explicit data/structure penalties applied AFTER the families, as a multiplicative
  // credibility discount rather than a hidden subtraction.
  let credibility = 1;
  if (ctx.stale === true) { credibility *= 0.5; penalties.push('STALE_DATA'); }
  if (ctx.supplyRisk && ctx.supplyRisk.dilutionRisk === 'HIGH') penalties.push('HIGH_SUPPLY_RISK');
  if (ctx.volumeClimax === true) { credibility *= 0.7; penalties.push('VOLUME_CLIMAX'); }

  const families = {
    SUPPLY_CONSTRAINT: +supply.toFixed(1),
    PARTICIPATION: +participation.toFixed(1),
    PRICE_ACCELERATION: +accel.toFixed(1),
    CATALYST: +catalyst.toFixed(1),
    INTRADAY_STRUCTURE: +structure.toFixed(1),
    REMAINING_RUNWAY: +runway.toFixed(1),
    MARKET_CONTEXT: +market.toFixed(1),
  };
  const raw = Object.values(families).reduce((a, b) => a + b, 0);
  const score = Math.round(clamp(raw * credibility, 0, 100));

  return {
    explosionPotentialScore: score,
    families,
    familyCaps: F,
    credibility: +credibility.toFixed(2),
    reasonCodes,
    penalties,
    version: LOW_FLOAT_IGNITION_VERSION,
    // Stated on every score so a reader is never left to infer it.
    interpretation: 'Interpretable 0-100 ranking of same-session supply/demand pressure. NOT a probability and NOT a buy score — see tradeQualityScore for whether an entry is defensible.',
  };
}

// ── TRADE QUALITY ────────────────────────────────────────────────────────────
// Whether an entry can actually be made and defended RIGHT NOW. Deliberately harsh on the
// things that destroy real-money outcomes: thin liquidity, extension, stale data, no spread
// visibility, bad reward:risk, and setups that have already failed.
function scoreTradeQuality(f = {}, ctx = {}) {
  const F = TRADE_QUALITY_FAMILIES;
  const reasonCodes = [];
  const warnings = [];

  // LIQUIDITY — CURRENT session dollars, not history. This is where a dormant name earns its
  // tradeability: $30M traded today makes it tradeable regardless of last month's 40k average.
  let liquidity = 0;
  if (finite(f.sessionDollarVolume) && f.sessionDollarVolume > 0) {
    liquidity += ramp(Math.log10(f.sessionDollarVolume), 5.7, 8, F.LIQUIDITY * 0.6);
  } else {
    warnings.push('SESSION_DOLLAR_VOLUME_UNKNOWN');
  }
  if (finite(f.dollarVolume15m)) liquidity += ramp(Math.log10(Math.max(1, f.dollarVolume15m)), 5, 7, F.LIQUIDITY * 0.4);
  else if (finite(f.sessionDollarVolume)) liquidity += F.LIQUIDITY * 0.1;   // partial credit, flagged below
  if (finite(f.price) && f.price < ENTRY.MANUAL_SPREAD_PRICE_BELOW) warnings.push('SUB_5_DOLLAR_SPREAD_RISK');
  liquidity = clamp(liquidity, 0, F.LIQUIDITY);

  // EXTENSION — how far above VWAP / how many ATRs. An extended entry is a bad entry even on
  // a stock that keeps going, because the stop has to sit somewhere.
  let extension = F.EXTENSION;
  const st = ctx.structure || null;
  if (st && finite(st.vwapExtensionAtr)) {
    extension -= ramp(st.vwapExtensionAtr, 1.0, ENTRY.MAX_VWAP_EXTENSION_ATR, F.EXTENSION * 0.7);
  }
  if (st && finite(st.vwapDistancePct)) {
    extension -= ramp(st.vwapDistancePct, 4, ENTRY.MAX_VWAP_EXTENSION_PCT, F.EXTENSION * 0.3);
  }
  if (!st) { extension = F.EXTENSION * 0.4; warnings.push('NO_INTRADAY_STRUCTURE_FOR_EXTENSION'); }
  if (finite(f.dayChangePct) && f.dayChangePct > 50) { extension *= 0.6; reasonCodes.push('ALREADY_UP_LARGE'); }
  extension = clamp(extension, 0, F.EXTENSION);

  // STRUCTURE — a failed or distributing setup is a bad trade regardless of explosion potential.
  let structure = 0;
  if (st) {
    const s = st.structureState;
    const table = {
      BREAKOUT_CONFIRMED: 1.0, BREAKOUT_RETEST: 0.95, CONSTRUCTIVE_PULLBACK: 0.85,
      COMPRESSION: 0.7, BREAKOUT_PENDING: 0.7, EARLY_IGNITION: 0.55,
      BREAKOUT_ATTEMPT: 0.4, WATCH: 0.35,
      FAILED_BREAKOUT: 0.05, DISTRIBUTION: 0.05, EXHAUSTED: 0.05, STALE_DATA: 0,
    };
    structure = (table[s] ?? 0.3) * F.STRUCTURE;
    if (st.upperWickRisk === true) { structure *= 0.7; warnings.push('UPPER_WICK_REJECTION'); }
    if (finite(st.lowerHighCount) && st.lowerHighCount >= 3) { structure *= 0.6; warnings.push('REPEATED_LOWER_HIGHS'); }
    reasonCodes.push(`STRUCTURE_${s}`);
  } else {
    warnings.push('STRUCTURE_NOT_ANALYZED');
  }
  structure = clamp(structure, 0, F.STRUCTURE);

  // RISK_REWARD — from the Stage-2 plan. Never credited when the plan is missing.
  let rr = 0;
  if (st && finite(st.riskReward)) {
    rr = ramp(st.riskReward, 1.0, 4.0, F.RISK_REWARD);
    if (st.riskReward < ENTRY.MIN_REWARD_RISK) warnings.push('REWARD_RISK_BELOW_FLOOR');
  } else {
    warnings.push('NO_PLAN_FOR_RISK_REWARD');
  }
  if (st && finite(st.stopDistancePct) && st.stopDistancePct > ENTRY.MAX_STOP_DISTANCE_PCT) {
    rr *= 0.4; warnings.push('STOP_TOO_WIDE');
  }
  rr = clamp(rr, 0, F.RISK_REWARD);

  // DATA_INTEGRITY — freshness, bar resolution, provider coverage. Stale data is not a minor
  // deduction; it is most of this family.
  let integrity = F.DATA_INTEGRITY;
  if (ctx.stale === true) { integrity = 0; warnings.push('STALE_DATA'); }
  else {
    if (finite(ctx.barAgeMinutes) && ctx.barAgeMinutes > ENTRY.MAX_COMPLETED_BAR_AGE_MINUTES) {
      integrity *= 0.2; warnings.push('BAR_TOO_OLD');
    }
    if (ctx.temporalResolutionRisk === true) { integrity *= 0.75; warnings.push('FIVE_MINUTE_RESOLUTION_ONLY'); }
    if (ctx.quoteAgeMs != null && ctx.quoteAgeMs > 120_000) { integrity *= 0.6; warnings.push('QUOTE_STALE'); }
  }
  integrity = clamp(integrity, 0, F.DATA_INTEGRITY);

  // SUPPLY_RISK — dilution penalizes TRADE QUALITY (never explosion potential, and never
  // removal from discovery). This is the spec's explicit design.
  let supplyQ = F.SUPPLY_RISK;
  const sr = ctx.supplyRisk || null;
  if (sr) {
    if (sr.dilutionRisk === 'HIGH') { supplyQ = 0; warnings.push('HIGH_DILUTION_RISK'); }
    else if (sr.dilutionRisk === 'MODERATE') { supplyQ *= 0.5; warnings.push('MODERATE_DILUTION_RISK'); }
    else if (sr.dilutionRisk === 'UNKNOWN') { supplyQ *= 0.6; warnings.push('DILUTION_RISK_UNKNOWN'); }
    if (sr.goingConcern) warnings.push('GOING_CONCERN');
    if (sr.reverseSplitRecent) warnings.push('RECENT_REVERSE_SPLIT');
  } else {
    supplyQ *= 0.6; warnings.push('SUPPLY_RISK_NOT_ASSESSED');
  }
  supplyQ = clamp(supplyQ, 0, F.SUPPLY_RISK);

  // Time-of-session multiplier: an entry with 12 minutes left is a poor trade whatever the chart.
  let timeMult = 1;
  if (finite(f.minutesUntilClose)) {
    if (f.minutesUntilClose < ENTRY.MIN_NEW_ENTRY_MINUTES_TO_CLOSE) { timeMult = 0.2; warnings.push('TOO_CLOSE_TO_CLOSE'); }
    else if (f.minutesUntilClose < 45) { timeMult = 0.7; warnings.push('LATE_SESSION'); }
  }
  if (f.sessionWindow === 'OPENING_NOISE') { timeMult *= 0.85; warnings.push('OPENING_NOISE_WINDOW'); }

  const families = {
    LIQUIDITY: +liquidity.toFixed(1),
    EXTENSION: +extension.toFixed(1),
    STRUCTURE: +structure.toFixed(1),
    RISK_REWARD: +rr.toFixed(1),
    DATA_INTEGRITY: +integrity.toFixed(1),
    SUPPLY_RISK: +supplyQ.toFixed(1),
  };
  const raw = Object.values(families).reduce((a, b) => a + b, 0);
  const score = Math.round(clamp(raw * timeMult, 0, 100));

  return {
    tradeQualityScore: score,
    families,
    familyCaps: F,
    timeMultiplier: +timeMult.toFixed(2),
    reasonCodes,
    warnings,
    version: LOW_FLOAT_IGNITION_VERSION,
    interpretation: 'Interpretable 0-100 ranking of whether an entry is executable and defensible right now. Independent of explosionPotentialScore — a name can score high on one and low on the other.',
  };
}

// ── IGNITION STATE ───────────────────────────────────────────────────────────
// Where in the ignition arc the name is. Distinct from Stage 2's STRUCTURE state (which is
// about chart geometry); this one is about the demand impulse.
function classifyIgnitionState(f = {}, ctx = {}) {
  if (ctx.stale === true) return IGNITION_STATES.INSUFFICIENT_DATA;
  const haveAny = finite(f.relativeVolume) || finite(f.volumeAcceleration5m) || finite(f.priceAcceleration15m);
  if (!haveAny) return IGNITION_STATES.INSUFFICIENT_DATA;

  const rv = f.relativeVolume ?? 0;
  const va = f.volumeAcceleration5m ?? 0;
  const p15 = f.priceAcceleration15m ?? 0;
  const dc = f.dayChangePct ?? 0;
  const dd = f.drawdownFromHighPct ?? 0;

  // CLIMAX — extreme participation with the price no longer making progress, or a volume
  // blow-off. The classic late-stage tell.
  if (va >= 4 && (p15 <= 0 || dd <= -4)) return IGNITION_STATES.CLIMAX;
  // FADING — the move is well off its high and participation is no longer accelerating.
  if (dd <= -6 && va < 1.5) return IGNITION_STATES.FADING;
  // EARLY — real acceleration, price expanding, but the move is not yet large.
  if (va >= 2 && p15 >= 1 && dc < 25) return IGNITION_STATES.EARLY_IGNITION;
  // SUSTAINED — big move, participation still strong, holding near the high.
  if (dc >= 15 && rv >= 3 && dd > -4) return IGNITION_STATES.SUSTAINED_IGNITION;
  // LATE — big move but the impulse has slowed.
  if (dc >= 25) return IGNITION_STATES.LATE_IGNITION;
  if (rv >= 2 || va >= 1.5) return IGNITION_STATES.EARLY_IGNITION;
  return IGNITION_STATES.NO_IGNITION;
}

// ── ORCHESTRATOR ─────────────────────────────────────────────────────────────
// Everything above, assembled into the record the API and UI consume. Pure — the caller does
// the fetching and passes context in, which is what makes the whole scoring path testable.
function analyzeLowFloatIgnition(input = {}, ctx = {}) {
  const f = calculateIgnitionFeatures(input);
  const explosion = scoreExplosionPotential(f, ctx);
  const quality = scoreTradeQuality(f, ctx);
  const ignitionState = classifyIgnitionState(f, ctx);
  const st = ctx.structure || null;

  const blockingReasons = [];
  if (ctx.stale === true) blockingReasons.push('STALE_DATA');
  if (finite(f.minutesUntilClose) && f.minutesUntilClose < ENTRY.MIN_NEW_ENTRY_MINUTES_TO_CLOSE) blockingReasons.push('INSUFFICIENT_TIME_TO_CLOSE');
  if (st && ['FAILED_BREAKOUT', 'DISTRIBUTION', 'EXHAUSTED'].includes(st.structureState)) blockingReasons.push(`SETUP_${st.structureState}`);
  if (ctx.supplyRisk && ctx.supplyRisk.dilutionRisk === 'HIGH') blockingReasons.push('HIGH_SUPPLY_RISK_UNVALIDATED_GROUP');

  return {
    version: LOW_FLOAT_IGNITION_VERSION,
    schemaVersion: SCHEMA_VERSION,
    scoringVersion: LOW_FLOAT_IGNITION_VERSION,
    ticker: input.ticker || null,
    asOf: ctx.now ? new Date(ctx.now).toISOString() : new Date().toISOString(),
    firstDetectedAt: input.firstDetectedAt || null,
    price: f.price,
    floatShares: f.floatShares,
    floatTier: ctx.floatTier || (f.floatUsable ? undefined : 'UNKNOWN'),
    floatConfidence: ctx.floatConfidence || 'LOW',
    sharesOutstanding: f.sharesOutstanding,
    currentSessionVolume: f.sessionVolume,
    currentSessionDollarVolume: f.sessionDollarVolume,
    floatTurnover: f.floatTurnover,
    recentFloatTurnover: f.recentFloatTurnover,
    fiveMinVolumeAcceleration: f.volumeAcceleration5m,
    fifteenMinVolumeAcceleration: f.volumeAcceleration15m,
    fiveMinPriceAcceleration: f.priceAcceleration5m,
    fifteenMinPriceAcceleration: f.priceAcceleration15m,
    thirtyMinPriceAcceleration: f.priceAcceleration30m,
    currentDollarVolume5m: f.dollarVolume5m,
    currentDollarVolume15m: f.dollarVolume15m,
    relativeVolume: f.relativeVolume,
    dayChangePct: f.dayChangePct,
    catalyst: ctx.catalyst ? ctx.catalyst.catalystType : null,
    catalystTier: ctx.catalyst ? ctx.catalyst.catalystTier : null,
    catalystFreshnessMinutes: ctx.catalyst ? ctx.catalyst.freshnessMinutes : null,
    dilutionRisk: ctx.supplyRisk ? ctx.supplyRisk.dilutionRisk : 'UNKNOWN',
    explosionPotentialScore: explosion.explosionPotentialScore,
    explosionFamilies: explosion.families,
    tradeQualityScore: quality.tradeQualityScore,
    tradeQualityFamilies: quality.families,
    continuationScore: st ? st.continuationScore : null,
    remainingEdgeScore: st ? st.remainingEdgeScore : null,
    ignitionState,
    structureState: st ? st.structureState : null,
    actionState: null,          // Stage 3 (lib/intraday-actionability) sets this
    minutesUntilClose: f.minutesUntilClose,
    sessionWindow: f.sessionWindow,
    featureBasis: f.basis,
    reasonCodes: [...explosion.reasonCodes, ...quality.reasonCodes].slice(0, 12),
    blockingReasons,
    warnings: [...explosion.penalties, ...quality.warnings].slice(0, 12),
    features: f,
    explosionDetail: explosion,
    qualityDetail: quality,
  };
}

// Default ordering for the Low-Float Radar. NOT by day gain — by the joint read the spec
// specifies: high explosion with acceptable quality first, then high explosion watch-only,
// then moderate explosion, then the avoided names.
function ignitionSortBucket(rec) {
  const e = rec.explosionPotentialScore ?? 0;
  const q = rec.tradeQualityScore ?? 0;
  if ((rec.blockingReasons || []).length && q < 40) return 4;   // avoided / rejected
  if (e >= 60 && q >= 55) return 0;
  if (e >= 60) return 1;
  if (e >= 40) return 2;
  return 3;
}

function sortIgnitionRecords(records) {
  return [...records].sort((a, b) => {
    const ba = ignitionSortBucket(a), bb = ignitionSortBucket(b);
    if (ba !== bb) return ba - bb;
    return (b.explosionPotentialScore ?? 0) - (a.explosionPotentialScore ?? 0)
      || (b.tradeQualityScore ?? 0) - (a.tradeQualityScore ?? 0);
  });
}

module.exports = {
  IGNITION_STATES, LOW_FLOAT_IGNITION_VERSION,
  ramp, sessionWindowAt, minutesUntilClose,
  calculateIgnitionFeatures, scoreExplosionPotential, scoreTradeQuality,
  classifyIgnitionState, analyzeLowFloatIgnition, ignitionSortBucket, sortIgnitionRecords,
};
