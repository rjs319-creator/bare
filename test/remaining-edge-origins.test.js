'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../lib/remaining-edge-origins');

const sig = (id, price, over = {}) => ({ id, ticker: id, price, entry: 10, stop: 9, target: 12, side: 'long', horizon: 'swing', score: 70, ...over });

test('captures a new signal immutably at first sight (bars 0, firstPrice = current price)', () => {
  const o = O.updateOrigins(null, [sig('screener:swing:ABC', 10.5)], '2026-07-17');
  const rec = o['screener:swing:ABC'];
  assert.equal(rec.firstDate, '2026-07-17');
  assert.equal(rec.firstPrice, 10.5);
  assert.equal(rec.target, 12);
  assert.equal(rec.bars, 0);
});

test('IMMUTABILITY: an existing origin never has its firstPrice/target rewritten', () => {
  const day1 = O.updateOrigins(null, [sig('id', 10)], '2026-07-15');
  // Same signal re-emitted at a higher price with a re-drawn target — origin must NOT move.
  const day2 = O.updateOrigins(day1, [sig('id', 11, { target: 15, price: 11 })], '2026-07-16');
  assert.equal(day2.id.firstPrice, 10, 'firstPrice frozen');
  assert.equal(day2.id.target, 12, 'target frozen');
});

test('bars advance once per distinct trading date, not per call', () => {
  let o = O.updateOrigins(null, [sig('id', 10)], '2026-07-15');
  assert.equal(o.id.bars, 0);
  o = O.updateOrigins(o, [sig('id', 10)], '2026-07-15'); // same date → no advance
  assert.equal(o.id.bars, 0);
  o = O.updateOrigins(o, [sig('id', 10)], '2026-07-16'); // new date → +1
  assert.equal(o.id.bars, 1);
  o = O.updateOrigins(o, [sig('id', 10)], '2026-07-17');
  assert.equal(o.id.bars, 2);
});

test('prunes entries unseen past the window; keeps still-present ones', () => {
  const seed = { old: { firstDate: '2026-01-01', lastDate: '2026-01-01', firstPrice: 5, bars: 0 } };
  // 'old' last seen Jan 1; today July 17 (> 90d) and not in today's signals → pruned.
  const o = O.updateOrigins(seed, [sig('fresh', 10)], '2026-07-17');
  assert.equal(o.old, undefined, 'stale origin pruned');
  assert.ok(o.fresh, 'new origin kept');
});

test('a stale-but-still-present name is NOT pruned (presence overrides age)', () => {
  const seed = { keep: { firstDate: '2026-01-01', lastDate: '2026-01-01', firstPrice: 5, bars: 0 } };
  const o = O.updateOrigins(seed, [sig('keep', 6)], '2026-07-17');
  assert.ok(o.keep, 'present today → survives regardless of age');
  assert.equal(o.keep.firstPrice, 5, 'still immutable');
});

test('is pure — does not mutate the previous map', () => {
  const prev = O.updateOrigins(null, [sig('id', 10)], '2026-07-15');
  const snapshot = JSON.stringify(prev);
  O.updateOrigins(prev, [sig('id', 11)], '2026-07-16');
  assert.equal(JSON.stringify(prev), snapshot, 'prev unchanged');
});
