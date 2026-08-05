'use strict';
// STAGE 3 — ACTIONABILITY: may this be entered, and if not, what exactly must happen first?
//
// This is the module that stops the app from doing the five things that lose money on a good
// screener: chasing, buying a forming-candle "breakout", buying stale data, buying a setup
// that already failed, and entering with no time left.
//
// EVERY BLOCK IS A HARD BLOCK. There is no score high enough to override "the data is stale"
// or "the breakout failed". Blocks are evaluated before any scoring, they are reason-coded,
// and they are all surfaced — a blocked candidate shows WHY, which is more useful than
// silently disappearing from the list.
//
// LIVE vs PAPER. The ONLY path to actionState = LIVE_VALIDATED_ENTRY is: the entry template
// has passed the formal promotion gate in lib/intraday-validation.js AND the
// ENABLE_LIVE_VALIDATED_SIGNALS flag is on AND the configuration version matches the one the
// template was validated under. Absent any of those, the best available state is
// PAPER_ENTRY_ELIGIBLE. A manual threshold cannot promote anything.

const { ENTRY, ACTIONABILITY_VERSION, SCHEMA_VERSION, flags, FLOAT_TIERS } = require('./lowfloat-config');
const { STRUCTURE_STATES } = require('./intraday-continuation');

const ACTION_STATES = Object.freeze({
  NO_TRADE: 'NO_TRADE',
  RESEARCH_CANDIDATE: 'RESEARCH_CANDIDATE',
  SETUP_BUILDING: 'SETUP_BUILDING',
  WATCH_ONLY: 'WATCH_ONLY',
  READY_IF_TRIGGERED: 'READY_IF_TRIGGERED',
  PAPER_ENTRY_ELIGIBLE: 'PAPER_ENTRY_ELIGIBLE',
  MISSED_OR_EXTENDED: 'MISSED_OR_EXTENDED',
  MANAGE_EXISTING_ONLY: 'MANAGE_EXISTING_ONLY',
  AVOID: 'AVOID',
  LIVE_VALIDATED_ENTRY: 'LIVE_VALIDATED_ENTRY',
});

const ENTRY_TEMPLATES = Object.freeze({
  COMPLETED_BREAKOUT: 'COMPLETED_BREAKOUT',
  FIRST_BREAKOUT_RETEST: 'FIRST_BREAKOUT_RETEST',
  VWAP_PULLBACK_RECOVERY: 'VWAP_PULLBACK_RECOVERY',
  HIGH_OF_DAY_COMPRESSION_BREAK: 'HIGH_OF_DAY_COMPRESSION_BREAK',
  EARLY_IGNITION_CONTINUATION: 'EARLY_IGNITION_CONTINUATION',
  AFTERNOON_VOLUME_REACCELERATION: 'AFTERNOON_VOLUME_REACCELERATION',
});

// Templates that are RESEARCH-ONLY by construction — they never reach paper-entry eligibility
// until their own evidence has accrued, regardless of how good an individual instance looks.
const RESEARCH_ONLY_TEMPLATES = new Set([ENTRY_TEMPLATES.EARLY_IGNITION_CONTINUATION]);

const SETUP_ENTRY_CLASSES = Object.freeze({
  GOOD_SETUP_GOOD_ENTRY: 'GOOD_SETUP_GOOD_ENTRY',
  GOOD_SETUP_WAITING: 'GOOD_SETUP_WAITING',
  GOOD_SETUP_BAD_ENTRY: 'GOOD_SETUP_BAD_ENTRY',
  BAD_SETUP: 'BAD_SETUP',
  FAILED_SETUP: 'FAILED_SETUP',
});

const finite = v => Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ── ENTRY ZONE AND MAXIMUM CHASE PRICE ───────────────────────────────────────
// Both a percentage and an ATR constraint apply; the TIGHTER one binds. That is what makes
// the same rule sane on a $2 name with 15% swings and a $60 name with 1.5% swings.
function buildEntryZone(analysis) {
  const trigger = analysis && analysis.trigger;
  const atr = analysis && analysis.atr5m;
  if (!finite(trigger) || trigger <= 0) return null;
  const byAtr = finite(atr) && atr > 0 ? trigger + ENTRY.MAX_CHASE_ATR * atr : Infinity;
  const byPct = trigger * (1 + ENTRY.MAX_CHASE_PCT / 100);
  const maximumChasePrice = +Math.min(byAtr, byPct).toFixed(2);
  return {
    trigger: +trigger.toFixed(2),
    entryZoneLow: +trigger.toFixed(2),
    entryZoneHigh: maximumChasePrice,
    maximumChasePrice,
    boundBy: byAtr < byPct ? 'atr' : 'percent',
    chaseBasis: `entry may not exceed the trigger by more than ${ENTRY.MAX_CHASE_ATR}×ATR(5m) or ${ENTRY.MAX_CHASE_PCT}%, whichever is tighter`,
  };
}

