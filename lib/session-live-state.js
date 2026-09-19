'use strict';
// SESSION LIVE STATE — where does a candidate sit RIGHT NOW relative to its own plan?
//
// One vocabulary for every horizon and every source:
//   not-triggered · in-zone · triggered · extended · stopped · target-hit · unknown
//
// Three pure functions, no I/O, no clock of their own (every caller passes `now`):
//   sessionPriceOf(quote, session)  — the price that is RELEVANT for the phase, with its basis
//   liveStatus({ row, quote, bars, session, now })  — status vs the row's entry/stop/target,
//                                     plus VWAP / opening range / relative volume context
//   lifecycleToStatus(daytradeRow)   — the day-trade opportunity-lifecycle state → same vocabulary
//
// Rules that are deliberate (and pinned by test/session-live-state.test.js):
//   • Direction-aware. A short's entry sits BELOW its stop and ABOVE its target; every
//     comparison is mirrored through `dir` (+1 long, −1 short) instead of duplicated.
//   • R = |entry − stop|. Within ±0.5R of entry (and not through the stop) = in-zone. Past
//     entry by ≤ 1R = triggered; past entry by > 1R = extended (the chase zone — the same
//     EXTENDED_R the decision engine's lifecycleState uses).
//   • An extended-hours print is NOT a fill. Stops and targets execute in regular hours only,
//     so for swing/position/portfolio rows a premarket or after-hours price can report
//     in-zone / triggered / extended / not-triggered but is CAPPED away from 'stopped' and
//     'target-hit'. Intraday rows use the regular-session price only — outside regular hours
//     they have no live status.
//   • A forming bar is never evidence. VWAP and the opening range are computed from
//     COMPLETED regular-session bars only (lib/intraday-features primitives, reused).
//   • Missing inputs produce null / 'unknown' with a note — never a fabricated number.

const IF = require('./intraday-features');
const { SESSION } = require('./market-session');
const { STATES: LIFECYCLE, REASON } = require('./opportunity-lifecycle');

const STATUS = Object.freeze({
  NOT_TRIGGERED: 'not-triggered',
  IN_ZONE: 'in-zone',
  TRIGGERED: 'triggered',
  EXTENDED: 'extended',
  STOPPED: 'stopped',
  TARGET_HIT: 'target-hit',
  UNKNOWN: 'unknown',
});
const STATUS_VALUES = Object.freeze(Object.values(STATUS));

// Fraction of R around the entry that still counts as "in the zone".
const IN_ZONE_R = 0.5;
// Beyond the entry by more than this many R the setup has been chased.
const EXTENDED_R = 1.0;
// Opening range window and the ET minute it is complete.
const ORB_MINUTES = 30;
const ORB_COMPLETE_MIN = IF.OPEN_MIN + ORB_MINUTES; // 10:00 ET
// Fills only print here.
const FILL_SESSIONS = new Set([SESSION.REGULAR]);
// Statuses an extended-hours print may never assert.
const FILL_ONLY_STATUSES = new Set([STATUS.STOPPED, STATUS.TARGET_HIT]);

const num = (v) => (Number.isFinite(v) && v > 0 ? +v : null);
const finite = (v) => Number.isFinite(v);
const pct = (from, to) => (finite(from) && finite(to) && from > 0 ? +(((to - from) / from) * 100).toFixed(2) : null);
const round2 = (v) => (finite(v) ? +v.toFixed(2) : null);

// Accept either a market-session descriptor ({ marketSession }) or the bare phase string.
function phaseOf(session) {
  if (!session) return null;
  const s = typeof session === 'string' ? session : session.marketSession;
  return Object.values(SESSION).includes(s) ? s : null;
}

// ── sessionPriceOf ───────────────────────────────────────────────────────────
// The price that describes the name in THIS phase. Yahoo's regularMarketPrice is the last
// regular-session print (yesterday's close before the open), so premarket and after-hours
// need their own fields — absent those, fall back to the regular price and SAY so via basis.
function sessionPriceOf(quote, session) {
  const q = quote || {};
  const phase = phaseOf(session);
  const regular = num(q.price);
  const prevClose = num(q.prevClose);
  const asOfOf = (t) => (t ? t : (q.asOf || null));

  if (phase === SESSION.PREMARKET) {
    const p = num(q.preMarketPrice);
    if (p != null) return { price: p, basis: 'premarket', asOf: asOfOf(q.preMarketTime) };
    // No premarket print: the last regular price IS the prior close — label it as such.
    const fallback = regular ?? prevClose;
    return { price: fallback, basis: fallback != null ? 'close' : null, asOf: q.asOf || null };
  }
  if (phase === SESSION.REGULAR) {
    return { price: regular, basis: regular != null ? 'regular' : null, asOf: q.asOf || null };
  }
  if (phase === SESSION.AFTERHOURS) {
    const p = num(q.postMarketPrice);
    if (p != null) return { price: p, basis: 'afterhours', asOf: asOfOf(q.postMarketTime) };
    return { price: regular, basis: regular != null ? 'close' : null, asOf: q.asOf || null };
  }
  // closed / unknown phase: the regular price is the close; prevClose is the only alternative.
  const p = regular ?? prevClose;
  return { price: p, basis: p != null ? 'close' : null, asOf: q.asOf || null };
}

