'use strict';
// Hypothesis registry + graveyard + BH/FDR (Phase 8 of the evidence-based redesign).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const HR = require('../lib/research/hypothesis-registry');

test('every registered hypothesis validates against the preregistration contract', () => {
  for (const h of HR.HYPOTHESES) {
    const v = HR.validateHypothesis(h);
    assert.ok(v.valid, `${h.id}: ${v.errors.join('; ')}`);
  }
});

test('the graveyard is populated — failed ideas are findable, not forgotten', () => {
  const dead = HR.graveyard();
  assert.ok(dead.length >= 10, `expected a substantial graveyard, got ${dead.length}`);
  // The canonical no-edge verdicts must be present so they cannot be re-run as new.
  for (const id of ['momentum-12-1-swing', 'omega-swing-selection', 'pead-sue', 'gap-metalabel', 'nonlinear-ml-panel']) {
    assert.ok(dead.find((h) => h.id === id), `${id} missing from graveyard`);
  }
});

test('no hypothesis claims confirmed status — no considerable alpha is currently proven', () => {
  assert.equal(HR.byStatus('confirmed').length, 0,
    'a confirmed entry appeared — that claim requires a passed confirmatory gate and a doc pointer');
});

test('confirmed status is structurally impossible for exploratory runs', () => {
  const v = HR.validateHypothesis({
    id: 'x', familyId: 'f', mode: 'exploratory', status: 'confirmed',
    hypothesis: 'h', mechanism: 'm', primaryMetric: 'p', baseline: 'b',
    universe: 'u', expectedDirection: 'd', stoppingRule: 's', evidence: 'e',
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => /confirmatory/.test(e)));
});

test('benjaminiHochberg produces monotone step-up q-values', () => {
  // Arrange — textbook example: p = .01, .02, .03, .04, .30
  const out = HR.benjaminiHochberg([
    { id: 'a', p: 0.01 }, { id: 'b', p: 0.02 }, { id: 'c', p: 0.30 },
    { id: 'd', p: 0.03 }, { id: 'e', p: 0.04 },
  ]);
  const q = Object.fromEntries(out.map((r) => [r.id, r.q]));

  // Assert — q_i = min_{j>=i}(p_j * n / j): a=.05, b=.05, d=.05, e=.05, c=.30
  assert.ok(Math.abs(q.a - 0.05) < 1e-12);
  assert.ok(Math.abs(q.e - 0.05) < 1e-12);
  assert.ok(Math.abs(q.c - 0.30) < 1e-12);
  // Monotone in p.
  const sorted = out.filter((r) => r.p != null).sort((x, y) => x.p - y.p);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].q >= sorted[i - 1].q - 1e-12);
});

test('invalid p-values are excluded without shrinking the correction denominator', () => {
  const out = HR.benjaminiHochberg([{ id: 'a', p: 0.04 }, { id: 'bad', p: null }, { id: 'b', p: 0.05 }]);
  assert.equal(out.find((r) => r.id === 'bad').q, null);
  // n=2 valid trials: q_b = .05*2/2 = .05, q_a = min(.04*2/1, .05) = .05
  assert.ok(Math.abs(out.find((r) => r.id === 'b').q - 0.05) < 1e-12);
});

test('familyTrials counts the program-level denominator per family', () => {
  assert.ok(HR.familyTrials('swing-ranking') >= 5, 'the swing-ranking family alone has ≥5 tested hypotheses');
  assert.equal(HR.familyTrials('nonexistent'), 0);
  assert.equal(HR.totalTrials(), HR.HYPOTHESES.length);
});

test('harness manifest trial count can never undercount the registry family', () => {
  const H = require('../lib/research/harness');
  const B = require('../lib/research/baseline-ranker');
  const rows = [];
  const d0 = Date.UTC(2024, 0, 1);
  for (let di = 0; di < 9; di++) {
    const date = new Date(d0 + di * 7 * 86400000).toISOString().slice(0, 10);
    for (let s = 0; s < 5; s++) rows.push({
      securityId: `S${s}`, ticker: `S${s}`, decisionTs: date, labelEndDate: date,
      horizon: 'swing', outcome: s / 10, features: { mom121: s / 10 },
    });
  }
  const out = H.runExperiment(rows, [B.randomRanker], { folds: 3, embargo: 0 },
    { experimentFamilyId: 'swing-ranking' });
  assert.ok(out.manifest.relatedExperimentsAttempted >= HR.familyTrials('swing-ranking'),
    'manifest trial denominator must be at least the registry family count');
});

test('sealed-holdout ledger: none are falsely claimed untouched', () => {
  for (const h of HR.untouchedHoldouts()) assert.equal(h.openedAt, null);
});
