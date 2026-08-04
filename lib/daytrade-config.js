'use strict';
// DAY-TRADE ACTIONABILITY CONFIG — the single home for the freshness tolerances and
// thesis-failure thresholds that decide whether a Day Trade candidate may be presented
// as a current, actionable buy. Centralized (no magic numbers scattered across routes,
// timing, and the UI) so tightening the policy is a one-line change and the same numbers
// drive the server gate, the tests, and the client's staleness display.
//
// WHY THESE EXIST. During regular hours the screener runs off a daily-candle cache built by
// the daily cron (post-close, 22:00 UTC), so a candidate's newest DAILY bar is a PRIOR session.
// NB this invariant is INDEPENDENT of the cron hour — the cache is only ever rebuilt once a day,
// so mid-session it can never hold the current session's completed bar. A daily bar can DISCOVER
// or RETAIN a watchlist name but can never establish that it is a live, current-session
// buy. Actionability therefore requires current-session 5-minute evidence AND a sufficiently
// recent quote — the two ages below. Missing/stale/contradictory evidence fails closed.

const FIVE_MIN_MS = 5 * 60 * 1000;

const FRESHNESS = Object.freeze({
  // A live quote older than this cannot validate "actionable right now" (≈2 price ticks at
  // the 30s client refresh cadence; the spec's 90–120s band).
  QUOTE_MAX_AGE_MS: 120 * 1000,
  // The newest intraday bar may be at most TWO bar intervals old (5-min bars → 10 min). One
  // interval is normal latency (a forming bar); beyond two the intraday read is stale.
  INTRADAY_BAR_MAX_AGE_MS: 2 * FIVE_MIN_MS,
  BAR_INTERVAL_MS: FIVE_MIN_MS,
  // A timestamp further in the FUTURE than this is contradictory data (clock skew is
  // tolerated up to here; beyond it the evidence fails closed — never "extra fresh").
  MAX_FUTURE_SKEW_MS: 90 * 1000,
});

// Stage-2 deep live-validation budget. The pool is selected by ONE cross-sectional
// priority score over the MERGED candidate set (all scan families + the expanded lane +
// intraday discovery) — never by family concatenation order, so no single family can
// consume the whole budget. Env-overridable without a deploy.
const STAGE2 = Object.freeze({
  MAX_NAMES: Math.max(5, parseInt(process.env.DAYTRADE_STAGE2_MAX || '30', 10) || 30),
  CONCURRENCY: 8,
  // STALENESS DECAY. During a live session, scan picks' pctChange/relVol/excessPct come from
  // the once-daily candle cache — i.e. the PRIOR session — while discovery picks carry live
  // values. Z-scoring both in one pool let yesterday's mover outrank today's. Stale daily
  // inputs are therefore decayed by this factor in the live priority score (0 disables them
  // entirely; 1 restores the old defective behavior).
  STALE_DAILY_WEIGHT: Math.min(1, Math.max(0, parseFloat(process.env.DAYTRADE_STALE_WEIGHT || '0.25'))),
  // LANE RESERVATIONS. The old selection gave any active lifecycle name a ×1000 boost, so
  // tracked names could consume the ENTIRE deep-validation budget and a brand-new discovery
  // could never be validated. Lanes fix that: management (failure detection on armed/
  // actionable/managing names) and revalidation stay protected, but NEW DISCOVERY candidates
  // are GUARANTEED a minimum allocation, with a small reserve for exceptional anomalies.
  // Unused reservation flows back to the global priority ranking (nothing is wasted).
  LANES: Object.freeze({
    MANAGEMENT_RESERVE: 12,   // MANAGING / ACTIONABLE_NOW / REVERSAL_RECLAIM — failure detection first
    REVALIDATION_RESERVE: 4,  // ARMED / OPENING_RANGE_FORMING — setups awaiting their trigger
    DISCOVERY_RESERVE: 6,     // guaranteed slots for candidates with fresh Stage-A discovery evidence
    ANOMALY_RESERVE: 2,       // exceptional anomalies (very high CUSUM) even beyond DISCOVERY_RESERVE
  }),
  // Distinct sector ETFs fetched per Stage-2 cycle so residualSector actually receives bars
  // (bounded — each ETF is one 5-min-chart fetch shared by every pick in that sector).
  SECTOR_ETF_MAX: 6,
});
// Reserve invariant: a DAYTRADE_STAGE2_MAX below the summed reserves silently broke lane
// guarantees. Validate at load — warn once and treat the summed reserves as the floor.
{
  const summed = Object.values(STAGE2.LANES).reduce((a, b) => a + b, 0);
  if (STAGE2.MAX_NAMES < summed) {
    console.warn(`[daytrade-config] DAYTRADE_STAGE2_MAX=${STAGE2.MAX_NAMES} < summed lane reserves (${summed}); lane guarantees degrade to first-come precedence.`);
  }
}

