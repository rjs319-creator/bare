'use strict';
// PURE mapping from the daily-bar screener's evidence → a lifecycle evaluation (`ev` for
// lib/opportunity-lifecycle.advanceLifecycle).
//
// HONEST LIMITATION (documented, not hidden): a daily bar cannot confirm intraday
// actionability — VWAP relationship, opening-range trigger, time-of-day relative volume,
// consecutive-close failures. Those signals are left UNSET here, so the actionable gate
// (which requires them ALL explicitly true) can never pass on daily evidence alone. A fresh
// daily mover therefore tops out at BUILDING; ARMED/ACTIONABLE_NOW/STALLING(intraday)/
// FAILED light up only once the Stage-2 intraday feature builder populates those fields.
const { STATUS, computeFreshness, isActionableFresh } = require('./freshness');

const TOD_RELVOL_MIN = 1.0;   // same-time-of-day participation floor to assert relVolOk

// Regular-hours session classifier in America/New_York (EST/EDT-safe).
function sessionOf(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return 'closed';
  let hh = parseInt(get('hour'), 10); if (hh === 24) hh = 0;
  const cur = hh * 60 + parseInt(get('minute'), 10);
  if (cur < 4 * 60) return 'closed';                 // before 04:00 ET
  if (cur < 9 * 60 + 30) return 'premarket';         // 04:00–09:30
  if (cur < 16 * 60) return 'regular';               // 09:30–16:00
  if (cur < 20 * 60) return 'afterhours';            // 16:00–20:00
  return 'closed';
}

// Finer-grained intraday bucket for session-specific normalization. Premarket, the opening
// minutes, midday and the power hour have structurally different volume/volatility — they
// must never share one baseline distribution.
function sessionBucketOf(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return 'closed';
  let hh = parseInt(get('hour'), 10); if (hh === 24) hh = 0;
  const cur = hh * 60 + parseInt(get('minute'), 10);
  const open = 9 * 60 + 30;
  if (cur < 4 * 60) return 'closed';
  if (cur < open) return 'premarket';
  if (cur < open + 5) return 'open5';
  if (cur < open + 30) return 'open30';
  if (cur < 15 * 60) return 'midday';
  if (cur < 16 * 60) return 'power';
  if (cur < 20 * 60) return 'afterhours';
  return 'closed';
}

function pickIsFresh(pick) {
  const f = pick.freshness;
  if (f) return f.freshnessStatus === STATUS.FRESH_TODAY || f.barIsToday === true;
  return pick.barIsToday === true;
}

// Build an ev from a live screener pick (rows from lib/screener-routes carry freshness,
// barIsToday, pctChange, relVol, excessPct, gapPct, last, entry/stop/target/rr). Only fields
// honestly derivable from DAILY evidence are set; intraday-only signals stay undefined.
function buildEvaluation(pick, { now } = {}) {
  const nowIso = now || new Date().toISOString();
  const fresh = pick.freshness || null;
  const isFresh = pickIsFresh(pick);
  // The daily-cache discovery case: the ONLY evidence is a completed prior-session bar (no
  // fresh intraday/quote timestamp). Such a name is historical discovery, never a live buy —
  // it routes to PRIOR_SESSION_WATCH rather than WATCHING so the UI can never present a
  // prior-session setup as actionable "right now".
  const hasDailyBar = !!(fresh && (fresh.candidateDate || fresh.dailyBarAsOf)) || pick.candidateDate != null || pick.date != null;
  return {
    ticker: pick.ticker,
    now: nowIso,
    session: sessionOf(new Date(nowIso)),
    freshness: fresh,
    priorSessionOnly: !isFresh && hasDailyBar,
    // Constructive daily evidence (coarse) — asserted ONLY when the bar is current-session.
    // A stale bar's pctChange/excessPct describe a PRIOR session, so they must not drive
    // current-session progression (momentumOk falls to false → the name stays WATCHING).
    momentumOk: isFresh ? (pick.pctChange != null ? pick.pctChange > 0 : undefined) : false,
    residualOk: isFresh && pick.excessPct != null ? pick.excessPct >= 0 : undefined,
    nearTrigger: isFresh && pick.pctChange != null && pick.pctChange > 0,
    // Intraday-only signals intentionally UNSET (aboveVwap/triggerConfirmed/relVolOk/
    // closesBelowVwap/extensionAtr/breakoutFailed/expired) ⇒ actionable gate cannot pass.
    metrics: {
      last: pick.last ?? null, pctChange: pick.pctChange ?? null, relVol: pick.relVol ?? null,
      residualVsSpy: pick.excessPct ?? null, gapPct: pick.gapPct ?? null,
    },
  };
}

// Evaluation for a name tracked earlier today but ABSENT from the current scan (no fresh
// confirmation this cycle). Not decisive — gently de-escalates; a formerly ACTIONABLE/ARMED
// name stalls (momentum lost) rather than silently vanishing.
function absentEvaluation(ticker, { now } = {}) {
  const nowIso = now || new Date().toISOString();
  return {
    ticker,
    now: nowIso,
    session: sessionOf(new Date(nowIso)),
    freshness: { freshnessStatus: STATUS.PRIOR_SESSION, barIsToday: false },
    momentumOk: false,
    metrics: { note: 'absent from current scan' },
  };
}

