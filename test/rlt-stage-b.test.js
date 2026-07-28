'use strict';
// RLT Stage B — trigger objectivity and execution honesty, via the SHARED
// premove trigger/waterfall engine. Guards: touch-without-acceptance is not a
// trigger; gap beyond max entry is triggered-but-NOT-executable (separate
// events, never a fabricated fill); families are classified deterministically.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRltTrigger, assessRltStageB, triggerFamilyFor, TRIGGER_FAMILIES } = require('../lib/rlt-stage-b');
const { planFill, POLICIES } = require('../lib/execution-policy');

const base = { meanRange20: 2, meanVol20: 1e6 };

test('trigger touch WITHOUT acceptance does not trigger', () => {
  // High pokes above the level but the close rejects back below with a big wick.
  const bar = { open: 99, high: 101.5, low: 98.5, close: 99.2, volume: 1e6 };
  const t = evaluateRltTrigger({ bar, level: 101, base });
  assert.equal(t.triggered, false);
  assert.equal(t.reason, 'touch-without-acceptance');
});

test('close acceptance above the level triggers and is executable', () => {
  const bar = { open: 100, high: 103, low: 99.5, close: 102.5, volume: 2e6 };
  const t = evaluateRltTrigger({ bar, level: 101, base, family: 'breakout-acceptance', sectorResidual5: 0.02 });
  assert.equal(t.triggered, true);
  assert.equal(t.executable, true);
  assert.equal(t.family, 'breakout-acceptance');
  assert.equal(t.sectorResidualConfirm, true, 'confirmation recorded alongside, not folded in');
});

test('gap beyond max entry: TRIGGERED but NOT executable — separate events', () => {
  const bar = { open: 110, high: 112, low: 109, close: 111, volume: 2e6 };   // 9% gap over level
  const t = evaluateRltTrigger({ bar, level: 101, base });
  assert.equal(t.triggered, true);
  assert.equal(t.executable, false);
  const b = assessRltStageB({ trigger: t, current: 111, entry: 101, stop: 98, target: 108, dailyVol: 0.02, tier: 'liquid' });
  assert.equal(b.state, 'NO_FILL');
  assert.equal(b.probabilities, null, 'no probabilities without an executable fill');
});

test('no trigger ⇒ Stage B answers WATCH, never a buy', () => {
  const b = assessRltStageB({ trigger: { triggered: false }, current: 100, entry: 101, stop: 98, target: 108, dailyVol: 0.02 });
  assert.equal(b.state, 'WATCH');
  assert.equal(b.action, 'wait');
});

test('an accepted trigger carries SEPARATE named probabilities, all model-estimate', () => {
  const bar = { open: 100, high: 103, low: 99.5, close: 102.5, volume: 2e6 };
  const t = evaluateRltTrigger({ bar, level: 101, base, family: 'tight-range-continuation' });
  const b = assessRltStageB({ trigger: t, current: 102.5, entry: 101, stop: 98, target: 110, dailyVol: 0.02, tier: 'liquid' });
  assert.ok(['ACCEPT_CANDIDATE', 'TRIGGERED_NEGATIVE_UTILITY'].includes(b.state));
  assert.equal(b.probabilities.calibrationStatus, 'model-estimate');
  assert.ok('pFillGivenTrigger' in b.probabilities);
  assert.ok('pTargetBeforeStopGivenFill' in b.probabilities);
  assert.ok('severeLossProbability' in b.probabilities);
  assert.equal(b.family, 'tight-range-continuation');
  // The waterfall's rows literally sum to the net utility (inspectable, not opaque).
  const sum = b.waterfall.rows.reduce((s, r) => s + r.bps, 0);
  assert.ok(Math.abs(sum - b.waterfall.expectedNetUtilityBps) < 0.5);
});

test('trigger families classify deterministically and stay within the enum', () => {
  const fam = triggerFamilyFor({ setup: { pivot: 100, compressionPctile: 0.8, compressionDuration: 5, breakoutAttempts: 0, breakoutRejections: 0 } });
  assert.ok(TRIGGER_FAMILIES.includes(fam));
  assert.equal(fam, 'tight-range-continuation');
  assert.equal(triggerFamilyFor({ setup: null }), null, 'no pivot structure ⇒ no family, never a guess');
});

test('next-session execution: the entry can never fill on the signal bar', () => {
  const candles = [
    { date: '2026-07-20', open: 100, high: 101, low: 99, close: 100.5 },
    { date: '2026-07-21', open: 100.6, high: 102, low: 100, close: 101.5 },
  ];
  const fill = planFill(candles, '2026-07-20', { policy: POLICIES.NEXT_OPEN, side: 'long', tier: 'liquid' });
  assert.equal(fill.filled, true);
  assert.equal(fill.earliestFillDate, '2026-07-21');
  assert.ok(fill.timestamps.earliestExecutableAt > fill.timestamps.signalGeneratedAt);
});
