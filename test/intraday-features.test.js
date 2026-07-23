'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  vwap, openingRange, closesBelowVwapStreak, timeOfDayRelVol, upto, buildIntradayFeatures, minutesSinceOpen,
} = require('../lib/intraday-features');
const { intradayEv } = require('../lib/lifecycle-eval');
const { advanceLifecycle, STATES } = require('../lib/opportunity-lifecycle');

// July → EDT (UTC-4). A bar at ET HH:MM is UTC (HH+4):MM.
function bar(etHHMM, o, h, l, c, v) {
  const [H, M] = etHHMM.split(':').map(Number);
  const t = `2026-07-08T${String(H + 4).padStart(2, '0')}:${String(M).padStart(2, '0')}:00.000Z`;
  return { t, o, h, l, c, v };
}
// A rising session: OR 09:30–09:55 trades 100–101, then breaks out and trends to 103 by 10:30.
function risingToday() {
  return [
    bar('09:30', 100, 100.6, 99.9, 100.4, 2000), bar('09:35', 100.4, 100.9, 100.2, 100.7, 2000),
    bar('09:40', 100.7, 101.0, 100.5, 100.8, 2000), bar('09:45', 100.8, 101.0, 100.6, 100.9, 2000),
    bar('09:50', 100.9, 101.0, 100.7, 100.95, 2000), bar('09:55', 100.95, 101.0, 100.8, 101.0, 2000),
    bar('10:00', 101.0, 101.6, 101.0, 101.5, 2200), bar('10:05', 101.5, 102.0, 101.4, 101.9, 2400),
    bar('10:10', 101.9, 102.3, 101.8, 102.2, 2400), bar('10:15', 102.2, 102.6, 102.1, 102.5, 2600),
    bar('10:20', 102.5, 102.9, 102.4, 102.8, 2600), bar('10:25', 102.8, 103.1, 102.7, 103.0, 2800),
    bar('10:30', 103.0, 103.2, 102.9, 103.0, 2800),
  ];
}
const priorFlat = () => risingToday().map(b => ({ ...b, v: b.v / 2 }));   // same times/prices, exactly half the volume
const NOW = '2026-07-08T14:30:00Z';   // 10:30 ET

test('vwap: volume-weighted typical price', () => {
  const bars = [{ h: 10, l: 10, c: 10, v: 100 }, { h: 20, l: 20, c: 20, v: 300 }];
  assert.equal(vwap(bars), 17.5);   // (10*100 + 20*300)/400
  assert.equal(vwap([]), null);
});

test('minutesSinceOpen: 09:35 ET is 5 minutes into the session', () => {
  assert.equal(minutesSinceOpen('2026-07-08T13:35:00Z'), 5);
});

test('openingRange: high/low/mid over the first 30 minutes only', () => {
  const or = openingRange(risingToday(), 30);
  assert.equal(or.high, 101.0);
  assert.equal(or.low, 99.9);
  assert.equal(or.bars, 6);         // 09:30..09:55
});

test('point-in-time: buildIntradayFeatures never uses bars after `now`', () => {
  const bars = risingToday();                       // runs to 10:30
  const f = buildIntradayFeatures({ todayBars: bars, now: '2026-07-08T14:00:00Z' });   // now = 10:00
  assert.equal(f.last, 101.5);                      // the 10:00 bar, NOT the 10:30 bar
  assert.ok(f.bars <= 7, `only bars up to 10:00 (${f.bars})`);
  assert.equal(upto(bars, '2026-07-08T14:00:00Z').length, 7);
});

test('triggerConfirmed once the opening range is complete and price breaks above it', () => {
  const f = buildIntradayFeatures({ todayBars: risingToday(), now: NOW, dailyAtr: 3, plan: { entry: 101, stop: 100, target: 110 } });
  assert.equal(f.orComplete, true);
  assert.equal(f.triggerConfirmed, true);           // last 103 > orHigh 101
  assert.equal(f.breakoutFailed, false);
  assert.equal(f.aboveVwap, true);
  assert.ok(f.remainingRR >= 1, `remaining R:R ${f.remainingRR}`);
  assert.ok(f.extensionAtr != null);
});

test('breakoutFailed: broke above the OR high, then closed back below the OR midpoint', () => {
  const bars = risingToday().slice(0, 8);
  bars.push(bar('10:10', 101.9, 102.5, 100.0, 100.2, 3000));   // spikes above OR high, closes below OR mid (~100.45)
  const f = buildIntradayFeatures({ todayBars: bars, now: '2026-07-08T14:10:00Z' });
  assert.equal(f.breakoutFailed, true);
});

test('timeOfDayRelVol: today vs the average prior-session cumulative volume at this time', () => {
  const rv = timeOfDayRelVol(risingToday(), [priorFlat()], 60);
  assert.equal(rv, 2);   // today cum ≈ 2× the prior session at 60 min in
  assert.equal(timeOfDayRelVol(risingToday(), [], 60), null);   // no prior session → unavailable
});

test('closesBelowVwapStreak: counts consecutive tail closes below the running VWAP', () => {
  const bars = risingToday().slice(0, 6);   // rising, all above/at vwap early
  bars.push(bar('10:00', 101, 101, 98.5, 98.6, 2000));   // dumps below vwap
  bars.push(bar('10:05', 98.6, 98.8, 98.0, 98.2, 2000)); // second close below vwap
  assert.ok(closesBelowVwapStreak(bars) >= 2);
});

// ── intraday `ev` → lifecycle integration ────────────────────────────────────
test('a fully-green intraday feature set drives the lifecycle to ACTIONABLE_NOW', () => {
  const f = buildIntradayFeatures({ todayBars: risingToday(), priorSessions: [priorFlat()], spyTodayBars: priorFlat(), now: NOW, dailyAtr: 3, plan: { entry: 101, stop: 100, target: 110 } });
  const ev = intradayEv({ ticker: 'ABC', candidateDate: '2026-07-08' }, f, { now: NOW });
  assert.equal(ev.aboveVwap, true);
  assert.equal(ev.triggerConfirmed, true);
  assert.equal(ev.relVolOk, true);
  assert.equal(ev.freshness.freshnessStatus, 'FRESH_TODAY');   // intraday bars ⇒ current-session fresh
  const rec = advanceLifecycle(null, { strategy: 'daytrade', ...ev });
  assert.equal(rec.state, STATES.ACTIONABLE_NOW);
});

test('an intraday breakout failure drives the lifecycle to FAILED', () => {
  const bars = risingToday().slice(0, 8);
  bars.push(bar('10:10', 101.9, 102.5, 100.0, 100.2, 3000));   // failed breakout
  const f = buildIntradayFeatures({ todayBars: bars, priorSessions: [priorFlat()], now: '2026-07-08T14:10:00Z', dailyAtr: 3 });
  const ev = intradayEv({ ticker: 'ABC', candidateDate: '2026-07-08' }, f, { now: '2026-07-08T14:10:00Z' });
  assert.equal(ev.breakoutFailed, true);
  const rec = advanceLifecycle(null, { strategy: 'daytrade', ...ev });
  assert.equal(rec.state, STATES.FAILED);
});