// STAGE-2: build a rich, current-session `ev` from intraday features (lib/intraday-features).
// Where a feature is null (insufficient data) the corresponding gate signal is left UNSET so
// the actionable gate stays conservative — never asserted on missing evidence. Fresh intraday
// bars make the name current-session FRESH even if the daily cache bar is stale (that's the
// whole point of live validation).
// `quote` (optional) = { price, asOf } — the live quote overlaid on the bar evidence (from
// the chart meta on the Stage-2 fetch). Actionability freshness requires BOTH a recent
// intraday bar AND a recent quote; without a quote the strict flag is false (fail closed).
function intradayEv(pick, f, { now, quote = null } = {}) {
  const nowIso = now || new Date().toISOString();
  const orHigh = f.openingRange ? f.openingRange.high : null;
  const nearTrigger = f.triggerConfirmed === true
    ? true
    : (orHigh != null && f.last != null ? f.last >= orHigh * 0.99 : undefined);
  // "positive OR convincingly improving" momentum.
  const momentumOk = f.mom15 != null
    ? (f.mom15 > 0 || (f.mom5 > 0 && (f.momAccel ?? 0) > 0))
    : undefined;
  const residualPct = f.residual15 != null ? +(f.residual15 * 100).toFixed(2) : null;
  // Current-session invalidation evidence against the ORIGINAL plan: a stop breach and the
  // ATR-normalized loss from the detection price. The detection reference is the plan entry
  // (the level the long thesis was built on), falling back to the detection bar's close.
  const detection = pick.entry ?? pick.last ?? null;
  const stopBreached = (pick.stop != null && f.last != null) ? f.last <= pick.stop : undefined;
  const lossFromDetectionAtr = (detection != null && f.last != null && f.dailyAtr > 0 && f.last < detection)
    ? +((detection - f.last) / f.dailyAtr).toFixed(2) : 0;
  // Intraday bars ARE current-session evidence → freshness reflects that, not the daily bar.
  // The quote timestamp completes the pair the strict actionability gate requires.
  const freshness = computeFreshness({
    barDate: pick.candidateDate || null, intradayBarAsOf: f.asOf,
    quoteAsOf: quote && quote.asOf ? quote.asOf : null, now: new Date(nowIso),
  });
  return {
    ticker: pick.ticker,
    now: nowIso,
    session: sessionOf(new Date(nowIso)),
    freshness,
    // STRICT actionability freshness: recent bar AND recent quote, no future-dated data.
    // This (not the loose FRESH_TODAY category) is what the actionable gate keys off.
    actionableFresh: isActionableFresh(freshness, { now: new Date(nowIso) }),
    livePlan: f.livePlan || null,
    stopBreached,
    lossFromDetectionAtr,
    aboveVwap: f.aboveVwap == null ? undefined : f.aboveVwap,
    triggerConfirmed: f.triggerConfirmed,
    breakoutFailed: f.breakoutFailed,
    openingRangeForming: f.openingRangeForming,
    relVolOk: f.timeOfDayRelVol != null ? f.timeOfDayRelVol >= TOD_RELVOL_MIN : undefined,
    momentumOk,
    residualOk: f.residual15 != null ? f.residual15 >= 0 : undefined,
    nearTrigger,
    remainingRR: f.remainingRR ?? undefined,
    extensionAtr: f.extensionAtr ?? undefined,
    closesBelowVwap: f.closesBelowVwapStreak ?? 0,
    noNewHighBars: f.barsSinceHigh ?? 0,
    volumeFading: f.volumeFading === true,
    lowerHighs: f.lowerHighs ?? 0,
    expired: f.expired === true,
    // CANONICAL FEATURE SURFACE (lib/intraday-schema). This object is what the immutable
    // snapshot captures as the model feature vector, so every model feature MUST be an own
    // property here (null = honest missingness; ABSENT = schema break, caught by tests).
    // residualVsSpy stays in PERCENT for display; residual15 is the canonical FRACTION.
    metrics: {
      last: f.last ?? null, vwap: f.vwap ?? null,
      mom5: f.mom5 ?? null, mom10: f.mom10 ?? null, mom15: f.mom15 ?? null, mom30: f.mom30 ?? null,
      momAccel: f.momAccel ?? null, momJerk: f.momJerk ?? null,
      residual15: f.residual15 ?? null, residual30: f.residual30 ?? null,
      residualSector15: f.residualSector15 ?? null,
      residualVsSpy: residualPct,
      timeOfDayRelVol: f.timeOfDayRelVol ?? null,
      volAccel: f.volAccel ?? null, dollarVolAccel: f.dollarVolAccel ?? null,
      rangeExpansion: f.rangeExpansion ?? null,
      vwapDist: f.vwapDist ?? null, vwapSlope: f.vwapSlope ?? null,
      distFromHod: f.distFromHod ?? null, barsSinceHigh: f.barsSinceHigh ?? null,
      lowerHighs: f.lowerHighs ?? null, closesBelowVwapStreak: f.closesBelowVwapStreak ?? null,
      extensionAtr: f.extensionAtr ?? null, remainingRR: f.remainingRR ?? null,
      quotePrice: quote && quote.price != null ? quote.price : null,
      dailyAtr: f.dailyAtr ?? null,
      schemaVersion: f.schemaVersion ?? null,
    },
    archetypes: f.archetypes || null,
  };
}

module.exports = { sessionOf, sessionBucketOf, buildEvaluation, absentEvaluation, intradayEv, TOD_RELVOL_MIN };
