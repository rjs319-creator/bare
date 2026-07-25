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
});

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
  EWMA_ALPHA: 0.15,                   // per-minute volatility estimator smoothing
  MAX_ANOMALIES: 25,                  // Stage-B candidates surfaced per scan
  STATE_STALE_MIN: 120,               // discard interval state older than this (new baseline)
  RESULT_FRESH_MIN: 10,               // runDaytrade merges a discovery doc younger than this
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

// Best-Opportunities / carry gate (kept here so the one fade-avoidance floor is shared).
const GATE = Object.freeze({
  BEST_CARRY_FLOOR: 50,                          // above pcarry BASE_RATE (~49% beat-SPY)
  BEST_FADE_CATALYSTS: ['FADE_OFFERING', 'MA'],  // dilution / M&A pops that fade
});

module.exports = { FRESHNESS, THESIS, RECLAIM, GATE, STAGE2, LIVE_PLAN, REGIME, DISCOVERY, FIVE_MIN_MS };
