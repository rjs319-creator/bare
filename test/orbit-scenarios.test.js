'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Sc = require('../lib/orbit-scenarios');

test('scenarioVector is a normalised soft distribution (never a hard state)', () => {
  const v = Sc.scenarioVector({ macroRisk: 20, vix: { pctile: 15, rising: false } }, { sectorTrend: 0.5 });
  const sum = Sc.SCENARIOS.reduce((s, k) => s + v.probs[k], 0);
  assert.ok(Math.abs(sum - 1) < 1e-3, 'sums to 1');
  assert.ok(v.probs.riskOn > v.probs.riskOff, 'calm tape favours risk-on');
  for (const k of Sc.SCENARIOS) assert.ok(v.probs[k] < 0.99, 'no hard 1.0');
  assert.ok(v.uncertainty > 0);
});

test('risk-off tape lifts the riskOff scenario', () => {
  const v = Sc.scenarioVector({ macroRisk: 85, vix: { pctile: 95, rising: true } }, {});
  assert.ok(v.probs.riskOff + v.probs.highVol > v.probs.riskOn, 'stress states dominate');
});

test('robustUp takes the WORST plausible scenario, not the bullish one', () => {
  // Diffuse tape so risk-off is plausible. Name is strong in risk-on, weak in risk-off.
  const v = Sc.scenarioVector({ macroRisk: 48, vix: { pctile: 50, rising: false } }, {});
  const perS = { riskOn: 0.82, neutral: 0.6, riskOff: 0.31, highVol: 0.25, sectorWeak: 0.5 };
  const r = Sc.robustUp(perS, v, { plausibility: 0.15 });
  assert.ok(r.robustUp <= 0.5, `robustUp ${r.robustUp} reflects a weak scenario, not 0.82`);
  assert.ok(r.robustUp < perS.riskOn, 'never just the bullish-case probability');
  assert.ok(r.lowerBound <= r.robustUp, 'lower bound is conservative');
});

test('market-independent strength is NOT awarded from a bullish tape alone', () => {
  // Even in a strongly risk-on tape, if any plausible scenario is weak, robustUp is capped there.
  const v = Sc.scenarioVector({ macroRisk: 15, vix: { pctile: 10, rising: false } }, {});
  const perS = { riskOn: 0.9, neutral: 0.55, riskOff: 0.2, highVol: 0.2, sectorWeak: 0.3 };
  const r = Sc.robustUp(perS, v, { plausibility: 0.1 });
  assert.ok(r.robustUp < 0.6, `capped by a plausible weak scenario, got ${r.robustUp}`);
});

test('perScenarioProb shifts a name toward each scenario base rate', () => {
  const per = Sc.perScenarioProb(0.6, { riskOn: 0.7, riskOff: 0.4 }, 0.55);
  assert.ok(per.riskOn > 0.6, 'favorable scenario shifts up');
  assert.ok(per.riskOff < 0.6, 'unfavorable scenario shifts down');
  assert.ok(per.riskOn <= 0.99 && per.riskOff >= 0.01, 'clamped');
});

test('null name prob → null perScenario and null robustUp', () => {
  assert.strictEqual(Sc.perScenarioProb(null), null);
  const v = Sc.scenarioVector({ macroRisk: 50 }, {});
  assert.strictEqual(Sc.robustUp(null, v).robustUp, null);
});
