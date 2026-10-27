'use strict';
// Regression: fetchIntradayBars used Yahoo meta.chartPreviousClose as "prev close". On a
// range=5d chart that is the close BEFORE the 5-day window, so Pulse / Session Board showed
// 5-day returns as the day's change (2026-10-26: SPY −0.16% shown vs +0.71% actual).
const test = require('node:test');
const assert = require('node:assert');
const { prevCloseFromPriorSessions } = require('../lib/intraday-data');

const bar = (t, c) => ({ t, o: c, h: c, l: c, c, v: 100 });

test('prev close is the last bar of the most recent prior session', () => {
  const prior = [
    [bar('2026-10-23T19:55:00Z', 100)],
    [bar('2026-10-26T19:50:00Z', 110), bar('2026-10-26T19:55:00Z', 111)],
  ];
  assert.strictEqual(prevCloseFromPriorSessions(prior), 111);
});

test('skips an empty trailing prior session', () => {
  assert.strictEqual(prevCloseFromPriorSessions([[bar('2026-10-23T19:55:00Z', 100)], []]), 100);
});

test('no prior bars → null (never a guess)', () => {
  assert.strictEqual(prevCloseFromPriorSessions([]), null);
  assert.strictEqual(prevCloseFromPriorSessions([[bar('2026-10-23T19:55:00Z', 0)]]), null);
});