// Live trade-plan recomputation for a CURRENT-session confirmed setup. An actionable card
// must never display the prior-session (daily-cache) stop/target as its plan — the plan is
// rebuilt from the live trigger + current ATR at validation time.
const LIVE_PLAN = Object.freeze({
  STOP_ATR_MULT: 1.5,     // stop = entry − 1.5×ATR, floored just under the opening-range low
  TARGET_RR: 2,           // target = entry + 2×risk
  OR_LOW_PAD_ATR: 0.1,    // pad under the OR low so a retest tick can't stop a valid setup
  EXPIRES_MIN: 120,       // a confirmed trigger not entered within this window expires
});

// Broad intraday discovery (Stage A) — full-liquid-universe anomaly scan.
const DISCOVERY = Object.freeze({
  MIN_PRICE: 3,                       // penny-name noise floor
  MIN_AVG_DOLLAR_VOL: 2_000_000,      // matches the expanded-universe liquidity floor
  MAX_UNIVERSE: 2500,                 // bulk-quote request bound
  CUSUM_K: 0.5,                       // drift allowance (in per-minute σ units)
  CUSUM_H: 4,                         // alarm threshold — abnormal positive activity
  // Quote-integrity bounds for Stage-A observations. A quote with no provider timestamp is
  // NEVER stamped with server time (fails closed: no CUSUM update, no ranking, no dataset);
  // one older than this cannot be treated as a live observation at the 5-min scan cadence.
  QUOTE_MAX_AGE_MS: 10 * 60 * 1000,
  // Deterministic tail rotation: the liquidity-ranked core keeps the top of the eligible
  // population every scan; this many slots rotate through the remaining tail so the same
  // cache-order names are not silently dropped forever.
  ROTATION_SLOTS: 300,
  EWMA_ALPHA: 0.15,                   // per-minute volatility estimator smoothing
  MAX_ANOMALIES: 25,                  // Stage-B candidates surfaced per scan
  STATE_STALE_MIN: 120,               // discard interval state older than this (new baseline)
  RESULT_FRESH_MIN: 10,               // runDaytrade merges a discovery doc younger than this
  // Same-cycle fallback: when no fresh persisted discovery doc exists, runDaytrade may run
  // ONE inline scan if at least this much of its time budget remains (fixes the structural
  // one-refresh delay between op=discover and the board consuming its output).
  INLINE_MIN_BUDGET_MS: 9000,
  // PREMARKET — separate thresholds; premarket participation must NEVER be normalized
  // against regular-hours distributions. Interval state resets on a session change so a
  // premarket CUSUM never contaminates the regular-hours detector (and vice versa).
  PREMARKET: Object.freeze({
    ENABLED: true,
    CUSUM_H: 5,                       // thinner tape → demand a stronger standardized drift
    MIN_AVG_DOLLAR_VOL: 5_000_000,    // premarket quotes on illiquid names are too unreliable
    MAX_ANOMALIES: 15,
  }),
});