// ── TEMPLATE SELECTION ───────────────────────────────────────────────────────
// One template per candidate, chosen by the structure state plus session context. Templates
// are tracked SEPARATELY through validation — their outcomes are never merged.
function selectEntryTemplate(analysis, ctx = {}) {
  const s = analysis && analysis.structureState;
  const window = analysis && analysis.sessionWindow;
  const S = STRUCTURE_STATES;

  if (s === S.BREAKOUT_CONFIRMED) {
    // An afternoon re-acceleration in a name that led this morning is its own template — the
    // conditions and the base rate are different from a 10:15 breakout.
    if (window === 'PRIME_AFTERNOON' && ctx.morningLeader === true && ctx.volumeReaccelerating === true) {
      return ENTRY_TEMPLATES.AFTERNOON_VOLUME_REACCELERATION;
    }
    return ENTRY_TEMPLATES.COMPLETED_BREAKOUT;
  }
  if (s === S.BREAKOUT_RETEST) return ENTRY_TEMPLATES.FIRST_BREAKOUT_RETEST;
  if (s === S.CONSTRUCTIVE_PULLBACK) return ENTRY_TEMPLATES.VWAP_PULLBACK_RECOVERY;
  if (s === S.COMPRESSION || s === S.BREAKOUT_PENDING) return ENTRY_TEMPLATES.HIGH_OF_DAY_COMPRESSION_BREAK;
  if (s === S.EARLY_IGNITION) return ENTRY_TEMPLATES.EARLY_IGNITION_CONTINUATION;
  return null;
}

// Per-template requirement checks. Each returns { satisfied, missing:[] } so the UI can show
// exactly which condition is outstanding rather than a bare "not ready".
function templateRequirements(template, analysis, ctx = {}) {
  const f = (analysis && analysis.features) || {};
  const missing = [];
  const req = (ok, code) => { if (!ok) missing.push(code); };
  const S = STRUCTURE_STATES;

  switch (template) {
    case ENTRY_TEMPLATES.COMPLETED_BREAKOUT:
      req(analysis.structureState === S.BREAKOUT_CONFIRMED, 'NEEDS_COMPLETED_CLOSE_ABOVE_RESISTANCE');
      req(f.volumeConfirmed === true, 'NEEDS_VOLUME_CONFIRMATION');
      req(f.closedUpperHalf === true, 'NEEDS_UPPER_HALF_CLOSE');
      req(analysis.aboveVwap === true, 'NEEDS_PRICE_ABOVE_VWAP');
      req(!finite(analysis.vwapExtensionAtr) || analysis.vwapExtensionAtr < ENTRY.MAX_VWAP_EXTENSION_ATR, 'TOO_EXTENDED');
      break;
    case ENTRY_TEMPLATES.FIRST_BREAKOUT_RETEST:
      req(analysis.structureState === S.BREAKOUT_RETEST, 'NEEDS_CONFIRMED_BREAKOUT_THEN_RETEST');
      req((analysis.lowerHighCount || 0) < 3, 'DISTRIBUTION_PATTERN_PRESENT');
      req(!finite(analysis.volumeAcceleration) || analysis.volumeAcceleration < 1.2, 'RETEST_VOLUME_NOT_CONTRACTING');
      break;
    case ENTRY_TEMPLATES.VWAP_PULLBACK_RECOVERY:
      req(analysis.structureState === S.CONSTRUCTIVE_PULLBACK, 'NEEDS_ORDERLY_PULLBACK');
      req(analysis.aboveVwap === true, 'NEEDS_VWAP_SUPPORT');
      req(!!(f.pullbackDetail && f.pullbackDetail.volContracted !== false), 'NEEDS_LOWER_PULLBACK_VOLUME');
      // The RECOVERY must be a completed trigger, not merely a shallow dip.
      req(!!(f.pullbackDetail && f.pullbackDetail.recovering === true), 'NEEDS_COMPLETED_RECOVERY_BAR');
      break;
    case ENTRY_TEMPLATES.HIGH_OF_DAY_COMPRESSION_BREAK:
      // Deliberately never satisfied while pending — this template stays READY_IF_TRIGGERED
      // until a completed bar breaks out, at which point it becomes COMPLETED_BREAKOUT.
      req(false, 'AWAITING_COMPLETED_BREAKOUT_BAR');
      break;
    case ENTRY_TEMPLATES.EARLY_IGNITION_CONTINUATION:
      req(ctx.floatUsable === true, 'NEEDS_RELIABLE_FLOAT');
      req(finite(ctx.floatTurnover) && ctx.floatTurnover > 0, 'NEEDS_FLOAT_TURNOVER');
      req(finite(ctx.sessionDollarVolume) && ctx.sessionDollarVolume >= ENTRY.MIN_SESSION_DOLLAR_VOLUME, 'NEEDS_SESSION_DOLLAR_VOLUME');
      req(!!(ctx.catalyst && ctx.catalyst.catalystPresent && ctx.catalyst.catalystTier <= 2), 'NEEDS_FRESH_MATERIAL_CATALYST');
      req(!finite(analysis.vwapExtensionAtr) || analysis.vwapExtensionAtr < 2.5, 'ALREADY_PARABOLIC');
      req(analysis.upperWickRisk !== true, 'SEVERE_REJECTION_PRESENT');
      break;
    case ENTRY_TEMPLATES.AFTERNOON_VOLUME_REACCELERATION:
      req(ctx.morningLeader === true, 'NEEDS_MORNING_LEADERSHIP');
      req(ctx.heldMiddayVwap !== false, 'NEEDS_MIDDAY_VWAP_HOLD');
      req(ctx.volumeReaccelerating === true, 'NEEDS_RENEWED_VOLUME');
      req(finite(analysis.minutesUntilClose) && analysis.minutesUntilClose >= 45, 'INSUFFICIENT_TIME_REMAINING');
      break;
    default:
      missing.push('NO_TEMPLATE_MATCHED');
  }
  return { satisfied: missing.length === 0, missing };
}

