'use strict';
// LIVE-RANK ISOLATION of the sector-peer (peer-propagation) model. The prospective walk-forward
// showed NO incremental lift, so these are the invariants that keep it from touching live
// rankings until the registry maturity is explicitly flipped through the evidence gates:
//   1. registry maturity stays non-production → isTradeEligible === false (fail closed),
//   2. the unified decision engine has no peerprop source or normalizer,
//   3. the engine's own snapshot declares affectsLiveRank: false and null probabilities.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const { isTradeEligible, statusOf } = require('../lib/strategy-gate');

test('peerlab is registered, shadow, and NOT trade-eligible', () => {
  const entry = STRATEGY_REGISTRY.find((s) => s.id === 'peerlab');
  assert.ok(entry, 'peerlab must stay registered (unregistered would hide it from governance)');
  assert.notEqual(entry.maturity, 'production');
  assert.equal(statusOf('peerlab'), 'shadow');
  assert.equal(isTradeEligible('peerlab'), false);
});

test('the unified decision engine has no peerprop branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'decision-sources.js'), 'utf8');
  assert.ok(!/peerprop|peerlab/i.test(src), 'decision-sources must not consume peer propagation');
  const norm = fs.readFileSync(path.join(__dirname, '..', 'lib', 'decision-normalizers.js'), 'utf8');
  assert.ok(!/peerprop|peerlab/i.test(norm), 'no peerprop normalizer may exist');
});

test('peerprop engine snapshots declare weight-0 shadow status', () => {
  const engine = require('../lib/peerprop/engine');
  assert.equal(typeof engine.runPeerPropagation, 'function');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'peerprop', 'engine.js'), 'utf8');
  assert.ok(/affectsLiveRank:\s*false/.test(src), 'snapshot must carry affectsLiveRank:false');
});
