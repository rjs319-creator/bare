'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  makePrediction, validatePrediction, prob, isProbabilityField, isRankField,
  PROBABILITY_FIELDS, FIELD_DEFAULTS,
} = require('../lib/prediction-contract');

test('unknown probabilities default to null WITH a reason, never fabricated', () => {
  const p = makePrediction({ validationStatus: 'research' });
  for (const f of PROBABILITY_FIELDS) {
    assert.equal(p[f], null, `${f} should default to null`);
    assert.ok(p.nulls[f], `${f} must carry a null-reason`);
  }
});

test('a rank is not a probability — the taxonomy keeps them separate', () => {
  assert.equal(isRankField('rankPercentile'), true);
  assert.equal(isProbabilityField('rankPercentile'), false);
  assert.equal(isProbabilityField('pTrigger'), true);
});

test('rankPercentile accepts [0,1] and rejects a value dressed up as a probability >1', () => {
  assert.equal(makePrediction({ rankPercentile: 0.9 }).rankPercentile, 0.9);
  assert.throws(() => makePrediction({ rankPercentile: 90 }), /percentile in \[0,1\]/);
});

test('a probability outside [0,1] is a hard error (no silent clamp)', () => {
  assert.throws(() => makePrediction({ pTrigger: 1.4 }), /\[0,1\]/);
  assert.throws(() => makePrediction({ pTargetBeforeStopGivenFill: -0.1 }), /\[0,1\]/);
});

test('prob() guards range and surfaces the null reason', () => {
  assert.deepEqual(prob(0.3), { value: 0.3, reason: null });
  assert.deepEqual(prob(null, 'no borrow data'), { value: null, reason: 'no borrow data' });
  assert.throws(() => prob(2), /out of \[0,1\]/);
});

test('safety flags default pessimistic (unsafe until proven)', () => {
  const p = makePrediction({});
  assert.equal(p.survivorshipSafe, false);
  assert.equal(p.pointInTimeSafe, false);
  assert.equal(p.calibrationStatus, 'unknown');
  assert.equal(p.validationStatus, 'unknown');
});

test('invalid enum status is rejected', () => {
  assert.throws(() => makePrediction({ calibrationStatus: 'perfect' }), /calibrationStatus/);
  assert.throws(() => makePrediction({ validationStatus: 'amazing' }), /validationStatus/);
});

test('uncertaintyInterval must be well-formed', () => {
  assert.throws(() => makePrediction({ uncertaintyInterval: { lo: 0.5, hi: 0.2 } }), /uncertaintyInterval/);
  const p = makePrediction({ uncertaintyInterval: { lo: 0.1, hi: 0.3, metric: 'pTargetBeforeStop' } });
  assert.equal(p.uncertaintyInterval.hi, 0.3);
});

test('extra carries domain-specific fields without polluting the canonical set', () => {
  const p = makePrediction({ extra: { pAbnormalExpansion: 0.076 } });
  assert.equal(p.extra.pAbnormalExpansion, 0.076);
  assert.equal('pAbnormalExpansion' in FIELD_DEFAULTS, false);
});

test('validatePrediction flags a null probability missing its reason', () => {
  const bad = { pTrigger: null, nulls: {}, calibrationStatus: 'unknown', validationStatus: 'unknown' };
  const r = validatePrediction(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /pTrigger is null without a reason/.test(e)));
});

test('validatePrediction passes a well-formed canonical prediction', () => {
  const p = makePrediction({
    rankPercentile: 0.8, pTrigger: 0.4, calibrationStatus: 'model-estimate', validationStatus: 'research',
  });
  assert.deepEqual(validatePrediction(p), { ok: true, errors: [] });
});

test('output is frozen (immutability contract)', () => {
  const p = makePrediction({});
  assert.throws(() => { p.pTrigger = 0.5; }, TypeError);
});
