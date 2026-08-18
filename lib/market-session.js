'use strict';
// CENTRALIZED, NOW-AWARE EXCHANGE-SESSION SERVICE — market-session-v1.
//
// THE DEFECT THIS CLOSES. Session used to be inferred from the LAST CANDLE'S
// timestamp (lib/signal.js deriveSession): stale data self-certified its own
// session, the age check only ran inside REGULAR hours, and closed/premarket/
// afterhours states passed a raw intraday BUY/SELL straight through — so a
// Saturday lookup could show "STRONG BUY" with live-looking levels off Friday's
// 15:55 bar. There was also no holiday or early-close awareness in the hot path.
//
// This module is the single authority for:
//   • what session it is RIGHT NOW (America/New_York, DST-correct, weekend/
//     holiday/early-close aware) — from the CLOCK, never from data timestamps;
//   • how old the newest bar/quote is, whether the bar is complete, and whether
//     an immediately-actionable intraday signal is even permitted.
//
// Pure: no network, no store, no module-level clock. `now` is injectable
// everywhere and defaults at the call boundary only.

const SESSION = Object.freeze({
  PREMARKET: 'premarket',
  REGULAR: 'regular',
  AFTERHOURS: 'afterhours',
  CLOSED: 'closed',
});

const FRESHNESS = Object.freeze({
  LIVE: 'live',                    // regular session, bar within threshold
  LIVE_EXTENDED: 'live-extended',  // pre/after-hours, bar within threshold — PROVISIONAL
  STALE: 'stale',                  // an open session but the newest bar is too old
  CLOSED: 'closed',                // market fully closed — context only, never a live trade
  DAILY_ONLY: 'daily-only',        // no intraday feed (daily-fallback source)
  UNAVAILABLE: 'unavailable',      // no usable bar/quote at all
});

// NYSE full-day holidays (observed dates), America/New_York. EXTEND EACH YEAR.
// Covers the ledger's historical window too — labels for past decision dates
// must resolve sessions correctly, so past years are listed, not just future.
const FULL_HOLIDAYS = new Set([
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27',
  '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  // 2025 (01-09 = national day of mourning, markets closed)
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// 13:00 ET early closes (day after Thanksgiving, Christmas Eve / pre-July-4th
// when they fall on a trading day). After-hours on early-close days ends 17:00.
const EARLY_CLOSES = new Set([
  '2024-07-03', '2024-11-29', '2024-12-24',
  '2025-07-03', '2025-11-28', '2025-12-24',
  '2026-11-27', '2026-12-24',
  '2027-11-26',
]);

// Session boundaries in minutes-past-midnight ET.
const PRE_OPEN_MIN = 4 * 60;            // 04:00
const REGULAR_OPEN_MIN = 9 * 60 + 30;   // 09:30
const REGULAR_CLOSE_MIN = 16 * 60;      // 16:00
const EARLY_CLOSE_MIN = 13 * 60;        // 13:00
const POST_CLOSE_MIN = 20 * 60;         // 20:00
const EARLY_POST_CLOSE_MIN = 17 * 60;   // 17:00 on early-close days

// Bar-age freshness thresholds (seconds). Extended hours print bars less often
// (thin tape) so the tolerance is wider — but bounded, so a stale premarket or
// after-hours bar can NEVER escape the age check (the old code's exact hole).
const MAX_BAR_AGE_REGULAR_SEC = 20 * 60;
const MAX_BAR_AGE_EXTENDED_SEC = 45 * 60;

// ── ET clock primitives ─────────────────────────────────────────────────────
function etParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
    minutes: hour * 60 + parseInt(get('minute'), 10),
  };
}

function isWeekendDay(weekday) { return weekday === 'Sat' || weekday === 'Sun'; }
function isFullHoliday(etDate) { return FULL_HOLIDAYS.has(etDate); }
function isEarlyCloseDay(etDate) { return EARLY_CLOSES.has(etDate); }

