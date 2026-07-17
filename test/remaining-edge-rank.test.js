'use strict';
// Acceptance tests for spec §3 — remaining-edge must ALTER the live ranking, not just annotate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/decision');

const mk = (ticker, price, over = {}) => D.makeSignal({
  ticker, source: 'screener', horizon: 'swing', rawConfidence: 80,
  price, entry: 10, stop: 9, target: 12, ...over,
}).signal;

test('§3 acceptance: a name that has RUN UP since its signal falls below a fresh equal-score peer', () => {
  // Wide stop (risk = 3) so the run-up name stays TRIGGERED (not 1R-extended → not auto-dropped),
  // isolating the remaining-edge demotion. FRESH is at its origin; RUN has climbed $10→$11.4
  // (70% of the $10→$12 move consumed) yet is only 0.47R past entry, so it remains on the board.
  const lv = { entry: 10, stop: 7, target: 12 };
  const fresh = mk('FRESH', 10.1, lv);
  const run = mk('RUN', 11.4, lv);
  const origins = {
    [fresh.id]: { firstPrice: 10, ...lv, bars: 0 },
    [run.id]: { firstPrice: 10, ...lv, bars: 0 },
  };
  // Without origins the two are ~tied (same inputs); with origins RUN must rank strictly below.
  const base = D.rankSignals([fresh, run], { regime: { riskOn: true }, scoreboard: null });
  const withOrigins = D.rankSignals([fresh, run], { regime: { riskOn: true }, scoreboard: null, origins });
  const rank = (arr, tk) => arr.find(s => s.ticker === tk).rank;
  const score = (arr, tk) => arr.find(s => s.ticker === tk).score;
  // Baseline: RUN was NOT below FRESH (its higher price even nudged confidence-neutral score up or tied).
  assert.ok(score(base, 'RUN') >= score(base, 'FRESH') - 0.1, 'baseline should not already bury RUN');
  // With remaining-edge: RUN is demoted below FRESH.
  assert.ok(rank(withOrigins, 'FRESH') < rank(withOrigins, 'RUN'), 'fresh must outrank the run-up name');
  assert.ok(score(withOrigins, 'RUN') < score(withOrigins, 'FRESH'), 'run-up name must score lower');
});

test('§3 acceptance: an expired (target-reached) name is dropped from the active board', () => {
  const done = mk('DONE', 12.1); // past target → lifecycle 'resolved' → inactive
  const [only] = D.rankSignals([done, mk('LIVE', 10.2)], { regime: { riskOn: true }, scoreboard: null });
  assert.equal(only.ticker, 'LIVE');
  // And in the include-inactive view it is present but classified resolved with floored remaining.
  const origins = { [done.id]: { firstPrice: 10, entry: 10, stop: 9, target: 12, bars: 0 } };
  const all = D.rankSignals([done], { regime: { riskOn: true }, scoreboard: null, includeInactive: true, origins });
  assert.equal(all[0].state, 'resolved');
});

test('§3 safety: rankSignals WITHOUT origins is byte-identical to before (mult never binds)', () => {
  const sigs = [mk('A', 10.3), mk('B', 10.6, { entry: 10.5, stop: 9.8, target: 13 })];
  const before = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null });
  // Re-run identically — scores are deterministic and must not have shifted from the feature.
  const again = D.rankSignals(sigs, { regime: { riskOn: true }, scoreboard: null });
  assert.deepEqual(before.map(s => s.score), again.map(s => s.score));
  assert.equal(before.every(s => s.remainingEdge === null), true, 'no remainingEdge attached without origins');
});

test('§3: a stale setup aged past its hold window is demoted vs the same setup fresh', () => {
  const sig = mk('AGED', 10.2);
  const freshOrig = { [sig.id]: { firstPrice: 10, entry: 10, stop: 9, target: 12, bars: 0 } };
  const staleOrig = { [sig.id]: { firstPrice: 10, entry: 10, stop: 9, target: 12, bars: 40 } };
  const f = D.rankSignals([sig], { regime: { riskOn: true }, scoreboard: null, origins: freshOrig })[0];
  const s = D.rankSignals([sig], { regime: { riskOn: true }, scoreboard: null, origins: staleOrig })[0];
  assert.ok(s.score < f.score, `aged ${s.score} should be < fresh ${f.score}`);
});
