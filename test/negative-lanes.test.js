'use strict';
// Evidence-negative lanes (2026-09-09 alpha pass). A section:tier:scope lane whose
// date-level cost-net record at its OWN contract horizon is CI-negative, well sampled,
// and corroborated by an adjacent horizon must not take a Quick Hit / Opportunities
// slot with a trade plan. Derived from the persisted scoreboard — never a hardcoded list.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const NL = require('../lib/negative-lanes');

const dn = (lo, hi, effectiveN, positive, blocks = 4) => ({
  n: effectiveN + 2, effectiveN, avg: (lo + hi) / 2, ci95: { lo, hi },
  blockStability: { blocks, positive, usable: blocks >= 4 },
});
const h = (netEx, dateNet, dates) => ({ n: 40, dates, avgNetExcess: netEx, netExcessN: 40, dateNet });

// Shapes lifted from op=scoreboard 2026-09-09.
const BREAKOUT_LARGE = { section: 'screener', tier: 'Breakout', scope: 'large', horizons: {
  '3d': h(-1.47, dn(-2.39, -0.4, 37, 0), 37),
  '5d': h(-2.1, dn(-4.25, -0.32, 36, 0), 36),
  '10d': h(-3.62, dn(-7.45, -1.17, 33, 1), 33),
} };
const EARLY_SMALL = { section: 'screener', tier: 'Early', scope: 'small', horizons: {
  '3d': h(-1.9, dn(-4.1, 0.3, 25, 1), 25),
  '5d': h(-3.8, dn(-6.95, -1.07, 25, 0), 25),
  '10d': h(-7.48, dn(-11.35, -2.74, 23, 0), 23),
} };
// Contract cell spans zero → NOT negative even though 5d/10d carry is (daytrade:A).
const DAYTRADE_A = { section: 'daytrade', tier: 'A', scope: null, horizons: {
  '1d': h(-0.34, dn(-1.86, 2.99, 31, 3), 31),
  '5d': h(-4.09, dn(-8.05, -2.67, 29, 0), 29),
} };
// Too few independent dates (Biotech:Emerging 5d: 10 dates).
const BIOTECH_EMERGING = { section: 'Biotech', tier: 'Emerging', scope: null, horizons: {
  '3d': h(-5.43, dn(-9.23, -1.49, 11, 1), 11),
  '5d': h(-5.04, dn(-11.18, -0.67, 10, 0), 10),
} };
// CI-negative at contract but no adjacent horizon agrees and 2/4 blocks positive.
const UNDERREACTION = { section: 'Underreaction', tier: 'FRESH_POSITIVE_UNDERREACTION', scope: null, horizons: {
  '3d': h(-0.5, dn(-2.0, 1.0, 16, 2), 16),
  '5d': h(-1.17, dn(-3.66, -0.04, 16, 2), 16),
  '10d': h(-0.8, dn(-3.0, 1.4, 15, 2), 15),
} };
// Short-side section: a negative long-basis record is the DESIGN, never a long AVOID.
const FADE_SHORT = { section: 'Fade', tier: 'SHORT', scope: null, horizons: {
  '3d': h(-2.0, dn(-3.5, -0.5, 26, 0), 26),
  '5d': h(-1.9, dn(-3.6, -0.3, 26, 0), 26),
  '10d': h(-3.0, dn(-5.0, -1.0, 24, 0), 24),
} };
const SUMMARY = { evidenceKeyVersion: 'x', groups: [BREAKOUT_LARGE, EARLY_SMALL, DAYTRADE_A, BIOTECH_EMERGING, UNDERREACTION, FADE_SHORT] };

