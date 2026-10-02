'use strict';
// ghostobs/ freshness — how many trading sessions the Ghost observation ledger is behind.
//
// WHY THIS EXISTS: `op=ghostlog` left the nightly chains on 2026-08-13 and nothing
// wrote ghostobs/ again until it was re-homed in the `atlasx` chain on 2026-10-02 —
// seven weeks in which lib/premove-routes.js kept reading the last 2026-08 snapshot as
// "the latest Ghost observation" with no visible sign anywhere. The Pre-Move payload
// now carries this read-out so the next silent stop shows up in the response.
//
// Pure: dates in, verdict out. The session walk mirrors lib/research/live-bridge.js
// forwardSessionAxis (weekday roll + optional holiday predicate).

// The ledger is written nightly for the session just closed, so during the day the
// latest snapshot is ONE session behind — fresh. Two or more means a nightly write was
// missed (or the step stopped being scheduled again).
const STALE_AFTER_SESSIONS = 2;
// Hard cap on the calendar walk so a very old (or garbage) date cannot spin.
const MAX_CALENDAR_DAYS = 400;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toUtcDate = (iso) => {
  if (typeof iso !== 'string' || !ISO_DATE_RE.test(iso)) return null;
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : d;
};
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

// Sessions strictly after `lastDate` up to and including `asOfDate`; null when either
// date is unusable (the caller treats null as stale — fail closed).
function sessionsBehind(lastDate, asOfDate, isHoliday = null) {
  const from = toUtcDate(lastDate);
  const to = toUtcDate(asOfDate);
  if (!from || !to) return null;
  if (from >= to) return 0;
  let count = 0;
  const cursor = new Date(from.getTime());
  for (let days = 0; days < MAX_CALENDAR_DAYS && cursor < to; days++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWeekend(cursor)) continue;
    const iso = cursor.toISOString().slice(0, 10);
    if (typeof isHoliday === 'function' && isHoliday(iso)) continue;
    count++;
  }
  return count;
}

// { lastDate, sessionsBehind, stale, status: 'fresh' | 'stale' | 'missing' }
function ghostObsFreshness({ lastDate = null, asOfDate, isHoliday = null } = {}) {
  if (!lastDate) return { lastDate: null, sessionsBehind: null, stale: true, status: 'missing' };
  const behind = sessionsBehind(lastDate, asOfDate, isHoliday);
  const stale = behind == null || behind >= STALE_AFTER_SESSIONS;
  return { lastDate, sessionsBehind: behind, stale, status: stale ? 'stale' : 'fresh' };
}

module.exports = { ghostObsFreshness, sessionsBehind, STALE_AFTER_SESSIONS };
