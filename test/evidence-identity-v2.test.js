'use strict';
// PHASE 4 — immutable evidence identity. Evidence must never transfer silently between
// different algorithms: a scoring, label, execution, benchmark, policy-tier, scope, side
// or cohort change is a DIFFERENT experiment with a DIFFERENT record.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EI = require('../lib/evidence-identity');

const FULL = {
  strategyId: 'gapgo', scoringVersion: 'gapgo-v1', side: 'long', policyTier: 'TAKE',
  scope: null, horizon: 'intraday', metric: '1d',
  executionPolicyVersion: 'gapgo-orb-verify-v2', labelVersion: 'executable-R-v1',
  benchmarkVersion: 'bench:SPY', cohortVersion: 'scoped-v1',
};

test('a complete identity is CANONICAL and may govern; anything missing is LEGACY_CONTEXT', () => {
  assert.equal(EI.classifyIdentity(FULL), EI.IDENTITY_CLASS.CANONICAL);
  assert.equal(EI.mayGovern(FULL), true);
  for (const axis of EI.REQUIRED_AXES) {
    const partial = { ...FULL, [axis]: null };
    assert.equal(EI.classifyIdentity(partial), EI.IDENTITY_CLASS.LEGACY_CONTEXT, `${axis} missing must degrade to legacy`);
    assert.equal(EI.mayGovern(partial), false);
    assert.deepEqual(EI.missingAxes(partial), [axis]);
  }
});

test('scope and policyTier may legitimately be null (a value), but null never matches a set value', () => {
  const scopeless = { ...FULL, scope: null, policyTier: null };
  assert.equal(EI.mayGovern(scopeless), true);
  assert.equal(EI.identitiesMatch(scopeless, { ...scopeless, scope: 'large' }), false);
  assert.equal(EI.identitiesMatch(scopeless, { ...scopeless, policyTier: 'WATCH' }), false);
});

test('EVERY axis is part of the identity — changing any one breaks the match', () => {
  for (const axis of EI.IDENTITY_AXES) {
    const changed = { ...FULL, [axis]: 'SOMETHING-ELSE' };
    assert.equal(EI.identitiesMatch(FULL, changed), false, `${axis} must be part of the key`);
    assert.deepEqual(EI.identityDiff(changed, FULL).map(d => d.axis), [axis]);
  }
});

test('the worked example: Gap & Go v1 evidence cannot validate the v2 execution contract', () => {
  const v1 = { ...FULL, executionPolicyVersion: 'gapgo-orb-verify-v1', labelVersion: 'proxy-close-v1' };
  assert.equal(EI.identitiesMatch(v1, FULL), false);
  assert.notEqual(EI.identityKey(v1), EI.identityKey(FULL));
});

test('long and short records can never merge', () => {
  assert.equal(EI.identitiesMatch({ ...FULL, side: 'short' }, FULL), false);
  assert.notEqual(EI.identityKey({ ...FULL, side: 'short' }), EI.identityKey(FULL));
});

test('proxy labels and executable labels are separate records', () => {
  const proxy = { ...FULL, labelVersion: 'proxy-close-v1' };
  assert.equal(EI.identitiesMatch(proxy, FULL), false);
});

test('KEY COLLISION: values containing the separator cannot forge another identity', () => {
  const a = EI.identityKey({ ...FULL, policyTier: 'A|scope=large' });
  const b = EI.identityKey({ ...FULL, policyTier: 'A', scope: 'large' });
  assert.notEqual(a, b);
});

test('identityKey is stable and order-independent for the same identity', () => {
  const shuffled = Object.fromEntries(Object.entries(FULL).reverse());
  assert.equal(EI.identityKey(shuffled), EI.identityKey(FULL));
  assert.equal(EI.identityKey(FULL), EI.identityKey({ ...FULL }));
});

test('MIGRATION: a v1-era record (no execution/label/benchmark axes) stays viewable but cannot govern', () => {
  const legacy = EI.canonicalIdentity({ strategyId: 'screener', tier: 'Setup', scope: 'large', side: 'long' });
  assert.equal(EI.classifyIdentity(legacy), EI.IDENTITY_CLASS.LEGACY_CONTEXT);
  assert.equal(EI.mayGovern(legacy), false);
  assert.ok(EI.missingAxes(legacy).includes('labelVersion'));
  // and it never matches the current canonical identity of the same strategy
  assert.equal(EI.identitiesMatch(legacy, FULL), false);
});

test('identityForStrategy derives the identity from the registry + contract (one derivation, not many)', () => {
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'screener');
  const id = EI.identityForStrategy(entry, { scope: 'large' });
  assert.equal(id.strategyId, 'screener');
  assert.equal(id.scoringVersion, 'screener-v2');
  assert.equal(id.metric, '5d');
  assert.equal(id.scope, 'large');
  // fillVerified:false ⇒ the label/execution axes honestly say PROXY, so this record can
  // never be confused with (or promote) an executable-fill record.
  assert.equal(id.labelVersion, 'proxy-close-v1');
  assert.equal(id.executionPolicyVersion, 'proxy-close-v1');
  assert.ok(id.benchmarkVersion.startsWith('bench:'));
});

test('maturity stamps the identity, its class, and whether it may govern', () => {
  const { gradeStrategy } = require('../lib/maturity');
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'screener');
  const g = gradeStrategy(entry, { groups: [], evidenceKeyVersion: 'scoped-v1' });
  assert.ok(g.identity);
  assert.equal(g.identity.strategyId, 'screener');
  assert.ok([EI.IDENTITY_CLASS.CANONICAL, EI.IDENTITY_CLASS.LEGACY_CONTEXT].includes(g.identityClass));
  assert.equal(typeof g.mayGovern, 'boolean');
});

test('governance refuses to promote a record whose identity is incomplete (LEGACY_CONTEXT)', () => {
  const G = require('../lib/governance');
  const graded = {
    id: 'x', label: 'X', grade: 'validated', version: 'x-v1',
    stats: { excessN: 60, avgExcess: 3, beatMktRate: 62, beatLo: 55 },
    mayGovern: false, identityMissingAxes: ['labelVersion', 'executionPolicyVersion'],
  };
  const r = G.governStrategy(graded, null, null, { nowMs: Date.parse('2026-08-04T12:00:00Z') });
  assert.notEqual(r.status, 'production');
  assert.match(r.reason, /LEGACY CONTEXT/);
});
