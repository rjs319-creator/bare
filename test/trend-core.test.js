'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consolidateTrend, PRICE_TREND_ENGINES } = require('../lib/trend-core');
const { validatePrediction } = require('../lib/prediction-contract');

test('six agreeing trend engines count as ONE price domain, not six', () => {
  const reads = {};
  for (const e of ['screener', 'momentum', 'apex', 'ignition', 'trendrider', 'confluence']) {
    reads[e] = { percentile: 0.9, bullish: true };
  }
  const r = consolidateTrend(reads);
  assert.equal(r.independentEvidenceDomains, 1);   // price is ONE domain regardless of count
  assert.equal(r.contributingEngines.length, 6);
  assert.equal(r.directionAgreement, 1);
});

test('a distinct overlay adds exactly one independent domain', () => {
  const reads = { apex: { percentile: 0.8, bullish: true }, momentum: { percentile: 0.8, bullish: true } };
  const withVol = consolidateTrend(reads, { volumeAccum: { present: true } });
  assert.equal(withVol.independentEvidenceDomains, 2);   // price + volume
  const withTwo = consolidateTrend(reads, { volumeAccum: { present: true }, insiderCluster: { present: true } });
  assert.equal(withTwo.independentEvidenceDomains, 3);
});

test('consolidation is a median rank — robust to piling on more correlated engines', () => {
  const base = { apex: { percentile: 0.7 }, momentum: { percentile: 0.7 }, screener: { percentile: 0.7 } };
  const piled = { ...base, ignition: { percentile: 0.7 }, trendrider: { percentile: 0.7 }, confluence: { percentile: 0.7 } };
  assert.equal(consolidateTrend(base).priceTrendPercentile, consolidateTrend(piled).priceTrendPercentile);
});

test('wide disagreement shades evidence strength and model confidence DOWN', () => {
  const tight = consolidateTrend({ apex: { percentile: 0.8 }, momentum: { percentile: 0.82 } });
  const split = consolidateTrend({ apex: { percentile: 0.95 }, momentum: { percentile: 0.15 } });
  assert.ok(split.evidenceStrength < tight.evidenceStrength);
  assert.ok(split.prediction.modelConfidence < tight.prediction.modelConfidence);
});

test('the prediction is SHADOW, uncalibrated, survivorship-unsafe, and valid', () => {
  const r = consolidateTrend({ apex: { percentile: 0.6, bullish: true } });
  assert.equal(r.prediction.validationStatus, 'shadow');
  assert.equal(r.prediction.calibrationStatus, 'uncalibrated');
  assert.equal(r.prediction.survivorshipSafe, false);
  assert.equal(validatePrediction(r.prediction).ok, true);
  // rankPercentile is a rank; there is NO fabricated win probability
  assert.equal(r.prediction.pTargetBeforeStopGivenFill, null);
  assert.ok(r.prediction.nulls.pTargetBeforeStopGivenFill);
});

test('returns null when no price-trend engine reported', () => {
  assert.equal(consolidateTrend({}), null);
  assert.equal(consolidateTrend({ someRandomEngine: { percentile: 0.9 } }), null);
});

test('PRICE_TREND_ENGINES excludes ghost (volume-accum is its own domain)', () => {
  assert.equal(PRICE_TREND_ENGINES.includes('ghost'), false);
});

// quant-redesign-3 guard: this list claimed to "match lib/decision.js SOURCE_FAMILY" but
// had drifted (listed a non-existent 'breakout' id, omitted gapgo/daytrade/coil). Pin
// the alignment both ways so it cannot drift silently again.
test('PRICE_TREND_ENGINES is a subset of SOURCE_FAMILY priceTrend ids (family map may be wider)', () => {
  // PR-02 (graduation-league) extended SOURCE_FAMILY to cover EVERY canonical id so
  // no strategy gets silent full-independence credit — including research verticals
  // (omega, atlasx, rlt, orbit, …) that trend-core does not consolidate. The
  // invariant that matters both ways: every consolidated engine must be mapped
  // priceTrend, and the original engine set must still be present.
  const { SOURCE_FAMILY } = require('../lib/decision');
  const familyIds = new Set(Object.keys(SOURCE_FAMILY).filter(k => SOURCE_FAMILY[k] === 'priceTrend'));
  for (const id of PRICE_TREND_ENGINES) {
    assert.ok(familyIds.has(id), `${id} consolidated by trend-core but not mapped priceTrend`);
  }
  for (const id of ['screener', 'momentum', 'apex', 'ignition', 'trendrider', 'coremo', 'gapgo', 'daytrade', 'coil', 'confluence']) {
    assert.ok(familyIds.has(id), `core engine ${id} missing from the priceTrend family`);
  }
});
