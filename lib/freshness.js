'use strict';
// PER-TICKER DATA FRESHNESS — the point-in-time guard that stops a completed prior-
// session daily bar from masquerading as a live current-session event.
//
// THE DEFECT THIS CLOSES. The screener warms a daily-candle cache before the open and
// any request may READ it for ~26h (lib/candle-cache FRESH_USE_MS). Mid-session the
// clock says "30 min into the session" and a market proxy (SPY) may carry a partial
// current-session bar, while an INDIVIDUAL name still resolves to YESTERDAY's COMPLETED
// daily bar in that same cache. If the clock-derived session-elapsed fraction is applied
// to that stale bar, a completed 1.0x prior-day volume reads as 5x/10x+ early in the
// session — a red/stagnant name gets ranked as a fresh volume explosion.
//
// The fix is to make freshness EXPLICIT and PER-TICKER: pacing/eligibility decisions key
// off "is THIS ticker's bar the current ET session's bar?", never off a shared clock or a
// single proxy's freshness. This also sidesteps the holiday calendar entirely — on a
// weekend/holiday there is simply no bar dated "today", so nothing is paceable.
//
// Pure (no network, no state). America/New_York throughout, DST-correct via Intl.

const STATUS = Object.freeze({
  FRESH_TODAY: 'FRESH_TODAY',       // this name has current-session data (today's bar and/or a live quote)
  PRIOR_SESSION: 'PRIOR_SESSION',   // newest data is a completed earlier-session bar — NOT live
  UNKNOWN: 'UNKNOWN',               // no usable date/quote at all
});

// ET calendar date ('YYYY-MM-DD') for a Date. en-CA renders ISO order; America/New_York
// resolves EST/EDT automatically. This is the single source of "what ET day is it".
function etDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Is a daily bar dated `barDate` (an ET 'YYYY-MM-DD') the CURRENT ET session's bar?
// A weekend/holiday has no bar dated today, so a Friday bar read on Saturday is correctly
// prior-session — no calendar needed.
function barIsCurrentSession(barDate, now = new Date()) {
  return !!barDate && barDate === etDate(now);
}

// Parse an ISO-ish timestamp to epoch ms, or null. Never throws.
function toMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  const m = Date.parse(ts);
  return Number.isFinite(m) ? m : null;
}

// Build the machine-readable freshness envelope for ONE ticker at evaluation time.
// Inputs are whatever the caller actually has; every field degrades to null cleanly.
//   barDate         — ET date of the newest DAILY bar used ('YYYY-MM-DD')
//   intradayBarAsOf — ISO ts of the newest 5-min bar used (optional)
//   quoteAsOf       — ISO ts of the live quote overlaid (optional)
//   liveValidatedAt — ISO ts when live validation last ran for this name (optional)
//   cacheUpdatedAt  — epoch ms or ISO of the candle-cache doc (optional)
//   now             — evaluation instant (injectable for tests)
function computeFreshness({
  barDate = null,
  intradayBarAsOf = null,
  quoteAsOf = null,
  liveValidatedAt = null,
  cacheUpdatedAt = null,
  now = new Date(),
} = {}) {
  const nowMs = now.getTime();
  const barToday = barIsCurrentSession(barDate, now);

  // The freshest REAL market timestamp we can attest for this name.
  const quoteMs = toMs(quoteAsOf);
  const intraMs = toMs(intradayBarAsOf);
  const freshestMs = [quoteMs, intraMs].filter(v => v != null).sort((a, b) => b - a)[0] ?? null;

  let freshnessStatus;
  if (freshestMs != null || barToday) freshnessStatus = STATUS.FRESH_TODAY;
  else if (barDate) freshnessStatus = STATUS.PRIOR_SESSION;
  else freshnessStatus = STATUS.UNKNOWN;

  // dataAgeSeconds is only honest when we have an explicit intraday/quote timestamp. A bare
  // DAILY bar has no intraday age (it's an end-of-session aggregate), so we leave it null and
  // let freshnessStatus carry the categorical signal rather than invent a number.
  const dataAgeSeconds = freshestMs != null ? Math.max(0, Math.round((nowMs - freshestMs) / 1000)) : null;

  const cacheMs = toMs(cacheUpdatedAt);
  return {
    candidateDate: barDate || null,
    dailyBarAsOf: barDate || null,
    intradayBarAsOf: intraMs != null ? new Date(intraMs).toISOString() : null,
    quoteAsOf: quoteMs != null ? new Date(quoteMs).toISOString() : null,
    liveValidatedAt: liveValidatedAt || null,
    cacheUpdatedAt: cacheMs != null ? new Date(cacheMs).toISOString() : null,
    dataAgeSeconds,
    barIsToday: barToday,
    freshnessStatus,
  };
}

// Convenience predicate for eligibility gates: can this name be labeled "Actionable Now"?
// Requires current-session evidence (today's bar OR a live intraday/quote timestamp).
function isCurrentSessionFresh(freshness) {
  return !!freshness && freshness.freshnessStatus === STATUS.FRESH_TODAY;
}

module.exports = {
  STATUS, etDate, barIsCurrentSession, computeFreshness, isCurrentSessionFresh,
};
