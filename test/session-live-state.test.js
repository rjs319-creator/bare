'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const SLS = require('../lib/session-live-state');
const { STATES: LIFECYCLE, REASON } = require('../lib/opportunity-lifecycle');
const { SESSION } = require('../lib/market-session');

const { STATUS } = SLS;

// 2026-09-18 is a Friday (regular session). 13:30Z = 09:30 ET during EDT.
const T = (hhmmZ) => `2026-09-18T${hhmmZ}:00.000Z`;
const bar = (hhmmZ, o, h, l, c, v) => ({ t: T(hhmmZ), o, h, l, c, v });

// Six completed opening-range bars 09:30-09:55 ET, then two more.
const RTH_BARS = [
  bar('13:30', 10.0, 10.4, 9.9, 10.2, 1000),
  bar('13:35', 10.2, 10.5, 10.1, 10.3, 800),
  bar('13:40', 10.3, 10.6, 10.2, 10.5, 900),
  bar('13:45', 10.5, 10.7, 10.4, 10.6, 700),
  bar('13:50', 10.6, 10.8, 10.5, 10.7, 600),
  bar('13:55', 10.7, 10.9, 10.6, 10.8, 500),
  bar('14:00', 10.8, 11.0, 10.7, 10.9, 400),
  bar('14:05', 10.9, 11.1, 10.8, 11.0, 300),
];

const longRow = { ticker: 'AAA', side: 'long', horizon: 'swing', entry: 100, stop: 90, target: 130 };
const shortRow = { ticker: 'BBB', side: 'short', horizon: 'swing', entry: 100, stop: 110, target: 70 };
const regular = { marketSession: SESSION.REGULAR };

const statusAt = (row, price, session = regular) =>
  SLS.liveStatus({ row, quote: { price, prevClose: 95, avgVolume: 1e6 }, session, now: T('15:00') }).status;

test('long: every status from price vs levels (R = 10)', () => {
  assert.equal(statusAt(longRow, 92), STATUS.NOT_TRIGGERED);      // below the zone, above the stop
  assert.equal(statusAt(longRow, 96), STATUS.IN_ZONE);            // within 0.5R below
  assert.equal(statusAt(longRow, 104), STATUS.IN_ZONE);           // within 0.5R above
  assert.equal(statusAt(longRow, 108), STATUS.TRIGGERED);         // past entry, ≤ 1R
  assert.equal(statusAt(longRow, 110), STATUS.TRIGGERED);         // exactly 1R is not extended
  assert.equal(statusAt(longRow, 111), STATUS.EXTENDED);          // > 1R past entry
  assert.equal(statusAt(longRow, 90), STATUS.STOPPED);            // at the stop
  assert.equal(statusAt(longRow, 85), STATUS.STOPPED);            // through the stop
  assert.equal(statusAt(longRow, 130), STATUS.TARGET_HIT);
  assert.equal(statusAt(longRow, 140), STATUS.TARGET_HIT);
});

test('short: mirrored (entry 100 < stop 110, target 70)', () => {
  assert.equal(statusAt(shortRow, 108), STATUS.NOT_TRIGGERED);    // not through stop, > 0.5R above entry
  assert.equal(statusAt(shortRow, 104), STATUS.IN_ZONE);
  assert.equal(statusAt(shortRow, 96), STATUS.IN_ZONE);
  assert.equal(statusAt(shortRow, 92), STATUS.TRIGGERED);
  assert.equal(statusAt(shortRow, 89), STATUS.EXTENDED);
  assert.equal(statusAt(shortRow, 110), STATUS.STOPPED);
  assert.equal(statusAt(shortRow, 115), STATUS.STOPPED);
  assert.equal(statusAt(shortRow, 70), STATUS.TARGET_HIT);
  assert.equal(statusAt(shortRow, 60), STATUS.TARGET_HIT);
});

test('short at 120 is stopped, not not-triggered (mirror sanity)', () => {
  assert.equal(statusAt(shortRow, 120), STATUS.STOPPED);
});

test('stop wins over target when a plan is degenerate', () => {
  // A long whose stop sits above the target: through-stop is checked first.
  const weird = { side: 'long', entry: 100, stop: 90, target: 85 };
  assert.equal(statusAt(weird, 80), STATUS.STOPPED);
});

