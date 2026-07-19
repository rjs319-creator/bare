'use strict';
// audit #10: the ensemble summed effN across specialists with NO cross-specialist discount, so two
// ~0.96-correlated specialists counted as two independent samples toward the TRADE gate. The fix
// discounts effN by measured effective independence (lib/redundancy.js).

const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/evolve');

const CONTRIBS = [{ specialist: 's1', p: 0.6, effN: 8 }, { specialist: 's2', p: 0.5, effN: 8 }];
const WEIGHTS = [{ specialist: 's1', weight: 1 }, { specialist: 's2', weight: 1 }];

test('ensembleProbability: no redundancy model → effN is the raw sum (backward compatible)', () => {
  const out = E.ensembleProbability(CONTRIBS, WEIGHTS);
  assert.equal(out.effN, 16);
  assert.equal(out.effNRaw, 16);
  assert.equal(out.independenceRatio, 1);
});

test('ensembleProbability: fully redundant specialists HALVE the effective sample', () => {
  const model = { credits: { 's1|s2': 0, 's2|s1': 0 } };     // measured credit 0 = interchangeable
  const out = E.ensembleProbability(CONTRIBS, WEIGHTS, { redundancyModel: model });
  assert.equal(out.independenceRatio, 0.5);
  assert.equal(out.effN, 8);                                  // 16 × 0.5 — one specialist's worth
  assert.equal(out.effNRaw, 16);
  assert.equal(out.redundantAgreement, true);
});

test('ensembleProbability: independent specialists keep the full effN', () => {
  const model = { credits: { 's1|s2': 1, 's2|s1': 1 } };
  const out = E.ensembleProbability(CONTRIBS, WEIGHTS, { redundancyModel: model });
  assert.equal(out.independenceRatio, 1);
  assert.equal(out.effN, 16);
  assert.equal(out.redundantAgreement, false);
});

test('buildSpecialistRedundancy: co-firing correlated specialists earn a LOW credit; <20 rows → null', () => {
  assert.equal(E.buildSpecialistRedundancy([{ predDate: '2022-01-01', ticker: 'A', specialists: ['s1', 's2'], spyRelReturn: 0.1 }]), null);
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ predDate: `2022-01-${String(1 + i).padStart(2, '0')}`, ticker: 'T' + i, specialists: ['s1', 's2'], spyRelReturn: (i % 2 ? 0.1 : -0.1) });
  const model = E.buildSpecialistRedundancy(rows);
  assert.ok(model && model.credits);
  const cr = model.credits['s1|s2'];
  assert.ok(Number.isFinite(cr) && cr < 0.6, `co-firing/correlated pair earns low independence credit (got ${cr})`);
});

test('effN discount de-risks the TRADE gate: redundant pair falls below minEffSample where the raw sum passed', () => {
  const contribs = [{ specialist: 's1', p: 0.6, effN: 8 }, { specialist: 's2', p: 0.6, effN: 8 }];
  const gate = E.GUARDRAILS.minEffSample;                     // 12
  const raw = E.ensembleProbability(contribs, WEIGHTS);
  assert.ok(raw.effN >= gate, 'raw summed effN (16) clears the gate');
  const disc = E.ensembleProbability(contribs, WEIGHTS, { redundancyModel: { credits: { 's1|s2': 0, 's2|s1': 0 } } });
  assert.ok(disc.effN < gate, 'discounted effN (8) does NOT clear the gate on one effective source');
});
