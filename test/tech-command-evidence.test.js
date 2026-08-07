'use strict';
// Evidence architecture: correlated families are discounted, missing data lowers
// quality, research overlays carry weight zero, and a probability is blocked unless
// every calibration condition holds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EV = require('../lib/tech-command-evidence');

const ev = (family, strength, quality = 'high', extra = {}) =>
  EV.makeEvidence({ family, label: family, strength, quality, source: 'test', ...extra });

test('correlated families collapse: three trend reads are not three confirmations', () => {
  const single = EV.composeEvidence([ev('price-trend', 1)]);
  const triple = EV.composeEvidence([ev('price-trend', 1), ev('relative-strength', 1), ev('pattern-structure', 1)]);
  // Adding two correlated members must not raise the composite the way three
  // independent families would.
  assert.ok(triple.score <= single.score + 1,
    `correlated agreement inflated the score (${single.score} → ${triple.score})`);
  const discounted = triple.contributions.filter(c => c.correlationDiscount < 1);
  assert.ok(discounted.length >= 1, 'at least one correlated member must be discounted');
  assert.equal(discounted[0].correlationDiscount, EV.WITHIN_CLUSTER_DISCOUNT);
});

test('the strongest member of a cluster counts fully; the rest are discounted', () => {
  const c = EV.composeEvidence([ev('price-trend', 0.2), ev('relative-strength', 0.9)]);
  const full = c.contributions.find(x => x.correlationDiscount === 1);
  assert.equal(full.family, 'relative-strength');
});

test('research-only families carry weight ZERO and cannot lift a score', () => {
  const withoutOverlay = EV.composeEvidence([ev('price-trend', 0.5)]);
  const withOverlay = EV.composeEvidence([
    ev('price-trend', 0.5), ev('options-positioning', 1), ev('social', 1), ev('insider', 1), ev('analyst-revisions', 1),
  ]);
  assert.equal(withOverlay.score, withoutOverlay.score,
    'a weight-0 overlay changed the actionable score');
  assert.ok(withOverlay.researchOnlyAnnotations.length >= 4);
  for (const f of ['options-positioning', 'social', 'insider', 'analyst-revisions', 'pattern-structure']) {
    assert.equal(EV.BASE_WEIGHTS[f], 0, `${f} must carry weight 0`);
  }
});

test('a contradicting overlay is still surfaced even though it carries no weight', () => {
  const c = EV.composeEvidence([ev('price-trend', 0.6), ev('options-positioning', -1, 'high', { direction: 'contradicting' })]);
  assert.ok(c.contradicting.some(x => x.family === 'options-positioning'));
});

test('missing evidence families reduce quality — they never read as neutral-good', () => {
  const rich = EV.composeEvidence([
    ev('price-trend', 0.5), ev('relative-strength', 0.5), ev('participation', 0.5),
    ev('volatility-execution', 0.5), ev('events-catalysts', 0.5), ev('market-regime', 0.5),
  ], { expectedFamilies: ['price-trend', 'relative-strength', 'participation', 'volatility-execution', 'events-catalysts', 'market-regime'] });
  const thin = EV.composeEvidence([ev('price-trend', 0.5)], {
    expectedFamilies: ['price-trend', 'relative-strength', 'participation', 'volatility-execution', 'events-catalysts', 'market-regime'],
  });
  assert.equal(rich.evidenceQuality, 'high');
  assert.ok(['low', 'insufficient'].includes(thin.evidenceQuality));
  assert.ok(thin.coveragePct < rich.coveragePct);
  assert.ok(thin.missingFamilies.includes('relative-strength'));
});

test('low-quality inputs are down-weighted relative to high-quality ones', () => {
  const high = EV.composeEvidence([ev('price-trend', 1, 'high')]);
  const unknown = EV.composeEvidence([ev('price-trend', 1, 'unknown')]);
  const hi = high.contributions[0], lo = unknown.contributions[0];
  assert.ok(lo.effectiveWeight < hi.effectiveWeight);
});

test('a probability is BLOCKED without a valid, matching calibration artifact', () => {
  const noArtifact = EV.probabilityDisplay({ outcome: 'reaching +8% before -4%', horizon: '21 sessions', modelVersion: 'x-v1', value: 0.6 });
  assert.equal(noArtifact.probability, null);
  assert.equal(noArtifact.blocked, true);
  assert.ok(noArtifact.reasons.some(r => /calibration artifact/.test(r)));

  const smallSample = EV.probabilityDisplay({
    outcome: 'o', horizon: 'h', modelVersion: 'x-v1', value: 0.6,
    artifact: { version: 'a', sampleSize: 10, outOfSample: true, horizon: 'h' },
  });
  assert.equal(smallSample.probability, null);

  const inSample = EV.probabilityDisplay({
    outcome: 'o', horizon: 'h', modelVersion: 'x-v1', value: 0.6,
    artifact: { version: 'a', sampleSize: 500, outOfSample: false, horizon: 'h' },
  });
  assert.equal(inSample.probability, null);

  const wrongModel = EV.probabilityDisplay({
    outcome: 'o', horizon: 'h', modelVersion: 'x-v2', value: 0.6,
    artifact: { version: 'a', sampleSize: 500, outOfSample: true, horizon: 'h', modelVersion: 'x-v1' },
  });
  assert.equal(wrongModel.probability, null);
  assert.ok(wrongModel.reasons.some(r => /different model version/.test(r)));
});

test('a vague probability request is refused even with a valid artifact', () => {
  const vague = EV.probabilityDisplay({
    value: 0.6, horizon: '21 sessions', modelVersion: 'x-v1',
    artifact: { version: 'a', sampleSize: 500, outOfSample: true, horizon: '21 sessions', modelVersion: 'x-v1' },
  });
  assert.equal(vague.probability, null);
  assert.ok(vague.reasons.some(r => /outcome is not precisely defined/.test(r)));
});

test('a fully-qualified request produces a precisely-labeled probability', () => {
  const ok = EV.probabilityDisplay({
    outcome: 'reaching +8% before -4%', horizon: '21 sessions', modelVersion: 'x-v1', value: 0.62,
    artifact: { version: 'cal-1', sampleSize: 500, outOfSample: true, horizon: '21 sessions', modelVersion: 'x-v1' },
  });
  assert.equal(ok.blocked, false);
  assert.equal(ok.probability, 0.62);
  assert.match(ok.label, /probability of reaching \+8% before -4% within 21 sessions/);
});

test('the composite is labeled a relative setup score, never a probability', () => {
  const c = EV.composeEvidence([ev('price-trend', 0.5)]);
  assert.match(c.scoreLabel, /uncalibrated/);
  assert.ok(!('probability' in c));
});

test('percentileWithin is the honest alternative and refuses a thin population', () => {
  assert.equal(EV.percentileWithin(5, [1, 2]), null);
  assert.equal(EV.percentileWithin(5, [1, 2, 3, 4, 5]), 100);
  assert.equal(EV.percentileWithin(1, [1, 2, 3, 4, 5]), 20);
});
