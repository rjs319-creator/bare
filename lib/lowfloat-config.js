'use strict';
// LOW-FLOAT IGNITION / INTRADAY-CONTINUATION CONFIG — the single home for every version
// string, feature flag, threshold and budget used by the new same-session discovery stack.
//
// WHY A SEPARATE CONFIG FROM lib/daytrade-config.js: the existing Day Trade config governs
// the LEGACY daily-candle lanes (Momentum & Liquid, Explosive Small-Cap, Momentum Run) and
// their lifecycle. This file governs the NEW staged system (Stage 0 discovery → Stage 1
// explosion potential → Stage 2 intraday structure → Stage 3 trade quality → Stage 4
// validation → Stage 5 miss audit). Keeping them apart is what lets the legacy ledgers keep
// their meaning while the new stack evolves its own versions independently.
//
// EVERY number here is a PRE-REGISTERED PRIOR, not a fitted parameter. Nothing in this file
// is claimed to be predictive; the scores it produces are interpretable rankings and the
// validation layer (lib/intraday-validation.js) is the ONLY thing that can promote a template.

// ── Contract versions. Stamped onto every API response and every stored record so a
//    result can always be traced to the exact scoring code that produced it, and so the
//    promotion gate can refuse to credit outcomes produced by a different configuration.
const SCHEMA_VERSION = 'lowfloat-schema-v1';
const LOW_FLOAT_IGNITION_VERSION = 'low-float-ignition-v1';
const CONTINUATION_VERSION = 'intraday-continuation-v1';
const ACTIONABILITY_VERSION = 'intraday-actionability-v1';
const DISCOVERY_VERSION = 'mover-discovery-v1';
// v2: enrichment moved from ONE truncated company-screener call (hard-capped at
// 10,000 rows, which silently left ~20% of eligible securities with no sector,
// industry or market cap) to a per-exchange query. The artifact's CONTENTS changed
// materially — 79% -> 99% metadata coverage — so its version must change with them.
// loadTradableUniverse discards a cached doc whose schema does not match, which is
// what makes every consumer drop the pre-fix artifact and rebuild once instead of
// serving stale coverage until the 20-hour age-out.
const UNIVERSE_VERSION = 'tradable-universe-v2';
const FLOAT_VERSION = 'float-data-v1';
const SUPPLY_RISK_VERSION = 'supply-risk-v1';
const CATALYST_VERSION = 'catalyst-context-v1';
const VALIDATION_VERSION = 'intraday-validation-v1';
const AUDIT_VERSION = 'large-mover-audit-v1';

// The composite "configuration version" a validated template is bound to. ANY change to a
// component version changes this string, which forces revalidation (see evaluateModelDrift).
const CONFIG_VERSION = [
  LOW_FLOAT_IGNITION_VERSION, CONTINUATION_VERSION, ACTIONABILITY_VERSION, DISCOVERY_VERSION,
].join('+');

// ── Feature flags. Read from env at call time via `flags()` so a Vercel env change takes
//    effect on the next invocation without a code deploy. Defaults implement the spec's
//    rollout: discovery/continuation/paper ON for observation, LIVE signals OFF.
const FLAG_DEFAULTS = Object.freeze({
  ENABLE_LOW_FLOAT_DISCOVERY: true,
  ENABLE_INTRADAY_CONTINUATION: true,
  ENABLE_INTRADAY_PAPER_SIGNALS: true,
  ENABLE_LIVE_VALIDATED_SIGNALS: false,   // may only be turned on AFTER a template passes the gate
  ENABLE_LARGE_MOVER_AUDIT: true,
});

// Truthy parsing that treats an UNSET variable as "use the default" and an explicitly set
// '0'/'false'/'off'/'no' as a deliberate disable. Never silently enables live signals.
function envFlag(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw === '') return dflt;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return dflt;
}

function flags() {
  const out = {};
  for (const [k, v] of Object.entries(FLAG_DEFAULTS)) out[k] = envFlag(k, v);
  return Object.freeze(out);
}

