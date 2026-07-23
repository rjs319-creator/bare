'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/swing-sessions');

// Bars: Thu 7/16, Fri 7/17, (weekend), Mon 7/20, Tue 7/21 — a real trading week.
const week = [
  { date: '2026-07-16', close: 10 },
  { date: '2026-07-17', close: 11 },
  { date: '2026-07-20', close: 12 },
  { date: '2026-07-21', close: 13 },
];

test('sessionsSince counts bars strictly after the decision date (age 0 on decision day)', () => {
  assert.equal(S.sessionsSince('2026-07-21', week), 0);        // decided on the last bar
  assert.equal(S.sessionsSince('2026-07-20', week), 1);        // one bar after
});

test('age advances correctly across a weekend (Fri decision → Mon+Tue = 2 sessions)', () => {
  // Decision Fri 7/17; Sat/Sun are not bars; Mon 7/20 + Tue 7/21 = 2 sessions. (test #10)
  assert.equal(S.sessionsSince('2026-07-17', week), 2);
});

test('age advances across a market holiday without counting the closed day', () => {
  // Fri 7/3/2026 is a holiday (Independence Day observed) — not a bar; 7/2 Thu → 7/6 Mon.
  const holidayWeek = [
    { date: '2026-07-01', close: 5 },  // Wed
    { date: '2026-07-02', close: 6 },  // Thu (decision)
    { date: '2026-07-06', close: 7 },  // Mon (7/3 holiday skipped)
  ];
  assert.equal(S.sessionsSince('2026-07-02', holidayWeek), 1); // only 7/6 counts (test #10)
});

test('repeated evaluation on the same date does not increment age twice (idempotent)', () => {
  // There is no mutable counter — recomputing yields the identical number. (test #11)
  const a = S.sessionsSince('2026-07-17', week);
  const b = S.sessionsSince('2026-07-17', week);
  const c = S.sessionsSince('2026-07-17', week);
  assert.equal(a, 2); assert.equal(b, 2); assert.equal(c, 2);
});

test('missing evaluation days do not freeze age — the next run sees every bar (test #12)', () => {
  // The monitor skipped Mon; on Tue it still counts BOTH Mon and Tue bars since Fri.
  assert.equal(S.sessionsSince('2026-07-17', week), 2);
  // vs. a broken counter that only advanced on days it ran (would report 1).
});

test('sessionsSince is null when no bars are available (cannot fabricate age)', () => {
  assert.equal(S.sessionsSince('2026-07-17', []), null);
  assert.equal(S.sessionsSince('2026-07-17', null), null);
});

test('barDate parses ISO date, epoch seconds and epoch ms', () => {
  assert.equal(S.barDate({ date: '2026-07-21' }), '2026-07-21');
  assert.equal(S.barDate({ time: 1768953600 }), '2026-01-21');       // seconds
  assert.equal(S.barDate({ t: 1768953600000 }), '2026-01-21');        // ms
  assert.equal(S.barDate({}), null);
});

test('latestSessionDate returns the most recent bar', () => {
  assert.equal(S.latestSessionDate(week), '2026-07-21');
  assert.equal(S.latestSessionDate([]), null);
});

test('nextSessionBar returns the earliest bar strictly after the decision (T+1 fill)', () => {
  const b = S.nextSessionBar('2026-07-17', week);              // Fri decision → Mon fill
  assert.equal(b.date, '2026-07-20');
  assert.equal(S.nextSessionBar('2026-07-21', week), null);    // no session after the last bar
});

test('calendarSessionsBetween is the fallback when candles are missing (weekend + holiday aware)', () => {
  // Fri 7/17 → Tue 7/21: Mon + Tue = 2 sessions, weekend excluded.
  assert.equal(S.calendarSessionsBetween('2026-07-17', '2026-07-21'), 2);
  // Thu 7/2 → Mon 7/6 across the 7/3 holiday = 1 session.
  assert.equal(S.calendarSessionsBetween('2026-07-02', '2026-07-06'), 1);
  assert.equal(S.calendarSessionsBetween('2026-07-21', '2026-07-21'), 0);
});
