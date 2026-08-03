'use strict';
const test = require('node:test');
const assert = require('node:assert');
const MS = require('../lib/market-session');

// Fixed instants (ET offsets written explicitly; Aug = EDT −04:00, Nov = EST −05:00).
const SAT_NOON = new Date('2026-08-01T12:00:00-04:00');        // Saturday
const SUN_NOON = new Date('2026-08-02T12:00:00-04:00');        // Sunday
const MON_PRE = new Date('2026-08-03T08:00:00-04:00');         // Monday premarket
const MON_RTH = new Date('2026-08-03T10:30:00-04:00');         // Monday regular hours
const MON_POST = new Date('2026-08-03T17:00:00-04:00');        // Monday after-hours
const MON_NIGHT = new Date('2026-08-03T22:00:00-04:00');       // Monday late night
const HOLIDAY = new Date('2026-07-03T11:00:00-04:00');         // observed July-4th holiday
const EARLY_NOONISH = new Date('2026-11-27T12:00:00-05:00');   // early-close day, before 13:00
const EARLY_AFTER = new Date('2026-11-27T14:00:00-05:00');     // early-close day, 14:00 ET
const EARLY_NIGHT = new Date('2026-11-27T18:00:00-05:00');     // early-close day, 18:00 ET

const sec = d => Math.floor(d.getTime() / 1000);

test('sessionInfoAt: Saturday and Sunday are fully closed', () => {
  for (const d of [SAT_NOON, SUN_NOON]) {
    const info = MS.sessionInfoAt(d);
    assert.strictEqual(info.marketSession, 'closed');
    assert.strictEqual(info.isWeekend, true);
    assert.strictEqual(info.isTradingDay, false);
  }
});

test('sessionInfoAt: normal trading day classifies premarket / regular / afterhours / closed', () => {
  assert.strictEqual(MS.sessionInfoAt(MON_PRE).marketSession, 'premarket');
  assert.strictEqual(MS.sessionInfoAt(MON_RTH).marketSession, 'regular');
  assert.strictEqual(MS.sessionInfoAt(MON_POST).marketSession, 'afterhours');
  assert.strictEqual(MS.sessionInfoAt(MON_NIGHT).marketSession, 'closed');
});

test('sessionInfoAt: a market holiday is closed all day', () => {
  const info = MS.sessionInfoAt(HOLIDAY);
  assert.strictEqual(info.marketSession, 'closed');
  assert.strictEqual(info.isHoliday, true);
  assert.strictEqual(info.isTradingDay, false);
});

test('sessionInfoAt: early-close day — regular before 13:00, after-hours 13:00–17:00, closed after', () => {
  const noon = MS.sessionInfoAt(EARLY_NOONISH);
  assert.strictEqual(noon.marketSession, 'regular');
  assert.strictEqual(noon.isEarlyClose, true);
  assert.strictEqual(noon.regularCloseMin, 13 * 60);
  assert.strictEqual(MS.sessionInfoAt(EARLY_AFTER).marketSession, 'afterhours');
  assert.strictEqual(MS.sessionInfoAt(EARLY_NIGHT).marketSession, 'closed');
});

test('assessFreshness: live regular-session data allows execution', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(MON_RTH) - 5 * 60,   // bar started 5 min ago
    now: MON_RTH,
  });
  assert.strictEqual(f.marketSession, 'regular');
  assert.strictEqual(f.freshnessState, 'live');
  assert.strictEqual(f.executionAllowed, true);
  assert.strictEqual(f.provisional, false);
});

test('assessFreshness: stale PREMARKET data cannot escape the age check', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(MON_PRE) - 3 * 60 * 60,   // 3h-old bar (Friday post tape)
    now: MON_PRE,
  });
  assert.strictEqual(f.marketSession, 'premarket');
  assert.strictEqual(f.freshnessState, 'stale');
  assert.strictEqual(f.executionAllowed, false);
});

test('assessFreshness: stale AFTER-HOURS data cannot escape the age check', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(MON_POST) - 2 * 60 * 60,
    now: MON_POST,
  });
  assert.strictEqual(f.marketSession, 'afterhours');
  assert.strictEqual(f.freshnessState, 'stale');
  assert.strictEqual(f.executionAllowed, false);
});

