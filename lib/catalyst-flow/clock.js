'use strict';
// CATALYST–FLOW — EVENT CLOCK.
//
// Turns an announcement into the four moments the experiment depends on, using an
// EXCHANGE SESSION AXIS (an injected array of observed session dates) rather than
// calendar-day arithmetic. "Five trading sessions" across a holiday week is not
// "seven calendar days", and every place this repo has used the latter it has been wrong.
//
//   announcementDate  → the vendor's event date.
//   confirmationSession — the first complete post-event regular session.
//   decisionDate      — that session's close; ALL features freeze here.
//   entrySession      — the next regular session; entry at its open or the 09:35–09:45 VWAP.
//   exitSession       — exactly `holdSessions` sessions after the entry session.
//
// WHY THE CONFIRMATION SESSION IS ALWAYS THE DAY AFTER. The vendor earnings feed carries
// no before-open/after-close marker (measured: 0 of 12,749 sampled rows). Taking the day
// after is correct for an after-close release and merely one session late for a
// before-open one. The reverse choice would let a before-open assumption observe a
// session that had not finished when the news broke. Late is a cost; early is leakage.
//
// A source that misses the cutoff POSTPONES the event — `postponeToNextDecision` moves the
// whole clock forward one session. It never backfills the value into the earlier cutoff.
//
// Pure module: no network, no clock, no fs.

const { CLOCK, ENTRY_CONVENTIONS } = require('./config');

// Index of the last session at or before `iso`; -1 when iso precedes the axis.
function sessionIndexAtOrBefore(sessions, iso) {
  let lo = 0, hi = sessions.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid] <= iso) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// Index of the first session STRICTLY AFTER `iso`; -1 when the axis does not reach it.
function sessionIndexAfter(sessions, iso) {
  const at = sessionIndexAtOrBefore(sessions, iso);
  const next = at + 1;
  return next < sessions.length ? next : -1;
}

// Build the full clock for one announcement.
//
// Returns `{ ok: false, reason }` — never a partially-filled clock — when the session axis
// does not extend far enough. An unobservable exit is a REJECTION, not a truncated hold.
function eventClock(sessions, announcementDate, opts = {}) {
  const {
    holdSessions = CLOCK.holdSessions,
    confirmationOffset = CLOCK.confirmationSessionOffset,
    entryOffset = CLOCK.entrySessionOffset,
    entryConvention = CLOCK.entryConvention,
    postponements = 0,
  } = opts;

  if (!Array.isArray(sessions) || sessions.length < 2) return { ok: false, reason: 'no-session-axis' };
  if (!ENTRY_CONVENTIONS.includes(entryConvention)) return { ok: false, reason: `unknown-entry-convention:${entryConvention}` };
  if (!(holdSessions >= 1)) return { ok: false, reason: 'hold-must-be-at-least-one-session' };

  const anchor = sessionIndexAtOrBefore(sessions, announcementDate);
  if (anchor < 0) return { ok: false, reason: 'announcement-precedes-session-axis' };

  const confIdx = anchor + confirmationOffset + postponements;
  const entryIdx = confIdx + entryOffset;
  const exitIdx = entryIdx + holdSessions - 1;
  if (exitIdx > sessions.length - 1) return { ok: false, reason: 'horizon-beyond-session-axis' };

  return Object.freeze({
    ok: true,
    announcementDate,
    announcementSessionIdx: anchor,
    confirmationSession: sessions[confIdx],
    confirmationIdx: confIdx,
    decisionDate: sessions[confIdx],
    entrySession: sessions[entryIdx],
    entryIdx,
    exitSession: sessions[exitIdx],
    exitIdx,
    holdSessions,
    entryConvention,
    postponements,
  });
}

// A source missed the cutoff: shift the whole clock one session later. The event is scored
// at the LATER decision date or not at all — its value is never backfilled into the
// original cutoff, which is precisely the move that would import future information.
const postponeToNextDecision = (sessions, announcementDate, opts = {}) =>
  eventClock(sessions, announcementDate, { ...opts, postponements: (opts.postponements || 0) + 1 });

// Is `availableAtTs` at or before the decision cutoff? A dataset that arrives overnight
// (Cboe EOD) is NOT available at the prior close — it is available for the FOLLOWING
// morning's decision, which is exactly what this comparison enforces.
function isAvailableByCutoff(availableAtTs, cutoffTs) {
  const a = Date.parse(availableAtTs), c = Date.parse(cutoffTs);
  if (!Number.isFinite(a) || !Number.isFinite(c)) return false;
  return a <= c;
}

// ── One-position-per-symbol gate ────────────────────────────────────────────
// "A symbol already in a five-session position cannot be re-entered until that position
// exits." Held as a symbol → exitIdx map so the check is O(1) and order-independent.
function admitOnePositionPerSymbol(clocks) {
  const openUntil = new Map();
  const admitted = [], rejected = [];
  for (const c of [...clocks].sort((a, b) => (a.entryIdx - b.entryIdx) || String(a.symbol).localeCompare(String(b.symbol)))) {
    const busyUntil = openUntil.get(c.symbol);
    if (busyUntil != null && c.entryIdx <= busyUntil) {
      rejected.push({ ...c, rejectReason: 'symbol-already-in-open-position' });
      continue;
    }
    openUntil.set(c.symbol, c.exitIdx);
    admitted.push(c);
  }
  return { admitted, rejected };
}

module.exports = {
  sessionIndexAtOrBefore, sessionIndexAfter,
  eventClock, postponeToNextDecision, isAvailableByCutoff,
  admitOnePositionPerSymbol,
};