// ── Status vs levels ─────────────────────────────────────────────────────────
// Pure geometry: given a price and a plan, where is it? `dir` mirrors shorts onto longs so
// the six comparisons are written once. Returns null when levels are unusable.
function statusVsLevels({ price, entry, stop, target, side }) {
  const p = num(price), e = num(entry), s = num(stop), t = num(target);
  if (p == null || e == null || s == null) return null;
  const dir = side === 'short' ? -1 : 1;
  const risk = Math.abs(e - s);
  if (!(risk > 0)) return null;
  // Signed distance in the trade direction (positive = price has moved the way the trade wants).
  const fromEntry = (p - e) * dir;
  const throughStop = (s - p) * dir >= 0;          // at/through the stop
  const throughTarget = t != null && (p - t) * dir >= 0;
  if (throughStop) return STATUS.STOPPED;
  if (throughTarget) return STATUS.TARGET_HIT;
  if (fromEntry > EXTENDED_R * risk) return STATUS.EXTENDED;
  if (Math.abs(fromEntry) <= IN_ZONE_R * risk) return STATUS.IN_ZONE;
  if (fromEntry > 0) return STATUS.TRIGGERED;
  return STATUS.NOT_TRIGGERED;
}

// ── Intraday context from completed bars ─────────────────────────────────────
function vwapOf(completed, price) {
  if (!completed.length) return null;
  const value = IF.vwap(completed);
  if (!finite(value)) return null;
  return { value: round2(value), above: finite(price) ? price > value : null };
}

function orbOf(completed, price, now) {
  if (!completed.length) return null;
  const or = IF.openingRange(completed, ORB_MINUTES);
  if (!or) return null;
  const nowMin = now ? IF.etMinutes(now) : null;
  // Forming until 10:00 ET has passed AND the whole window is present (6 five-minute bars).
  const complete = nowMin != null && nowMin >= ORB_COMPLETE_MIN && or.bars >= ORB_MINUTES / IF.DEFAULT_BAR_INTERVAL_MIN;
  let state = 'forming';
  if (complete) {
    if (!finite(price)) state = 'inside';
    else if (price > or.high) state = 'above';
    else if (price < or.low) state = 'below';
    else state = 'inside';
  }
  return { high: round2(or.high), low: round2(or.low), state };
}

// Relative volume for the phase. Regular hours: pace-adjusted against prior sessions'
// same-minute cumulative volume when prior sessions are supplied (the honest curve), else raw
// day/avg and labelled. Premarket: premarket volume vs the FULL-DAY average — a different
// denominator, so it is labelled and never compared to the regular-hours figure.
function relVolOf({ quote, bars, phase, now }) {
  const q = quote || {};
  const avg = num(q.avgVolume);
  if (phase === SESSION.PREMARKET) {
    const pv = num(q.preMarketVolume);
    if (pv == null || avg == null) return null;
    return { value: +(pv / avg).toFixed(2), basis: 'premarket volume vs full-day avg' };
  }
  if (phase !== SESSION.REGULAR) return null;
  const completed = (bars && Array.isArray(bars.completed)) ? bars.completed : [];
  const priors = (bars && Array.isArray(bars.priorSessions)) ? bars.priorSessions.filter(s => Array.isArray(s) && s.length) : [];
  if (completed.length && priors.length) {
    const last = completed[completed.length - 1];
    const uptoMin = IF.minutesSinceOpen(last.t);
    const v = IF.timeOfDayRelVol(completed, priors, uptoMin);
    if (finite(v)) return { value: v, basis: 'same-time-of-day vs prior sessions' };
  }
  const dv = num(q.dayVolume);
  if (dv == null || avg == null) return null;
  return { value: +(dv / avg).toFixed(2), basis: 'day volume vs 3-month avg (not pace-adjusted)' };
}

