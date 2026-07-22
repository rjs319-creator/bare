'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STATUS, etDate, barIsCurrentSession, computeFreshness, isCurrentSessionFresh } = require('../lib/freshness');

// America/New_York is EDT (UTC-4) in July.

test('etDate: resolves the ET calendar date, not the UTC date', () => {
  // 2026-07-08T01:00:00Z = 2026-07-07 21:00 ET (still the 7th in New York).
  assert.equal(etDate(new Date('2026-07-08T01:00:00Z')), '2026-07-07');
  // 2026-07-08T12:00:00Z = 2026-07-08 08:00 ET.
  assert.equal(etDate(new Date('2026-07-08T12:00:00Z')), '2026-07-08');
});

test('barIsCurrentSession: today matches, prior session does not', () => {
  const now = new Date('2026-07-08T14:00:00Z');   // 10:00 ET on the 8th
  assert.equal(barIsCurrentSession('2026-07-08', now), true);
  assert.equal(barIsCurrentSession('2026-07-07', now), false);   // yesterday's completed bar
  assert.equal(barIsCurrentSession(null, now), false);
});

test('barIsCurrentSession: a Friday bar read on Saturday is prior-session (no calendar needed)', () => {
  const saturday = new Date('2026-07-11T14:00:00Z');   // 2026-07-11 is a Saturday, 10:00 ET
  assert.equal(barIsCurrentSession('2026-07-10', saturday), false);   // Friday's bar is NOT "today"
  assert.equal(etDate(saturday), '2026-07-11');
});

test('barIsCurrentSession: a holiday has no bar dated today, so the prior bar stays stale', () => {
  // Whatever the holiday calendar, the guard needs none: on a non-trading weekday the
  // newest bar is dated an earlier day, so barIsCurrentSession is false and nothing paces.
  const holiday = new Date('2026-07-03T15:00:00Z');   // 11:00 ET
  assert.equal(barIsCurrentSession('2026-07-02', holiday), false);
});

test('computeFreshness: a current-session daily bar reads FRESH_TODAY', () => {
  const now = new Date('2026-07-08T14:00:00Z');
  const f = computeFreshness({ barDate: '2026-07-08', now });
  assert.equal(f.freshnessStatus, STATUS.FRESH_TODAY);
  assert.equal(f.barIsToday, true);
  assert.equal(f.candidateDate, '2026-07-08');
  assert.equal(f.dailyBarAsOf, '2026-07-08');
  assert.equal(isCurrentSessionFresh(f), true);
});

test('computeFreshness: a stale prior-session bar reads PRIOR_SESSION and is NOT actionable', () => {
  const now = new Date('2026-07-08T14:00:00Z');
  const f = computeFreshness({ barDate: '2026-07-07', now });
  assert.equal(f.freshnessStatus, STATUS.PRIOR_SESSION);
  assert.equal(f.barIsToday, false);
  assert.equal(isCurrentSessionFresh(f), false);   // stale candidates cannot be ACTIONABLE_NOW
});

test('computeFreshness: no data at all reads UNKNOWN', () => {
  const f = computeFreshness({ barDate: null, now: new Date('2026-07-08T14:00:00Z') });
  assert.equal(f.freshnessStatus, STATUS.UNKNOWN);
  assert.equal(isCurrentSessionFresh(f), false);
});

test('computeFreshness: a live quote makes even a prior-session bar FRESH_TODAY with a real age', () => {
  const now = new Date('2026-07-08T14:00:05Z');
  const f = computeFreshness({ barDate: '2026-07-07', quoteAsOf: '2026-07-08T14:00:00Z', now });
  assert.equal(f.freshnessStatus, STATUS.FRESH_TODAY);   // the quote is current-session evidence
  assert.equal(f.quoteAsOf, '2026-07-08T14:00:00.000Z');
  assert.equal(f.dataAgeSeconds, 5);                     // now - quoteAsOf
  assert.equal(isCurrentSessionFresh(f), true);
});

test('computeFreshness: dataAgeSeconds is null for a bare daily bar (no intraday age to claim)', () => {
  const f = computeFreshness({ barDate: '2026-07-08', now: new Date('2026-07-08T14:00:00Z') });
  assert.equal(f.dataAgeSeconds, null);   // honest: a daily aggregate has no intraday timestamp
});

test('computeFreshness: cacheUpdatedAt is normalized to ISO from epoch ms', () => {
  const now = new Date('2026-07-08T14:00:00Z');
  const f = computeFreshness({ barDate: '2026-07-08', cacheUpdatedAt: Date.parse('2026-07-08T09:00:00Z'), now });
  assert.equal(f.cacheUpdatedAt, '2026-07-08T09:00:00.000Z');
});