// ── The session verdict for an instant ──────────────────────────────────────
// Returns a frozen descriptor of the exchange session at `now`. This is the
// ONLY place session classification lives — everything else consumes it.
function sessionInfoAt(now = new Date()) {
  const { date, weekday, minutes } = etParts(now);
  const weekend = isWeekendDay(weekday);
  const holiday = isFullHoliday(date);
  const earlyClose = !weekend && !holiday && isEarlyCloseDay(date);
  const isTradingDay = !weekend && !holiday;

  const regularCloseMin = earlyClose ? EARLY_CLOSE_MIN : REGULAR_CLOSE_MIN;
  const postCloseMin = earlyClose ? EARLY_POST_CLOSE_MIN : POST_CLOSE_MIN;

  let marketSession = SESSION.CLOSED;
  if (isTradingDay) {
    if (minutes >= PRE_OPEN_MIN && minutes < REGULAR_OPEN_MIN) marketSession = SESSION.PREMARKET;
    else if (minutes >= REGULAR_OPEN_MIN && minutes < regularCloseMin) marketSession = SESSION.REGULAR;
    else if (minutes >= regularCloseMin && minutes < postCloseMin) marketSession = SESSION.AFTERHOURS;
  }

  return Object.freeze({
    etDate: date,
    etWeekday: weekday,
    etMinutes: minutes,
    isWeekend: weekend,
    isHoliday: holiday,
    isEarlyClose: earlyClose,
    isTradingDay,
    marketSession,
    regularOpenMin: REGULAR_OPEN_MIN,
    regularCloseMin,
  });
}

// ET date of the most recent COMPLETED regular session strictly before/at `now`.
// Used to label closed-market context ("last regular-session assessment of …").
function lastCompletedRegularSession(now = new Date()) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let probe = now instanceof Date ? now : new Date(now);
  for (let i = 0; i < 15; i++) {  // bounded scan: longest closure runs are < 2 weeks
    const info = sessionInfoAt(probe);
    const sessionDone = info.isTradingDay && info.etMinutes >= info.regularCloseMin;
    if (i > 0 ? info.isTradingDay : sessionDone) return info.etDate;
    probe = new Date(probe.getTime() - (i === 0 ? (info.etMinutes + 1) * 60 * 1000 : DAY_MS));
  }
  return null;
}

// The session a daily EOD feed is EXPECTED to have published by `now`.
//
// `lastCompletedRegularSession` flips the moment the bell rings, but a provider needs
// minutes to post the day's bar — so comparing a feed against it directly reports a
// phantom missing session every afternoon. This applies a settle grace, giving the one
// question a freshness check actually wants to ask: which session should the data have
// reached by now? Behind THIS is genuinely stale; behind the raw close is just early.
const BAR_SETTLE_MS = 90 * 60 * 1000;
// Memoized to the minute: this sits on the ~515-wide scan path now, and the answer walks
// the calendar through Intl formatting — identical for every ticker in a given scan.
let _dueMemo = { key: null, value: null };
function sessionDue(now = new Date(), settleMs = BAR_SETTLE_MS) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(t)) return null;
  const key = `${Math.floor((t - settleMs) / 60000)}`;
  if (_dueMemo.key === key) return _dueMemo.value;
  const value = lastCompletedRegularSession(new Date(t - settleMs));
  _dueMemo = { key, value };
  return value;
}

// ── Timestamp helpers ───────────────────────────────────────────────────────
function toEpochMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return null;
    return ts < 1e12 ? ts * 1000 : ts;   // epoch seconds vs ms
  }
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