// ── HARD BLOCKS ──────────────────────────────────────────────────────────────
// Every reason a NEW entry may not be taken. Evaluated before scoring; any one of them is
// dispositive. Returns codes plus human sentences (the UI shows the sentences).
function buildAvoidanceReasons(analysis, ctx = {}) {
  const blocking = [];
  const caution = [];
  const add = (cond, code) => { if (cond) blocking.push(code); };
  const warn = (cond, code) => { if (cond) caution.push(code); };
  const S = STRUCTURE_STATES;
  const s = analysis && analysis.structureState;

  // Data integrity
  add(ctx.stale === true, 'STALE_DATA');
  add(s === S.STALE_DATA, 'STALE_DATA');
  add(ctx.priorSessionData === true, 'PRIOR_SESSION_DATA');
  add(finite(ctx.barAgeMinutes) && ctx.barAgeMinutes > ENTRY.MAX_COMPLETED_BAR_AGE_MINUTES, 'BAR_TOO_OLD');
  add(ctx.dataUnreliable === true, 'UNRELIABLE_DATA');

  // Structure
  add(s === S.BREAKOUT_ATTEMPT, 'FORMING_CANDLE_BREAKOUT_NOT_CONFIRMED');
  add(s === S.FAILED_BREAKOUT, 'FAILED_BREAKOUT');
  add(s === S.DISTRIBUTION, 'DISTRIBUTION');
  add(s === S.EXHAUSTED, 'EXHAUSTION');
  add(ctx.postSpikeCollapse === true, 'POST_SPIKE_COLLAPSE');

  // Time
  add(finite(analysis && analysis.minutesUntilClose) && analysis.minutesUntilClose < ENTRY.MIN_NEW_ENTRY_MINUTES_TO_CLOSE, 'INSUFFICIENT_TIME_TO_CLOSE');

  // Risk geometry
  const minRR = analysis && analysis.sessionWindow === 'LATE_SESSION'
    ? ENTRY.LATE_SESSION_MIN_REWARD_RISK : ENTRY.MIN_REWARD_RISK;
  add(finite(analysis && analysis.riskReward) && analysis.riskReward < minRR, 'REWARD_RISK_BELOW_FLOOR');
  add(!finite(analysis && analysis.riskReward), 'NO_VALID_PLAN');
  add(finite(analysis && analysis.stopDistancePct) && analysis.stopDistancePct > ENTRY.MAX_STOP_DISTANCE_PCT, 'STOP_TOO_WIDE');

  // Extension / chase
  const zone = buildEntryZone(analysis);
  const price = analysis && analysis.price;
  add(!!(zone && finite(price) && price > zone.maximumChasePrice), 'ABOVE_MAXIMUM_CHASE_PRICE');
  add(finite(analysis && analysis.vwapExtensionAtr) && analysis.vwapExtensionAtr > ENTRY.MAX_VWAP_EXTENSION_ATR, 'VWAP_EXTENSION_EXCESSIVE');
  add(finite(analysis && analysis.vwapDistancePct) && analysis.vwapDistancePct > ENTRY.MAX_VWAP_EXTENSION_PCT, 'VWAP_EXTENSION_PCT_EXCESSIVE');

  // Liquidity — CURRENT session, not history.
  add(finite(ctx.sessionDollarVolume) && ctx.sessionDollarVolume < ENTRY.MIN_SESSION_DOLLAR_VOLUME, 'SESSION_LIQUIDITY_TOO_THIN');
  add(finite(ctx.price) && ctx.price < ENTRY.MIN_PRICE, 'PRICE_BELOW_FLOOR');

  // Execution visibility — the app has no NBBO, so certain names REQUIRE a human check.
  if (requiresManualSpreadCheck(ctx)) {
    add(ctx.spreadConfirmed !== true, 'MANUAL_SPREAD_CONFIRMATION_REQUIRED');
  }

  // Supply risk — blocks LIVE actionability for the un-validated group, not discovery.
  add(!!(ctx.supplyRisk && ctx.supplyRisk.dilutionRisk === 'HIGH' && ctx.supplyRiskGroupValidated !== true), 'HIGH_SUPPLY_RISK_GROUP_NOT_VALIDATED');

  // Regime — a default, not a validated gate (see lib/daytrade-config REGIME). It is honest
  // about being a policy choice rather than an evidence-backed one.
  add(ctx.regime === 'risk-off' && ctx.allowRiskOffEntries !== true, 'RISK_OFF_MARKET_DEFAULT_BLOCK');

  // Cautions (never blocking on their own)
  warn(ctx.temporalResolutionRisk === true, 'FIVE_MINUTE_RESOLUTION_ONLY');
  warn(ctx.floatConfidence === 'LOW', 'FLOAT_CONFIDENCE_LOW');
  warn(!!(ctx.supplyRisk && ctx.supplyRisk.dilutionRisk === 'MODERATE'), 'MODERATE_DILUTION_RISK');
  warn(analysis && analysis.sessionWindow === 'OPENING_NOISE', 'OPENING_NOISE_WINDOW');
  warn(analysis && analysis.upperWickRisk === true, 'UPPER_WICK_REJECTION');
  warn(finite(analysis && analysis.remainingEdgeScore) && analysis.remainingEdgeScore < 35, 'LOW_REMAINING_EDGE');

  return { blockingReasons: [...new Set(blocking)], cautionReasons: [...new Set(caution)] };
}

