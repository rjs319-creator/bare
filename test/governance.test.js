'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/governance');

const graded = (over = {}) => ({
  id: 'x', label: 'X', section: 'X', horizon: 'swing', kind: 'signal', core: false,
  grade: 'experimental', stats: { excessN: 0, avgExcess: null, beatMktRate: null, beatLo: null },
  ...over,
});

test('validated + full sample → Production at 100% weight', () => {
  const r = G.governStrategy(graded({ grade: 'validated', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null);
  assert.equal(r.status, 'production');
  assert.equal(r.weight, 1);
});

test('validated but sample below the verdict gate → paper, never sized', () => {
  const r = G.governStrategy(graded({ grade: 'validated', stats: { excessN: 5, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null);
  assert.equal(r.status, 'paper');
  assert.equal(r.weight, 0);
});

test('proven model whose edge is weakening → Reduced (half size)', () => {
  const prev = { status: 'production', version: null, avgExcess: 4 };
  const now = graded({ grade: 'validated', stats: { excessN: 40, avgExcess: 1, beatMktRate: 48, beatLo: 42 } });
  const r = G.governStrategy(now, prev);
  assert.equal(r.status, 'reduced');
  assert.equal(r.weight, 0.5);
});

test('promising fresh model → Paper-only; promising AFTER being live → Probation', () => {
  const fresh = G.governStrategy(graded({ grade: 'promising', stats: { excessN: 10, avgExcess: 2, beatMktRate: 55, beatLo: 40 } }), null);
  assert.equal(fresh.status, 'paper');
  const demoted = G.governStrategy(graded({ grade: 'promising', stats: { excessN: 10, avgExcess: 2, beatMktRate: 55, beatLo: 40 } }), { status: 'production', version: null });
  assert.equal(demoted.status, 'probation');
  assert.equal(demoted.weight, 0.25);
});

test('disabled grade → Disabled, zero weight', () => {
  const r = G.governStrategy(graded({ grade: 'disabled', stats: { excessN: 30, avgExcess: -3, beatMktRate: 35, beatLo: 25 } }), null);
  assert.equal(r.status, 'disabled');
  assert.equal(r.weight, 0);
});

test('informational / context-only class is never sized', () => {
  const r = G.governStrategy(graded({ kind: 'informational', grade: 'informational' }), null);
  assert.equal(r.status, 'paper');
  assert.equal(r.weight, 0);
});

test('explicit retirement overrides everything', () => {
  const r = G.governStrategy(graded({ retired: true, grade: 'validated', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }), null);
  assert.equal(r.status, 'retired');
});

test('VERSION GUARD: a scoring-version change resets a live model to Probation and never merges the old record', () => {
  const prev = { status: 'production', version: 'model-v1', avgExcess: 4 };
  const now = graded({ grade: 'validated', version: 'model-v2', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } });
  const r = G.governStrategy(now, prev);
  assert.equal(r.versionReset, true);
  assert.equal(r.status, 'probation'); // NOT production — the v2 model must re-prove
  assert.match(r.reason, /version changed/i);
});

test('version guard resets a paper model to paper (not upgraded across versions)', () => {
  const prev = { status: 'paper', version: 'model-v1' };
  const now = graded({ grade: 'promising', version: 'model-v2', stats: { excessN: 10, avgExcess: 2, beatMktRate: 55, beatLo: 40 } });
  const r = G.governStrategy(now, prev);
  assert.equal(r.versionReset, true);
  assert.equal(r.status, 'paper');
});

test('governRegistry tallies statuses, sorts strongest-first, sums cleared weight', () => {
  const classified = { generatedAt: 't', strategies: [
    graded({ id: 'a', grade: 'validated', stats: { excessN: 40, avgExcess: 3, beatMktRate: 62, beatLo: 55 } }),
    graded({ id: 'b', grade: 'disabled', stats: { excessN: 30, avgExcess: -3, beatMktRate: 35, beatLo: 25 } }),
    graded({ id: 'c', grade: 'experimental', stats: { excessN: 2, avgExcess: null, beatMktRate: null, beatLo: null } }),
  ] };
  const out = G.governRegistry(classified, new Map());
  assert.equal(out.counts.production, 1);
  assert.equal(out.counts.disabled, 1);
  assert.equal(out.counts.paper, 1);
  assert.equal(out.strategies[0].status, 'production'); // strongest first
  assert.equal(out.clearedWeight, 1); // only the production model contributes weight
});

test('isWeakening needs BOTH a slip and a sub-50 beat bound (one soft quarter does not cut size)', () => {
  assert.equal(G.isWeakening({ excessN: 40, avgExcess: 1, beatLo: 48 }, { avgExcess: 4 }), true);
  assert.equal(G.isWeakening({ excessN: 40, avgExcess: 1, beatLo: 55 }, { avgExcess: 4 }), false); // beat bound still >50
  assert.equal(G.isWeakening({ excessN: 5, avgExcess: -5, beatLo: 10 }, { avgExcess: 4 }), false); // sample too small
});
