'use strict';
// GRIDLOCK opportunity score + action gate: decomposition, renormalization,
// penalties, no probability, no momentum double-count, causal/timing separation.
const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/gridlock-score');

const rel = { estimatedExposureStrength: 0.9, estimatedMateriality: 'high', verifiedOrInferred: 'verified' };
const cls = (over = {}) => ({
  ticker: 'TST', classification: 'DIRECT_BENEFICIARY', direction: 1, named: true,
  swingRelevant: true, horizonDays: 10, uncertaintyPenalties: [], ...over,
});
const ev = (over = {}) => ({
  announcedAt: '2026-07-28', certainty: 'CONTRACTED', contractDuration: 240,
  demandDeltaMW: 800, sourceEvidence: [{ primaryOrSecondary: 'primary' }], ...over,
});
const cps = { total: 70, dataQuality: 'good', version: 'gridlock-cps-v1' };
const tape = { excessMovePct: 1.5, relVol: 1.4, dollarVol: 60e6 };

test('score decomposes fully, sums via weights, stays within 0–100 and NEVER emits a probability', () => {
  const s = G.opportunityScore({
    event: ev(), relationship: rel, classification: cls(), cps, tape,
    notYetRepriced: { score: 65 }, dollarVol: 60e6, asOf: '2026-07-30',
  });
  assert.ok(s.total >= 0 && s.total <= 100);
  assert.strictEqual(s.available.length, 8);
  assert.strictEqual(s.missing.length, 0);
  assert.strictEqual(s.probability, null);
  assert.ok(s.weights && s.components && Array.isArray(s.penalties));
  assert.strictEqual(s.dataQualityGrade, 'A');
});

test('the score contains NO momentum features — timing lives only in OMEGA (no double-counting)', () => {
  const keys = Object.keys(G.WEIGHTS);
  for (const banned of ['momentum', 'relativeStrength', 'rs', 'trend', 'volumeAccum']) {
    assert.ok(!keys.some(k => k.toLowerCase().includes(banned.toLowerCase())), `weight ${banned} must not exist`);
  }
  // priceVolumeConfirm is thesis CONFIRMATION vs a bench, not a momentum ranker:
  // a move AGAINST the thesis scores low, which a momentum feature would score high.
  const against = G.priceVolumeConfirmScore({ excessMovePct: -6, relVol: 3 }, +1);
  const withThesis = G.priceVolumeConfirmScore({ excessMovePct: 3, relVol: 1.2 }, +1);
  assert.ok(against < withThesis);
});

test('missing components renormalize and are reported; sparse inputs draw a penalty', () => {
  const s = G.opportunityScore({
    event: ev({ demandDeltaMW: null, contractDuration: null, certainty: 'ANNOUNCED' }),
    relationship: rel, classification: cls(), cps: null, tape: null,
    notYetRepriced: { score: null }, dollarVol: null, asOf: '2026-07-30',
  });
  assert.ok(s.missing.includes('eventMagnitude') && s.missing.includes('constraintPressure') && s.missing.includes('priceVolumeConfirm'));
  assert.ok(s.penalties.some(p => p.kind === 'sparse-inputs'));
  assert.ok(s.total != null);                                 // scored over what exists…
  assert.ok(s.missing.length >= 4);                           // …with the gaps disclosed
});

test('explicit penalties subtract from the weighted sum (duplicate/uncertain evidence is not free)', () => {
  const clean = G.opportunityScore({ event: ev(), relationship: rel, classification: cls(), cps, tape, notYetRepriced: { score: 65 }, dollarVol: 60e6, asOf: '2026-07-30' });
  const penalized = G.opportunityScore({
    event: ev({ sourceEvidence: [{ primaryOrSecondary: 'secondary' }] }),
    relationship: rel,
    classification: cls({ uncertaintyPenalties: [{ kind: 'far-future-start', points: 15 }, { kind: 'single-source', points: 10 }] }),
    cps, tape, notYetRepriced: { score: 65 }, dollarVol: 60e6, asOf: '2026-07-30',
  });
  assert.ok(penalized.total < clean.total);
  assert.ok(penalized.penaltyPoints >= 25 + 15);              // + no-primary-source
});