// Which names REQUIRE a human spread/liquidity check before any entry can be allowed.
function requiresManualSpreadCheck(ctx = {}) {
  if (ctx.spreadObserved === true) return false;    // a provider gave us a real quoted spread
  if (finite(ctx.price) && ctx.price < ENTRY.MANUAL_SPREAD_PRICE_BELOW) return true;
  if (ENTRY.MANUAL_SPREAD_FLOAT_TIERS.includes(ctx.floatTier)) return true;
  if (finite(ctx.sessionDollarVolume) && ctx.sessionDollarVolume < 10_000_000) return true;
  if (finite(ctx.dayChangePct) && Math.abs(ctx.dayChangePct) > 40) return true;   // violent tape
  return false;
}

// ── ENTRY QUALITY ────────────────────────────────────────────────────────────
// 0-100 quality of THIS entry (not the setup). Distance above trigger dominates: the same
// setup entered at the trigger and 4% above it are different trades.
function calculateEntryQuality(analysis, ctx = {}) {
  if (!analysis || !finite(analysis.price)) return 0;
  const zone = buildEntryZone(analysis);
  let q = 100;
  if (zone && finite(analysis.trigger) && analysis.trigger > 0) {
    const abovePct = ((analysis.price / analysis.trigger) - 1) * 100;
    q -= clamp(abovePct / ENTRY.MAX_CHASE_PCT, 0, 1.5) * 45;
  }
  if (finite(analysis.riskReward)) q -= clamp((3 - analysis.riskReward) / 2, 0, 1) * 20;
  else q -= 20;
  if (finite(analysis.vwapExtensionAtr)) q -= clamp(analysis.vwapExtensionAtr / ENTRY.MAX_VWAP_EXTENSION_ATR, 0, 1) * 20;
  if (finite(analysis.remainingEdgeScore)) q -= clamp((60 - analysis.remainingEdgeScore) / 60, 0, 1) * 15;
  if (analysis.upperWickRisk) q -= 10;
  if (ctx.stale) q = 0;
  return Math.round(clamp(q, 0, 100));
}

