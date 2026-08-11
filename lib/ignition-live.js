'use strict';
// IGNITION LIVE — the spec-shaped synthesis over the low-float pipeline's evidence.
//
// PURE MODULE. No network, no store, no clock reads beyond the `now` handed in. Everything
// here is computed from a pipeline record (lib/lowfloat-pipeline.js) plus optional context
// (attention metrics, dilution assessment, short-interest flag, regime). That is what makes
// every rule below unit-testable and what keeps the tick's cost profile unchanged.
//
// THE TWO-SCORE CONTRACT (non-negotiable, mirrors explosion-vs-quality upstream):
//   IGNITION_SCORE    "how powerful and abnormal is this momentum event?"
//   OPPORTUNITY_SCORE "how attractive is the CURRENT trade location?"
// They are intentionally different numbers and the dashboard default-sorts by OPPORTUNITY.
// A stock can print Ignition 97 with Opportunity 20 because it is already parabolic —
// EXTENSION_RISK is allowed to override momentum enthusiasm, always.
//
// HONESTY RULES enforced here:
//   - A missing input earns ZERO of its component weight. It is never imputed, and the
//     weight is not redistributed. UNKNOWN float ≠ low float; UNKNOWN dilution ≠ safe.
//   - Nothing in this file is a probability. Derived outlook labels are RULE_BASED_ESTIMATE.
//   - Halt/LULD fields are structurally UNKNOWN on this stack (no halt feed) and are
//     reported as such rather than modeled.

const C = require('./ignition-live-config');

