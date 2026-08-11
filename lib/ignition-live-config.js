'use strict';
// IGNITION LIVE CONFIG — versions, weights and thresholds for the IGNITION synthesis layer.
//
// WHAT THIS LAYER IS: a spec-shaped VIEW over the existing low-float / intraday-continuation
// stack (lib/lowfloat-pipeline.js). It does not fetch anything and it does not re-score the
// market; it takes the pipeline's already-computed evidence (acceleration, structure, float,
// catalyst, supply risk) plus two genuinely new inputs (market-wide attention-rank history,
// EDGAR filing flags) and produces the IGNITION contract: IGNITION_SCORE, STAGE,
// EXTENSION_RISK, OPPORTUNITY_SCORE, DO_NOT_CHASE, alert states.
//
// WHY A SEPARATE CONFIG FROM lib/lowfloat-config.js: that file's CONFIG_VERSION is the
// binding for the template promotion gate — touching it forces revalidation of the whole
// low-float stack. This layer is additive and versions independently.
//
// EVERY number here is a PRE-REGISTERED PRIOR, not a fitted parameter. IGNITION_SCORE and
// OPPORTUNITY_SCORE are interpretable rankings; neither is a probability, and any numeric
// outlook derived from them is labeled RULE_BASED_ESTIMATE, never an ML probability.

const IGNITION_LIVE_VERSION = 'ignition-live-v1';
const ATTENTION_RANK_VERSION = 'attention-rank-v1';
const DILUTION_FILINGS_VERSION = 'dilution-filings-v1';

// ── IGNITION_SCORE component weights (sum to 100). The spec's initial table, verbatim.
//    A component whose inputs are missing earns ZERO of its weight — missing data can lower
//    a score, never raise it, and the weight is NOT redistributed to the components we have.
const IGNITION_WEIGHTS = Object.freeze({
  CATALYST_QUALITY: 18,
  PARTICIPATION: 18,            // RVOL + volume acceleration
  SUPPLY_PRESSURE: 14,          // float turnover / supply constraint
  PRICE_MOMENTUM: 12,
  DOLLAR_VOLUME_ACCELERATION: 10,
  TECHNICAL_STRUCTURE: 10,      // VWAP / EMA / higher-low structure
  BASE_COMPRESSION: 6,
  MOMENTUM_HISTORY: 5,          // currently UNAVAILABLE at this stack's budget — earns 0
  SHORT_PRESSURE: 4,
  MARKET_CONTEXT: 3,
});

// ── Catalyst letter grades. Mapped from lib/catalyst-context.js tiers (1..4 + NONE).
//    Initial scores per the spec: A 16-18, B 11-15, C 5-10, D 0-4, NONE 0 — we use the
//    band midpoints, then modulate by source quality inside the band.
const CATALYST_GRADES = Object.freeze({
  A: { tier: 1, base: 17 },
  B: { tier: 2, base: 13 },
  C: { tier: 3, base: 7.5 },
  D: { tier: 4, base: 2 },
  NONE: { tier: null, base: 0 },
});

// Freshness decay steps (the spec's table). Applied to the catalyst grade score.
// An UNKNOWN publication time gets the conservative mid factor, never full freshness.
const CATALYST_DECAY = Object.freeze([
  { maxMinutes: 60, factor: 1.0 },
  { maxMinutes: 3 * 60, factor: 0.9 },
  { maxMinutes: 8 * 60, factor: 0.75 },
  { maxMinutes: 24 * 60, factor: 0.5 },
  { maxMinutes: 3 * 24 * 60, factor: 0.25 },
  { maxMinutes: Infinity, factor: 0.1 },
]);
const CATALYST_DECAY_UNKNOWN_AGE = 0.5;
const CATALYST_RECYCLED_FACTOR = 0.5;   // market has already seen it (on top of decay)

// ── STAGES (spec taxonomy). Precedence is destructive-first so a failed name can never be
//    promoted by a stale constructive reading lower in the list.
const STAGES = Object.freeze({
  DORMANT: 'DORMANT',
  EARLY_IGNITION: 'EARLY_IGNITION',
  CONFIRMING: 'CONFIRMING',
  BREAKOUT: 'BREAKOUT',
  EXPANSION: 'EXPANSION',
  PARABOLIC: 'PARABOLIC',
  EXHAUSTION: 'EXHAUSTION',
  FAILED: 'FAILED',
});

// ── EXTENSION_RISK bands (spec).
const EXTENSION_BANDS = Object.freeze([
  { max: 30, label: 'NORMAL' },
  { max: 60, label: 'CAUTION' },
  { max: 80, label: 'DO_NOT_INITIATE' },
  { max: 100, label: 'PARABOLIC_EXIT_BIAS' },
]);

// Extension ceilings reuse the stack's pre-registered entry controls (lowfloat-config ENTRY /
// STRUCTURE) as saturation points, so "fully extended" here means the same thing the entry
// gate already enforces. Point budgets sum to 100.
const EXTENSION_POINTS = Object.freeze({
  VWAP_EXTENSION_ATR: 28,       // saturates at ENTRY.MAX_VWAP_EXTENSION_ATR (4.0)
  VWAP_DISTANCE_PCT: 14,        // saturates at ENTRY.MAX_VWAP_EXTENSION_PCT (18%)
  EMA9_DISTANCE_ATR: 10,        // saturates at 3 ATR above the 9-EMA
  DAY_GAIN: 18,                 // saturates at +80% on the day
  PARABOLIC_RUN: 12,            // sessionRunPct ≥ STRUCTURE.PARABOLIC_RUN_PCT (40%)
  VOLUME_CLIMAX: 10,            // lastBarVolMult ≥ STRUCTURE.EXHAUSTION_VOLUME_CLIMAX (4×)
  UPPER_WICK: 8,                // rejection wicks at the highs
});