// ── SETUP vs ENTRY classification ────────────────────────────────────────────
function classifySetupEntry(analysis, { blockingReasons = [], entryQualityScore = 0 } = {}) {
  const S = STRUCTURE_STATES;
  const s = analysis && analysis.structureState;
  if (s === S.FAILED_BREAKOUT) return SETUP_ENTRY_CLASSES.FAILED_SETUP;
  if ([S.DISTRIBUTION, S.EXHAUSTED, S.STALE_DATA].includes(s)) return SETUP_ENTRY_CLASSES.BAD_SETUP;
  if ([S.COMPRESSION, S.BREAKOUT_PENDING, S.BREAKOUT_ATTEMPT].includes(s)) return SETUP_ENTRY_CLASSES.GOOD_SETUP_WAITING;
  const chaseBlocked = blockingReasons.includes('ABOVE_MAXIMUM_CHASE_PRICE')
    || blockingReasons.includes('VWAP_EXTENSION_EXCESSIVE')
    || blockingReasons.includes('VWAP_EXTENSION_PCT_EXCESSIVE');
  if (chaseBlocked) return SETUP_ENTRY_CLASSES.GOOD_SETUP_BAD_ENTRY;
  if ([S.BREAKOUT_CONFIRMED, S.BREAKOUT_RETEST, S.CONSTRUCTIVE_PULLBACK].includes(s)) {
    return entryQualityScore >= 55 ? SETUP_ENTRY_CLASSES.GOOD_SETUP_GOOD_ENTRY : SETUP_ENTRY_CLASSES.GOOD_SETUP_BAD_ENTRY;
  }
  if (s === S.EARLY_IGNITION) return SETUP_ENTRY_CLASSES.GOOD_SETUP_WAITING;
  return SETUP_ENTRY_CLASSES.BAD_SETUP;
}

// ── CHECKLIST ────────────────────────────────────────────────────────────────
// Every condition, with its current pass/fail. This is what the user actually reads before
// deciding, and it doubles as the audit record of why a state was assigned.
function buildEntryChecklist(analysis, ctx = {}) {
  const zone = buildEntryZone(analysis);
  const minRR = analysis && analysis.sessionWindow === 'LATE_SESSION'
    ? ENTRY.LATE_SESSION_MIN_REWARD_RISK : ENTRY.MIN_REWARD_RISK;
  const item = (label, pass, detail) => ({ label, pass: pass === true, unknown: pass == null, detail: detail ?? null });
  return [
    item('Data is current (completed bar within tolerance)',
      ctx.stale === true ? false : (finite(ctx.barAgeMinutes) ? ctx.barAgeMinutes <= ENTRY.MAX_COMPLETED_BAR_AGE_MINUTES : null),
      finite(ctx.barAgeMinutes) ? `newest completed bar ${ctx.barAgeMinutes.toFixed(1)} min old` : 'bar age unknown'),
    item('Breakout confirmed by a COMPLETED bar (not a forming candle)',
      analysis ? analysis.structureState === STRUCTURE_STATES.BREAKOUT_CONFIRMED
        || analysis.structureState === STRUCTURE_STATES.BREAKOUT_RETEST
        || analysis.structureState === STRUCTURE_STATES.CONSTRUCTIVE_PULLBACK : null,
      analysis ? analysis.structureState : null),
    item('Setup has not failed or begun distributing',
      analysis ? ![STRUCTURE_STATES.FAILED_BREAKOUT, STRUCTURE_STATES.DISTRIBUTION, STRUCTURE_STATES.EXHAUSTED].includes(analysis.structureState) : null),
    item('Price is at or below the maximum chase price',
      zone && finite(analysis.price) ? analysis.price <= zone.maximumChasePrice : null,
      zone ? `max chase $${zone.maximumChasePrice}` : null),
    item(`Reward:risk at least ${minRR}`,
      finite(analysis && analysis.riskReward) ? analysis.riskReward >= minRR : null,
      finite(analysis && analysis.riskReward) ? `${analysis.riskReward}:1` : 'no plan'),
    item('Stop distance is structurally sane',
      finite(analysis && analysis.stopDistancePct) ? analysis.stopDistancePct <= ENTRY.MAX_STOP_DISTANCE_PCT : null,
      finite(analysis && analysis.stopDistancePct) ? `${analysis.stopDistancePct}% to invalidation` : null),
    item(`At least ${ENTRY.MIN_NEW_ENTRY_MINUTES_TO_CLOSE} minutes remain`,
      finite(analysis && analysis.minutesUntilClose) ? analysis.minutesUntilClose >= ENTRY.MIN_NEW_ENTRY_MINUTES_TO_CLOSE : null,
      finite(analysis && analysis.minutesUntilClose) ? `${analysis.minutesUntilClose} min to close` : null),
    item('Current-session liquidity is adequate',
      finite(ctx.sessionDollarVolume) ? ctx.sessionDollarVolume >= ENTRY.MIN_SESSION_DOLLAR_VOLUME : null,
      finite(ctx.sessionDollarVolume) ? `$${(ctx.sessionDollarVolume / 1e6).toFixed(1)}M traded today` : 'unknown'),
    item('Spread and liquidity verified',
      requiresManualSpreadCheck(ctx) ? ctx.spreadConfirmed === true : true,
      requiresManualSpreadCheck(ctx) ? 'manual confirmation required — this app has no NBBO' : 'not required for this name'),
    item('Supply/dilution risk acceptable',
      ctx.supplyRisk ? ctx.supplyRisk.dilutionRisk !== 'HIGH' : null,
      ctx.supplyRisk ? ctx.supplyRisk.dilutionRisk : 'not assessed'),
  ];
}

