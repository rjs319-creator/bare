'use strict';
// The Scoreboard's evidenceHash is hashed over `groups` ONLY. factorAlpha is a SIBLING
// block: its arrival, change or removal must leave the hash — and therefore every
// version-matched promotion artifact — byte-identical. This test pins that and the
// source-level placement (the block is attached outside `groups`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AR = require('../lib/apex-routes');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');

const groups = [{ section: 'screener', tier: 'Breakout', scope: 'large', picks: 3, noHistory: 0, benchFallback: 0, selfBenchmarked: 0, horizons: { '5d': { n: 3, avg: 0.5, avgExcess: 0.1 } } }];

test('evidenceHashOf(summary) ignores the factorAlpha sibling block', () => {
  const base = { generatedAt: 'x', groups };
  const h0 = AR.evidenceHashOf(base);
  assert.match(h0, /^[0-9a-f]{64}$/);
  const withBlock = { ...base, factorAlpha: { version: 'factor-alpha-v1', groups: { 'screener:Breakout:large': { '5d': { alpha: 0.2 } } } } };
  assert.equal(AR.evidenceHashOf(withBlock), h0);
  const changedBlock = { ...base, factorAlpha: { version: 'factor-alpha-v1', groups: { 'screener:Breakout:large': { '5d': { alpha: -9 } } } } };
  assert.equal(AR.evidenceHashOf(changedBlock), h0);
  assert.equal(AR.evidenceHashOf({ ...base, fillVerification: { screener: 1 } }), h0, 'the existing sibling convention is preserved');
  // …but the groups themselves still move the hash.
  const changedGroups = { ...base, groups: [{ ...groups[0], picks: 4 }] };
  assert.notEqual(AR.evidenceHashOf(changedGroups), h0);
});

test('summary writer attaches factorAlpha OUTSIDE groups and hashes groups only (source pin)', () => {
  assert.match(SRC, /summary\.evidenceHash = evidenceHashOf\(summary\)/);
  assert.match(SRC, /if \(factorAlpha\) summary\.factorAlpha = factorAlpha;/);
  // The per-group projection into the persisted summary names its fields explicitly and
  // must not have grown a factor field (that would change evidenceHash for every lane).
  const proj = SRC.match(/groups: out\.map\(g => \(\{ ([^}]+) \}\)\)/);
  assert.ok(proj, 'persisted groups projection present');
  assert.doesNotMatch(proj[1], /factor|alphaFF/i);
});
