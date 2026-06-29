'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forwardMfe, SIGNALS } = require('../lib/moverstudy');

const c = (close, high) => ({ close, high: high == null ? close : high });

test('forwardMfe: captures the biggest run-up over the window, not the close', () => {
  // entry 10 → ran to a high of 15 (intrabar) then closed back at 11.
  const candles = [c(10), c(12, 13), c(11, 15), c(11, 11)];
  assert.equal(forwardMfe(candles, 0, 3), 50); // (15-10)/10 = +50%
});

test('forwardMfe: respects the bar window', () => {
  const candles = [c(10), c(11, 11), c(10, 10), c(20, 20)];
  assert.equal(forwardMfe(candles, 0, 2), 10); // only looks 2 bars ahead → high 11
});

test('forwardMfe: a name that only fell has 0 max-favorable-excursion', () => {
  const candles = [c(10), c(9, 9.5), c(8, 8.5)];
  assert.equal(forwardMfe(candles, 0, 2), 0);
});

test('forwardMfe: null entry yields null', () => {
  assert.equal(forwardMfe([c(0), c(5, 6)], 0, 1), null);
});

test('SIGNALS: each entry is [key, label, predicate] and predicates are pure booleans', () => {
  assert.ok(SIGNALS.length >= 10);
  const sample = { r: { status: 'Breakout', emergingLeader: true, filters: { rsVsSpy: true, aboveSmas: true }, metrics: { accumRatio: 2, udVol: 1.5, volSurge: 2, pocketPivot: true, vcpContractions: 3, longBase: true } }, run: true, momHigh: true };
  for (const [key, label, pred] of SIGNALS) {
    assert.equal(typeof key, 'string');
    assert.equal(typeof label, 'string');
    assert.equal(typeof pred(sample), 'boolean');
  }
  const byKey = Object.fromEntries(SIGNALS.map(s => [s[0], s[2]]));
  assert.equal(byKey.emergingLeader(sample), true);
  assert.equal(byKey.momentumRun(sample), true);
  assert.equal(byKey.breakout(sample), true);
  assert.equal(byKey.breakout({ ...sample, r: { ...sample.r, status: 'Setup' } }), false);
});
