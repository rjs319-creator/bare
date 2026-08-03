'use strict';
// Family-specific structural detectors — positive AND negative fixtures per family, plus
// the fail-closed feature-evaluation rules (missing required features are penalized, not
// renormalized away).
const { test } = require('node:test');
const assert = require('node:assert');
const F = require('./helpers/pattern-fixtures');
const { detectWindow } = require('../lib/patterns/detectors');
const { evalFeatures, FAMILY_DETECTORS, DISABLED_FAMILIES } = require('../lib/patterns/families');

const find = (bars, tf, family) => detectWindow(bars, { timeframe: tf }).find(d => d.family === family) || null;

// ---- positive fixtures: every priority family has a working dedicated detector ----
const POSITIVES = [
  ['BULL_FLAG', F.bullFlag(), '20d'],
  ['BEAR_FLAG', F.bearFlag(), '20d'],
  ['DOUBLE_BOTTOM', F.doubleBottom(), '20d'],
  ['DOUBLE_TOP', F.doubleTop(), '20d'],
  ['VCP', F.vcp(), '60d'],
  ['FLAT_BASE', F.flatBase(), '20d'],
  ['CUP_AND_HANDLE', F.cupHandle(), '60d'],
  ['ASCENDING_TRIANGLE', F.ascTriangle(), '20d'],
  ['DESCENDING_TRIANGLE', F.descTriangle(), '20d'],
  ['BREAKOUT_RETEST', F.breakoutRetest(), '20d'],
  ['FAILED_BREAKOUT', F.failedBreakout(), '20d'],
  ['UNDERCUT_RECLAIM', F.undercutReclaim(), '20d'],
];

for (const [family, bars, tf] of POSITIVES) {
  test(`families: ${family} positive fixture detects with a valid structural plan`, () => {
    const d = find(bars, tf, family);
    assert.ok(d, `${family} should be detected`);
    assert.ok(d.structural.pass, 'structural pass');
    assert.deepStrictEqual(d.structural.missingRequiredFeatures, []);
    assert.ok(d.plan && typeof d.plan.trigger === 'number' && typeof d.plan.stop === 'number' && typeof d.plan.target === 'number', 'full family-specific plan');
    assert.ok(d.triggerLevel.sourceBarIdxs.length >= 0 && d.triggerLevel.type, 'trigger carries provenance/type');
    assert.ok(d.structural.featureCoverage > 0, 'featureCoverage reported');
  });
}

// ---- negative fixtures: similar-looking charts missing the defining requirement ----

test('families: a flag with an excessive retracement is NOT a bull flag', () => {
  assert.strictEqual(find(F.bullFlag({ retraceDeep: true }), '20d', 'BULL_FLAG'), null);
});

test('families: a single-bottom V is NOT a double bottom (two comparable pivots required)', () => {
  assert.strictEqual(find(F.doubleBottom({ single: true }), '20d', 'DOUBLE_BOTTOM'), null);
});

test('families: expanding swings are NOT a VCP (progressively smaller contractions required)', () => {
  assert.strictEqual(find(F.vcp({ expanding: true }), '60d', 'VCP'), null);
});

test('families: a cup whose handle retraces too deep is NOT cup-and-handle', () => {
  assert.strictEqual(find(F.cupHandle({ deepHandle: true }), '60d', 'CUP_AND_HANDLE'), null);
});

test('families: a plain downtrend produces no confirmed long', () => {
  const dets = detectWindow(F.downtrend(), { timeframe: '20d' });
  assert.ok(!dets.some(d => d.direction === 'LONG' && d.phase === 'CONFIRMED' && !d.invalidationHit));
});

// ---- fail-closed feature evaluation (no renormalization) ----

test('families: missing REQUIRED feature scores zero and fails the pattern (not renormalized)', () => {
  const r = evalFeatures([
    { name: 'a', score: 1, required: true },
    { name: 'b', score: null, required: true },   // missing → counted as 0
    { name: 'c', score: 1, required: true },
  ]);
  assert.deepStrictEqual(r.missingRequiredFeatures, ['b']);
  assert.strictEqual(r.pass, false);
  assert.ok(Math.abs(r.validity - 2 / 3) < 1e-3, `validity ${r.validity} must include the zero, got renormalized otherwise`);
});

test('families: a measurable required feature scoring ~0 (hard violation) also fails', () => {
  const r = evalFeatures([
    { name: 'a', score: 1, required: true },
    { name: 'b', score: 0.05, required: true },
  ]);
  assert.deepStrictEqual(r.violatedFeatures, ['b']);
  assert.strictEqual(r.pass, false);
});

test('families: featureCoverage reflects the measured fraction', () => {
  const r = evalFeatures([
    { name: 'a', score: 1, required: true },
    { name: 'b', score: null, required: false },
  ]);
  assert.strictEqual(r.featureCoverage, 0.5);
});

// ---- registry hygiene ----

test('families: every registered family has a dedicated detector and declared timeframes', () => {
  for (const f of FAMILY_DETECTORS) {
    assert.strictEqual(typeof f.detect, 'function', `${f.family} detector`);
    assert.ok(Array.isArray(f.timeframes) && f.timeframes.length, `${f.family} timeframes`);
    assert.ok(f.minBars >= 8, `${f.family} minBars sane`);
  }
  assert.ok(Array.isArray(DISABLED_FAMILIES), 'disabled families list exists (honest not-implemented channel)');
});
