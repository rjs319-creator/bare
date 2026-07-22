'use strict';
// STEP 10b — the confirmation engine. Options evidence is judged AGAINST an independent
// stock setup: confirm → REVIEW, conflict/hedge/event → AVOID, ambiguous → WAIT. Every
// level in the record comes from the setup (chart math), never options.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agreement, buildDecision, bucketViews } = require('../lib/options-confirm');

const longSetup = { direction: 'long', valid: true, quality: 0.7, spot: 100, trigger: 105, invalidation: 95, target: 125, support: 96, resistance: 105, rr: 2 };
const noSetup = { direction: 'none', valid: false };

test('agreement matches options lean to setup direction', () => {
  assert.equal(agreement('long', 'PROVISIONAL_BULLISH'), 'confirms');
  assert.equal(agreement('long', 'PROVISIONAL_BEARISH'), 'contradicts');
  assert.equal(agreement('short', 'PROVISIONAL_BEARISH'), 'confirms');
  assert.equal(agreement('long', 'MIXED'), 'mixed');
  assert.equal(agreement('long', 'DIRECTION_UNKNOWN'), 'unknown');
});

test('confirming options on a valid setup → REVIEW (confirmation view), with chart-math levels', () => {
  const d = buildDecision(longSetup, {
    ticker: 'NVDA', directionState: 'PROVISIONAL_BULLISH', directionLabel: 'Provisional bullish',
    unknownShare: 0.2, oiConfirmedContracts: 3,
  });
  assert.equal(d.action, 'REVIEW');
  assert.equal(d.view, 'confirmation');
  assert.equal(d.confirmationState, 'confirms');
  assert.equal(d.evidenceQuality, 'clear');
  // levels come from the setup, not the options
  assert.equal(d.trigger, 105);
  assert.equal(d.invalidation, 95);
  assert.equal(d.target, 125);
  assert.equal(d.researchMaturity, 'shadow');
});

test('contradicting options → AVOID (contradiction view)', () => {
  const d = buildDecision(longSetup, { ticker: 'X', directionState: 'PROVISIONAL_BEARISH', directionLabel: 'Provisional bearish', unknownShare: 0.2, oiConfirmedContracts: 1 });
  assert.equal(d.action, 'AVOID');
  assert.equal(d.view, 'contradiction');
  assert.equal(d.confirmationState, 'contradicts');
});

test('mixed/unknown options on a valid setup → WAIT (neutral)', () => {
  const d = buildDecision(longSetup, { ticker: 'X', directionState: 'MIXED', unknownShare: 0.5 });
  assert.equal(d.action, 'WAIT');
  assert.equal(d.view, 'neutral');
});

test('index/ETF flow → AVOID (hedge ambiguity)', () => {
  const d = buildDecision(longSetup, { ticker: 'SPY', isIndex: true, directionState: 'PROVISIONAL_BULLISH', unknownShare: 0.1, oiConfirmedContracts: 5 });
  assert.equal(d.action, 'AVOID');
  assert.equal(d.liquidityQuality, 'index-hedge');
});

test('earnings before expiry with unclear evidence → AVOID (event risk)', () => {
  const d = buildDecision(longSetup, { ticker: 'X', directionState: 'PROVISIONAL_BULLISH', unknownShare: 0.6, earningsBeforeExpiry: true });
  assert.equal(d.action, 'AVOID');
  assert.equal(d.eventRisk, 'earnings-before-expiry');
});

test('no valid stock setup → WAIT, raw-only (options cannot confirm nothing)', () => {
  const d = buildDecision(noSetup, { ticker: 'X', directionState: 'PROVISIONAL_BULLISH', unknownShare: 0.2, oiConfirmedContracts: 3 });
  assert.equal(d.action, 'WAIT');
  assert.equal(d.view, 'neutral');
  assert.equal(d.setupValid, false);
  assert.match(d.reasons.join(' '), /No valid stock setup/);
});

test('bucketViews splits into confirmations / contradictions / raw(all)', () => {
  const decisions = [
    buildDecision(longSetup, { ticker: 'A', directionState: 'PROVISIONAL_BULLISH', unknownShare: 0.2, oiConfirmedContracts: 2 }),
    buildDecision(longSetup, { ticker: 'B', directionState: 'PROVISIONAL_BEARISH', unknownShare: 0.2, oiConfirmedContracts: 1 }),
    buildDecision(longSetup, { ticker: 'C', directionState: 'MIXED', unknownShare: 0.5 }),
  ];
  const v = bucketViews(decisions);
  assert.equal(v.confirmations.length, 1);
  assert.equal(v.contradictions.length, 1);
  assert.equal(v.raw.length, 3);   // Raw shows everything
});