test('assessFreshness: fresh extended-hours bar is provisional, never executable', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(MON_PRE) - 5 * 60,
    now: MON_PRE,
  });
  assert.strictEqual(f.freshnessState, 'live-extended');
  assert.strictEqual(f.provisional, true);
  assert.strictEqual(f.executionAllowed, false);
});

test('assessFreshness: a recent bar on a fully closed day is CLOSED — the clock wins', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(SAT_NOON) - 10 * 60,   // impossibly fresh bar on a Saturday
    now: SAT_NOON,
  });
  assert.strictEqual(f.freshnessState, 'closed');
  assert.strictEqual(f.executionAllowed, false);
});

test('assessFreshness: holiday is closed regardless of bar age', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(HOLIDAY) - 60,
    now: HOLIDAY,
  });
  assert.strictEqual(f.freshnessState, 'closed');
  assert.ok(/holiday/i.test(f.freshnessReason));
});

test('assessFreshness: early-close afternoon (14:00 ET) is after-hours, not regular', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(EARLY_AFTER) - 5 * 60,
    now: EARLY_AFTER,
  });
  assert.strictEqual(f.marketSession, 'afterhours');
  assert.strictEqual(f.executionAllowed, false);
});

test('assessFreshness: a forming (incomplete) bar is flagged barComplete=false', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(MON_RTH) - 2 * 60,   // bar started 2 min ago; 5-min span not elapsed
    barIntervalSec: 300,
    now: MON_RTH,
  });
  assert.strictEqual(f.barComplete, false);
  const done = MS.assessFreshness({
    sourceKind: 'intraday',
    barTimestamp: sec(MON_RTH) - 6 * 60,
    barIntervalSec: 300,
    now: MON_RTH,
  });
  assert.strictEqual(done.barComplete, true);
});

test('assessFreshness: daily-only source never claims intraday freshness', () => {
  const f = MS.assessFreshness({ sourceKind: 'daily', barTimestamp: sec(MON_RTH) - 60, now: MON_RTH });
  assert.strictEqual(f.freshnessState, 'daily-only');
  assert.strictEqual(f.executionAllowed, false);
});

test('assessFreshness: no bar and no quote is unavailable', () => {
  const f = MS.assessFreshness({ sourceKind: 'intraday', now: MON_RTH });
  assert.strictEqual(f.freshnessState, 'unavailable');
  assert.strictEqual(f.executionAllowed, false);
  assert.strictEqual(f.dataAsOf, null);
});

test('assessFreshness: provider-declared delay is disclosed', () => {
  const f = MS.assessFreshness({
    sourceKind: 'intraday', barTimestamp: sec(MON_RTH) - 60, delayedByMin: 15, now: MON_RTH,
  });
  assert.strictEqual(f.delayed, true);
});

test('lastCompletedRegularSession: Saturday resolves to Friday', () => {
  assert.strictEqual(MS.lastCompletedRegularSession(SAT_NOON), '2026-07-31');
});

test('lastCompletedRegularSession: holiday resolves to the prior trading day', () => {
  // 2026-07-03 (Fri) is the observed holiday → last completed regular session is Thu 07-02.
  assert.strictEqual(MS.lastCompletedRegularSession(HOLIDAY), '2026-07-02');
});

test('legacyMarketState maps the session vocabulary', () => {
  assert.strictEqual(MS.legacyMarketState('premarket'), 'PRE');
  assert.strictEqual(MS.legacyMarketState('regular'), 'REGULAR');
  assert.strictEqual(MS.legacyMarketState('afterhours'), 'POST');
  assert.strictEqual(MS.legacyMarketState('closed'), 'CLOSED');
});

test('deterministic — identical inputs give identical output', () => {
  const a = MS.assessFreshness({ sourceKind: 'intraday', barTimestamp: sec(MON_RTH) - 300, now: MON_RTH });
  const b = MS.assessFreshness({ sourceKind: 'intraday', barTimestamp: sec(MON_RTH) - 300, now: MON_RTH });
  assert.deepStrictEqual(a, b);
});

test('assessFreshness result is frozen (immutable record)', () => {
  const f = MS.assessFreshness({ sourceKind: 'intraday', barTimestamp: sec(MON_RTH) - 300, now: MON_RTH });
  assert.ok(Object.isFrozen(f));
  assert.throws(() => { 'use strict'; f.executionAllowed = true; });
});