test('extended-hours print never reports a fill for swing rows', () => {
  const pre = { marketSession: SESSION.PREMARKET };
  const post = { marketSession: SESSION.AFTERHOURS };
  const throughStop = SLS.liveStatus({ row: longRow, quote: { price: 95, preMarketPrice: 85 }, session: pre, now: T('12:00') });
  assert.equal(throughStop.status, STATUS.NOT_TRIGGERED);
  assert.match(throughStop.note, /extended-hours print; not a fill/);
  assert.equal(throughStop.priceBasis, 'premarket');
  const throughTarget = SLS.liveStatus({ row: longRow, quote: { price: 95, postMarketPrice: 135 }, session: post, now: T('21:00') });
  assert.equal(throughTarget.status, STATUS.EXTENDED);
  assert.match(throughTarget.note, /not a fill/);
  // A premarket print inside the zone reports normally, with its basis noted.
  const inZone = SLS.liveStatus({ row: longRow, quote: { price: 95, preMarketPrice: 101 }, session: pre, now: T('12:00') });
  assert.equal(inZone.status, STATUS.IN_ZONE);
  assert.match(inZone.note, /premarket print/);
});

test('intraday rows have no live status outside regular hours', () => {
  const row = { ...longRow, horizon: 'intraday' };
  const r = SLS.liveStatus({ row, quote: { price: 105, preMarketPrice: 104 }, session: { marketSession: SESSION.PREMARKET }, now: T('12:00') });
  assert.equal(r.status, STATUS.UNKNOWN);
  assert.equal(r.price, null);
  assert.match(r.note, /outside regular hours/);
  const live = SLS.liveStatus({ row, quote: { price: 108 }, session: regular, now: T('15:00') });
  assert.equal(live.status, STATUS.TRIGGERED);
});

test('pct distances are signed from the current price; null when a level is missing', () => {
  const r = SLS.liveStatus({ row: longRow, quote: { price: 100 }, session: regular, now: T('15:00') });
  assert.equal(r.pct.toEntry, 0);
  assert.equal(r.pct.toStop, -10);
  assert.equal(r.pct.toTarget, 30);
  const noTarget = SLS.liveStatus({ row: { ...longRow, target: null }, quote: { price: 100 }, session: regular, now: T('15:00') });
  assert.equal(noTarget.pct.toTarget, null);
  assert.equal(noTarget.status, STATUS.IN_ZONE);
});

test('missing plan or price → unknown with a note, never a throw', () => {
  const noLevels = SLS.liveStatus({ row: { ticker: 'X', side: 'long' }, quote: { price: 10 }, session: regular, now: T('15:00') });
  assert.equal(noLevels.status, STATUS.UNKNOWN);
  assert.match(noLevels.note, /missing entry or stop/);
  const noPrice = SLS.liveStatus({ row: longRow, quote: {}, session: regular, now: T('15:00') });
  assert.equal(noPrice.status, STATUS.UNKNOWN);
  assert.match(noPrice.note, /no price/);
  assert.equal(noPrice.pct.toEntry, null);
  assert.equal(noPrice.vwap, null);
  assert.equal(noPrice.orb, null);
  assert.equal(noPrice.relVol, null);
  assert.equal(noPrice.dayRangePct, null);
  // No arguments at all.
  assert.equal(SLS.liveStatus().status, STATUS.UNKNOWN);
  // Unknown phase: the regular price is treated as the close — geometry still reports,
  // but a through-stop/target print is not a fill.
  assert.equal(SLS.liveStatus({ row: longRow, quote: { price: 108 }, session: null }).status, STATUS.TRIGGERED);
  assert.equal(SLS.liveStatus({ row: longRow, quote: { price: 85 }, session: null }).status, STATUS.NOT_TRIGGERED);
});

