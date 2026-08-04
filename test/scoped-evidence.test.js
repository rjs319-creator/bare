// Defect 5 — scope-contaminated track records. Under the scoped evidence-key
// contract a strong large-cap record can no longer tilt a small/micro candidate;
// insufficient scoped evidence yields a neutral buildingEvidence, never a
// fallback to the pooled record. Legacy (pre-contract) summaries keep their
// historical join so old stored docs still resolve as context.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { expectancyFor, expectancyTilt, rankSignals, makeSignal } = require('../lib/decision');
const EI = require('../lib/evidence-identity');

const strong5d = { avgExcess: 6.2, winRate: 71, avg: 7.0, median: 5.5, n: 60 };
const scopedSummary = {
  evidenceKeyVersion: EI.EVIDENCE_KEY_VERSION,
  groups: [
    { section: 'screener', tier: 'Setup', scope: 'large', picks: 60, horizons: { '5d': strong5d } },
    { section: 'screener', tier: 'Setup', scope: '', picks: 40, horizons: { '5d': strong5d } },   // legacy pre-scope records
  ],
};
const legacySummary = {   // a pre-contract summary: no evidenceKeyVersion, pooled group
  groups: [{ section: 'screener', tier: 'Setup', horizons: { '5d': strong5d } }],
};

test('a strong large-cap record cannot raise a small-cap candidate (neutral buildingEvidence)', () => {
  const exp = expectancyFor('screener', 'Setup', 'swing', scopedSummary, 'small');
  assert.strictEqual(exp.known, false);
  assert.strictEqual(exp.buildingEvidence, true);
  assert.strictEqual(expectancyTilt(exp).tilt, 1, 'neutral tilt — no pooled fallback');
});

test('the exact scope match resolves its own record', () => {
  const exp = expectancyFor('screener', 'Setup', 'swing', scopedSummary, 'large');
  assert.strictEqual(exp.known, true);
  assert.strictEqual(exp.n, 60);
  assert.ok(expectancyTilt(exp).tilt > 1, 'a genuinely scoped strong record still tilts up');
});

test('scoped signals never join the legacy (pre-scope) record inside a scoped summary', () => {
  // scope '' is the legacy bucket — a signal stamped micro must not borrow it.
  const exp = expectancyFor('screener', 'Setup', 'swing', scopedSummary, 'micro');
  assert.strictEqual(exp.known, false);
});

test('legacy summaries (no evidenceKeyVersion) keep the historical join — displayable context', () => {
  const exp = expectancyFor('screener', 'Setup', 'swing', legacySummary, 'small');
  assert.strictEqual(exp.known, true, 'pre-contract docs resolve as before; the next scoreboard write migrates the contract');
});

test('scope-specific expectancy cannot leak between scopes in the full ranking path', () => {
  const mk = (ticker, universeScope) => makeSignal({
    ticker, source: 'screener', section: 'screener', tier: 'Setup', horizon: 'swing', side: 'long',
    entry: 10, stop: 9, target: 13, price: 10, rawConfidence: 60, universeScope,
  }).signal;
  const ranked = rankSignals([mk('LGE', 'large'), mk('SML', 'small')], { regime: { riskOn: true }, scoreboard: scopedSummary });
  const lge = ranked.find(x => x.ticker === 'LGE');
  const sml = ranked.find(x => x.ticker === 'SML');
  assert.ok(lge.expectancyTilt > 1, 'large candidate earns its scoped record');
  assert.strictEqual(sml.expectancyTilt, 1, 'small candidate stays neutral — no leakage from the large record');
  assert.ok(lge.score > sml.score, 'the earned record, not pooling, differentiates them');
});

test('pooling across scopes is off as data, not wording', () => {
  assert.strictEqual(EI.MAY_POOL_SCOPES, false);
  assert.ok(EI.EVIDENCE_KEY_FIELDS.includes('universeScope'));
});
