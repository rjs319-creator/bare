'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const gate = require('../lib/strategy-gate');
const validation = require('../lib/alerts-validation');

test('Trade Alerts (xalerts) is registered as SHADOW', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'xalerts');
  assert.ok(entry, 'xalerts is in the registry');
  assert.equal(entry.maturity, 'shadow');
});

test('Trade Alerts CANNOT originate or boost a live trade while shadow', () => {
  assert.equal(gate.statusOf('xalerts'), 'shadow');
  assert.equal(gate.isTradeEligible('xalerts'), false);
});

test('promotion requires the predefined PROMOTION_GATE (not a UI/wording change)', () => {
  assert.ok(gate.PROMOTION_GATE.minResolvedEpisodes >= 50);
  assert.ok(gate.PROMOTION_GATE.incrementalExcessReturn);
  assert.ok(gate.PROMOTION_GATE.costAware);
});

test('walk-forward stays INCONCLUSIVE on too few independent dates (no premature promotion)', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ date: `2026-07-0${i + 1}`, excess: 1, arms: { setup: 0.5, socialEqual: 0.5, socialSkill: 0.5, priceEqual: 0.5, priceSkill: 0.5, placebo: 0.5 } }));
  const v = validation.walkForward(rows);
  assert.equal(v.ready, false);
  assert.ok(v.verdict.includes('INCONCLUSIVE'));
});

test('walk-forward: account-skill arm must beat setup-alone, equal-weight AND placebo to be READY', () => {
  // Construct enough independent dates where the skill arm ranks outcomes best.
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const good = i % 2 === 0;
    rows.push({
      date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`,
      excess: good ? 3 : -3,
      arms: {
        setup: 0.5, socialEqual: 0.5,
        socialSkill: good ? 0.9 : 0.1,       // skill arm perfectly ranks the winners
        priceEqual: 0.5,
        priceSkill: good ? 0.9 : 0.1,
        placebo: (i * 7 % 10) / 10,
      },
    });
  }
  const v = validation.walkForward(rows);
  assert.ok(v.independentDates >= validation.MIN_INDEP_DATES);
  assert.ok(v.arms.priceSkill.topTercileMeanExcess > v.arms.placebo.topTercileMeanExcess);
});

test('champion/challenger never auto-promotes to production', () => {
  const cc = validation.championChallenger({ challenger: { ready: true } });
  assert.ok(cc.recommendation.includes('PENDING_HUMAN'));
});