// Early-signal research states (SCOUT → PRIMED → IGNITION → EARLY_CONFIRMED). These are
// WATCH/RESEARCH annotations rendered before any actionable state — never buy language.
// Thresholds pre-registered here (not fitted); the states exist to be MEASURED (lead time,
// post-state MFE) by the capture/label pipeline before any of them can gate anything.
const EARLY = Object.freeze({
  SCOUT_CUSUM: 2,            // change detector waking up (below alarm) or mild residual strength
  PRIMED_CUSUM: 4,           // alarm-level accumulation (matches DISCOVERY.CUSUM_H)
  IGNITION_Z: 2.5,           // standardized interval shock
  IGNITION_VOL_ACCEL: 1.5,   // participation accelerating alongside price
  CONFIRM_MIN_BARS: 2,       // bars of follow-through for EARLY_CONFIRMED
  MAX_EXTENSION_ATR: 2.5,    // beyond this it's a chase, not an early signal
});

// ── ANTI-FLAPPING — episode identity, cooldowns, hysteresis, revival confirmation ──
// The defect these close: ACTIONABLE_NOW → STALLING → ACTIONABLE_NOW could cycle on 60s
// evaluations because (a) STALLING/TOO_EXTENDED/EXPIRED set no cooldown (only FAILED did),
// (b) enter and re-enter shared the exact same thresholds (zero hysteresis band), and
// (c) EVERY revival minted a new setupId, which changed the alert-dedup key — so one noisy
// name could emit an entry/retire alert pair every couple of minutes, each with fresh levels.
const ANTIFLAP = Object.freeze({
  // Cooldown after a soft retirement (STALLING / TOO_EXTENDED / EXPIRED) before the name may
  // re-arm to ACTIONABLE. Spec band 15–30 min; env-overridable within that band.
  RETIRE_COOLDOWN_MS: Math.min(30, Math.max(15, parseInt(process.env.DAYTRADE_RETIRE_COOLDOWN_MIN || '20', 10) || 20)) * 60 * 1000,
  // Consecutive qualifying evaluations required before a retired name revives (debounce —
  // a single passing evaluation after retirement is exactly the noise that caused flapping).
  REVIVE_CONFIRM_EVALS: 2,
  // Hysteresis bands: re-qualifying AFTER retirement demands strictly better evidence than
  // first entry, so a value oscillating around the entry threshold cannot flap the state.
  REENTER_MIN_RR: 1.2,               // vs 1.0 first-entry floor
  REENTER_MAX_EXTENSION_ATR: 2.2,    // vs 2.5 first-entry ceiling
  // Material-new-setup test: a revival keeps its setupId (same episode, no re-alert) UNLESS
  // the structure genuinely changed. ATR-normalized so the same rule fits a 2%-ADR and a
  // 15%-ADR name.
  MATERIAL_TRIGGER_ATR: 0.5,         // trigger level moved ≥ this many ATRs
  MATERIAL_PRICE_ATR: 1.0,           // price structure displaced ≥ this many ATRs from retirement
  MATERIAL_MIN_ELAPSED_MS: 45 * 60 * 1000,  // enough elapsed time = a genuinely new context
});

// Alert budgets + classes. Alerts are server-emitted; these bounds are the LAST line of
// defense (dedup + episode identity + cooldowns come first).
const ALERTS = Object.freeze({
  MAX_PER_TICKER_PER_DAY: 6,   // across all kinds; excess is counted + suppressed, never silent
  MAX_PER_CYCLE: 10,           // one evaluation cycle may not flood the feed
  // Early-watch alerts fire on upward early-state progression only, once per state per setup.
  EARLY_LADDER: Object.freeze(['SCOUT', 'PRIMED', 'IGNITION', 'EARLY_CONFIRMED']),
  // Early alerts below this rung are board-only (SCOUT fires too often to notify on).
  EARLY_MIN_NOTIFY_STATE: 'PRIMED',
});

