'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { applyGates } = require('../lib/biotech-gates');
const { ACTION, ARCHETYPES: A, CAPITAL_STATES: S, DATA_QUALITY } = require('../lib/biotech-config');

const liquid = { avgDollarVol: 3e7, price: 12 };

test('unverified catalyst cannot reach PRIMARY-SOURCE CONFIRMED', () => {
  const g = applyGates({ archetype: A.POST_CATALYST, event: { verified: false }, liquidity: liquid, plan: { rewardRisk: 2, planStatus: 'ready' } });
  assert.notEqual(g.actionCeiling, ACTION.PRIMARY_CONFIRMED);
});

test('verified + liquid + valid R:R can reach PRIMARY-SOURCE CONFIRMED', () => {
  const g = applyGates({ archetype: A.POST_CATALYST, event: { verified: true, verification: 'PRIMARY' }, liquidity: liquid, plan: { rewardRisk: 2, planStatus: 'ready' } });
  assert.equal(g.actionCeiling, ACTION.PRIMARY_CONFIRMED);
});

test('insufficient liquidity → NON-EXECUTABLE', () => {
  const g = applyGates({ archetype: A.POST_CATALYST, event: { verified: true }, liquidity: { avgDollarVol: 500000, price: 3 }, plan: { rewardRisk: 2 } });
  assert.equal(g.actionCeiling, ACTION.NON_EXECUTABLE);
});

test('pending offering → WAIT FOR FINANCING; severe dilution → AVOID', () => {
  const pend = applyGates({ archetype: A.POST_CATALYST, event: { verified: true }, capital: { state: S.PENDING_OFFERING }, liquidity: liquid, plan: { rewardRisk: 2 } });
  assert.equal(pend.actionCeiling, ACTION.WAIT_FOR_FINANCING);
  const severe = applyGates({ archetype: A.POST_CATALYST, event: { verified: true }, capital: { state: S.SEVERE_DILUTION_RISK }, liquidity: liquid, plan: { rewardRisk: 2 } });
  assert.equal(severe.actionCeiling, ACTION.AVOID);
});

test('binary watch archetype → BINARY WATCH ONLY', () => {
  const g = applyGates({ archetype: A.BINARY_WATCH, event: { verified: false }, liquidity: liquid, plan: { rewardRisk: 2 } });
  assert.equal(g.actionCeiling, ACTION.BINARY_WATCH_ONLY);
});

test('overextended / consumed move → LATE', () => {
  const g = applyGates({ archetype: A.POST_CATALYST, event: { verified: true }, features: { extAtr: 5 }, liquidity: liquid, plan: { rewardRisk: 2 } });
  assert.equal(g.actionCeiling, ACTION.LATE);
});

test('invalid reward:risk → WAIT', () => {
  const g = applyGates({ archetype: A.POST_CATALYST, event: { verified: true }, liquidity: liquid, plan: { rewardRisk: 1.0, planStatus: 'ready' } });
  assert.equal(g.actionCeiling, ACTION.WAIT_FOR_TRIGGER);
});

test('conflicting evidence → NEEDS REVIEW', () => {
  const g = applyGates({ archetype: A.POST_CATALYST, event: { verified: false, verification: 'CONFLICTED', conflicts: ['x'] }, liquidity: liquid, plan: { rewardRisk: 2 } });
  assert.equal(g.actionCeiling, ACTION.NEEDS_REVIEW);
});

test('unidentified reason + thin liquidity → WATCH ONLY', () => {
  const g = applyGates({ archetype: A.UNCLASSIFIED, aiClass: 'NOISE', liquidity: { avgDollarVol: 3e6, price: 4 }, plan: { rewardRisk: 2 } });
  assert.equal(g.actionCeiling, ACTION.WATCH_ONLY);
});

test('missing critical data never presents as actionable', () => {
  const g = applyGates({ archetype: A.POST_CATALYST, event: { verified: true }, liquidity: liquid, plan: { rewardRisk: 2, planStatus: 'ready' }, dataQuality: DATA_QUALITY.MISSING });
  assert.ok(['WATCH ONLY', 'NON-EXECUTABLE', 'AVOID'].includes(g.actionCeiling));
});

test('severe-loss risk flagged High for binary-ahead without exit-before', () => {
  const g = applyGates({ archetype: A.BINARY_WATCH, timing: 'Ahead', hasExitBefore: false, liquidity: liquid, plan: {} });
  assert.equal(g.severeLossRisk, 'High');
});