// ── OPPORTUNITY_SCORE shaping. Opportunity is about the CURRENT trade location, so the
//    dominant terms are entry quality and extension, not momentum magnitude.
const OPPORTUNITY = Object.freeze({
  // Blend of the location evidence (fractions of the pre-multiplier base, sum 1.0).
  ENTRY_QUALITY_SHARE: 0.40,
  TRADE_QUALITY_SHARE: 0.25,
  IGNITION_SHARE: 0.20,
  RISK_REWARD_SHARE: 0.15,
  RISK_REWARD_SATURATION: 4.0,  // R:R at which the R:R term saturates
  // Extension multiplier: full credit through NORMAL, then decays to this floor at 100.
  EXTENSION_FREE_THROUGH: 30,
  EXTENSION_FLOOR_MULT: 0.10,
  // Stage multipliers — the spec's RULE 13: an 85 with a clean setup must outrank a 99
  // that has gone parabolic.
  STAGE_MULT: Object.freeze({
    DORMANT: 0.50, EARLY_IGNITION: 1.0, CONFIRMING: 1.0, BREAKOUT: 0.90,
    EXPANSION: 0.70, PARABOLIC: 0.15, EXHAUSTION: 0.10, FAILED: 0.05,
  }),
  // Additive bonuses on top of the multiplied base (capped).
  ATTENTION_SURGE_BONUS: 8,
  CATALYST_BONUS: Object.freeze({ A: 6, B: 4, C: 1 }),
  // A blocked or stale name can still be studied but is not an opportunity.
  BLOCKED_CAP: 25,
});

// ── ALERT STATES (spec §30) with emission thresholds. Dedup key is ticker|state|session;
//    per-ticker and per-cycle budgets mirror lib/lowfloat-alerts.js.
const ALERT_STATES = Object.freeze({
  WATCH: 'WATCH',
  IGNITION: 'IGNITION',
  CONFIRMED: 'CONFIRMED',
  BREAKOUT: 'BREAKOUT',
  ATTENTION_SURGE: 'ATTENTION_SURGE',
  PARABOLIC_WARNING: 'PARABOLIC_WARNING',
  FAILED: 'FAILED',
});
const ALERTS = Object.freeze({
  WATCH_MIN_IGNITION: 55,
  IGNITION_MIN_IGNITION: 75,
  CONFIRMED_MIN_IGNITION: 80,
  BREAKOUT_MIN_IGNITION: 70,
  MAX_PER_TICKER_PER_DAY: 6,
  MAX_PER_CYCLE: 10,
});

// ── ATTENTION ranking. Composite weights for the market-wide per-scan rank (applied to
//    saturating ramps of each input, missing input = 0 — a name with no volume data cannot
//    outrank one with real participation).
const ATTENTION = Object.freeze({
  WEIGHTS: Object.freeze({
    PRICE_ACCEL: 20,            // 5-minute change (rate, not day total)
    VOLUME_ACCEL: 20,
    DOLLAR_VOLUME: 15,          // log-scaled session dollar volume
    RELATIVE_VOLUME: 20,
    DAY_CHANGE: 10,             // level matters, but less than the rates above
    FLOAT_TURNOVER: 15,
  }),
  HISTORY_CAP: 60,              // rank stamps kept per ticker per session (~10-min cadence)
  // ATTENTION_SURGE: improved by ≥ SURGE_MIN_IMPROVEMENT ranks inside SURGE_WINDOW_MIN
  // minutes AND landed inside the top SURGE_TOP_RANK.
  SURGE_MIN_IMPROVEMENT: 50,
  SURGE_WINDOW_MIN: 25,
  SURGE_TOP_RANK: 25,
});

// ── DILUTION_RISK combination. Base is lib/supply-risk.js's 0-100 headline score; EDGAR
//    filing-index evidence adds pre-registered increments (primary-source dates beat headline
//    inference, so a real 424B takedown is the strongest single signal here).
const DILUTION = Object.freeze({
  FILING_POINTS: Object.freeze({
    RECENT_TAKEDOWN_7D: 30,     // 424B* priced/filed within ~7 days — active selling
    RECENT_TAKEDOWN_90D: 15,
    SHELF_ON_FILE_400D: 15,     // S-3 capacity (capacity, not an imminent sale)
    S1_ON_FILE_180D: 10,
    UNREGISTERED_SALES_90D: 10, // 8-K item 3.02
  }),
  BANDS: Object.freeze([
    { max: 24, label: 'LOW' },
    { max: 54, label: 'MODERATE' },
    { max: 79, label: 'HIGH' },
    { max: 100, label: 'EXTREME' },
  ]),
  CACHE_TTL_HOURS: 24,          // filings move on filing cadence, not intraday
  FETCH_CAP_PER_TICK: 10,       // EDGAR is throttled (~130ms/req) — bound the per-tick spend
});

// Stale-data credibility: a stale record's ignition score is discounted, mirroring the
// explosion scorer's own stale discount. Missing data must never improve a score.
const STALE_SCORE_FACTOR = 0.5;

module.exports = {
  IGNITION_LIVE_VERSION, ATTENTION_RANK_VERSION, DILUTION_FILINGS_VERSION,
  IGNITION_WEIGHTS, CATALYST_GRADES, CATALYST_DECAY, CATALYST_DECAY_UNKNOWN_AGE,
  CATALYST_RECYCLED_FACTOR, STAGES, EXTENSION_BANDS, EXTENSION_POINTS, OPPORTUNITY,
  ALERT_STATES, ALERTS, ATTENTION, DILUTION, STALE_SCORE_FACTOR,
};
