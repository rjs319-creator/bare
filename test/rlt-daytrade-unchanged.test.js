'use strict';
// Day Trade is FROZEN by user directive. RLT must be provably incapable of
// touching it: byte-identical Day Trade normalizer output under every RLT_MODE,
// the pinned eligibility path untouched, and the frozen contract intact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/decision-normalizers');
const { assessSource } = require('../lib/eligibility');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const { CONTRACTS } = require('../lib/strategy-contracts');

const daytradeFixture = {
  ok: true,
  generatedAt: '2026-07-24T20:00:00Z',
  best: [
    { ticker: 'HIMS', state: 'ACTIONABLE_NOW', score: 82, relScore: 91, price: 21.4,
      livePlan: { entry: 21.5, stop: 20.8, target: 23.0 }, session: 'regular',
      lifecycle: { state: 'ACTIONABLE_NOW' } },
    { ticker: 'SOFI', state: 'ARMED', score: 74, relScore: 80, price: 8.1,
      livePlan: { entry: 8.2, stop: 7.9, target: 8.8 }, session: 'regular',
      lifecycle: { state: 'ARMED' } },
  ],
};

test('Day Trade normalizer output is byte-identical under every RLT_MODE', () => {
  const prev = process.env.RLT_MODE;
  const outputs = [];
  try {
    for (const mode of ['off', 'shadow', 'enforce', undefined]) {
      if (mode === undefined) delete process.env.RLT_MODE;
      else process.env.RLT_MODE = mode;
      outputs.push(JSON.stringify(N.fromDayTrade(JSON.parse(JSON.stringify(daytradeFixture)))));
    }
  } finally {
    if (prev === undefined) delete process.env.RLT_MODE;
    else process.env.RLT_MODE = prev;
  }
  for (const o of outputs.slice(1)) assert.equal(o, outputs[0]);
});

test('daytrade eligibility stays PINNED production regardless of RLT registration', () => {
  const a = assessSource('daytrade', { registry: STRATEGY_REGISTRY, gov: { byId: new Map(), fresh: false, savedAt: null } });
  assert.equal(a.pinned, true);
  assert.equal(a.tradeEligible, true);
  assert.equal(a.sizingWeight, 1);
});

test('the frozen Day Trade registry row and contract are untouched', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'daytrade');
  assert.equal(entry.maturity, 'production');
  assert.equal(entry.scoringVersion, 'daytrade-v2');
  assert.equal(CONTRACTS.daytrade.frozen, true);
});

test('rlt is registered shadow and its contract exists — the flip side of the freeze', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'rlt');
  assert.ok(entry, 'rlt must be registered or it escapes the evidence system');
  assert.equal(entry.maturity, 'shadow');
  assert.equal(entry.core, false);
  assert.ok(CONTRACTS.rlt, 'rlt outcome contract must exist');
  assert.equal(CONTRACTS.rlt.fillVerified, false, 'fill verification is not pretended');
});
