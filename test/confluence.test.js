'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { efficiencyRatio, marketCondition, emaSeries, rsiSeries } = require('../lib/confluence');

test('efficiencyRatio: a straight line is perfectly efficient (1.0)', () => {
  const closes = [1, 2, 3, 4, 5];
  assert.equal(efficiencyRatio(closes, 4, 4), 1);
});

test('efficiencyRatio: a round-trip zigzag is inefficient (0)', () => {
  const closes = [1, 2, 1, 2, 1];
  assert.equal(efficiencyRatio(closes, 4, 4), 0);
});

test('efficiencyRatio: returns 0 before enough bars', () => {
  assert.equal(efficiencyRatio([1, 2, 3], 1, 5), 0);
});

test('marketCondition: risk-off regime short-circuits to riskoff', () => {
  assert.equal(marketCondition(null, 'risk-off'), 'riskoff');
});

test('marketCondition: too little history is mixed', () => {
  assert.equal(marketCondition([{ close: 100 }], 'neutral'), 'mixed');
});

test('marketCondition: a clean uptrend above its 200DMA is trending', () => {
  // 260 bars rising steadily → high efficiency, price above the 200DMA
  const spy = Array.from({ length: 260 }, (_, i) => ({ close: 100 + i }));
  assert.equal(marketCondition(spy, 'neutral'), 'trending');
});

test('marketCondition: a tight range is choppy', () => {
  const spy = Array.from({ length: 260 }, (_, i) => ({ close: 100 + (i % 2) }));  // oscillates 100/101
  assert.equal(marketCondition(spy, 'neutral'), 'choppy');
});

test('emaSeries and rsiSeries return aligned-length arrays', () => {
  const vals = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(emaSeries(vals, 10).length, 30);
  assert.equal(rsiSeries(vals, 14).length, 30);
});