test('freshness decays to zero (old seeded events cannot look actionable)', () => {
  assert.strictEqual(G.freshnessScore('2024-09-20', '2026-07-30'), 0);
  assert.strictEqual(G.freshnessScore('2026-07-29', '2026-07-30'), 100);
});

test('actionGate cascade returns the FIRST failing gate with its reason', () => {
  const score = G.opportunityScore({ event: ev(), relationship: rel, classification: cls(), cps, tape, notYetRepriced: { score: 65 }, dollarVol: 60e6, asOf: '2026-07-30' });
  const timing = { stage: 'CONFIRMED', entry: { classification: 'BUY_NOW' }, risk: { invalidation: 10, target1: 14, rr: 2.4 } };

  assert.strictEqual(G.actionGate({ classification: cls({ classification: 'MIXED_EFFECT' }), score, cps, timing, regime: {}, dollarVol: 60e6 }).status, G.STATUS.RECORDED_ONLY);
  assert.strictEqual(G.actionGate({ classification: cls({ swingRelevant: false, horizonDays: 90 }), score, cps, timing, regime: {}, dollarVol: 60e6 }).status, G.STATUS.NOT_SWING_RELEVANT);
  assert.strictEqual(G.actionGate({ classification: cls(), score, cps: { total: null, dataQuality: 'poor' }, timing, regime: {}, dollarVol: 60e6 }).status, G.STATUS.DATA_INSUFFICIENT);
  assert.strictEqual(G.actionGate({ classification: cls(), score, cps, timing, regime: { riskOff: true }, dollarVol: 60e6 }).status, G.STATUS.REGIME_BLOCKED);
  assert.strictEqual(G.actionGate({ classification: cls(), score, cps, timing, regime: {}, dollarVol: 1e6 }).status, G.STATUS.ILLIQUID);
  assert.strictEqual(G.actionGate({ classification: cls(), score, cps, timing: null, regime: {}, dollarVol: 60e6 }).status, G.STATUS.NO_TIMING_CONFIRM);
  assert.strictEqual(G.actionGate({ classification: cls(), score, cps, timing: { stage: 'EXTENDED', entry: { classification: 'BUY_ON_FIRST_PULLBACK' }, risk: timing.risk }, regime: {}, dollarVol: 60e6 }).status, G.STATUS.OVEREXTENDED);
  assert.strictEqual(G.actionGate({ classification: cls(), score, cps, timing: { stage: 'EARLY', entry: { classification: 'SKIP', reason: 'no data' }, risk: timing.risk }, regime: {}, dollarVol: 60e6 }).status, G.STATUS.NO_TIMING_CONFIRM);
  const pass = G.actionGate({ classification: cls(), score, cps, timing, regime: { riskOff: false }, dollarVol: 60e6 });
  assert.strictEqual(pass.status, G.STATUS.ACTIONABLE_RESEARCH);
  assert.strictEqual(pass.shadow, true);                      // even the pass is shadow
});

test('price action against the thesis blocks the gate', () => {
  const badTape = { excessMovePct: -5, relVol: 1.0, dollarVol: 60e6 };
  const s = G.opportunityScore({ event: ev(), relationship: rel, classification: cls(), cps, tape: badTape, notYetRepriced: { score: 40 }, dollarVol: 60e6, asOf: '2026-07-30' });
  const g = G.actionGate({ classification: cls(), score: s, cps, timing: { entry: { class: 'BUY_NOW' }, risk: { invalidation: 1, target1: 2, rr: 2 } }, regime: {}, dollarVol: 60e6 });
  assert.strictEqual(g.status, G.STATUS.NO_TIMING_CONFIRM);
  assert.match(g.reason, /does not confirm/);
});