// ── "WHAT MUST HAPPEN NEXT" ──────────────────────────────────────────────────
// Every non-actionable candidate explains its next required condition in plain language.
function whatMustHappenNext(analysis, { actionState, blockingReasons = [], zone = null, template = null }) {
  const S = STRUCTURE_STATES;
  const s = analysis && analysis.structureState;
  const money = v => (finite(v) ? `$${v.toFixed(2)}` : 'the trigger');

  // An ENTERABLE candidate still has a "next": what invalidates it and where to act. Falling
  // through to the not-met text here told the reader "conditions for an entry are not met" on
  // a card whose headline said PAPER ENTRY ONLY — a direct contradiction.
  if (actionState === ACTION_STATES.PAPER_ENTRY_ELIGIBLE || actionState === ACTION_STATES.LIVE_VALIDATED_ENTRY) {
    const scope = actionState === ACTION_STATES.PAPER_ENTRY_ELIGIBLE
      ? 'Paper entry only — this template has not passed its promotion gate.'
      : 'Validated entry template.';
    return `${scope} Act inside ${money(zone && zone.entryZoneLow)}–${money(zone && zone.maximumChasePrice)} and not above it; the thesis is wrong below ${money(analysis && analysis.invalidation)}.`;
  }

  if (blockingReasons.includes('STALE_DATA') || blockingReasons.includes('PRIOR_SESSION_DATA') || blockingReasons.includes('BAR_TOO_OLD')) {
    return 'The intraday data is not current. No entry decision can be made until fresh completed bars arrive.';
  }
  if (blockingReasons.includes('MANUAL_SPREAD_CONFIRMATION_REQUIRED')) {
    return 'Confirm the current bid/ask spread and depth in your broker, then tick the confirmation. This app has no NBBO feed and will not assume one.';
  }
  if (blockingReasons.includes('INSUFFICIENT_TIME_TO_CLOSE')) {
    return `Fewer than ${ENTRY.MIN_NEW_ENTRY_MINUTES_TO_CLOSE} minutes remain in the session. No new entry — manage existing positions only.`;
  }
  if (actionState === ACTION_STATES.MISSED_OR_EXTENDED) {
    return zone
      ? `Do not chase. A controlled retest of ${money(zone.entryZoneLow)}–${money(zone.maximumChasePrice)} is required before this is an entry again.`
      : 'Do not chase. Price is too far above the trigger; wait for a controlled retest.';
  }
  if (s === S.DISTRIBUTION) {
    return 'Avoid unless price reclaims VWAP, breaks the most recent lower high, and establishes a higher low.';
  }
  if (s === S.FAILED_BREAKOUT) {
    return 'The breakout failed on a completed bar. New entries are blocked until an entirely new structure forms and confirms.';
  }
  if (s === S.EXHAUSTED) {
    return 'The move shows climax characteristics. No new entry; a fresh base and renewed participation would be required.';
  }
  if (s === S.BREAKOUT_ATTEMPT) {
    return 'The active candle is still forming. Confirmation is not complete — wait for the five-minute bar to close above the level.';
  }
  if (s === S.BREAKOUT_PENDING || s === S.COMPRESSION) {
    return `Wait for a completed five-minute close above ${money(analysis && analysis.trigger)} with volume above the recent bar average.`;
  }
  if (s === S.EARLY_IGNITION) {
    return 'Volume and price acceleration are increasing, but a stable entry structure has not formed. Watch only.';
  }
  if (s === S.CONSTRUCTIVE_PULLBACK) {
    return `The pullback is orderly. A completed recovery bar back above ${money(analysis && analysis.trigger)} on rising volume is the trigger.`;
  }
  if (blockingReasons.includes('REWARD_RISK_BELOW_FLOOR')) {
    return 'The reward-to-risk on the structural stop is below the floor. Do not tighten the stop to fix this — wait for a lower entry or a higher target.';
  }
  if (blockingReasons.includes('SESSION_LIQUIDITY_TOO_THIN')) {
    return 'The stock may continue moving, but current session liquidity makes the entry unsuitable.';
  }
  if (template && RESEARCH_ONLY_TEMPLATES.has(template)) {
    return 'This entry template is still in research. It is logged and measured, but is not offered as a paper or live entry.';
  }
  return 'Conditions for an entry are not met. The candidate remains on watch.';
}