// Market-regime policy for Day Trade. HONEST STATUS: the "momentum fails in risk-off"
// finding comes from the MULTI-DAY swing research (63-session exits study) — the app has NO
// Day-Trade-specific walk-forward evidence that hard risk-off suppression helps intraday
// (the forward book's worst regime was actually risk-ON). So regime is used as CONTEXT and
// a model input, not a hard gate, until a Day-Trade-specific evidence gate passes.
const REGIME = Object.freeze({
  HARD_SUPPRESS: false,                 // flip only when EVIDENCE_GATE becomes 'passed'
  EVIDENCE_GATE: 'not-passed',          // pre-registered: needs daytrade-specific WF/prospective evidence
  NOTE: 'Regime shown as context and used as a model input; intraday hard suppression is NOT validated for Day Trade (the multi-day risk-off finding does not transfer automatically).',
});

// Strategy-specific, NORMALIZED thesis-failure thresholds for the original momentum-
// continuation setup. "Down 10%" is deliberately NOT a universal rule — failure is
// confirmed by ATR-normalized loss, VWAP structure, breakout failure, or a stop breach
// (any binding condition), so the same absolute % means different things on a 2%-ADR
// name and a 15%-ADR name.
const THESIS = Object.freeze({
  // Loss from the detection price, in ATR units, past which the long momentum thesis is
  // considered invalidated even if price is momentarily above VWAP.
  FAIL_LOSS_ATR: 1.5,
  // Consecutive 5-min closes below VWAP that CONFIRM failure (hysteresis — one wick can't).
  VWAP_LOSS_CONFIRM: 2,
  // A day collapse (current-session % change) inconsistent with a fresh long momentum setup.
  DAY_COLLAPSE_PCT: -6,
});

// The reclaim/reversal archetype is a NEW setup, never a continuation of the stale pick.
// These are the minimum current-session conditions before a failed momentum name may be
// re-presented as a REVERSAL_RECLAIM (still not the original thesis).
const RECLAIM = Object.freeze({
  VWAP_RECLAIM_CLOSES: 2,   // confirmed VWAP reclaim = ≥2 closes back above VWAP
  MIN_REMAINING_RR: 1.5,    // acceptable reward:risk on the NEW reclaim structure
});

// Best-Opportunities gate (gate-v2). The 3-session pcarry model and price overextension are
// RANKING/context inputs only — they can no longer suppress an otherwise-valid intraday
// setup (pcarry answers a multi-day question; the intraday admission question is answered
// by the lifecycle gate + execution checks). Dilution/M&A fade catalysts remain a hard
// exclusion (a mechanical, catalyst-class rule, not a model output).
const GATE = Object.freeze({
  VERSION: 'best-gate-v2',
  BEST_CARRY_FLOOR: 50,                          // legacy v1 floor — kept for the LOG-time byGate evidence stream only
  BEST_FADE_CATALYSTS: ['FADE_OFFERING', 'MA'],  // dilution / M&A pops that fade
  CARRY_NEUTRAL: 49,                             // rank value assumed when carry is unknown (the base rate)
  OVEREXTENDED_RANK_DISCOUNT: 15,                // carry-points discount for blow-off extension (rank, not exclusion)
});

// LIVE EXECUTION GATE — blocks/downgrades actionability on execution grounds. Checks run
// only on evidence that EXISTS: spread/halt checks apply when a provider observes them;
// the risk-vs-cost and dollar-volume checks always run (the tiered cost model is always
// computable, conservatively, from measured liquidity).
const EXECUTION = Object.freeze({
  MAX_SPREAD_BPS: 50,        // observed quoted spread above this blocks a marketable entry
  MIN_RISK_TO_COST: 3,       // plan risk (bps) must be ≥ this multiple of the round-trip cost
  MIN_ADV_TO_NOTIONAL: 200,  // avg daily dollar volume must be ≥ this multiple of the unit notional
});

module.exports = { FRESHNESS, THESIS, RECLAIM, GATE, EXECUTION, STAGE2, LIVE_PLAN, REGIME, DISCOVERY, EARLY, ANTIFLAP, ALERTS, FIVE_MIN_MS };
