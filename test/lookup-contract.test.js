'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/lookup-contract');

const base = (over = {}) => ({
  ticker: 'aapl', horizon: 'swing', engine: 'swingread', modelVersion: 'swing-v1',
  direction: 'bullish', setupState: 'forming', action: 'WATCH',
  dataAsOf: '2026-08-03T14:00:00.000Z', marketSession: 'regular',
  freshnessState: 'live', barComplete: true, evidenceStrength: 6,
  executionAllowed: true, evidenceFamilies: ['price-trend'],
  ...over,
});

test('makeSignal normalizes ticker case and freezes the record', () => {
  const s = C.makeSignal(base());
  assert.strictEqual(s.ticker, 'AAPL');
  assert.ok(Object.isFrozen(s));
  assert.throws(() => { 'use strict'; s.action = 'TRIGGERED'; });
});

test('TRIGGERED without a confirmed trigger is demoted to WATCH/READY with a warning', () => {
  const forming = C.makeSignal(base({ action: 'TRIGGERED', setupState: 'forming' }));
  assert.strictEqual(forming.action, 'WATCH');
  assert.ok(forming.warnings.some(w => /trigger has not occurred/i.test(w)));
  const ready = C.makeSignal(base({ action: 'TRIGGERED', setupState: 'ready' }));
  assert.strictEqual(ready.action, 'READY');
});

test('TRIGGERED without executionAllowed is demoted to READY', () => {
  const s = C.makeSignal(base({ action: 'TRIGGERED', setupState: 'triggered', executionAllowed: false }));
  assert.strictEqual(s.action, 'READY');
  assert.ok(s.warnings.some(w => /execution not allowed/i.test(w)));
});

test('a genuine TRIGGERED (confirmed trigger + execution allowed) survives', () => {
  const s = C.makeSignal(base({ action: 'TRIGGERED', setupState: 'triggered', executionAllowed: true }));
  assert.strictEqual(s.action, 'TRIGGERED');
  assert.deepStrictEqual([...s.warnings], []);
});

test('a probability WITHOUT a calibration artifact is dropped, never displayed', () => {
  const s = C.makeSignal(base({ calibratedProbability: 0.63 }));
  assert.strictEqual(s.calibratedProbability, null);
  assert.ok(s.warnings.some(w => /calibration artifact/i.test(w)));
});

test('a probability WITH a valid out-of-sample artifact is kept and clamped', () => {
  const artifact = { version: 'cal-v3', sampleSize: 512, outOfSample: true, horizon: 'swing' };
  const s = C.makeSignal(base({ calibratedProbability: 1.4, calibrationArtifact: artifact }));
  assert.strictEqual(s.calibratedProbability, 1);
  assert.deepStrictEqual(s.calibrationArtifact, artifact);
});

test('an in-sample or thin artifact does NOT unlock probability display', () => {
  const inSample = { version: 'cal-v3', sampleSize: 512, outOfSample: false, horizon: 'swing' };
  const thin = { version: 'cal-v3', sampleSize: 40, outOfSample: true, horizon: 'swing' };
  assert.strictEqual(C.makeSignal(base({ calibratedProbability: 0.6, calibrationArtifact: inSample })).calibratedProbability, null);
  assert.strictEqual(C.makeSignal(base({ calibratedProbability: 0.6, calibrationArtifact: thin })).calibratedProbability, null);
});

test('evidenceStrength is clamped to 0–10 and unknown values become null', () => {
  assert.strictEqual(C.makeSignal(base({ evidenceStrength: 14 })).evidenceStrength, 10);
  assert.strictEqual(C.makeSignal(base({ evidenceStrength: undefined })).evidenceStrength, null);
});

test('unknown evidence families are filtered out', () => {
  const s = C.makeSignal(base({ evidenceFamilies: ['price-trend', 'astrology'] }));
  assert.deepStrictEqual([...s.evidenceFamilies], ['price-trend']);
});

test('validateSignal rejects a hand-built TRIGGERED-without-confirmation record', () => {
  const bad = { ...C.makeSignal(base()), action: 'TRIGGERED', setupState: 'forming' };
  const v = C.validateSignal(bad);
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /TRIGGERED requires/i.test(e)));
});

test('validateSignal accepts every makeSignal output', () => {
  for (const action of C.ACTIONS) {
    const s = C.makeSignal(base({ action, setupState: 'triggered', executionAllowed: true }));
    assert.strictEqual(C.validateSignal(s).valid, true, `action ${action}`);
  }
});

test('deterministic — identical inputs give identical output', () => {
  assert.deepStrictEqual(C.makeSignal(base()), C.makeSignal(base()));
});