const finite = v => Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Saturating ramp: 0 at `lo`, 1 at `hi`. The workhorse normalizer (same idiom as
// low-float-ignition's ramp, returned as a 0..1 fraction).
const frac = (v, lo, hi) => (finite(v) ? clamp((v - lo) / (hi - lo), 0, 1) : 0);

// ── CATALYST GRADE ───────────────────────────────────────────────────────────
// Maps the existing 4-tier classifier onto the spec's A/B/C/D/NONE letters and applies the
// spec's freshness-decay table. `null` grade means NOT_EVALUATED (budget) — distinct from
// NONE (news checked, nothing material), and never awarded credit.
function catalystGrade(rec = {}) {
  const tier = rec.catalystTier;
  const evaluated = tier != null || rec.catalystPresent === false;
  if (!evaluated) {
    return { grade: null, baseScore: 0, decayFactor: null, score: 0, basis: 'NOT_EVALUATED — catalyst was not checked this cycle (budget); no credit awarded' };
  }
  let grade = 'NONE';
  if (tier === 1) grade = 'A';
  else if (tier === 2) grade = 'B';
  else if (tier === 3) grade = 'C';
  else if (tier === 4 && rec.catalystPresent !== false) grade = 'D';
  const base = C.CATALYST_GRADES[grade].base;

  const age = rec.catalystFreshnessMinutes;
  const decay = grade === 'NONE' ? 0
    : !finite(age) ? C.CATALYST_DECAY_UNKNOWN_AGE
    : C.CATALYST_DECAY.find(s => age <= s.maxMinutes).factor;
  const recycledMult = rec.catalystRecycled === true ? C.CATALYST_RECYCLED_FACTOR : 1;

  const score = +(base * decay * recycledMult).toFixed(2);
  return {
    grade, baseScore: base, decayFactor: decay,
    recycled: rec.catalystRecycled === true, score,
    catalystType: rec.catalyst || null,
    ageMinutes: finite(age) ? age : null,
    basis: grade === 'NONE' ? 'news checked — no material catalyst class matched'
      : `tier-${tier} catalyst, decay ×${decay}${recycledMult < 1 ? ', recycled ×0.5' : ''}`,
  };
}

// ── SUPPLY PRESSURE (0-100) ──────────────────────────────────────────────────
// Rises with a small float, fast turnover, rising turnover velocity, and strength holding
// near the high on real participation. An UNKNOWN float earns zero — never proxied.
const FLOAT_TIER_POINTS = Object.freeze({
  ULTRA_LOW: 40, LOW: 32, MODERATELY_LOW: 22, SMALL_SUPPLY: 12, NORMAL: 4, UNKNOWN: 0,
});
function supplyPressureScore(rec = {}, { turnoverVelocityPerMin = null } = {}) {
  const tierPts = FLOAT_TIER_POINTS[rec.floatTier] ?? 0;
  const floatKnown = tierPts > 0 || rec.floatTier === 'NORMAL';
  const turnover = floatKnown ? rec.floatTurnover : null;
  const turnoverPts = frac(turnover, 0, 1.5) * 30;
  // Velocity in float-fractions per minute; 0.5%/min ≈ a full float turn in ~3.3 hours.
  const velocityPts = floatKnown ? frac(turnoverVelocityPerMin, 0, 0.005) * 15 : 0;
  const nearHigh = finite(rec.distanceFromHighPct) && rec.distanceFromHighPct > -3;
  const persistentVol = (rec.fiveMinVolumeAcceleration ?? 0) >= 1;
  const strengthPts = floatKnown && nearHigh && persistentVol ? 15 : 0;
  const score = Math.round(clamp(tierPts + turnoverPts + velocityPts + strengthPts, 0, 100));
  return {
    score,
    components: { floatTier: tierPts, turnover: +turnoverPts.toFixed(1), turnoverVelocity: +velocityPts.toFixed(1), strengthNearHigh: strengthPts },
    turnoverVelocityPerMin: finite(turnoverVelocityPerMin) ? +turnoverVelocityPerMin.toFixed(5) : null,
    basis: floatKnown ? 'real float from provider' : 'float UNKNOWN — zero supply credit (never inferred from market cap)',
  };
}

// ── IGNITION_SCORE (0-100) ───────────────────────────────────────────────────
// The spec's weight table over normalized components. Acceleration terms deliberately weigh
// the RATE of change alongside the level: a +10% name still accelerating outranks a +60%
// name that is decelerating (the low-float scorer's signature property, preserved here).
function ignitionScore(rec = {}, ctx = {}) {
  const W = C.IGNITION_WEIGHTS;
  const sf = rec.structureFeatures || {};
  const cat = ctx.catalyst || catalystGrade(rec);
  const supply = ctx.supply || supplyPressureScore(rec, ctx);

  // Dollar-volume acceleration: 5-minute dollar volume vs one-third of the trailing
  // 15-minute dollar volume (>1 = the newest window is running ahead of its recent pace).
  const dv5 = rec.currentDollarVolume5m, dv15 = rec.currentDollarVolume15m;
  const dollarVolAccel = finite(dv5) && finite(dv15) && dv15 > 0 ? dv5 / (dv15 / 3) : null;

  const components = {
    CATALYST_QUALITY: clamp(cat.score / C.CATALYST_GRADES.A.base, 0, 1),
    PARTICIPATION: 0.5 * frac(rec.relativeVolume, 1.5, 10) + 0.5 * frac(rec.fiveMinVolumeAcceleration, 1, 4),
    SUPPLY_PRESSURE: supply.score / 100,
    PRICE_MOMENTUM: 0.45 * frac(rec.dayChangePct, 3, 30)
      + 0.35 * frac(rec.fiveMinPriceAcceleration, 0.3, 4)
      + 0.20 * frac(rec.fifteenMinPriceAcceleration, 0.8, 8),
    DOLLAR_VOLUME_ACCELERATION: frac(dollarVolAccel, 1, 4),
    TECHNICAL_STRUCTURE: (sf.aboveVwap === true ? 0.35 : 0)
      + frac(sf.consecutiveHigherLows, 0, 3) * 0.35
      + (sf.emaStacked === true ? 0.15 : 0)
      + (finite(rec.distanceFromHighPct) && rec.distanceFromHighPct > -3 ? 0.15 : 0),
    BASE_COMPRESSION: (finite(sf.compressionRatio) && sf.compressionRatio <= 0.65 ? 0.6 : 0)
      + (['COMPRESSION', 'BREAKOUT_PENDING'].includes(rec.structureState) ? 0.4 : 0),
    // No per-ticker multi-day history fits the intraday budget; the component exists so the
    // weight is visibly UNEARNED rather than silently redistributed.
    MOMENTUM_HISTORY: 0,
    SHORT_PRESSURE: ctx.shortPressure && ctx.shortPressure.level === 'high' ? 1
      : ctx.shortPressure && ctx.shortPressure.level === 'elevated' ? 0.6
      : ctx.shortPressure && ctx.shortPressure.known ? 0.2 : 0,
    MARKET_CONTEXT: ctx.regime === 'risk-on' ? 1 : ctx.regime === 'risk-off' ? 0.2 : 0.6,
  };

  let raw = 0;
  const points = {};
  for (const [k, w] of Object.entries(W)) {
    const p = clamp(components[k] ?? 0, 0, 1) * w;
    points[k] = +p.toFixed(2);
    raw += p;
  }
  const staleDiscount = rec.stale === true ? C.STALE_SCORE_FACTOR : 1;
  const score = Math.round(clamp(raw * staleDiscount, 0, 100));
  return {
    score, points,
    dollarVolumeAcceleration: finite(dollarVolAccel) ? +dollarVolAccel.toFixed(2) : null,
    staleDiscount: staleDiscount < 1 ? staleDiscount : null,
    unearned: Object.entries(points).filter(([, p]) => p === 0).map(([k]) => k),
  };
}

// ── EXTENSION_RISK (0-100 + label) ───────────────────────────────────────────
// Every term saturates at the stack's pre-registered "the move is already made" ceilings.
// All-null inputs (no bars) → null risk with an UNKNOWN label, never a reassuring zero.
function extensionRisk(rec = {}) {
  const P = C.EXTENSION_POINTS;
  const sf = rec.structureFeatures || {};
  const ema9DistAtr = finite(rec.price) && finite(rec.ema9) && finite(sf.atr5m) && sf.atr5m > 0
    ? (rec.price - rec.ema9) / sf.atr5m : null;

  const inputsSeen = [sf.vwapExtensionAtr, sf.vwapDistancePct, rec.dayChangePct, sf.sessionRunPct]
    .some(finite);
  if (!inputsSeen) {
    return { risk: null, label: 'UNKNOWN', points: null, basis: 'no usable intraday inputs — extension cannot be assessed' };
  }

  const points = {
    VWAP_EXTENSION_ATR: frac(sf.vwapExtensionAtr, 0, 4) * P.VWAP_EXTENSION_ATR,
    VWAP_DISTANCE_PCT: frac(sf.vwapDistancePct, 0, 18) * P.VWAP_DISTANCE_PCT,
    EMA9_DISTANCE_ATR: frac(ema9DistAtr, 0, 3) * P.EMA9_DISTANCE_ATR,
    DAY_GAIN: frac(rec.dayChangePct, 0, 80) * P.DAY_GAIN,
    PARABOLIC_RUN: (finite(sf.sessionRunPct) && sf.sessionRunPct >= 40 ? 1 : frac(sf.sessionRunPct, 20, 40) * 0.5) * P.PARABOLIC_RUN,
    VOLUME_CLIMAX: frac(sf.lastBarVolMult, 2, 4) * P.VOLUME_CLIMAX,
    UPPER_WICK: sf.upperWickRisk === true ? P.UPPER_WICK : 0,
  };
  const risk = Math.round(clamp(Object.values(points).reduce((a, b) => a + b, 0), 0, 100));
  const label = C.EXTENSION_BANDS.find(b => risk <= b.max).label;
  return {
    risk, label,
    points: Object.fromEntries(Object.entries(points).map(([k, v]) => [k, +v.toFixed(1)])),
    basis: 'saturates at the same ceilings the entry gate enforces (ENTRY.MAX_VWAP_EXTENSION_*)',
  };
}

// ── STAGE CLASSIFIER ─────────────────────────────────────────────────────────
// Deterministic, destructive-first. The architecture point the spec asks for: the mapping is
// one pure function of already-versioned states, so a future model can replace this function
// without touching anything upstream or downstream of it.
function stageOf(rec = {}, ext = null) {
  const st = rec.structureState;
  const ig = rec.ignitionState;
  const sf = rec.structureFeatures || {};
  const extRisk = ext && finite(ext.risk) ? ext.risk : null;

  if (st === 'FAILED_BREAKOUT' || st === 'DISTRIBUTION'
    || (ig === 'FADING' && sf.aboveVwap === false)) return C.STAGES.FAILED;
  if (st === 'EXHAUSTED' || ig === 'CLIMAX' || ig === 'FADING') return C.STAGES.EXHAUSTION;
  if ((extRisk != null && extRisk > 80)
    || (finite(sf.sessionRunPct) && sf.sessionRunPct >= 40 && (sf.lastBarVolMult ?? 0) >= 4)) return C.STAGES.PARABOLIC;

  const nearHigh = finite(rec.distanceFromHighPct) && rec.distanceFromHighPct > -2;
  const inBreakout = ['BREAKOUT_CONFIRMED', 'BREAKOUT_ATTEMPT', 'BREAKOUT_RETEST'].includes(st);
  if (ig === 'SUSTAINED_IGNITION' && inBreakout && nearHigh
    && (rec.fiveMinVolumeAcceleration ?? 0) >= 1) return C.STAGES.EXPANSION;
  if (inBreakout) return C.STAGES.BREAKOUT;

  const constructiveBase = ['COMPRESSION', 'BREAKOUT_PENDING', 'CONSTRUCTIVE_PULLBACK'].includes(st);
  if (sf.aboveVwap === true && constructiveBase
    && (ig === 'SUSTAINED_IGNITION' || ig === 'EARLY_IGNITION' || (sf.consecutiveHigherLows ?? 0) >= 2)) return C.STAGES.CONFIRMING;
  if (ig === 'EARLY_IGNITION' || st === 'EARLY_IGNITION') return C.STAGES.EARLY_IGNITION;
  return C.STAGES.DORMANT;
}

// ── OPPORTUNITY_SCORE (0-100) ────────────────────────────────────────────────
function opportunityScore(rec = {}, { ignition, ext, stage, catalyst, attention } = {}) {
  const O = C.OPPORTUNITY;
  const base = 100 * (
    O.ENTRY_QUALITY_SHARE * frac(rec.entryQualityScore, 0, 100)
    + O.TRADE_QUALITY_SHARE * frac(rec.tradeQualityScore, 0, 100)
    + O.IGNITION_SHARE * frac(ignition && ignition.score, 0, 100)
    + O.RISK_REWARD_SHARE * frac(rec.riskReward, 0, O.RISK_REWARD_SATURATION)
  );

  const risk = ext && finite(ext.risk) ? ext.risk : null;
  // No extension reading (stale/no bars) is treated as fully penalized — an unmeasurable
  // location can never look like a clean one.
  const extensionMult = risk == null ? O.EXTENSION_FLOOR_MULT
    : 1 - frac(risk, O.EXTENSION_FREE_THROUGH, 100) * (1 - O.EXTENSION_FLOOR_MULT);
  const stageMult = O.STAGE_MULT[stage] ?? 0.5;

  let score = base * extensionMult * stageMult;
  if (attention && attention.surge) score += O.ATTENTION_SURGE_BONUS;
  if (catalyst && O.CATALYST_BONUS[catalyst.grade]) score += O.CATALYST_BONUS[catalyst.grade];

  const blocked = rec.stale === true
    || ['AVOID', 'NO_TRADE'].includes(rec.actionState)
    || (rec.blockingReasons || []).length > 0;
  if (blocked) score = Math.min(score, O.BLOCKED_CAP);

  return {
    score: Math.round(clamp(score, 0, 100)),
    base: Math.round(base), extensionMult: +extensionMult.toFixed(3), stageMult,
    blockedCapApplied: blocked,
  };
}

// ── DATA QUALITY ─────────────────────────────────────────────────────────────
// This stack is NEVER "REALTIME": bars are 5-minute and only completed bars are evidence.
function dataQualityOf(rec = {}) {
  if (!rec.analyzed) return { quality: 'LOW', feed: 'UNAVAILABLE', note: 'no usable intraday bars this cycle' };
  if (rec.stale) return { quality: 'LOW', feed: 'STALE', note: 'newest completed bar is beyond the freshness ceiling' };
  return { quality: 'MEDIUM', feed: 'DELAYED', note: '5-minute completed-bar resolution — never real-time on this stack' };
}

// ── ALERT STATES ─────────────────────────────────────────────────────────────
// Returns every state the record currently qualifies for; the first is the primary.
function alertStatesOf(view) {
  const out = [];
  const A = C.ALERTS;
  const ig = view.ignitionScore, st = view.stage;
  if (st === C.STAGES.FAILED) out.push(C.ALERT_STATES.FAILED);
  if (view.extensionLabel === 'PARABOLIC_EXIT_BIAS') out.push(C.ALERT_STATES.PARABOLIC_WARNING);
  if (st === C.STAGES.BREAKOUT && ig >= A.BREAKOUT_MIN_IGNITION) out.push(C.ALERT_STATES.BREAKOUT);
  if (st === C.STAGES.CONFIRMING && ig >= A.CONFIRMED_MIN_IGNITION && view.entryTemplate) out.push(C.ALERT_STATES.CONFIRMED);
  if ((st === C.STAGES.EARLY_IGNITION || st === C.STAGES.CONFIRMING) && ig >= A.IGNITION_MIN_IGNITION) out.push(C.ALERT_STATES.IGNITION);
  if (view.attention && view.attention.surge) out.push(C.ALERT_STATES.ATTENTION_SURGE);
  if (st === C.STAGES.EARLY_IGNITION && ig >= A.WATCH_MIN_IGNITION) out.push(C.ALERT_STATES.WATCH);
  return [...new Set(out)];
}

// ── WHY NOW / RISKS ──────────────────────────────────────────────────────────
function whyNowOf(rec, { catalyst, supply, attention, ignition } = {}) {
  const sf = rec.structureFeatures || {};
  const out = [];
  if (catalyst && (catalyst.grade === 'A' || catalyst.grade === 'B')) out.push(`Fresh tier-${catalyst.grade} catalyst (${catalyst.catalystType || 'news'})`);
  if ((rec.relativeVolume ?? 0) >= 3) out.push(`RVOL ${rec.relativeVolume.toFixed(1)}×`);
  if ((rec.fiveMinVolumeAcceleration ?? 0) >= 2) out.push(`Volume accelerating ${rec.fiveMinVolumeAcceleration.toFixed(1)}× recent pace`);
  if (ignition && (ignition.dollarVolumeAcceleration ?? 0) >= 1.5) out.push(`Dollar volume accelerating ${ignition.dollarVolumeAcceleration.toFixed(1)}×`);
  if (supply && supply.score >= 50) out.push(`Supply pressure ${supply.score}/100 (${rec.floatTier} float, turnover ${finite(rec.floatTurnover) ? rec.floatTurnover.toFixed(2) + '×' : 'n/a'})`);
  if (sf.aboveVwap === true) out.push('Above VWAP');
  if ((sf.consecutiveHigherLows ?? 0) >= 2) out.push(`${sf.consecutiveHigherLows} higher lows`);
  if (finite(rec.distanceFromHighPct) && rec.distanceFromHighPct > -2) out.push('Within 2% of session high');
  if (attention && finite(attention.rankNow) && finite(attention.rank20mAgo) && attention.rank20mAgo - attention.rankNow >= 20) {
    out.push(`Attention rank #${attention.rank20mAgo} → #${attention.rankNow}`);
  }
  return out;
}

function risksOf(rec, { dilution, ext } = {}) {
  const out = [];
  if (rec.floatTier === 'ULTRA_LOW' || rec.floatTier === 'LOW') out.push('Micro-float: extreme volatility and slippage');
  if (rec.floatTier === 'UNKNOWN') out.push('Float UNKNOWN — supply cannot be assessed');
  const dl = dilution ? dilution.label : rec.dilutionRisk;
  if (dl === 'HIGH' || dl === 'EXTREME') out.push(`Dilution risk ${dl}`);
  if (dl === 'UNKNOWN') out.push('Dilution risk UNKNOWN — not cleared');
  if (ext && ext.label === 'DO_NOT_INITIATE') out.push('Extended — do not initiate');
  if (ext && ext.label === 'PARABOLIC_EXIT_BIAS') out.push('Parabolic — exit bias, do not chase');
  if (rec.manualSpreadCheckRequired) out.push('No NBBO — manual spread check required');
  if (rec.stale) out.push('Stale data — nothing actionable');
  for (const b of (rec.blockingReasons || []).slice(0, 3)) out.push(`Blocked: ${b}`);
  return out;
}

// ── THE SYNTHESIS ────────────────────────────────────────────────────────────
// One record in, one IGNITION view out. `ctx` carries the tick-level extras.
function synthesizeIgnitionView(rec = {}, ctx = {}) {
  const catalyst = catalystGrade(rec);
  const supply = supplyPressureScore(rec, { turnoverVelocityPerMin: ctx.turnoverVelocityPerMin });
  const ignition = ignitionScore(rec, { ...ctx, catalyst, supply });
  const ext = extensionRisk(rec);
  const stage = stageOf(rec, ext);
  const opportunity = opportunityScore(rec, { ignition, ext, stage, catalyst, attention: ctx.attention });
  const dq = dataQualityOf(rec);

  const view = {
    version: C.IGNITION_LIVE_VERSION,
    ticker: rec.ticker,
    price: rec.price,
    dayChangePct: rec.dayChangePct,
    ignitionScore: ignition.score,
    ignitionComponents: ignition.points,
    ignitionUnearned: ignition.unearned,
    opportunityScore: opportunity.score,
    opportunityDetail: opportunity,
    stage,
    extensionRisk: ext.risk,
    extensionLabel: ext.label,
    extensionPoints: ext.points,
    catalystGrade: catalyst.grade,
    catalystScore: catalyst.score,
    catalystType: catalyst.catalystType || null,
    catalystAgeMinutes: catalyst.ageMinutes ?? null,
    supplyPressureScore: supply.score,
    floatTurnoverVelocityPerMin: supply.turnoverVelocityPerMin,
    dollarVolumeAcceleration: ignition.dollarVolumeAcceleration,
    attention: ctx.attention || null,
    dilution: ctx.dilution || null,
    shortPressure: ctx.shortPressure || null,
    // The anti-FOMO contract reuses the actionability layer's chase ceiling verbatim.
    doNotChasePrice: rec.maximumChasePrice ?? null,
    trigger: rec.trigger ?? null,
    invalidation: rec.invalidation ?? null,
    riskReward: rec.riskReward ?? null,
    entryTemplate: rec.entryTemplate ?? null,
    setup: rec.entryTemplate ?? null,
    actionState: rec.actionState ?? null,
    structureState: rec.structureState ?? null,
    ignitionState: rec.ignitionState ?? null,
    relativeVolume: rec.relativeVolume ?? null,
    fiveMinVolumeAcceleration: rec.fiveMinVolumeAcceleration ?? null,
    floatShares: rec.floatShares ?? null,
    floatTier: rec.floatTier ?? 'UNKNOWN',
    floatTurnover: rec.floatTurnover ?? null,
    dataQuality: dq,
    // Structural absences, stated per record so a consumer can never forget them.
    haltCount: null,
    haltStatus: 'UNKNOWN — no halt/LULD feed on this stack',
    scoreBasis: 'RULE_BASED_ESTIMATE — pre-registered weights over deterministic features; not a probability, not fitted, no edge claimed',
  };
  view.alertStates = alertStatesOf(view);
  view.whyNow = whyNowOf(rec, { catalyst, supply, attention: ctx.attention, ignition });
  view.risks = risksOf(rec, { dilution: ctx.dilution, ext });
  return view;
}

module.exports = {
  IGNITION_LIVE_VERSION: C.IGNITION_LIVE_VERSION,
  STAGES: C.STAGES, ALERT_STATES: C.ALERT_STATES,
  frac, catalystGrade, supplyPressureScore, ignitionScore, extensionRisk, stageOf,
  opportunityScore, dataQualityOf, alertStatesOf, synthesizeIgnitionView,
};
