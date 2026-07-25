'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/patterns/similarity');
const { findAnalogs } = require('../lib/patterns/analog');
const { SHAPES } = require('../lib/patterns/templates');

test('similarity: identical normalized paths score ~1 on both path and DTW', () => {
  const a = [0, 0.1, 0.25, 0.2, 0.35, 0.5, 0.48];
  assert.strictEqual(S.pathCorrelation(a, a.slice()), 1);
  assert.ok(S.dtwSimilarity(a, a.slice()) > 0.98);
});

test('similarity: price scale/offset does not change path correlation', () => {
  const a = [1, 2, 3, 2.5, 4, 5];
  const b = a.map(x => x * 250 + 40);
  assert.ok(Math.abs(S.pathCorrelation(a, b) - 1) < 1e-9);
});

test('similarity: inverted path is anti-correlated', () => {
  const a = [0, 0.2, 0.4, 0.3, 0.6];
  assert.strictEqual(S.pathCorrelation(a, a.map(x => -x)), -1);
});

test('similarity: components stay SEPARATE in combine (not collapsed to one "correlation")', () => {
  const r = S.combineSimilarity({ pathCorrelation: 0.8, geometrySimilarity: 0.9, dtwSimilarity: 0.7, volumeSimilarity: 0.6, contextSimilarity: 0.5 });
  assert.ok('pathCorrelation' in r.used && 'geometrySimilarity' in r.used, 'each component preserved individually');
  assert.ok(r.combined > 0 && r.combined < 1);
});

test('similarity: match tier is DESCRIPTIVE (not calibrated) without a validated distribution', () => {
  const t = S.matchTier(0.9);
  assert.strictEqual(t.calibratedThreshold, false, 'must not claim a calibrated threshold from thin air');
});

test('similarity: match tier becomes calibrated only with deciles + sufficient N', () => {
  const t = S.matchTier(0.9, { deciles: [.3, .4, .5, .6, .65, .7, .75, .8, .88], effectiveN: 120 });
  assert.strictEqual(t.calibratedThreshold, true);
  assert.strictEqual(t.tier, 'STRONG');
});

test('similarity: strong shape with incompatible context is discounted', () => {
  const tmpl = { context: { regime: ['RISK_ON'], liquidity: 'SUPPORTED', volMax: 60 } };
  const good = S.contextSimilarity({ marketRegime: 'RISK_ON', liquidity: 'SUPPORTED', volPercentile: 40 }, tmpl);
  const bad = S.contextSimilarity({ marketRegime: 'RISK_OFF', liquidity: 'THIN', volPercentile: 95 }, tmpl);
  assert.ok(good > bad, `good ${good} should exceed bad ${bad}`);
});

test('analog: FUTURE bars can never enter the query set (no lookahead)', () => {
  const q = { path: SHAPES.bullFlag, context: { marketRegime: 'RISK_ON', volPercentile: 40 }, family: 'BULL_FLAG', direction: 'LONG', ticker: 'ABC', queryDate: '2026-01-01' };
  const corpus = [
    { ticker: 'XYZ', asOfDate: '2025-06-01', path: SHAPES.bullFlag, context: { marketRegime: 'RISK_ON', volPercentile: 42 }, family: 'BULL_FLAG', direction: 'LONG', outcome: { targetFirst: true } },
    { ticker: 'FUT', asOfDate: '2026-06-01', path: SHAPES.bullFlag, context: { marketRegime: 'RISK_ON', volPercentile: 40 }, family: 'BULL_FLAG', direction: 'LONG', outcome: { targetFirst: true } }, // future
  ];
  const r = findAnalogs(q, corpus, { minSim: 0.5, minEffectiveN: 1 });
  assert.strictEqual(r.rawCount, 1, 'the 2026 record must be excluded');
});

test('analog: a stock cannot match its own overlapping/future window', () => {
  const q = { path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', ticker: 'ABC', queryDate: '2026-01-01' };
  const corpus = [
    { ticker: 'ABC', asOfDate: '2025-12-28', path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', outcome: { targetFirst: true } }, // same ticker, window overlaps query
  ];
  const r = findAnalogs(q, corpus, { minSim: 0.4, overlapDays: 20, minEffectiveN: 1 });
  assert.strictEqual(r.effectiveSampleSize, 0, 'own overlapping window excluded');
});

test('analog: overlapping windows do NOT inflate effective sample size', () => {
  const q = { path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', ticker: 'ABC', queryDate: '2026-01-01' };
  const corpus = [
    { ticker: 'XYZ', asOfDate: '2025-06-01', path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', outcome: { targetFirst: true } },
    { ticker: 'XYZ', asOfDate: '2025-06-03', path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', outcome: { targetFirst: true } }, // overlaps within 20d
    { ticker: 'XYZ', asOfDate: '2025-06-04', path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', outcome: { targetFirst: true } }, // overlaps
    { ticker: 'DEF', asOfDate: '2025-09-01', path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', outcome: { targetFirst: false } },
  ];
  const r = findAnalogs(q, corpus, { minSim: 0.4, overlapDays: 20, minEffectiveN: 1 });
  assert.strictEqual(r.rawCount, 4);
  assert.strictEqual(r.effectiveSampleSize, 2, 'three overlapping XYZ windows collapse to one; DEF is the other');
});

test('analog: incremental lift is null without matched controls (no fabricated baseline)', () => {
  const q = { path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', ticker: 'ABC', queryDate: '2026-01-01' };
  const corpus = [{ ticker: 'XYZ', asOfDate: '2025-06-01', path: SHAPES.bullFlag, context: {}, family: 'BULL_FLAG', direction: 'LONG', outcome: { targetFirst: true } }];
  const r = findAnalogs(q, corpus, { minSim: 0.4, minEffectiveN: 1 });
  assert.strictEqual(r.baselineRate, null);
  assert.strictEqual(r.incrementalLift, null);
});
