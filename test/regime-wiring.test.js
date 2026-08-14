'use strict';
// Audit 2026-08-14: two defects disconnected the app's ONE validated lever (regime
// avoidance) from the live board.
//   1. api/screener.js serialized the bare sel.regime — no killSwitch, no macro — so
//      lib/decision.js regimeFit never saw VIX/credit risk-off (regime.killSwitch was
//      always undefined on the live payload).
//   2. regimeFit treated riskOn:false as risk-off; computeRegime always emits a hard
//      riskOn boolean, so the neutral branch (×0.85) was unreachable and every neutral
//      tape scored longs at the ×0.45 risk-off multiplier.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rankSignals } = require('../lib/decision');

// regimeFit is internal; observe it through rankSignals' regimeFit output field.
const SIG = {
  source: 'screener', section: 'screener', tier: 'Early', universeScope: 'large',
  horizon: 'swing', side: 'long', ticker: 'AAA', price: 100,
  entry: 101, stop: 95, target: 115, rr: 2.3, rawConfidence: 70,
  evidenceFamilies: ['priceTrend'], evidenceOrigins: { priceTrend: 'screener' },
  liquidity: { dollarVol: 5e8, price: 100 },
};
const fitUnder = (regime) => rankSignals([{ ...SIG }], { regime })[0].regimeFit;

test('neutral tape (bearish:false, riskOn:false) scores the NEUTRAL multiplier, not risk-off', () => {
  const neutral = fitUnder({ bearish: false, riskOn: false });
  const riskOff = fitUnder({ bearish: true, riskOn: false });
  const riskOn = fitUnder({ bearish: false, riskOn: true });
  assert.equal(riskOff, 0.45);
  assert.equal(riskOn, 1);
  assert.ok(neutral > riskOff && neutral < riskOn, `neutral ${neutral} must sit between`);
  assert.equal(neutral, 0.85);
});

test('macro killSwitch alone de-rates longs to the risk-off multiplier', () => {
  assert.equal(fitUnder({ bearish: false, riskOn: false, killSwitch: true }), 0.45);
});

test('a payload carrying ONLY riskOn:false (no bearish field) still fails closed to risk-off', () => {
  assert.equal(fitUnder({ riskOn: false }), 0.45);
});

test('api/screener serializes killSwitch + macroRiskOff onto the regime op=today consumes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'screener.js'), 'utf8');
  assert.match(src, /regime:\s*regime\s*\n?\s*\?\s*\{\s*\.\.\.regime,\s*killSwitch:/,
    'the top-level regime payload must carry killSwitch — the ghost.* copy never reaches lib/decision.js');
  assert.match(src, /macroRiskOff\s*\}/, 'macroRiskOff must ride on the serialized regime');
});
