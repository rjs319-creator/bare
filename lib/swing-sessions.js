'use strict';
// SWING SESSION AGING — the single source of truth for "how old is this episode?"
//
// The origin store's bug (remaining-edge-origins.js) was a hand-incremented `bars`
// counter that advanced only on days the SIGNAL was present, froze on absent days, and
// could double-count if the cron ran twice. This module removes all of that: age is
// DERIVED from the actual daily bar dates of the security, never incremented.
//
//   sessionsSince(fromDate, candles) = number of trading bars strictly after fromDate
//
// Properties this buys for free (see the required tests):
//   • Weekend/holiday aware — the daily feed only returns trading days, so a Friday→Monday
//     gap counts as one session, and a holiday is simply not a bar.
//   • Idempotent — re-evaluating on the same date recomputes the same count; there is no
//     mutable counter to increment twice (test: "same date does not increment age twice").
//   • Gaps don't freeze age — if the monitor skips days but the security kept trading, the
//     next run still sees every bar and reports the true age (test: "missing days do not
//     freeze episode age").
//
// A calendar fallback (weekday roll minus known holidays) is provided ONLY for when candles
// are unavailable (a stale/failed feed), so the board can still show an age estimate and
// flag DATA_STALE rather than silently freezing. The candle-derived count is always
// preferred when bars exist.
//
// Pure: no network, no clock, no store. Dates are ISO 'YYYY-MM-DD' strings throughout.

const { isMarketHoliday } = require('./stats');

// Normalize a candle's date to an ISO 'YYYY-MM-DD' string. Candles in this app carry a
// `date` ('YYYY-MM-DD') or a `time`/`t` epoch (seconds or ms). Returns null if unparseable.
function barDate(c) {
  if (!c) return null;
  if (typeof c.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c.date)) return c.date.slice(0, 10);
  const t = c.time != null ? c.time : c.t;
  if (Number.isFinite(t)) {
    const ms = t > 1e12 ? t : t * 1000; // seconds → ms
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

// Sorted, de-duplicated array of trading-session dates from a candle array.
function sessionDates(candles) {
  if (!Array.isArray(candles)) return [];
  const seen = new Set();
  for (const c of candles) { const d = barDate(c); if (d) seen.add(d); }
  return [...seen].sort();
}

// The most recent bar date, or null.
function latestSessionDate(candles) {
  const ds = sessionDates(candles);
  return ds.length ? ds[ds.length - 1] : null;
}

// Count of trading sessions strictly after `fromDate` and up to (inclusive) the last bar.
// This is the episode's age in sessions. `fromDate` is the decision date (T); a bar dated
// exactly T is NOT counted (age 0 on the decision day). Returns null when there are no bars.
function sessionsSince(fromDate, candles) {
  if (!fromDate) return null;
  const ds = sessionDates(candles);
  if (!ds.length) return null;
  const from = String(fromDate).slice(0, 10);
  let n = 0;
  for (const d of ds) if (d > from) n++;
  return n;
}

// Count of trading sessions in the half-open window (fromDate, toDate] present in candles.
function sessionsBetween(fromDate, toDate, candles) {
  if (!fromDate || !toDate) return null;
  const ds = sessionDates(candles);
  const from = String(fromDate).slice(0, 10);
  const to = String(toDate).slice(0, 10);
  let n = 0;
  for (const d of ds) if (d > from && d <= to) n++;
  return n;
}

// The bar strictly after `fromDate` (the earliest executable next-open fill session), or null.
// Used to enforce the causal rule: a swing EOD recommendation fills no earlier than T+1.
function nextSessionBar(fromDate, candles) {
  if (!fromDate) return null;
  if (!Array.isArray(candles)) return null;
  const from = String(fromDate).slice(0, 10);
  const rows = candles
    .map(c => ({ c, d: barDate(c) }))
    .filter(x => x.d && x.d > from)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return rows.length ? rows[0].c : null;
}

// CALENDAR FALLBACK — trading sessions in (fromDate, toDate] by weekday roll minus known
// holidays. Used only when candles are missing so age still advances (never freezes) and
// the board can flag staleness. `isHoliday` defaults to the app's NYSE table.
function calendarSessionsBetween(fromDate, toDate, isHoliday = isMarketHoliday) {
  if (!fromDate || !toDate) return null;
  const from = new Date(String(fromDate).slice(0, 10) + 'T00:00:00Z');
  const to = new Date(String(toDate).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return 0;
  let n = 0;
  const d = new Date(from);
  let guard = 0;
  while (guard++ < 4000) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d > to) break;
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (typeof isHoliday === 'function' && isHoliday(iso)) continue;
    n++;
  }
  return n;
}

module.exports = {
  barDate, sessionDates, latestSessionDate, sessionsSince, sessionsBetween,
  nextSessionBar, calendarSessionsBetween,
};
