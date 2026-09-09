'use strict';
// Adjacent-horizon reads on the maturity grade (2026-09-09 alpha pass). A strategy is
// graded ONLY on its contract horizon (correct — anything else is max-of-7 mining), but
// the grade said nothing when the neighbouring bars were CI-negative: Ghost:STALKING:large
// graded `promising` on 5d +0.28 while 1d (−0.42, CI [−1.39,−0.14]) and 3d (−0.90,
// [−2.70,−0.36]) were significantly negative. This is DESCRIPTIVE: it never gates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/maturity');

const dn = (lo, hi, n, avg) => ({ n, effectiveN: n, avg, se: 0.3, ci95: { lo, hi } });
const cell = (netEx, netN, dateNet, dates) => ({ excessN: netN, avgExcess: netEx, beatMktRate: 50, netExcessN: netN, avgNetExcess: netEx, netBeatMktRate: 50, dates, dateNet });

const STALKING_LIKE = [{ section: 'Ghost', tier: 'STALKING', scope: 'large', horizons: {
  '1d': cell(-0.42, 148, dn(-1.39, -0.14, 35, -0.6), 35),
  '3d': cell(-0.9, 148, dn(-2.7, -0.36, 35, -1.2), 35),
  '5d': cell(0.28, 148, dn(-4.14, 4.72, 35, 0.29), 35),
  '20d': cell(-2.1, 120, dn(-6.0, 1.5, 30, -2.0), 30),
  '1m': cell(3.2, 100, dn(0.4, 6.1, 28, 3.0), 28),
} }];

test('adjacentHorizonReads: reports every non-contract horizon and flags CI-negative / CI-positive ones', () => {
  const r = M.adjacentHorizonReads(STALKING_LIKE, '5d');
  assert.equal(r.metric, '5d');
  assert.deepEqual(Object.keys(r.horizons).sort(), ['1d', '1m', '20d', '3d']);
  assert.equal(r.horizons['1d'].avgNetExcess, -0.42);
  assert.deepEqual(r.horizons['1d'].ci95, { lo: -1.39, hi: -0.14 });
  assert.equal(r.horizons['1d'].effectiveDates, 35);
  assert.deepEqual(r.negative, ['1d', '3d']);
  assert.deepEqual(r.positive, ['1m']);
  assert.equal(r.basis, 'descriptive — never a grade input');
});

test('adjacentHorizonReads: thin adjacent bars are reported but cannot be flagged', () => {
  const thin = [{ section: 'X', tier: 'T', scope: null, horizons: {
    '5d': cell(0.5, 20, dn(-1, 2, 20, 0.5), 20),
    '1d': cell(-3, 20, dn(-5, -1, 5, -3), 5),
  } }];
  const r = M.adjacentHorizonReads(thin, '5d');
  assert.equal(r.horizons['1d'].effectiveDates, 5);
  assert.deepEqual(r.negative, []);
});

test('gradeStrategy: adjacent-horizon warning rides on stats + reason without changing the grade', () => {
  const entry = { id: 'ghost', label: 'Ghost', section: 'Ghost', horizon: 'swing', kind: 'signal', policyTiers: ['STALKING'] };
  const summary = { groups: STALKING_LIKE, evidenceKeyVersion: 'x' };
  const g = M.gradeStrategy(entry, summary);
  assert.ok(g.stats.adjacentHorizons, 'stats carry the adjacent reads');
  assert.deepEqual(g.stats.adjacentHorizons.negative, ['1d', '3d']);
  assert.match(g.reason, /Adjacent horizons CI-negative: 1d \[-1\.39, -0\.14\] \(35 dates\), 3d \[-2\.7, -0\.36\] \(35 dates\)/);
  // CONTRAST: the same record with neutral neighbours carries no warning.
  const quiet = [{ ...STALKING_LIKE[0], horizons: { ...STALKING_LIKE[0].horizons, '1d': cell(0.1, 148, dn(-1, 1.2, 35, 0.1), 35), '3d': cell(0.2, 148, dn(-1.5, 1.9, 35, 0.2), 35) } }];
  const g2 = M.gradeStrategy(entry, { groups: quiet, evidenceKeyVersion: 'x' });
  assert.equal(g2.grade, g.grade, 'the warning is descriptive — grade unchanged');
  assert.doesNotMatch(g2.reason, /Adjacent horizons CI-negative/);
  assert.deepEqual(g2.stats.adjacentHorizons.negative, []);
});
