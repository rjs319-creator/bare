'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const B = require('../lib/evolve-backfill');

test('specialistsFiring: breakout / emerging-leader → momentumIgnition', () => {
  assert.deepStrictEqual(B.specialistsFiring({ qualifies: true, metrics: {} }), ['momentumIgnition']);
  assert.deepStrictEqual(B.specialistsFiring({ emergingLeader: true, metrics: {} }), ['momentumIgnition']);
});

test('specialistsFiring: accumulation footprint (not yet broken out) → quietAccumulation', () => {
  const r = { qualifies: false, aboveSma200: true, metrics: { accumRatio: 1.6, udVol: 1.2 } };
  assert.deepStrictEqual(B.specialistsFiring(r), ['quietAccumulation']);
});

test('specialistsFiring: weak accumulation or below 200DMA → nothing', () => {
  assert.deepStrictEqual(B.specialistsFiring({ qualifies: false, aboveSma200: true, metrics: { accumRatio: 1.1, udVol: 1.2 } }), []);
  assert.deepStrictEqual(B.specialistsFiring({ qualifies: false, aboveSma200: false, metrics: { accumRatio: 1.9, udVol: 1.5 } }), []);
});

test('specialistsFiring: a confirmed breakout is momentum, NOT double-counted as accumulation', () => {
  const r = { qualifies: true, aboveSma200: true, metrics: { accumRatio: 1.9, udVol: 1.5 } };
  assert.deepStrictEqual(B.specialistsFiring(r), ['momentumIgnition']);   // quiet requires !qualifies
});
