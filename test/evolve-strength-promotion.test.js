'use strict';
// audit #9 promotion: the candidate-strength tilt earns its way into the decision ONLY via a shadow
// OOS comparison — it must beat the base P out-of-sample (rank-IC + Brier) by a predeclared margin.

const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/evolve');

function rows(n, outcomeFn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const strength = (i * 37) % 100;
    const outcome = outcomeFn(i, strength);
    out.push({ strengthPercentile: strength, probability: 0.5 + (((i % 5) - 2) * 0.002), won: outcome > 0, spyRelReturn: outcome });
  }
  return out;
}

test('strengthOOSComparison: insufficient strength-carrying rows → ready:false, stays SHADOW', () => {
  const cmp = E.strengthOOSComparison([{ strengthPercentile: 90, probability: 0.5, won: true, spyRelReturn: 0.1 }]);
  assert.equal(cmp.ready, false);
  assert.equal(cmp.promote, false);
  assert.match(cmp.note, /accrues forward/);
});

test('strengthOOSComparison: PROMOTES when strength genuinely predicts the outcome OOS', () => {
  const cmp = E.strengthOOSComparison(rows(80, (i, s) => (s - 50) / 100 * 0.2));   // outcome monotone in strength
  assert.equal(cmp.ready, true);
  assert.ok(cmp.adjIC > cmp.baseIC, `adjIC ${cmp.adjIC} > baseIC ${cmp.baseIC}`);
  assert.ok(cmp.adjBrier <= cmp.baseBrier);
  assert.equal(cmp.promote, true);
});

test('strengthOOSComparison: does NOT promote when strength is uninformative', () => {
  // Each strength level appears with exactly one win AND one loss → strength carries zero information
  // about the outcome (deterministic, not a noisy draw).
  const out = [];
  for (let i = 0; i < 80; i++) {
    const strength = ((i >> 1) % 40) * 2 + 5;   // 40 levels, each used twice
    const won = i % 2 === 0;                     // one win, one loss per level
    out.push({ strengthPercentile: strength, probability: 0.5, won, spyRelReturn: won ? 0.05 : -0.05 });
  }
  const cmp = E.strengthOOSComparison(out);
  assert.equal(cmp.ready, true);
  assert.equal(cmp.promote, false);
  assert.match(cmp.verdict, /SHADOW/);
});

test('promotion gate: ctx.strengthPromoted swaps the decision P to the strength-tilted value', () => {
  const sig = { ticker: 'X', evolveHorizon: 'swing', source: 'ghost', sources: ['ghost'], percentile: 95,
    price: 100, entry: 100, liquidity: {}, execution: { quality: 1 } };
  const ctx = { perfBySpecialist: {}, barriersByHorizon: { swing: { up: 0.15, down: 0.07, window: 21 } }, regime: {}, priorP: 0.4 };
  const shadow = E.scoreCandidate(sig, ctx);
  const promoted = E.scoreCandidate(sig, { ...ctx, strengthPromoted: true });
  assert.equal(shadow.strengthPromoted, false);
  assert.equal(promoted.strengthPromoted, true);
  if (shadow.probability != null && shadow.strengthAdjustedP != null) {
    assert.notEqual(promoted.probability, shadow.probability);            // decision P changed
    assert.ok(Math.abs(promoted.probability - shadow.strengthAdjustedP) < 1e-6);  // == the tilted P
  }
});