test('negativeLanes: flags only well-sampled, contract-horizon, adjacent-corroborated long lanes', () => {
  const lanes = NL.negativeLanes(SUMMARY);
  const keys = lanes.map(l => l.key).sort();
  assert.deepEqual(keys, ['screener:Breakout:large', 'screener:Early:small']);
  const bl = lanes.find(l => l.key === 'screener:Breakout:large');
  assert.equal(bl.metric, '5d');
  assert.equal(bl.metricBasis, 'contract');
  assert.equal(bl.avgNetExcess, -2.1);
  assert.deepEqual(bl.ci95, { lo: -4.25, hi: -0.32 });
  assert.equal(bl.effectiveDates, 36);
  assert.equal(bl.positiveBlocks, 0);
  assert.deepEqual(bl.adjacentNegative, ['3d', '10d']);
  assert.match(bl.reason, /CI95 \[-4\.25, -0\.32\]/);
});

test('negativeLanes: contract cell spanning zero is never flagged on post-contract carry', () => {
  assert.equal(NL.negativeLanes({ groups: [DAYTRADE_A] }).length, 0);
});

test('negativeLanes: thresholds are the gate — thin dates, positive blocks, no adjacency, short side all excluded', () => {
  assert.equal(NL.negativeLanes({ groups: [BIOTECH_EMERGING] }).length, 0, 'thin dates');
  assert.equal(NL.negativeLanes({ groups: [UNDERREACTION] }).length, 0, 'positive blocks + no adjacency');
  assert.equal(NL.negativeLanes({ groups: [FADE_SHORT] }).length, 0, 'short-side contract');
  // Loosening the gates in the caller must be an explicit, visible act.
  assert.equal(NL.negativeLanes({ groups: [BIOTECH_EMERGING] }, { minEffectiveDates: 8 }).length, 1);
});

test('negativeLanes: no summary / no groups / legacy records → empty, never throws', () => {
  assert.deepEqual(NL.negativeLanes(null), []);
  assert.deepEqual(NL.negativeLanes({}), []);
  assert.deepEqual(NL.negativeLanes({ groups: [{ section: 'screener', tier: 'Early', scope: 'large', horizons: { '5d': { n: 5, avgNetExcess: -3 } } }] }), []);
});

test('laneKey / findLane: scope-aware join, null scope is its own key', () => {
  const lanes = NL.negativeLanes(SUMMARY);
  assert.equal(NL.laneKey('screener', 'Breakout', 'large'), 'screener:Breakout:large');
  assert.equal(NL.laneKey('daytrade', 'A', null), 'daytrade:A:');
  assert.ok(NL.findLane(lanes, 'screener', 'Early', 'small'));
  assert.equal(NL.findLane(lanes, 'screener', 'Early', 'large'), null, 'large Early must not inherit the small verdict');
  assert.equal(NL.findLane(lanes, 'screener', 'Breakout', null), null);
  assert.equal(NL.findLane(null, 'screener', 'Breakout', 'large'), null);
});

test('negativeLanes: input is not mutated', () => {
  const before = JSON.stringify(SUMMARY);
  NL.negativeLanes(SUMMARY);
  assert.equal(JSON.stringify(SUMMARY), before);
});

test('adjacency: 20d and 1m are twins — a 1m-contract lane needs 10d or 3m to corroborate', () => {
  assert.deepEqual(NL.adjacentKeys('1m'), ['10d', '3m']);
  assert.deepEqual(NL.adjacentKeys('20d'), ['10d', '3m']);
  assert.deepEqual(NL.adjacentKeys('5d'), ['3d', '10d']);
  // CrossAsset contract is 1m, long side. Negative at 1m + 20d ONLY → not a lane.
  const twinOnly = { section: 'CrossAsset', tier: 'Inline', scope: null, horizons: {
    '10d': h(-0.5, dn(-2.0, 1.0, 20, 2), 20),
    '20d': h(-3.0, dn(-5.0, -1.0, 20, 0), 20),
    '1m': h(-3.1, dn(-5.1, -1.1, 20, 0), 20),
  } };
  assert.equal(NL.negativeLanes({ groups: [twinOnly] }).length, 0);
  const withTenDay = { ...twinOnly, horizons: { ...twinOnly.horizons, '10d': h(-2.0, dn(-3.5, -0.5, 20, 0), 20) } };
  const lanes = NL.negativeLanes({ groups: [withTenDay] });
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].metric, '1m');
  assert.deepEqual(lanes[0].adjacentNegative, ['10d']);
});