// ── FLOAT TIERS. Actual publicly tradable share count — NEVER market capitalization.
const FLOAT_TIERS = Object.freeze({
  ULTRA_LOW: { max: 5_000_000, label: 'Ultra-low float' },
  LOW: { max: 10_000_000, label: 'Low float' },
  MODERATELY_LOW: { max: 20_000_000, label: 'Moderately low float' },
  SMALL_SUPPLY: { max: 50_000_000, label: 'Small share supply' },
  NORMAL: { max: Infinity, label: 'Normal float' },
});

// Float record hygiene. A float value older than STALE_DAYS is usable but confidence-
// penalized; beyond MAX_AGE_DAYS it is not credited to the supply-constraint family at all.
const FLOAT_QUALITY = Object.freeze({
  STALE_DAYS: 120,             // ~ one filing cycle
  MAX_AGE_DAYS: 400,
  // Two provider values that disagree by more than this fraction are a CONFLICT (the record
  // keeps the more conservative — larger — float and drops to LOW confidence).
  CONFLICT_TOLERANCE: 0.15,
  // Impossible-value bounds. Float below this is almost always a units error; above this it
  // exceeds any real US common-stock float.
  MIN_PLAUSIBLE_SHARES: 10_000,
  MAX_PLAUSIBLE_SHARES: 100_000_000_000,
  CACHE_TTL_HOURS: 20,          // float changes on filings, not intraday — refresh daily
});

// ── SESSION WINDOWS (America/New_York). Drive window-specific behavior in Stage 2/3.
const SESSION_WINDOWS = Object.freeze([
  { key: 'PRE_OPEN', startMin: 0, endMin: 9 * 60 + 30, label: 'Before the open' },
  { key: 'OPENING_NOISE', startMin: 9 * 60 + 30, endMin: 10 * 60, label: 'Opening noise' },
  { key: 'PRIME_MORNING', startMin: 10 * 60, endMin: 11 * 60 + 30, label: 'Prime morning' },
  { key: 'MIDDAY', startMin: 11 * 60 + 30, endMin: 13 * 60 + 30, label: 'Midday' },
  { key: 'PRIME_AFTERNOON', startMin: 13 * 60 + 30, endMin: 15 * 60 + 15, label: 'Prime afternoon' },
  { key: 'LATE_SESSION', startMin: 15 * 60 + 15, endMin: 16 * 60, label: 'Late session' },
  { key: 'AFTER_CLOSE', startMin: 16 * 60, endMin: 24 * 60, label: 'After the close' },
]);

// ── HARD ENTRY CONTROLS. These block new entries; they are never softened to populate a
//    screen. See lib/intraday-actionability.js for the enforcement.
const ENTRY = Object.freeze({
  MAX_COMPLETED_BAR_AGE_MINUTES: 7,
  MIN_NEW_ENTRY_MINUTES_TO_CLOSE: 15,
  MIN_REWARD_RISK: 1.8,
  // LATE_SESSION demands a better payoff for the same risk (less time for the thesis to work).
  LATE_SESSION_MIN_REWARD_RISK: 2.5,
  // Volatility-aware chase ceiling: entry may not be more than this many 5-minute ATRs above
  // the trigger, NOR more than the percentage cap — whichever binds first.
  MAX_CHASE_ATR: 0.75,
  MAX_CHASE_PCT: 3.0,
  // Structural stop sanity. A stop wider than this fraction of price is not a day trade;
  // a stop tighter than the noise floor is a fake reward:risk (never tighten to pass R:R).
  MAX_STOP_DISTANCE_PCT: 12,
  MIN_STOP_ATR: 0.6,
  // Extension ceilings — beyond these the move is already made.
  MAX_VWAP_EXTENSION_ATR: 4.0,
  MAX_VWAP_EXTENSION_PCT: 18,
  // Manual spread confirmation is REQUIRED below this price or for these float tiers, because
  // the app has no NBBO. See lib/intraday-actionability.js.
  MANUAL_SPREAD_PRICE_BELOW: 5,
  MANUAL_SPREAD_FLOAT_TIERS: Object.freeze(['ULTRA_LOW', 'LOW']),
  // Current-session tradeability floors used INSTEAD of a historical average-volume gate.
  MIN_SESSION_DOLLAR_VOLUME: 3_000_000,
  MIN_RECENT_DOLLAR_VOLUME_15M: 250_000,
  MIN_PRICE: 0.75,
});