// ── THE STATE DECISION ───────────────────────────────────────────────────────
function evaluateActionability(analysis, ctx = {}) {
  const F = ctx.flags || flags();
  const zone = buildEntryZone(analysis);
  const { blockingReasons, cautionReasons } = buildAvoidanceReasons(analysis, ctx);
  const entryQualityScore = calculateEntryQuality(analysis, ctx);
  const template = selectEntryTemplate(analysis, ctx);
  const reqs = template ? templateRequirements(template, analysis, ctx) : { satisfied: false, missing: ['NO_TEMPLATE_MATCHED'] };
  const setupEntryClassification = classifySetupEntry(analysis, { blockingReasons, entryQualityScore });

  const S = STRUCTURE_STATES;
  const s = analysis && analysis.structureState;
  const price = analysis && analysis.price;

  const triggerSatisfied = [S.BREAKOUT_CONFIRMED, S.BREAKOUT_RETEST].includes(s)
    || (s === S.CONSTRUCTIVE_PULLBACK && !!(analysis.features && analysis.features.pullbackDetail && analysis.features.pullbackDetail.recovering));
  const confirmationSatisfied = triggerSatisfied && reqs.satisfied;
  const overChase = !!(zone && finite(price) && price > zone.maximumChasePrice);

  // ── State resolution, most restrictive first ───────────────────────────────
  let actionState;
  if (blockingReasons.includes('STALE_DATA') || blockingReasons.includes('PRIOR_SESSION_DATA')
      || blockingReasons.includes('BAR_TOO_OLD') || blockingReasons.includes('UNRELIABLE_DATA')) {
    actionState = ACTION_STATES.NO_TRADE;
  } else if ([S.FAILED_BREAKOUT, S.DISTRIBUTION, S.EXHAUSTED].includes(s)) {
    actionState = ACTION_STATES.AVOID;
  } else if (blockingReasons.includes('INSUFFICIENT_TIME_TO_CLOSE')) {
    actionState = ACTION_STATES.MANAGE_EXISTING_ONLY;
  } else if (overChase) {
    actionState = ACTION_STATES.MISSED_OR_EXTENDED;
  } else if (blockingReasons.length && confirmationSatisfied) {
    // The setup is genuinely ready but something external (spread confirmation, dilution,
    // regime, liquidity) blocks it. WATCH_ONLY, with the reason visible.
    actionState = ACTION_STATES.WATCH_ONLY;
  } else if (confirmationSatisfied && !blockingReasons.length) {
    if (RESEARCH_ONLY_TEMPLATES.has(template)) {
      actionState = ACTION_STATES.RESEARCH_CANDIDATE;
    } else if (F.ENABLE_LIVE_VALIDATED_SIGNALS && ctx.templatePromotion === 'LIVE_VALIDATED'
               && ctx.promotionConfigVersion && ctx.promotionConfigVersion === ctx.currentConfigVersion) {
      actionState = ACTION_STATES.LIVE_VALIDATED_ENTRY;
    } else if (F.ENABLE_INTRADAY_PAPER_SIGNALS) {
      actionState = ACTION_STATES.PAPER_ENTRY_ELIGIBLE;
    } else {
      actionState = ACTION_STATES.WATCH_ONLY;
    }
  } else if ([S.BREAKOUT_PENDING, S.COMPRESSION].includes(s)) {
    actionState = ACTION_STATES.READY_IF_TRIGGERED;
  } else if (s === S.BREAKOUT_ATTEMPT) {
    actionState = ACTION_STATES.WATCH_ONLY;
  } else if (s === S.EARLY_IGNITION) {
    actionState = ACTION_STATES.RESEARCH_CANDIDATE;
  } else if (s === S.CONSTRUCTIVE_PULLBACK) {
    // A pullback whose RECOVERY bar has not printed is a WATCH, not a setup in progress: the
    // trigger for this template IS the completed recovery, so until it exists there is nothing
    // building — only something to watch for. Once it prints and something else blocks the
    // entry, SETUP_BUILDING is the honest description.
    const recovering = !!(analysis.features && analysis.features.pullbackDetail
      && analysis.features.pullbackDetail.recovering === true);
    actionState = recovering ? ACTION_STATES.SETUP_BUILDING : ACTION_STATES.WATCH_ONLY;
  } else {
    actionState = ACTION_STATES.WATCH_ONLY;
  }

  // FINAL INVARIANT — belt and braces. LIVE_VALIDATED_ENTRY is impossible unless the flag is
  // on AND the template is promoted under the CURRENT configuration version. This is asserted
  // here (not only in the branch above) so no future edit to the decision tree can leak a
  // live label past the promotion gate.
  if (actionState === ACTION_STATES.LIVE_VALIDATED_ENTRY) {
    const ok = F.ENABLE_LIVE_VALIDATED_SIGNALS === true
      && ctx.templatePromotion === 'LIVE_VALIDATED'
      && !!ctx.promotionConfigVersion
      && ctx.promotionConfigVersion === ctx.currentConfigVersion;
    if (!ok) actionState = F.ENABLE_INTRADAY_PAPER_SIGNALS ? ACTION_STATES.PAPER_ENTRY_ELIGIBLE : ACTION_STATES.WATCH_ONLY;
  }

  const entryAllowed = actionState === ACTION_STATES.LIVE_VALIDATED_ENTRY
    || actionState === ACTION_STATES.PAPER_ENTRY_ELIGIBLE;

  const chaseRisk = zone && finite(price) && finite(analysis.trigger) && analysis.trigger > 0
    ? +(((price / analysis.trigger) - 1) * 100).toFixed(2) : null;

  return {
    version: ACTIONABILITY_VERSION,
    schemaVersion: SCHEMA_VERSION,
    scoringVersion: ACTIONABILITY_VERSION,
    actionState,
    entryTemplate: template,
    setupEntryClassification,
    entryQualityScore,
    entryAllowed,
    triggerSatisfied,
    confirmationSatisfied,
    chaseRisk,
    riskReward: analysis ? analysis.riskReward ?? null : null,
    riskPerShare: analysis ? analysis.riskPerShare ?? null : null,
    distanceAboveTriggerPct: chaseRisk,
    stopDistancePct: analysis ? analysis.stopDistancePct ?? null : null,
    entryZoneLow: zone ? zone.entryZoneLow : null,
    entryZoneHigh: zone ? zone.entryZoneHigh : null,
    maximumChasePrice: zone ? zone.maximumChasePrice : null,
    trigger: analysis ? analysis.trigger ?? null : null,
    invalidation: analysis ? analysis.invalidation ?? null : null,
    target1: analysis ? analysis.target1 ?? null : null,
    target2: analysis ? analysis.target2 ?? null : null,
    checklist: buildEntryChecklist(analysis, ctx),
    templateRequirementsMissing: reqs.missing,
    blockingReasons,
    cautionReasons,
    manualSpreadCheckRequired: requiresManualSpreadCheck(ctx),
    spreadConfirmed: ctx.spreadConfirmed === true,
    whatMustHappenNext: whatMustHappenNext(analysis, { actionState, blockingReasons, zone, template }),
    recommendedActionText: recommendedActionText(actionState, { zone, analysis, template }),
    liveSignalsEnabled: F.ENABLE_LIVE_VALIDATED_SIGNALS === true,
    paperSignalsEnabled: F.ENABLE_INTRADAY_PAPER_SIGNALS === true,
    honesty: 'Strong mover does not necessarily mean an appropriate entry. Explosion potential and trade quality are scored separately and neither is a probability.',
  };
}

