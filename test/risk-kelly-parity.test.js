'use strict';
// PARITY — the two pre-existing Kelly implementations (lib/cern.js continuous Kelly sizing and
// lib/gapgo.js tier fractional-Kelly risk) must produce BIT-IDENTICAL numbers after being
// re-pointed at lib/risk-kelly.js. The oracles below are the formulas verbatim as they stood
// before the refactor; they are the fixtures, not the implementation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RK = require('../lib/risk-kelly');
const { suggestedRiskPct, TIER_STATS, KELLY_FRACTION } = require('../lib/gapgo');

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// lib/cern.js dailyTick, pre-refactor:
//   const kelly = clamp((predMu - cost) / (predSd * predSd), 0, 4);
//   const size  = clamp(0.25 * kelly * 0.01, 0, 0.05);
function legacyCernSize(predMu, predSd, cost) {
  const kelly = clamp((predMu - cost) / (predSd * predSd), 0, 4);
  return { kelly, size: clamp(0.25 * kelly * 0.01, 0, 0.05) };
}

// lib/gapgo.js suggestedRiskPct, pre-refactor:
function legacySuggestedRiskPct(tier, score, regime) {
  if (regime === 'risk-off') return 0;
  const st = TIER_STATS[tier]; if (!st) return 0;
  const scoreScale = Math.max(0.35, Math.min(1, (score || 0) / 70));
  return +(st.fullKelly * KELLY_FRACTION * scoreScale * 100).toFixed(2);
}

const GRID_MU = [-0.05, -0.001, 0, 0.0004, 0.003, 0.012, 0.05, 0.2, 1.5];
const GRID_SD = [0.004, 0.01, 0.025, 0.06, 0.15, 0.4];
const GRID_COST = [0, 0.003, 0.006, 0.012, 0.02, 0.035, 0.06];

test('cern continuous Kelly + 0.25x size: identical to the legacy inline formula across a grid', () => {
  let checked = 0;
  for (const mu of GRID_MU) for (const sd of GRID_SD) for (const cost of GRID_COST) {
    const legacy = legacyCernSize(mu, sd, cost);
    const kelly = RK.kellyContinuous({ mu, sd, cost });
    const size = RK.cernSizeFraction(kelly);
    assert.equal(kelly, legacy.kelly, `kelly mu=${mu} sd=${sd} cost=${cost}`);
    assert.equal(size, legacy.size, `size mu=${mu} sd=${sd} cost=${cost}`);
    checked++;
  }
  assert.ok(checked > 300);
});

test('gapgo suggestedRiskPct: identical to the legacy formula for every tier × score × regime', () => {
  const scores = [null, undefined, 0, 10, 24.5, 45, 60, 69.99, 70, 85, 100, 140];
  for (const tier of ['STRONG', 'MODERATE', 'WEAK', undefined]) {
    for (const score of scores) {
      for (const regime of ['risk-on', 'neutral', 'risk-off', undefined]) {
        assert.equal(suggestedRiskPct(tier, score, regime), legacySuggestedRiskPct(tier, score, regime),
          `tier=${tier} score=${score} regime=${regime}`);
      }
    }
  }
});

test('gapgo TIER_STATS fullKelly values are what the module\'s discrete Kelly reproduces to rounding', () => {
  // The backtest published win/payoff/fullKelly per tier; the module's kellyFraction must agree
  // with those published numbers to 3dp when fed the same win rate and payoff (avgLoss = 1R).
  for (const [tier, st] of Object.entries(TIER_STATS)) {
    const k = RK.kellyFraction({ winRate: st.winRate, avgWin: st.payoff, avgLoss: -1 });
    assert.ok(Math.abs(k - st.fullKelly) < 0.002, `${tier}: ${k} vs ${st.fullKelly}`);
  }
});
