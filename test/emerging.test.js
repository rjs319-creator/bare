'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agg } = require('../lib/emerging');

test('agg: empty set returns n=0', () => {
  assert.deepEqual(agg([]), { n: 0 });
});

test('agg: computes mean excess + beat rates with Wilson lower bounds', () => {
  const recs = [
    { r: 0.10, rSpy: 0.08 },   // win vs cohort + spy
    { r: 0.05, rSpy: -0.01 },  // win vs cohort, lose vs spy
    { r: -0.04, rSpy: -0.06 }, // lose both
    { r: 0.02, rSpy: 0.03 },   // win both
  ];
  const a = agg(recs);
  assert.equal(a.n, 4);
  assert.equal(a.beatCohortRate, 0.75);        // 3/4 r>0
  assert.equal(a.beatSpyRate, 0.5);            // 2/4 rSpy>0
  assert.ok(a.meanExcessPct > 0);              // (0.10+0.05-0.04+0.02)/4 > 0
  assert.ok(a.beatCohortWilsonLo < a.beatCohortRate); // LB below point estimate
  assert.ok(a.beatCohortWilsonLo >= 0 && a.beatSpyWilsonLo >= 0);
});

test('agg: handles records with no SPY label (rSpy null)', () => {
  const a = agg([{ r: 0.03, rSpy: null }, { r: -0.02, rSpy: null }]);
  assert.equal(a.n, 2);
  assert.equal(a.nSpy, 0);
  assert.equal(a.beatSpyRate, null);           // no spy-labeled records
  assert.equal(a.beatSpyWilsonLo, null);
  assert.equal(a.beatCohortRate, 0.5);         // cohort rate still computed
});