function recommendedActionText(actionState, { zone, analysis, template } = {}) {
  const money = v => (finite(v) ? `$${v.toFixed(2)}` : '—');
  switch (actionState) {
    case ACTION_STATES.LIVE_VALIDATED_ENTRY:
      return `Validated entry template (${template}). Entry zone ${money(zone && zone.entryZoneLow)}–${money(zone && zone.maximumChasePrice)}; invalidation ${money(analysis && analysis.invalidation)}.`;
    case ACTION_STATES.PAPER_ENTRY_ELIGIBLE:
      return `PAPER entry only — this template has not passed its promotion gate. Zone ${money(zone && zone.entryZoneLow)}–${money(zone && zone.maximumChasePrice)}; invalidation ${money(analysis && analysis.invalidation)}.`;
    case ACTION_STATES.READY_IF_TRIGGERED:
      return `Ready if triggered. No entry until a completed five-minute close above ${money(analysis && analysis.trigger)}.`;
    case ACTION_STATES.MISSED_OR_EXTENDED:
      return 'Good setup, poor current entry. Wait for a controlled retest.';
    case ACTION_STATES.AVOID:
      return 'Avoid. The setup has failed, is distributing, or is exhausted.';
    case ACTION_STATES.NO_TRADE:
      return 'No trade — the data required to make a decision is not current.';
    case ACTION_STATES.MANAGE_EXISTING_ONLY:
      return 'Too late in the session for a new entry. Manage existing positions only.';
    case ACTION_STATES.RESEARCH_CANDIDATE:
      return 'Research candidate. Logged and measured; not offered as an entry.';
    case ACTION_STATES.SETUP_BUILDING:
      return 'Setup building. Not yet triggered.';
    default:
      return 'Watch only.';
  }
}

module.exports = {
  ACTION_STATES, ENTRY_TEMPLATES, RESEARCH_ONLY_TEMPLATES, SETUP_ENTRY_CLASSES, ACTIONABILITY_VERSION,
  buildEntryZone, selectEntryTemplate, templateRequirements, buildAvoidanceReasons,
  requiresManualSpreadCheck, calculateEntryQuality, classifySetupEntry, buildEntryChecklist,
  whatMustHappenNext, recommendedActionText, evaluateActionability,
};