// ── liveStatus ───────────────────────────────────────────────────────────────
function liveStatus({ row, quote, bars, session, now } = {}) {
  const r = row || {};
  const q = quote || {};
  const phase = phaseOf(session);
  const notes = [];
  const side = r.side === 'short' ? 'short' : 'long';
  const horizon = r.horizon || 'swing';
  const isIntraday = horizon === 'intraday';

  // Price for the phase. Intraday rows only live in regular hours.
  let sp = sessionPriceOf(q, phase);
  if (isIntraday && phase !== SESSION.REGULAR) {
    sp = { price: null, basis: null, asOf: null };
    notes.push('intraday setup: no live status outside regular hours');
  }
  const price = sp.price;

  const completed = (bars && Array.isArray(bars.completed) && phase === SESSION.REGULAR) ? bars.completed : [];
  const vwap = phase === SESSION.REGULAR ? vwapOf(completed, price) : null;
  const orb = phase === SESSION.REGULAR ? orbOf(completed, price, now) : null;
  const rv = relVolOf({ quote: q, bars, phase, now });
  const dayRangePct = (num(q.dayHigh) != null && num(q.dayLow) != null && num(q.prevClose) != null)
    ? +(((q.dayHigh - q.dayLow) / q.prevClose) * 100).toFixed(2) : null;

  let status = statusVsLevels({ price, entry: r.entry, stop: r.stop, target: r.target, side });
  if (status == null) {
    status = STATUS.UNKNOWN;
    if (price == null) notes.push('no price for this session phase');
    else notes.push('plan is missing entry or stop');
  } else if (!FILL_SESSIONS.has(phase) && FILL_ONLY_STATUSES.has(status)) {
    // Extended-hours print through a stop or target: report the geometry, not a fill.
    status = status === STATUS.STOPPED ? STATUS.NOT_TRIGGERED : STATUS.EXTENDED;
    notes.push('extended-hours print; not a fill');
  } else if (phase != null && !FILL_SESSIONS.has(phase) && sp.basis && sp.basis !== 'regular') {
    notes.push(`${sp.basis} print`);
  }

  return {
    status,
    price,
    priceBasis: sp.basis,
    priceAsOf: sp.asOf,
    pct: {
      toEntry: pct(price, num(r.entry)),
      toStop: pct(price, num(r.stop)),
      toTarget: pct(price, num(r.target)),
    },
    vwap,
    orb,
    relVol: rv ? rv.value : null,
    relVolBasis: rv ? rv.basis : null,
    dayRangePct,
    note: notes.length ? notes.join('; ') : null,
  };
}

// ── lifecycleToStatus ────────────────────────────────────────────────────────
// Every opportunity-lifecycle state maps explicitly; the test asserts the table covers the
// enum so a new lifecycle state cannot silently fall through to 'unknown'.
const LIFECYCLE_TO_STATUS = Object.freeze({
  [LIFECYCLE.PRIOR_SESSION_WATCH]: STATUS.NOT_TRIGGERED,
  [LIFECYCLE.WATCHING]: STATUS.NOT_TRIGGERED,
  [LIFECYCLE.BUILDING]: STATUS.NOT_TRIGGERED,
  [LIFECYCLE.OPENING_RANGE_FORMING]: STATUS.NOT_TRIGGERED,
  [LIFECYCLE.ARMED]: STATUS.IN_ZONE,
  [LIFECYCLE.ACTIONABLE_NOW]: STATUS.IN_ZONE,
  [LIFECYCLE.REVERSAL_RECLAIM]: STATUS.IN_ZONE,
  [LIFECYCLE.MANAGING]: STATUS.TRIGGERED,
  [LIFECYCLE.TOO_EXTENDED]: STATUS.EXTENDED,
  [LIFECYCLE.STALLING]: STATUS.EXTENDED,
  [LIFECYCLE.FAILED]: STATUS.STOPPED,
  [LIFECYCLE.TARGET_REACHED]: STATUS.TARGET_HIT,
  // CLOSED is post-entry and outcome-ambiguous: the closing transition's reason code decides
  // (CLOSED_TARGET / CLOSED_STOP / CLOSED_TIME) — see lifecycleToStatus. This is the default.
  [LIFECYCLE.CLOSED]: STATUS.UNKNOWN,
  [LIFECYCLE.EXPIRED]: STATUS.UNKNOWN,
});

const CLOSED_REASON_TO_STATUS = Object.freeze({
  [REASON.CLOSED_TARGET]: STATUS.TARGET_HIT,
  [REASON.CLOSED_STOP]: STATUS.STOPPED,
  [REASON.CLOSED_TIME]: STATUS.UNKNOWN,
});

function lifecycleToStatus(daytradeRow) {
  const isRecord = daytradeRow && typeof daytradeRow === 'object';
  const state = isRecord ? daytradeRow.state : daytradeRow;
  if (typeof state !== 'string') return STATUS.UNKNOWN;
  if (state === LIFECYCLE.CLOSED && isRecord) {
    const history = Array.isArray(daytradeRow.history) ? daytradeRow.history : [];
    const last = history.length ? history[history.length - 1] : null;
    const code = last && last.to === LIFECYCLE.CLOSED ? last.reasonCode : null;
    if (code && CLOSED_REASON_TO_STATUS[code]) return CLOSED_REASON_TO_STATUS[code];
  }
  return LIFECYCLE_TO_STATUS[state] || STATUS.UNKNOWN;
}

module.exports = {
  STATUS, STATUS_VALUES, IN_ZONE_R, EXTENDED_R, ORB_MINUTES, LIFECYCLE_TO_STATUS, CLOSED_REASON_TO_STATUS,
  sessionPriceOf, statusVsLevels, liveStatus, lifecycleToStatus,
};
