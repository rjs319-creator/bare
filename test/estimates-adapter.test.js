'use strict';
// Shadow estimates adapter: the PIT rule (asOf fail-closed), safe scaling on
// near-zero EPS, and the shadow/PIT_UNPROVEN stamp on every output.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeObservation, asOf, latestAsOf, revision30d, revisionBreadth,
  revisionAcceleration, disagreementChange, daysToEarnings,
  missingnessAndStaleness, shadowFeatures, contentHash, PIT_STATUS, EPS_SCALE_FLOOR,
} = require('../lib/research/estimates-adapter');

const obs = (knownAt, estimateValue, extra = {}) => ({
  securityId: 'SEC1', symbolAtObservation: 'AAPL', fiscalPeriod: '2026-Q3', metric: 'EPS',
  estimateValue, estimateType: 'consensus_mean', analystCount: 10, upRevisions: 2,
  downRevisions: 1, dispersion: 0.05, sourcePublishedAt: knownAt, knownAt,
  ingestedAt: null, source: 'test', rawContentHash: 'x', provenance: {},
  ...extra,
});

test('asOf returns only observations genuinely available by the decision time', () => {
  const set = [obs('2026-05-01', 1.0), obs('2026-06-01', 1.1), obs('2026-07-15', 1.2)];
  const eligible = asOf(set, '2026-06-30');
  assert.deepEqual(eligible.map(o => o.knownAt), ['2026-05-01', '2026-06-01']);
  assert.equal(latestAsOf(set, '2026-06-30').estimateValue, 1.1);
});

test('asOf is fail-closed: missing/unparseable knownAt is excluded, bad decision ts returns nothing', () => {
  const set = [obs(null, 9.9), obs('not-a-date', 8.8), obs('2026-06-01', 1.1)];
  assert.equal(asOf(set, '2026-07-01').length, 1);
  assert.deepEqual(asOf(set, 'garbage'), []);
});

test('revision windows report raw and floor-scaled normalized change', () => {
  const set = [obs('2026-06-01', 1.0), obs('2026-07-01', 1.2)];
  const r = revision30d(set, '2026-07-02');
  assert.ok(Math.abs(r.raw - 0.2) < 1e-12);
  assert.ok(Math.abs(r.normalized - 0.2) < 1e-12);
  assert.equal(r.windowDays, 30);
});

test('near-zero and negative EPS bases use the scale floor, never exploding percentages', () => {
  const nearZero = [obs('2026-06-01', 0.001), obs('2026-07-01', 0.101)];
  const r = revision30d(nearZero, '2026-07-02');
  assert.ok(Math.abs(r.normalized - (0.1 / EPS_SCALE_FLOOR)) < 1e-9, 'divides by floor, not 0.001');
  const negative = [obs('2026-06-01', -0.5), obs('2026-07-01', -0.4)];
  const rn = revision30d(negative, '2026-07-02');
  assert.ok(Math.abs(rn.raw - 0.1) < 1e-12);
  assert.ok(Math.abs(rn.normalized - 0.2) < 1e-12, 'scales by |prev|');
});

test('breadth, acceleration, disagreement and daysToEarnings compute or return null honestly', () => {
  const hist = [
    obs('2026-04-10', 1.0, { dispersion: 0.10 }), obs('2026-05-10', 1.0),
    obs('2026-06-10', 1.05, { dispersion: 0.06 }), obs('2026-07-01', 1.2, { upRevisions: 5, downRevisions: 1, analystCount: 12 }),
  ];
  assert.ok(Math.abs(revisionBreadth(hist, '2026-07-02') - 4 / 12) < 1e-12);
  const acc = revisionAcceleration(hist, '2026-07-02');
  assert.ok(acc.raw > 0, 'revisions sped up');
  const dis = disagreementChange(hist, '2026-07-02', 60);
  assert.ok(dis.raw < 0, 'disagreement narrowed');
  assert.equal(daysToEarnings('2026-07-02', '2026-07-30'), 28);
  assert.equal(daysToEarnings('2026-07-02', null), null);
  assert.equal(revisionBreadth([obs('2026-06-01', 1, { upRevisions: null })], '2026-07-01'), null);
});

test('missingness and staleness are reported as of the decision time', () => {
  const set = [obs('2026-06-01', 1.1, { dispersion: null })];
  const m = missingnessAndStaleness(set, '2026-06-11');
  assert.equal(m.eligibleCount, 1);
  assert.equal(m.staleDays, 10);
  assert.deepEqual(m.missingFields, ['dispersion']);
});

test('every shadowFeatures output is shadow-only, PIT_UNPROVEN, and probability-free', () => {
  const f = shadowFeatures([obs('2026-06-01', 1.0), obs('2026-07-01', 1.1)], '2026-07-02');
  assert.equal(f.shadow, true);
  assert.equal(f.pitStatus, 'PIT_UNPROVEN');
  assert.equal(PIT_STATUS, 'PIT_UNPROVEN');
  assert.ok(Object.isFrozen(f), 'output is immutable');
  const flat = JSON.stringify(f).toLowerCase();
  for (const banned of ['probability', 'prob"', 'score', 'rank', 'weight']) {
    assert.ok(!flat.includes(banned), `output must not carry ${banned}`);
  }
});

test('normalizeObservation maps vendor fields, hashes raw content stably, and fails closed on knownAt', () => {
  const raw = { m_ticker: 'AAPL', per_end: '2026-Q3', mean_est: '1.25', obs_date: '2026-07-01', n: '11' };
  const fields = { ticker: 'm_ticker', fiscalPeriod: 'per_end', estimateValue: 'mean_est', asOfDate: 'obs_date', analystCount: 'n' };
  const o = normalizeObservation(raw, fields, { source: 'test-vendor' });
  assert.equal(o.symbolAtObservation, 'AAPL');
  assert.equal(o.estimateValue, 1.25);
  assert.equal(o.knownAt, '2026-07-01');
  assert.equal(o.provenance.shadow, true);
  assert.equal(o.provenance.pitStatus, 'PIT_UNPROVEN');
  assert.equal(o.rawContentHash, contentHash(raw), 'hash is deterministic');
  assert.equal(contentHash({ b: 1, a: 2 }), contentHash({ a: 2, b: 1 }), 'key order does not change the hash');
  const noDate = normalizeObservation({ m_ticker: 'AAPL' }, fields);
  assert.equal(noDate.knownAt, null);
  assert.deepEqual(asOf([noDate], '2026-07-01'), [], 'unknown availability is excluded from as-of');
});