// ── The authoritative freshness verdict ─────────────────────────────────────
// One object every renderer/orchestrator trusts. Inputs:
//   sourceKind    'intraday' | 'daily' | null — what the feed actually is
//   barTimestamp  newest bar's START time (epoch sec/ms or ISO)
//   barIntervalSec bar span (300 for 5-min; ignored for daily)
//   quoteTimestamp optional newest live-quote time
//   delayedByMin  provider-declared delay in minutes (Yahoo exchangeDataDelayedBy)
//   now           evaluation instant (injectable)
function assessFreshness({
  sourceKind = null,
  barTimestamp = null,
  barIntervalSec = 300,
  quoteTimestamp = null,
  delayedByMin = 0,
  now = new Date(),
} = {}) {
  const info = sessionInfoAt(now);
  const nowMs = now instanceof Date ? now.getTime() : toEpochMs(now);
  const barMs = toEpochMs(barTimestamp);
  const quoteMs = toEpochMs(quoteTimestamp);
  const newestMs = [barMs != null ? barMs + (sourceKind === 'intraday' ? barIntervalSec * 1000 : 0) : null, quoteMs]
    .filter(v => v != null)
    .sort((a, b) => b - a)[0] ?? null;

  const ageSeconds = newestMs != null ? Math.max(0, Math.round((nowMs - newestMs) / 1000)) : null;
  const barComplete = barMs != null && sourceKind === 'intraday'
    ? nowMs >= barMs + barIntervalSec * 1000
    : barMs != null;  // a daily bar we can date is treated complete only via barDate checks by callers
  const delayed = Number(delayedByMin) > 0;

  let freshnessState;
  let freshnessReason;
  if (barMs == null && quoteMs == null) {
    freshnessState = FRESHNESS.UNAVAILABLE;
    freshnessReason = 'No bar or quote timestamp available.';
  } else if (sourceKind !== 'intraday') {
    freshnessState = FRESHNESS.DAILY_ONLY;
    freshnessReason = 'Only daily bars available — no intraday feed.';
  } else if (info.marketSession === SESSION.CLOSED) {
    freshnessState = FRESHNESS.CLOSED;
    freshnessReason = info.isHoliday ? 'Market holiday — exchange closed.'
      : info.isWeekend ? 'Weekend — exchange closed.'
      : 'Outside all trading sessions (04:00–20:00 ET).';
  } else {
    // An OPEN session (pre/regular/after) — the age check applies to ALL of
    // them. A stale premarket or after-hours bar must not escape it.
    const maxAge = info.marketSession === SESSION.REGULAR ? MAX_BAR_AGE_REGULAR_SEC : MAX_BAR_AGE_EXTENDED_SEC;
    if (ageSeconds == null || ageSeconds > maxAge) {
      freshnessState = FRESHNESS.STALE;
      freshnessReason = `Newest data is ${ageSeconds == null ? 'undated' : Math.round(ageSeconds / 60) + ' min old'} — over the ${Math.round(maxAge / 60)} min ${info.marketSession} threshold.`;
    } else if (info.marketSession === SESSION.REGULAR) {
      freshnessState = FRESHNESS.LIVE;
      freshnessReason = 'Regular session, data within freshness threshold.';
    } else {
      freshnessState = FRESHNESS.LIVE_EXTENDED;
      freshnessReason = `${info.marketSession === SESSION.PREMARKET ? 'Premarket' : 'After-hours'} tape — provisional, thin-liquidity session.`;
    }
  }

  // Immediately-actionable intraday entries are permitted ONLY on live
  // regular-session data. Extended hours are provisional; closed/stale/daily
  // are context. Delayed feeds are disclosed but do not alone forbid execution.
  const executionAllowed = freshnessState === FRESHNESS.LIVE;

  return Object.freeze({
    marketSession: info.marketSession,
    etDate: info.etDate,
    isTradingDay: info.isTradingDay,
    isHoliday: info.isHoliday,
    isWeekend: info.isWeekend,
    isEarlyClose: info.isEarlyClose,
    dataAsOf: newestMs != null ? new Date(newestMs).toISOString() : null,
    ageSeconds,
    barComplete,
    delayed,
    freshnessState,
    freshnessReason,
    executionAllowed,
    provisional: freshnessState === FRESHNESS.LIVE_EXTENDED,
  });
}

// Legacy marketState vocabulary ('PRE'|'REGULAR'|'POST'|'CLOSED') used across
// the existing payload/UI. Maps the clock session — NOT the last candle.
function legacyMarketState(marketSession) {
  if (marketSession === SESSION.PREMARKET) return 'PRE';
  if (marketSession === SESSION.REGULAR) return 'REGULAR';
  if (marketSession === SESSION.AFTERHOURS) return 'POST';
  return 'CLOSED';
}

module.exports = {
  SESSION, FRESHNESS, FULL_HOLIDAYS, EARLY_CLOSES,
  etParts, sessionInfoAt, lastCompletedRegularSession, sessionDue, BAR_SETTLE_MS,
  assessFreshness, legacyMarketState, toEpochMs,
  MAX_BAR_AGE_REGULAR_SEC, MAX_BAR_AGE_EXTENDED_SEC,
};
