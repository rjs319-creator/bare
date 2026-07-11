'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wilson, isMarketHoliday, nowET } = require('../lib/stats');

test('wilson: empty sample is [0,0]', () => {
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 0 });
});

test('isMarketHoliday: known NYSE full-day closures are flagged', () => {
  assert.equal(isMarketHoliday('2026-01-01'), true);   // New Year's Day
  assert.equal(isMarketHoliday('2026-07-03'), true);   // Independence Day (observed)
  assert.equal(isMarketHoliday('2026-11-26'), true);   // Thanksgiving
  assert.equal(isMarketHoliday('2026-12-25'), true);   // Christmas
});

test('isMarketHoliday: an ordinary trading day is not', () => {
  assert.equal(isMarketHoliday('2026-07-06'), false);
  assert.equal(isMarketHoliday('2026-06-24'), false);
});

test('nowET: exposes isMarketClosed = weekend OR holiday', () => {
  const n = nowET();
  assert.equal(typeof n.date, 'string');
  assert.equal(n.isMarketClosed, n.isWeekend || n.isHoliday);
});

test('wilson: a small lucky sample has a low floor', () => {
  const ci = wilson(3, 3);          // 3/3 = 100% point estimate
  assert.ok(ci.lo < 0.6);           // but the floor is far below 100%
  assert.ok(ci.hi <= 1);
});

test('wilson: the floor rises as the sample grows', () => {
  assert.ok(wilson(60, 100).lo > wilson(6, 10).lo);   // same 60% rate, more data → higher floor
});

test('wilson: 50% over a large sample brackets 0.5', () => {
  const ci = wilson(500, 1000);
  assert.ok(ci.lo > 0.45 && ci.lo < 0.5);
  assert.ok(ci.hi > 0.5 && ci.hi < 0.55);
});
