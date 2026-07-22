'use strict';
// STEP 7 — swing-relevant expiry coverage. The scanner must fetch expiries that
// populate the PRIMARY SWING (21–45) and POSITION (46–75) DTE buckets, not just the
// nearest weekly. pickSwingExpiries is the pure selection core (no network, injected
// clock) so we can assert the coverage deterministically.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickSwingExpiries, SWING_EXPIRY_TARGETS } = require('../lib/options-baseline');
const { dteBucket } = require('../lib/options-classify');

const DAY = 86_400;
const NOW = 1_700_000_000;                 // fixed injected clock (seconds)
const at = dte => NOW + dte * DAY;         // an expiry `dte` days out
const dteOf = ts => Math.round((ts - NOW) / DAY);

test('picks expiries closest to the swing + position targets (21–45 and 46–75 buckets)', () => {
  // A realistic weekly+monthly ladder in DTE: 3, 10, 17, 31, 45, 59, 80.
  const ladder = [3, 10, 17, 31, 45, 59, 80].map(at);
  const nearestTs = at(3);
  const chosen = pickSwingExpiries({ expirationDates: ladder, nearestTs, nowSec: NOW });
  // Two extras chosen (one per default target 32, 58).
  assert.equal(chosen.length, 2);
  const buckets = chosen.map(ts => dteBucket(dteOf(ts)));
  assert.ok(buckets.includes('21-45'), `expected a primary-swing expiry, got ${buckets}`);
  assert.ok(buckets.includes('46-75'), `expected a position expiry, got ${buckets}`);
  // 31 is closest to target 32; 59 is closest to target 58.
  assert.deepEqual(chosen.map(dteOf).sort((a, b) => a - b), [31, 59]);
});

test('never re-picks the nearest expiry and never picks the same expiry twice', () => {
  const ladder = [3, 31, 59].map(at);
  const nearestTs = at(3);
  const chosen = pickSwingExpiries({ expirationDates: ladder, nearestTs, nowSec: NOW });
  assert.ok(!chosen.includes(nearestTs), 'nearest must be excluded');
  assert.equal(new Set(chosen).size, chosen.length, 'no duplicates');
});

test('degrades gracefully when only short-dated weeklies exist (picks closest available)', () => {
  // Only 3, 7, 12 DTE available — no ideal swing/position expiry.
  const ladder = [3, 7, 12].map(at);
  const chosen = pickSwingExpiries({ expirationDates: ladder, nearestTs: at(3), nowSec: NOW });
  // Still returns up to 2 distinct further-out expiries (the closest to each target),
  // rather than crashing or fabricating a date.
  assert.ok(chosen.length >= 1 && chosen.length <= 2);
  chosen.forEach(ts => assert.ok(dteOf(ts) > 3, 'must be further out than nearest'));
});

test('empty / single-expiry inputs yield no extras (no throw)', () => {
  assert.deepEqual(pickSwingExpiries({ expirationDates: [], nearestTs: null, nowSec: NOW }), []);
  assert.deepEqual(pickSwingExpiries({ expirationDates: [at(3)], nearestTs: at(3), nowSec: NOW }), []);
});

test('excludes already-expired timestamps', () => {
  const ladder = [-5, -1, 30].map(at);        // two in the past
  const chosen = pickSwingExpiries({ expirationDates: ladder, nearestTs: null, nowSec: NOW });
  chosen.forEach(ts => assert.ok(ts - NOW > 0, 'no past expiries'));
  assert.deepEqual(chosen.map(dteOf), [30]);
});

test('maxExtra caps the number of extra fetches (cost guard)', () => {
  const ladder = [3, 31, 59, 80].map(at);
  const chosen = pickSwingExpiries({ expirationDates: ladder, nearestTs: at(3), nowSec: NOW, maxExtra: 1 });
  assert.equal(chosen.length, 1);
});

test('default targets are the documented swing + position windows', () => {
  assert.deepEqual([...SWING_EXPIRY_TARGETS], [32, 58]);
  assert.equal(dteBucket(SWING_EXPIRY_TARGETS[0]), '21-45');
  assert.equal(dteBucket(SWING_EXPIRY_TARGETS[1]), '46-75');
});
