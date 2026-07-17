'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RE = require('../lib/remaining-edge');

// A long flagged at $10, entry $10, stop $9, target $12 (a +20% advertised move, 2R).
const longSig = (price, extra = {}) => ({
  ticker: 'ABC', side: 'long', horizon: 'swing', price, ...extra,
});
const origin = { firstPrice: 10, entry: 10, stop: 9, target: 12, bars: 0 };

test('fresh signal at its detection price keeps mult = 1 (byte-identical to no-feature)', () => {
  const r = RE.computeRemainingEdge(longSig(10, { entry: 10, stop: 9, target: 12 }), origin);
  assert.equal(r.rated, true);
  assert.equal(r.consumedPct, 0);
  assert.equal(r.mult, 1);
  assert.equal(r.freshness, 'fresh');
});

test('a name that has consumed most of its move is demoted (mult << 1) and marked late', () => {
  // Ran from $10 to $11.8 → consumed 90% of the $10→$12 move.
  const r = RE.computeRemainingEdge(longSig(11.8, { entry: 10, stop: 9, target: 12 }), origin);
  assert.equal(r.consumedPct, 90);
  assert.ok(r.mult < 0.3, `expected steep demotion, got ${r.mult}`);
  assert.equal(r.freshness, 'late');
});

test('monotonic: mult strictly decreases as more of the move is consumed', () => {
  const at = p => RE.computeRemainingEdge(longSig(p, { entry: 10, stop: 9, target: 12 }), origin).mult;
  const seq = [10, 10.5, 11, 11.5, 11.9].map(at);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1], `not monotonic at ${i}: ${seq}`);
  assert.ok(seq[0] > seq[seq.length - 1]);
});

test('expired: no net edge left once price reaches the target → floor + expired class', () => {
  const r = RE.computeRemainingEdge(longSig(12, { entry: 10, stop: 9, target: 12 }), origin);
  assert.ok(r.netRemainingPct <= 0);
  assert.equal(r.mult, RE.CONFIG.REMAIN_FLOOR);
  assert.equal(r.freshness, 'expired');
});

test('cost eats the remaining edge: a near-target name with a fat round trip is expired', () => {
  // $11.95 leaves ~0.42% to target; a 1% round trip wipes it out → net negative.
  const r = RE.computeRemainingEdge(longSig(11.95, { entry: 10, stop: 9, target: 12, costPct: 1 }), origin);
  assert.ok(r.netRemainingPct < 0);
  assert.equal(r.freshness, 'expired');
  assert.equal(r.mult, RE.CONFIG.REMAIN_FLOOR);
});

test('extension haircut: a chased name (far past entry in R) is trimmed vs an un-chased one', () => {
  // Same 30% consumed, but one is 2R past entry. Build a target far enough that 30% consumed
  // still leaves runway, with a wide-enough R that extension is the only difference.
  const o = { firstPrice: 10, entry: 10, stop: 9.5, target: 20, bars: 0 };
  const calm = RE.computeRemainingEdge(longSig(10.2, { entry: 10, stop: 9.5, target: 20 }), o); // 0.4R past
  const chased = RE.computeRemainingEdge(longSig(13, { entry: 10, stop: 9.5, target: 20 }), o); // 6R past
  assert.ok(chased.extensionR > calm.extensionR);
  assert.ok(chased.extFactor < calm.extFactor, `extFactor ${chased.extFactor} !< ${calm.extFactor}`);
});

test('decay haircut: a setup aged well past its hold window loses reliability', () => {
  const fresh = RE.computeRemainingEdge(longSig(10.2, { entry: 10, stop: 9, target: 12 }), { ...origin, bars: 0 });
  const stale = RE.computeRemainingEdge(longSig(10.2, { entry: 10, stop: 9, target: 12 }), { ...origin, bars: 30 });
  assert.equal(fresh.decayFactor, 1);
  assert.ok(stale.decayFactor < 1, `expected decay, got ${stale.decayFactor}`);
  assert.ok(stale.mult < fresh.mult);
});

test('no origin → self-origin → nothing consumed; mult 1 at entry (safety: feature-off equivalence)', () => {
  // At the entry price there is no extension either, so the self-origin path is a clean 1.
  const r = RE.computeRemainingEdge(longSig(10, { entry: 10, stop: 9, target: 12 }), null);
  assert.equal(r.hasOrigin, false);
  assert.equal(r.consumedPct, 0);
  assert.equal(r.mult, 1);
});

test('extension binds even without an origin (it reads current price vs entry, not history)', () => {
  // Self-origin ⇒ consumed 0, but 1R past entry ⇒ extension haircut. The board-level safety
  // guarantee (feature-off ⇒ unchanged) is enforced by rankSignals gating, not here.
  const r = RE.computeRemainingEdge(longSig(11, { entry: 10, stop: 9, target: 12 }), null);
  assert.equal(r.consumedPct, 0);
  assert.ok(r.mult < 1 && r.extFactor < 1);
});

test('unrated: a lead with no target is neutral (mult 1), never penalized', () => {
  const r = RE.computeRemainingEdge({ ticker: 'X', side: 'long', horizon: 'position', price: 50 }, null);
  assert.equal(r.rated, false);
  assert.equal(r.freshness, 'unrated');
  assert.equal(r.mult, 1);
});

test('invalidated: a failed (stopped-out) signal floors to the minimum weight', () => {
  const r = RE.computeRemainingEdge(longSig(8.9, { entry: 10, stop: 9, target: 12, state: 'failed' }), origin);
  assert.equal(r.freshness, 'invalidated');
  assert.equal(r.mult, RE.CONFIG.REMAIN_FLOOR);
});

test('shorts mirror longs: a short toward $8 from $10 consumes as price falls', () => {
  const shortOrigin = { firstPrice: 10, entry: 10, stop: 11, target: 8, bars: 0 };
  const fresh = RE.computeRemainingEdge({ ticker: 'S', side: 'short', horizon: 'swing', price: 10, entry: 10, stop: 11, target: 8 }, shortOrigin);
  const consumed = RE.computeRemainingEdge({ ticker: 'S', side: 'short', horizon: 'swing', price: 8.4, entry: 10, stop: 11, target: 8 }, shortOrigin);
  assert.equal(fresh.consumedPct, 0);
  assert.ok(consumed.consumedPct >= 79 && consumed.consumedPct <= 81, `got ${consumed.consumedPct}`);
  assert.ok(consumed.mult < fresh.mult);
});