// ── DISCOVERY (Stage 0) budgets and lane thresholds. Deliberately LOW bars: this layer is
//    tuned for RECALL. Precision is Stage 1-3's job.
const DISCOVERY = Object.freeze({
  // Every cap is env-overridable so the endpoint can be tuned without a deploy.
  DISCOVERY_CANDIDATE_CAP: intEnv('DISCOVERY_CANDIDATE_CAP', 250),
  INTRADAY_ENRICHMENT_CAP: intEnv('INTRADAY_ENRICHMENT_CAP', 60),
  FLOAT_ENRICHMENT_CAP: intEnv('FLOAT_ENRICHMENT_CAP', 120),
  NEWS_ENRICHMENT_CAP: intEnv('NEWS_ENRICHMENT_CAP', 25),
  REQUEST_DEADLINE_MS: intEnv('REQUEST_DEADLINE_MS', 50_000),
  YAHOO_CONCURRENCY: intEnv('YAHOO_CONCURRENCY', 8),
  PROVIDER_BATCH_SIZE: intEnv('PROVIDER_BATCH_SIZE', 200),
  UNIVERSE_QUOTE_CAP: intEnv('DISCOVERY_UNIVERSE_CAP', 6000),
  // Lane admission thresholds (RECALL-first; see lib/mover-discovery.js).
  PCT_MOVER_MIN: 3.0,               // well below the legacy +8% explosive gate
  RVOL_MIN: 2.0,
  VOLUME_ACCEL_MIN: 2.0,
  PRICE_ACCEL_5M_MIN: 1.2,          // percent over the last completed 5-minute bar
  PRICE_ACCEL_15M_MIN: 2.5,
  GAP_MIN_PCT: 4.0,
  CATALYST_FRESH_MINUTES: 24 * 60,
  LOW_FLOAT_TURNOVER_MIN: 0.20,     // 20% of the float has changed hands this session
  // A candidate must show at least this much CURRENT-session dollar volume to be worth
  // enriching. This replaces the historical average-volume block entirely.
  MIN_SESSION_DOLLAR_VOLUME: 500_000,
  MIN_PRICE: 0.50,
  MAX_PRICE: 2000,
});

// ── SCORE FAMILY CAPS (Stage 1). Each evidence family contributes at most its cap, so no
//    single input can manufacture a high score. Caps sum to 100.
const EXPLOSION_FAMILIES = Object.freeze({
  SUPPLY_CONSTRAINT: 22,
  PARTICIPATION: 22,
  PRICE_ACCELERATION: 18,
  CATALYST: 14,
  INTRADAY_STRUCTURE: 10,
  REMAINING_RUNWAY: 9,
  MARKET_CONTEXT: 5,
});

const TRADE_QUALITY_FAMILIES = Object.freeze({
  LIQUIDITY: 25,
  EXTENSION: 20,
  STRUCTURE: 20,
  RISK_REWARD: 15,
  DATA_INTEGRITY: 12,
  SUPPLY_RISK: 8,
});

// ── STRUCTURE STATE MACHINE thresholds (Stage 2). Hysteresis prevents a state from
//    flapping on one noisy bar; see lib/intraday-continuation.js.
const STRUCTURE = Object.freeze({
  NEAR_HIGH_PCT: 1.0,               // within 1% of the session high = "at the high"
  BREAKOUT_CONFIRM_VOL_MULT: 1.3,   // breakout bar volume vs the recent bar average
  BREAKOUT_UPPER_HALF: 0.5,         // close must land in the upper half of the bar's range
  COMPRESSION_RATIO_MAX: 0.65,      // recent range ÷ earlier range below this = compression
  DISTRIBUTION_DRAWDOWN_PCT: 6,     // drawdown from the session high that signals distribution
  DISTRIBUTION_LOWER_HIGHS: 3,
  EXHAUSTION_EXTENSION_ATR: 4.0,
  // Advance off the session low past which a name printing a volume climax is treated as
  // exhausted, whatever the VWAP/ATR-normalized measures say (in a parabola those measures
  // are inflated by the parabolic bars themselves and stop detecting it).
  PARABOLIC_RUN_PCT: 40,
  EXHAUSTION_VOLUME_CLIMAX: 4.0,    // last bar volume vs recent average
  EARLY_IGNITION_VOL_ACCEL: 2.0,
  EARLY_IGNITION_MAX_EXTENSION_ATR: 2.5,
  PULLBACK_MAX_DEPTH_PCT: 40,       // retrace of the session range beyond which it is a failure
  UPPER_WICK_RATIO: 0.6,            // wick ÷ total range above which the bar is a rejection
  MIN_BARS_FOR_STRUCTURE: 3,
  // Hysteresis: a constructive state must be re-earned by this many consecutive evaluations
  // once the name has been in a destructive state.
  RECOVERY_CONFIRM_EVALS: 2,
});

