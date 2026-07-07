const { test } = require('node:test');
const assert = require('node:assert');
const { buildFeedbackDigest } = require('../lib/feedback-digest');

test('returns empty when the screener is absent or every class is still calibrating', () => {
  assert.equal(buildFeedbackDigest('Anomaly', null), '');
  assert.equal(buildFeedbackDigest('Anomaly', { sections: {} }), '');
  assert.equal(buildFeedbackDigest('Anomaly', { sections: { Anomaly: {
    classes: { Accumulation: { n: 4, beatRate: 50, verdict: 'CALIBRATING' } },
    attributes: { conviction: { label: 'confidence', n: 5, rankIC: 0.2, verdict: 'CALIBRATING' } },
  } } }), '');
});

test('summarizes graded classes (PROVEN/DUD) and skips calibrating ones', () => {
  const d = buildFeedbackDigest('Anomaly', { sections: { Anomaly: {
    classes: {
      Accumulation: { n: 22, beatRate: 61, verdict: 'PROVEN' },
      Explained:    { n: 19, beatRate: 37, verdict: 'DUD' },
      Noise:        { n: 6,  beatRate: 50, verdict: 'CALIBRATING' }, // skipped
    },
    attributes: null,
  } } });
  assert.match(d, /PERFORMANCE FEEDBACK/);
  assert.match(d, /"Accumulation" calls have beaten their sector 61% .* over 22 resolved picks \(reliable/);
  assert.match(d, /"Explained" calls have beaten their sector 37% .* \(weak/);
  assert.doesNotMatch(d, /"Noise"/); // calibrating class not surfaced
});

test('reports conviction calibration verdicts with the right steer', () => {
  const mk = conviction => buildFeedbackDigest('SecondWave', { sections: { SecondWave: {
    classes: {}, attributes: { conviction },
  } } });
  assert.match(mk({ label: 'virality', n: 30, rankIC: 0.18, verdict: 'CALIBRATED' }), /HAS tracked outcomes \(rank-IC \+0\.18\)/);
  assert.match(mk({ label: 'virality', n: 30, rankIC: -0.16, verdict: 'INVERTED' }), /INVERTED \(rank-IC -0\.16\).*sceptical/);
  assert.match(mk({ label: 'virality', n: 30, rankIC: 0.02, verdict: 'NOISE' }), /NOT separated winners from losers/);
});
