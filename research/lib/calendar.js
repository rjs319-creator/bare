'use strict';
// MARKET-SESSION CALENDAR (us-sessions-v1) — the common US trading-session
// axis for cohort-maturity arithmetic.
//
// WHY THIS EXISTS (verified defect): panel-v3.1 declared a decision date
// "fully mature" for a horizon as soon as ANY row carried a finite outcome.
// Early delistings resolve their labels before the horizon elapses, so a
// cohort with 3 label-ready delistings and 1,704 pending active names was
// declared mature and its 3-name "cross-section" entered rank-IC. Maturity is
// a property of the CALENDAR (has the required exit session elapsed?) and of
// the COHORT (are any rows still pending?), never of one row's label state.
//
// The calendar is built from an observed benchmark bar series (SPY cache —
// the app has no separately authoritative exchange calendar), versioned, and
// content-hashed so any change to the session axis changes provenance.
//
// Pure module: no network, no clock, no fs. Callers inject the bar dates.

const crypto = require('crypto');

const CALENDAR_VERSION = 'us-sessions-v1';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// buildSessionCalendar(dates, { source }) → frozen calendar object.
// dates: ISO 'YYYY-MM-DD' strings (any order, duplicates tolerated).
function buildSessionCalendar(dates, { source = null } = {}) {
  const sessions = [...new Set((dates || []).filter((d) => typeof d === 'string' && ISO_DATE_RE.test(d)))].sort();
  if (sessions.length < 2) throw new Error('session calendar requires at least 2 observed sessions');
  const index = new Map(sessions.map((d, i) => [d, i]));
  return Object.freeze({
    schema: 'MarketSessionCalendar',
    version: CALENDAR_VERSION,
    source,
    sessions: Object.freeze(sessions),
    firstSession: sessions[0],
    lastSession: sessions[sessions.length - 1],
    calendarHash: sha256(`${CALENDAR_VERSION}\n${sessions.join('\n')}`),
    _index: index,
  });
}

const isSession = (cal, iso) => cal._index.has(iso);
const sessionAt = (cal, idx) => (idx >= 0 && idx < cal.sessions.length ? cal.sessions[idx] : null);

// Index of the last session at or before `iso`; -1 when iso precedes the calendar.
function sessionIndexAtOrBefore(cal, iso) {
  if (cal._index.has(iso)) return cal._index.get(iso);
  let lo = 0, hi = cal.sessions.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cal.sessions[mid] <= iso) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// The cohort window for (decisionDate, horizonSessions):
//   entrySession        — last session at or before the decision date (the
//                         decision bar; labels enter here).
//   requiredExitSession — the session exactly `horizonSessions` sessions after
//                         the entry session; null when the calendar itself does
//                         not extend that far (window cannot have elapsed).
function cohortWindow(cal, decisionDate, horizonSessions) {
  const entryIdx = sessionIndexAtOrBefore(cal, decisionDate);
  if (entryIdx < 0) return { entryIdx: -1, entrySession: null, exitIdx: null, requiredExitSession: null };
  const exitIdx = entryIdx + horizonSessions;
  return {
    entryIdx,
    entrySession: cal.sessions[entryIdx],
    exitIdx,
    requiredExitSession: sessionAt(cal, exitIdx),
  };
}

// Has the full horizon window elapsed inside the observation cutoff?
// True ONLY when the required exit session exists on the calendar and is at or
// before labelObservationCutoff. Beyond-calendar windows are NOT elapsed.
function cohortWindowElapsed(cal, decisionDate, horizonSessions, labelObservationCutoff) {
  const w = cohortWindow(cal, decisionDate, horizonSessions);
  return !!(w.requiredExitSession && w.requiredExitSession <= labelObservationCutoff);
}

// Serializable form (no Map) for the on-disk artifact.
function calendarArtifact(cal) {
  return {
    schema: cal.schema, version: cal.version, source: cal.source,
    firstSession: cal.firstSession, lastSession: cal.lastSession,
    sessionCount: cal.sessions.length,
    calendarHash: cal.calendarHash,
    sessions: [...cal.sessions],
  };
}

// Rehydrate from the artifact, verifying the content hash (a tampered or
// truncated calendar must never silently drive maturity arithmetic).
function loadCalendarArtifact(doc) {
  if (!doc || doc.schema !== 'MarketSessionCalendar' || !Array.isArray(doc.sessions)) {
    throw new Error('not a MarketSessionCalendar artifact');
  }
  const cal = buildSessionCalendar(doc.sessions, { source: doc.source });
  if (doc.calendarHash && doc.calendarHash !== cal.calendarHash) {
    throw new Error(`calendar artifact hash mismatch: declared ${String(doc.calendarHash).slice(0, 12)}… != recomputed ${cal.calendarHash.slice(0, 12)}…`);
  }
  return cal;
}

module.exports = {
  CALENDAR_VERSION,
  buildSessionCalendar, isSession, sessionAt, sessionIndexAtOrBefore,
  cohortWindow, cohortWindowElapsed, calendarArtifact, loadCalendarArtifact,
};
