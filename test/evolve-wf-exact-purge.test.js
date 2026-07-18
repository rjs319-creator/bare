'use strict';
// #2: exact label-end purge in the EVOLVE walk-forward. The old purge estimated a label's span as
// predDate + full window ×1.4 calendar days; the exact form uses the label's ACTUAL end date
// (evolve-labels labelEndDate), which recovers training data from labels that resolved early and
// fixes holiday miscounts.

const test = require('node:test');
const assert = require('node:assert');
const WF = require('../lib/evolve-walkforward');

test('exact purge KEEPS an early-resolving label the window×1.4 estimate would DROP', () => {
  // swing horizon (window 21), embargo 3. Label predicted 2022-01-03 but resolved early 2022-01-10.
  const predDate = '2022-01-03', labelEndDate = '2022-01-10', testStart = '2022-01-20', embargo = 3;
  // Exact: real label end is 10 calendar days before the test block → cleanly closed → KEEP.
  assert.equal(WF.labelClearsTestBlockExact(labelEndDate, testStart, embargo), true);
  // Approx: assumes the label ran the FULL 21-day window from predDate → estimates it still open → DROP.
  assert.equal(WF.labelClearsTestBlock(predDate, testStart, 'swing', embargo), false);
});

test('exact purge DROPS a label that closes inside the embargo buffer of the test block', () => {
  // Label resolves 2022-01-19, test opens 2022-01-20 — only 1 calendar day, within the embargo.
  assert.equal(WF.labelClearsTestBlockExact('2022-01-19', '2022-01-20', 3), false);
});

test('walkForward reports the exact-label-end purge method when events carry labelEndDate', () => {
  // Build a small resolved, specialist-tagged event set with real label-end dates.
  const dates = Array.from({ length: 8 }, (_, i) => `2022-0${1 + Math.floor(i / 4)}-0${1 + (i % 4)}`);
  const events = [];
  for (let i = 0; i < dates.length; i++) for (let n = 0; n < 4; n++) {
    events.push({
      predDate: dates[i], horizon: 'swing', contextKey: 'neutral|large|swing',
      specialists: ['s1'], won: (i + n) % 2 === 0, terminalReturn: ((i + n) % 3 - 1) * 0.05,
      labelEndDate: dates[Math.min(dates.length - 1, i + 2)],
    });
  }
  const wf = WF.walkForward(events, { folds: 4, embargo: 3, purge: true });
  assert.ok(wf.purge, 'purge diagnostic present');
  assert.equal(wf.purge.method, 'exact-label-end');
  assert.ok(wf.purge.exactDecisions > 0);
  assert.equal(wf.purge.approxDecisions, 0);
});

test('walkForward falls back to window×1.4 for legacy events without labelEndDate (reported as mixed/approx)', () => {
  const dates = Array.from({ length: 8 }, (_, i) => `2022-0${1 + Math.floor(i / 4)}-0${1 + (i % 4)}`);
  const events = [];
  for (let i = 0; i < dates.length; i++) for (let n = 0; n < 4; n++) {
    events.push({ predDate: dates[i], horizon: 'swing', contextKey: 'neutral|large|swing',
      specialists: ['s1'], won: (i + n) % 2 === 0, terminalReturn: ((i + n) % 3 - 1) * 0.05 });  // no labelEndDate
  }
  const wf = WF.walkForward(events, { folds: 4, embargo: 3, purge: true });
  assert.equal(wf.purge.exactDecisions, 0);
  assert.ok(wf.purge.approxDecisions > 0);
  assert.equal(wf.purge.method, 'approx-window×1.4');
});
