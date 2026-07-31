'use strict';
// GRIDLOCK scenario engine: pure deterministic arithmetic, disclosed formulas,
// input validation, bull/base/bear coherence.
const test = require('node:test');
const assert = require('node:assert');
const SC = require('../lib/gridlock-scenario');

test('computeScenario is deterministic and shows its formulas', () => {
  const a = { addedLoadMW: 6000, generationAddMW: 2000, retirementsMW: 3000, gasPriceUSD: 4, completionProb: 0.8 };
  const r1 = SC.computeScenario(a), r2 = SC.computeScenario(a);
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.derived.effAddedLoadMW.value, 4800);           // 6000 × 0.8
  assert.match(r1.derived.effAddedLoadMW.formula, /completionProb/);
  assert.match(r1.caveat, /NOT a production-cost model/);
});

test('input validation fails fast with clear messages', () => {
  const bad = SC.computeScenario({ addedLoadMW: 'many', completionProb: 3, weatherSeverity: 7 });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.length >= 3);
});

test('tightening inputs tighten the margin; a cancelled project (prob 0) adds nothing', () => {
  const base = SC.computeScenario({});
  const tight = SC.computeScenario({ addedLoadMW: 10000, retirementsMW: 8000 });
  assert.ok(tight.derived.reserveMarginAfterPct.value < base.derived.reserveMarginAfterPct.value);
  assert.strictEqual(tight.derived.constraintDirection.value, 'tightening');
  const cancelled = SC.computeScenario({ addedLoadMW: 10000, completionProb: 0 });
  assert.strictEqual(cancelled.derived.effAddedLoadMW.value, 0);
});

test('scenarioTriplet: bull margin ≤ base margin ≤ bear margin (for a scarcity thesis)', () => {
  const tri = SC.scenarioTriplet({ addedLoadMW: 8000, generationAddMW: 4000, retirementsMW: 2000, gasPriceUSD: 3.5, completionProb: 0.8 });
  assert.strictEqual(tri.ok, true);
  const m = (s) => s.derived.reserveMarginAfterPct.value;
  assert.ok(m(tri.bull) <= m(tri.base));
  assert.ok(m(tri.base) <= m(tri.bear));
  assert.ok(tri.bull.derived.priceProxyUSDMWh.value >= tri.bear.derived.priceProxyUSDMWh.value);
  assert.ok(tri.adjustments.bull && tri.adjustments.bear);           // perturbations disclosed
});

test('transmission impairment haircuts capacity', () => {
  const on = SC.computeScenario({ transmissionAvailable: true });
  const off = SC.computeScenario({ transmissionAvailable: false });
  assert.ok(off.derived.capacityMW.value < on.derived.capacityMW.value);
});
