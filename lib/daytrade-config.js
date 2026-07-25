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

module.exports = { FRESHNESS, THESIS, RECLAIM, GATE, FIVE_MIN_MS };
