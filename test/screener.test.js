'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { emergingLeaderSignal } = require('../lib/screener');

// A baseline early momentum-emergence leg (RKLB-style): above both MAs, RS turning
// positive, short-term momentum up, accumulation building, still early (not extended).
const BASE = { aboveSmas: true, rsVsSpy63: 0.45, mom21: 0.18, accumRatio: 2.1, extAbove50: 0.08, rsi: 62 };

test('emergingLeaderSignal: fires on a fresh confirmed-strength leg', () => {
  assert.equal(emergingLeaderSignal(BASE), true);
});

test('emergingLeaderSignal: does NOT fire when below the moving averages (oversold-bounce/squeeze archetype)', () => {
  // FCEL-style: launches from weakness — no leading footprint to detect.
  assert.equal(emergingLeaderSignal({ ...BASE, aboveSmas: false }), false);
});

test('emergingLeaderSignal: does NOT fire when relative strength is negative', () => {
  assert.equal(emergingLeaderSignal({ ...BASE, rsVsSpy63: -0.05 }), false);
});

test('emergingLeaderSignal: does NOT fire when extended above the 50-DMA (already ran)', () => {
  assert.equal(emergingLeaderSignal({ ...BASE, extAbove50: 0.40 }), false);
});

test('emergingLeaderSignal: does NOT fire without accumulation', () => {
  assert.equal(emergingLeaderSignal({ ...BASE, accumRatio: 0.9 }), false);
});

test('emergingLeaderSignal: does NOT fire when overbought (rsi >= 75)', () => {
  assert.equal(emergingLeaderSignal({ ...BASE, rsi: 82 }), false);
});

test('emergingLeaderSignal: null inputs are treated as unknown and fail safe', () => {
  assert.equal(emergingLeaderSignal({ aboveSmas: true, rsVsSpy63: null, mom21: 0.1, accumRatio: 2, extAbove50: 0.05, rsi: 60 }), false);
  assert.equal(emergingLeaderSignal({}), false);
});

test('emergingLeaderSignal: missing rsi does not block (rsi optional)', () => {
  assert.equal(emergingLeaderSignal({ ...BASE, rsi: null }), true);
});
