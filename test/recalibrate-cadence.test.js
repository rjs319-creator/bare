'use strict';
// op=recalibrate on the nightly chain: adoption is trusted-only, so the chain is the one
// path that can put a re-fit in force — and it does so once a week, not nightly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { recalibrateDue } = require('../lib/apex-routes');

test('weekly cadence is due only on the last trading day of the week (ET)', () => {
  assert.deepEqual(recalibrateDue('weekly', new Date('2026-10-16T22:10:00Z')), { due: true, reason: null });          // Fri
  assert.equal(recalibrateDue('weekly', new Date('2026-10-15T22:10:00Z')).due, false);                               // Thu
  assert.match(recalibrateDue('weekly', new Date('2026-10-17T15:00:00Z')).reason, /not a trading day/);              // Sat
  assert.equal(recalibrateDue('weekly', new Date('2026-11-27T22:10:00Z')).due, true);                                 // Fri early close is still a trading day
  assert.equal(recalibrateDue('weekly', new Date('2026-07-03T22:10:00Z')).due, false);                                // Fri Jul 3 2026 observed holiday
  assert.equal(recalibrateDue('weekly', new Date('2026-07-02T22:10:00Z')).due, true);                                 // Thu Jul 2 = that week's last session
  assert.equal(recalibrateDue('weekly', new Date('2026-12-24T22:10:00Z')).due, true);                                 // Thu Dec 24 (Fri Dec 25 closed)
  assert.equal(recalibrateDue('weekly', new Date('2026-12-23T22:10:00Z')).due, false);                                // Wed Dec 23
});

test('no cadence (the browser dry run, a manual trusted call) is always due', () => {
  assert.deepEqual(recalibrateDue(undefined), { due: true, reason: null });
  assert.deepEqual(recalibrateDue('daily'), { due: true, reason: null });
});

test('the maturity chain carries the weekly step and the op stays browser-callable (expensive, not privileged)', () => {
  const chains = require('../lib/warm-chains').CHAINS;
  assert.ok(chains.maturity.includes('op=recalibrate&cadence=weekly'));
  const tracker = require('../api/tracker');
  assert.equal(tracker.policyOf('recalibrate'), 'public-throttled');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');
  assert.match(src, /skipped: 'cadence'/, 'an off-cadence scheduled call is a benign skip, not a failure');
});