// ── PROMOTION GATE (Stage 4). Pre-registered; changing any of these invalidates prior
//    promotions because CONFIG_VERSION is part of the binding.
const PROMOTION = Object.freeze({
  MIN_RESOLVED_EVENTS: 150,
  MIN_OUT_OF_SAMPLE_EVENTS: 40,
  MIN_TIME_BLOCKS: 3,
  MAX_SINGLE_TICKER_SHARE: 0.05,
  MAX_SINGLE_MONTH_PROFIT_SHARE: 0.5,
  // Target-before-stop rate must beat the matched baseline by at least this margin, AND its
  // Wilson lower bound must not be materially below the baseline point estimate.
  MIN_EDGE_OVER_BASELINE: 0.03,
  MAX_LOWER_BOUND_SHORTFALL: 0.02,
  MIN_EXPECTANCY_R: 0.05,           // after conservative friction
  // Drift/demotion: recent window vs the validated record.
  DRIFT_WINDOW_EVENTS: 40,
  DRIFT_EXPECTANCY_FLOOR_R: -0.05,
});

// ── COST / FRICTION assumptions used when simulating a fill. Deliberately CONSERVATIVE:
//    the app has no NBBO, so a modeled fill must assume it paid for the spread.
const FRICTION = Object.freeze({
  // Slippage in basis points by liquidity tier of the CURRENT session's dollar volume.
  SLIPPAGE_BPS: Object.freeze({ DEEP: 10, NORMAL: 25, THIN: 60, VERY_THIN: 150 }),
  DEEP_SESSION_DOLLAR_VOL: 100_000_000,
  NORMAL_SESSION_DOLLAR_VOL: 20_000_000,
  THIN_SESSION_DOLLAR_VOL: 3_000_000,
  COMMISSION_BPS: 0,
});

// ── POSITION SIZING defaults (reference calculator only — never places an order).
const SIZING = Object.freeze({
  DEFAULT_ACCOUNT_SIZE: 25_000,
  DEFAULT_MAX_RISK_PER_TRADE_PCT: 0.5,
  DEFAULT_MAX_POSITION_PCT: 20,
  DEFAULT_MAX_PORTFOLIO_OPEN_RISK_PCT: 2,
  // Liquidity capacity: a position may not exceed this share of the CURRENT session's
  // dollar volume. Low-float names get the far tighter cap.
  MAX_SHARE_OF_SESSION_DOLLAR_VOL: 0.005,
  LOW_FLOAT_MAX_SHARE_OF_SESSION_DOLLAR_VOL: 0.001,
});

function intEnv(name, dflt) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : dflt;
}

module.exports = {
  SCHEMA_VERSION, LOW_FLOAT_IGNITION_VERSION, CONTINUATION_VERSION, ACTIONABILITY_VERSION,
  DISCOVERY_VERSION, UNIVERSE_VERSION, FLOAT_VERSION, SUPPLY_RISK_VERSION, CATALYST_VERSION,
  VALIDATION_VERSION, AUDIT_VERSION, CONFIG_VERSION,
  FLAG_DEFAULTS, flags, envFlag,
  FLOAT_TIERS, FLOAT_QUALITY, SESSION_WINDOWS, ENTRY, DISCOVERY,
  EXPLOSION_FAMILIES, TRADE_QUALITY_FAMILIES, STRUCTURE, PROMOTION, FRICTION, SIZING,
};