test('VWAP and opening range come from completed regular-session bars only', () => {
  const row = { ...longRow, horizon: 'intraday', entry: 10.5, stop: 10.0, target: 12 };
  const bars = { completed: RTH_BARS, forming: [bar('14:10', 11.0, 12.0, 10.9, 11.9, 9999)] };
  const r = SLS.liveStatus({ row, quote: { price: 11.05, prevClose: 10, dayHigh: 11.1, dayLow: 9.9, avgVolume: 1e6, dayVolume: 5e5 }, bars, session: regular, now: T('14:12') });
  // VWAP over the eight completed bars — the forming 12.0 spike must not move it.
  const tp = RTH_BARS.map(b => ((b.h + b.l + b.c) / 3) * b.v).reduce((a, b) => a + b, 0);
  const vol = RTH_BARS.reduce((a, b) => a + b.v, 0);
  assert.equal(r.vwap.value, +(tp / vol).toFixed(2));
  assert.equal(r.vwap.above, true);
  // ORB = first 30 minutes (six bars 09:30-09:55): high 10.9, low 9.9; now 10:12 ET → complete.
  assert.deepEqual(r.orb, { high: 10.9, low: 9.9, state: 'above' });
  assert.equal(r.dayRangePct, 12);
  assert.equal(r.status, STATUS.EXTENDED); // 11.05 is > 1R (0.5) past 10.5
});

test('opening range is forming before 10:00 ET or with too few bars', () => {
  const row = { ...longRow, horizon: 'intraday', entry: 10.5, stop: 10.0, target: 12 };
  const early = SLS.liveStatus({ row, quote: { price: 10.4 }, bars: { completed: RTH_BARS.slice(0, 3) }, session: regular, now: T('13:47') });
  assert.equal(early.orb.state, 'forming');
  assert.equal(early.orb.high, 10.6);
  const inside = SLS.liveStatus({ row, quote: { price: 10.4 }, bars: { completed: RTH_BARS }, session: regular, now: T('14:12') });
  assert.equal(inside.orb.state, 'inside');
  const below = SLS.liveStatus({ row, quote: { price: 9.5 }, bars: { completed: RTH_BARS }, session: regular, now: T('14:12') });
  assert.equal(below.orb.state, 'below');
});

test('VWAP and ORB are null outside regular hours even when bars are supplied', () => {
  const r = SLS.liveStatus({ row: longRow, quote: { price: 100 }, bars: { completed: RTH_BARS }, session: { marketSession: SESSION.AFTERHOURS }, now: T('21:00') });
  assert.equal(r.vwap, null);
  assert.equal(r.orb, null);
});

test('relative volume: premarket vs full-day avg, regular pace-adjusted when priors exist, else raw and labelled', () => {
  const pre = SLS.liveStatus({ row: longRow, quote: { price: 100, preMarketPrice: 101, preMarketVolume: 250000, avgVolume: 1e6 }, session: { marketSession: SESSION.PREMARKET }, now: T('12:00') });
  assert.equal(pre.relVol, 0.25);
  assert.match(pre.relVolBasis, /full-day avg/);
  const raw = SLS.liveStatus({ row: longRow, quote: { price: 100, dayVolume: 3e6, avgVolume: 1e6 }, session: regular, now: T('15:00') });
  assert.equal(raw.relVol, 3);
  assert.match(raw.relVolBasis, /not pace-adjusted/);
  // Prior sessions with identical bars → same-time-of-day relVol of exactly 1.
  const bars = { completed: RTH_BARS, priorSessions: [RTH_BARS, RTH_BARS] };
  const paced = SLS.liveStatus({ row: longRow, quote: { price: 100, dayVolume: 3e6, avgVolume: 1e6 }, bars, session: regular, now: T('14:12') });
  assert.equal(paced.relVol, 1);
  assert.match(paced.relVolBasis, /same-time-of-day/);
  const closed = SLS.liveStatus({ row: longRow, quote: { price: 100, dayVolume: 3e6, avgVolume: 1e6 }, session: { marketSession: SESSION.CLOSED }, now: T('23:00') });
  assert.equal(closed.relVol, null);
});

