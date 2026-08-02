'use strict';
// MOMENTUM v2 UNIVERSE — social trending must never be the discovery universe
// (predictive-redesign defect #14) and the contract is same-session (defect #15).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildCandidateUniverse } = require('../api/momentum.js');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const SC = require('../lib/strategy-contracts');

test('the momentum universe is price/volume-discovered — social can never originate a candidate', () => {
  // Arrange: discovery anomalies + screener movers; social would love to add MEME.
  const discovery = { anomalies: [{ ticker: 'RUNR', cusum: 6.2 }, { ticker: 'IGNT', cusum: 3.1 }] };
  const screens = [{ results: [{ ticker: 'MOVR', pctChange: 4.5 }, { ticker: 'RUNR', pctChange: 2.0 }] }];

  // Act
  const u = buildCandidateUniverse({ discovery, screens });

  // Assert: only discovery/screener origins exist; discovery outranks screener; dedup kept
  // the stronger origin; nothing social-sourced is possible by construction.
  assert.deepEqual(u.map(x => x.ticker), ['RUNR', 'IGNT', 'MOVR']);
  assert.ok(u.every(x => x.origin === 'discovery' || x.origin === 'screener'));
  assert.equal(u[0].origin, 'discovery');
});

test('with no price/volume universe the result is EMPTY — social trending is not a fallback universe', () => {
  const u = buildCandidateUniverse({ discovery: null, screens: [null, null, null] });
  assert.equal(u.length, 0, 'an empty board, never a social-only board');
});

test('momentum-v2 contract is intraday with a same-session grading metric', () => {
  const reg = STRATEGY_REGISTRY.find(x => x.id === 'momentum');
  assert.equal(reg.horizon, 'intraday');
  assert.equal(reg.scoringVersion, 'momentum-v2');
  assert.equal(reg.maturity, 'shadow', 'the rebuilt contract starts without inherited evidence');
  const c = SC.CONTRACTS.momentum;
  assert.equal(c.horizon, 'intraday');
  assert.equal(c.metric, '1d');
  assert.equal(c.timeExitSessions, 1);
});
