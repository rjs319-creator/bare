'use strict';
// STEP 13 — governance: promotion readiness, calibration gate, purged walk-forward,
// champion/challenger. The whole point is that the options layer stays SHADOW and shows
// NO probability until leakage-resistant, cost-aware, prospective evidence clears the gate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  promotionReadiness, calibrationGate, incrementalWalkForward, championChallengerState, governanceReport,
} = require('../lib/options-governance');

// Synthesize N graded episodes across D distinct dates with a given excess-vs-SPY.
function gradedSet(n, { excess = 1, dates = 30, horizon = 21, score = 50 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      graded: true, decisionDate: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % Math.max(1, dates))).padStart(2, '0')}`,
      score: score + (i % 5), horizons: { [horizon]: { excessVsSpy: excess + (i % 3) - 1 } },
    });
  }
  return out;
}

test('promotionReadiness stays SHADOW with a thin ledger and never auto-promotes', () => {
  const r = promotionReadiness(gradedSet(5), { horizon: 21 });
  assert.equal(r.verdict, 'shadow');
  assert.equal(r.canPromote, false);
  assert.equal(r.criteria.minResolvedEpisodes.met, false);
  assert.equal(r.criteria.minResolvedEpisodes.required, 50);
});

test('promotionReadiness reports met/not-met per criterion with real numbers', () => {
  const r = promotionReadiness(gradedSet(60, { excess: 3, dates: 25 }), { horizon: 21 });
  assert.equal(r.criteria.minResolvedEpisodes.met, true);      // 60 >= 50
  assert.equal(r.criteria.costAware.met, true);                // grading nets cost
  // calibration + regime robustness are honestly NOT met yet, so overall stays shadow.
  assert.equal(r.criteria.calibrationBeatsBaseRate.met, false);
  assert.equal(r.criteria.regimeRobust.met, false);
  assert.equal(r.verdict, 'shadow');
});

test('calibrationGate hard-suppresses probability and says why', () => {
  const g = calibrationGate(gradedSet(5), { horizon: 21 });
  assert.equal(g.probabilityAllowed, false);
  assert.match(g.reason, /insufficient prospective evidence/i);
  assert.ok(g.showInstead.includes('evidence score'));
});

test('calibrationGate stays off even with a large sample (no OOS-calibrated model exists)', () => {
  const g = calibrationGate(gradedSet(100), { horizon: 21 });
  assert.equal(g.probabilityAllowed, false);
  assert.match(g.reason, /calibrated model/i);
});

test('incrementalWalkForward reports not-ready on too few dates', () => {
  const wf = incrementalWalkForward(gradedSet(4, { dates: 2 }), { horizon: 21, folds: 4 });
  assert.equal(wf.ready, false);
  assert.match(wf.interpretation, /Not enough/i);
});

test('incrementalWalkForward runs a purged, embargoed walk-forward when dates suffice', () => {
  // 60 episodes across many distinct dates → the purged WF can form folds.
  const graded = [];
  for (let i = 0; i < 60; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const mon = String(1 + Math.floor(i / 28)).padStart(2, '0');
    graded.push({ graded: true, decisionDate: `2026-${mon}-${day}`, score: 40 + (i % 20), horizons: { 21: { excessVsSpy: (i % 7) - 3 } } });
  }
  const wf = incrementalWalkForward(graded, { horizon: 21, folds: 4 });
  assert.equal(wf.embargoDays, 21);
  assert.ok('positiveBlocks' in wf && 'testedBlocks' in wf);
});

test('championChallengerState marks the champion (and layer) shadow, exposes lifecycle states', () => {
  const s = championChallengerState({ challengers: [{ id: 'chal-1', label: 'residual score', state: 'shadow' }] });
  assert.equal(s.champion.state, 'shadow');
  assert.equal(s.challengers[0].state, 'shadow');
  assert.match(s.policy, /No auto-promotion|clearing every PROMOTION_GATE|every PROMOTION_GATE/);
});

test('championChallengerState defaults an unknown challenger state to experimental', () => {
  const s = championChallengerState({ challengers: [{ id: 'x', label: 'y', state: 'bogus' }] });
  assert.equal(s.challengers[0].state, 'experimental');
});

test('governanceReport bundles all four sections', () => {
  const rep = governanceReport(gradedSet(10), { horizon: 21 });
  assert.ok(rep.promotion && rep.calibration && rep.walkForward && rep.championChallenger);
  assert.equal(rep.calibration.probabilityAllowed, false);
});
