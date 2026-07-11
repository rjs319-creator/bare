'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { efficiencyRatio, marketCondition, emaSeries, rsiSeries, independentScore, STRATEGY_FAMILY, CORR_DISCOUNT, CONFLUENCE_FAMILY_VERSION } = require('../lib/confluence');

// ── independent-evidence families (family-v1) ────────────────────────────────
test('STRATEGY_FAMILY: 4 of 5 strategies are one trend family, rsi is the independent one', () => {
  const fams = new Set(Object.values(STRATEGY_FAMILY));
  assert.equal(fams.size, 2);
  assert.equal(STRATEGY_FAMILY.ema, 'trend');
  assert.equal(STRATEGY_FAMILY.macd, 'trend');
  assert.equal(STRATEGY_FAMILY.rsi, 'meanReversion');
  assert.equal(CONFLUENCE_FAMILY_VERSION, 'family-v1');
});

test('independentScore: within-family agreement is correlation-discounted', () => {
  // first vote full, each extra in the same family × CORR_DISCOUNT (0.3)
  assert.equal(independentScore({ trend: [1] }), 1);
  assert.equal(independentScore({ trend: [1, 1] }), +(1 + CORR_DISCOUNT).toFixed(2)); // 1.3
  assert.equal(independentScore({ trend: [1, 1, 1, 1] }), +(1 + 3 * CORR_DISCOUNT).toFixed(2)); // 1.9
});

test('independentScore: two INDEPENDENT families outrank more correlated votes', () => {
  const allTrend = independentScore({ trend: [1, 1, 1, 1] });          // 1.9
  const crossFamily = independentScore({ trend: [1], meanReversion: [1] }); // 2.0
  assert.ok(crossFamily > allTrend, 'trend+meanReversion should beat 4 correlated trend votes');
});

test('independentScore: heavier weights sort to full-credit within a family', () => {
  // the strongest vote in a family always gets full weight, weaker ones discounted
  assert.equal(independentScore({ trend: [2, 1] }), +(2 + 1 * CORR_DISCOUNT).toFixed(2)); // 2.3
});

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
