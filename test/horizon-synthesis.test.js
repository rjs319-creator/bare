'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { synthesizeHorizons } = require('../lib/horizon-synthesis');

const intr = a => ({ action: a, available: a !== 'UNAVAILABLE' });
const sw = a => ({ action: a, available: a !== 'UNAVAILABLE', setup: 'x' });
const lt = t => ({ trend: t, available: t !== 'unavailable' });

test('aligned bullish across all three', () => {
  const s = synthesizeHorizons({ intraday: intr('BUY'), swing: sw('BUY'), longTerm: lt('bullish') });
  assert.strictEqual(s.overall, 'aligned-bullish');
  assert.strictEqual(s.conflicts.length, 0);
  assert.match(s.headline, /Bullish across all three/);
});

test('intraday pullback inside bullish structure', () => {
  const s = synthesizeHorizons({ intraday: intr('SELL'), swing: sw('BUY'), longTerm: lt('bullish') });
  assert.match(s.headline, /reclaim/i);
  assert.ok(s.conflicts.some(c => /intraday.*bearish.*swing.*bullish/i.test(c)));
});

test('counter-trend bounce inside damaged structure', () => {
  const s = synthesizeHorizons({ intraday: intr('BUY'), swing: sw('SELL'), longTerm: lt('bearish') });
  assert.match(s.headline, /Counter-trend bounce/i);
  assert.strictEqual(s.overall, 'conflicting');
});

test('swing SELL vs long-term bullish → protect gains / wait', () => {
  const s = synthesizeHorizons({ intraday: intr('HOLD'), swing: sw('SELL'), longTerm: lt('bullish') });
  assert.match(s.headline, /protect gains|deteriorating/i);
});

test('swing BUY vs long-term bearish → higher failure risk', () => {
  const s = synthesizeHorizons({ intraday: intr('HOLD'), swing: sw('BUY'), longTerm: lt('bearish') });
  assert.match(s.headline, /higher failure risk|downtrend/i);
});

test('unavailable swing does not become neutral', () => {
  const s = synthesizeHorizons({ intraday: intr('BUY'), swing: sw('UNAVAILABLE'), longTerm: lt('bullish') });
  assert.strictEqual(s.sides.swing, 'unavailable');
  assert.ok(!s.conflicts.some(c => /swing/.test(c)), 'unavailable never conflicts');
});

test('all daily horizons unavailable → intraday-only note', () => {
  const s = synthesizeHorizons({ intraday: intr('BUY'), swing: sw('UNAVAILABLE'), longTerm: lt('unavailable') });
  // only one horizon available and it is bullish → aligned by that single read
  assert.strictEqual(s.overall, 'aligned-bullish');
  assert.match(s.note, /intraday-only/i);
});

test('disagreement is preserved, never averaged into a number', () => {
  const s = synthesizeHorizons({ intraday: intr('BUY'), swing: sw('SELL'), longTerm: lt('neutral') });
  assert.strictEqual(typeof s.overall, 'string');
  assert.ok(!('score' in s), 'no composite score field');
  assert.ok(s.conflicts.length >= 1);
});

// Table-test every meaningful combination renders without throwing and preserves conflicts.
test('table: all bull/neutral/bear/unavailable combinations are stable', () => {
  const I = ['BUY', 'HOLD', 'SELL', 'UNAVAILABLE'];
  const S = ['BUY', 'WAIT', 'SELL', 'UNAVAILABLE'];
  const L = ['bullish', 'neutral', 'bearish', 'unavailable'];
  for (const i of I) for (const s of S) for (const l of L) {
    const r = synthesizeHorizons({ intraday: intr(i), swing: sw(s), longTerm: lt(l) });
    assert.ok(typeof r.headline === 'string' && r.headline.length > 0);
    assert.ok(['aligned-bullish', 'aligned-bearish', 'conflicting', 'leaning-bullish', 'leaning-bearish', 'neutral', 'unavailable'].includes(r.overall));
    assert.ok(Array.isArray(r.conflicts));
  }
});
