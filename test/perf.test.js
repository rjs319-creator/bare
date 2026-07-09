// Tests for the op=perf return math (lib/perf-routes.js) — day / 5-session / month
// performance used by Quick Hit's mover leaderboards.
const test = require('node:test');
const assert = require('node:assert');
const { retK } = require('../lib/perf-routes');

test('retK: computes the % return vs k sessions ago', () => {
  const closes = [100, 101, 102, 103, 104, 105]; // last = 105
  assert.strictEqual(retK(closes, 1), 0.96);   // vs 104
  assert.strictEqual(retK(closes, 5), 5);      // vs 100
});

test('retK: returns null when history is too short', () => {
  assert.strictEqual(retK([100, 105], 5), null);
  assert.strictEqual(retK([100, 105], 21), null);
});

test('retK: returns null on a non-positive price', () => {
  assert.strictEqual(retK([0, 105], 1), null);
  assert.strictEqual(retK([100, 0], 1), null);
});

test('retK: handles a negative move', () => {
  assert.strictEqual(retK([100, 90], 1), -10);
});
