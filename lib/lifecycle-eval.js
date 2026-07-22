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
const { STATUS } = require('./freshness');

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
  return {
    ticker: pick.ticker,
    now: nowIso,
    session: sessionOf(new Date(nowIso)),
    freshness: fresh,
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

module.exports = { sessionOf, buildEvaluation, absentEvaluation };