test('sessionPriceOf picks the phase price and labels its basis', () => {
  const q = { price: 100, prevClose: 98, preMarketPrice: 103, postMarketPrice: 97, asOf: 'A', preMarketTime: 'P', postMarketTime: 'Q' };
  assert.deepEqual(SLS.sessionPriceOf(q, SESSION.PREMARKET), { price: 103, basis: 'premarket', asOf: 'P' });
  assert.deepEqual(SLS.sessionPriceOf(q, { marketSession: SESSION.REGULAR }), { price: 100, basis: 'regular', asOf: 'A' });
  assert.deepEqual(SLS.sessionPriceOf(q, SESSION.AFTERHOURS), { price: 97, basis: 'afterhours', asOf: 'Q' });
  assert.deepEqual(SLS.sessionPriceOf(q, SESSION.CLOSED), { price: 100, basis: 'close', asOf: 'A' });
  // No extended-hours print: fall back to the regular price, honestly labelled as the close.
  assert.deepEqual(SLS.sessionPriceOf({ price: 100, asOf: 'A' }, SESSION.PREMARKET), { price: 100, basis: 'close', asOf: 'A' });
  assert.deepEqual(SLS.sessionPriceOf({ prevClose: 98 }, SESSION.CLOSED), { price: 98, basis: 'close', asOf: null });
  assert.deepEqual(SLS.sessionPriceOf(null, 'nonsense'), { price: null, basis: null, asOf: null });
  assert.deepEqual(SLS.sessionPriceOf({ price: 0 }, SESSION.REGULAR), { price: null, basis: null, asOf: null });
});

test('lifecycleToStatus covers every opportunity-lifecycle state', () => {
  for (const state of Object.values(LIFECYCLE)) {
    assert.ok(Object.prototype.hasOwnProperty.call(SLS.LIFECYCLE_TO_STATUS, state), `unmapped lifecycle state ${state}`);
    assert.ok(SLS.STATUS_VALUES.includes(SLS.lifecycleToStatus({ state })), `bad status for ${state}`);
  }
  assert.equal(Object.keys(SLS.LIFECYCLE_TO_STATUS).length, Object.values(LIFECYCLE).length);
  assert.equal(SLS.lifecycleToStatus({ state: LIFECYCLE.WATCHING }), STATUS.NOT_TRIGGERED);
  assert.equal(SLS.lifecycleToStatus({ state: LIFECYCLE.ACTIONABLE_NOW }), STATUS.IN_ZONE);
  assert.equal(SLS.lifecycleToStatus({ state: LIFECYCLE.MANAGING }), STATUS.TRIGGERED);
  assert.equal(SLS.lifecycleToStatus({ state: LIFECYCLE.TOO_EXTENDED }), STATUS.EXTENDED);
  assert.equal(SLS.lifecycleToStatus({ state: LIFECYCLE.FAILED }), STATUS.STOPPED);
  assert.equal(SLS.lifecycleToStatus({ state: LIFECYCLE.TARGET_REACHED }), STATUS.TARGET_HIT);
  assert.equal(SLS.lifecycleToStatus({ state: LIFECYCLE.EXPIRED }), STATUS.UNKNOWN);
  assert.equal(SLS.lifecycleToStatus(LIFECYCLE.ARMED), STATUS.IN_ZONE);       // bare string accepted
  assert.equal(SLS.lifecycleToStatus({ state: 'NOT_A_STATE' }), STATUS.UNKNOWN);
  assert.equal(SLS.lifecycleToStatus(null), STATUS.UNKNOWN);
});

test('CLOSED resolves through the closing transition reason code', () => {
  const closed = (reasonCode) => ({ state: LIFECYCLE.CLOSED, history: [{ from: LIFECYCLE.MANAGING, to: LIFECYCLE.CLOSED, reasonCode }] });
  assert.equal(SLS.lifecycleToStatus(closed(REASON.CLOSED_TARGET)), STATUS.TARGET_HIT);
  assert.equal(SLS.lifecycleToStatus(closed(REASON.CLOSED_STOP)), STATUS.STOPPED);
  assert.equal(SLS.lifecycleToStatus(closed(REASON.CLOSED_TIME)), STATUS.UNKNOWN);
  assert.equal(SLS.lifecycleToStatus({ state: LIFECYCLE.CLOSED }), STATUS.UNKNOWN);
});

test('inputs are never mutated', () => {
  const row = { ...longRow };
  const quote = { price: 105, dayHigh: 106, dayLow: 99, prevClose: 100 };
  const bars = { completed: RTH_BARS.map(b => ({ ...b })) };
  const snapRow = JSON.stringify(row), snapQuote = JSON.stringify(quote), snapBars = JSON.stringify(bars);
  SLS.liveStatus({ row, quote, bars, session: regular, now: T('15:00') });
  assert.equal(JSON.stringify(row), snapRow);
  assert.equal(JSON.stringify(quote), snapQuote);
  assert.equal(JSON.stringify(bars), snapBars);
});
