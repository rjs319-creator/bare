'use strict';
// PHASE 9 — score comparability, an explicit merge model, and cost-net rank influence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SN = require('../lib/score-normalize');
const D = require('../lib/decision');

const cross = (source, values) => values.map((v, i) => ({ source, ticker: `T${i}`, rawConfidence: v, horizon: 'swing', side: 'long' }));

test('WITHIN-SOURCE percentile: a score is ranked against its OWN screener\'s cross-section', () => {
  const out = SN.normalizeSignals(cross('screener', [10, 20, 30, 40, 50, 60, 70, 80]));
  assert.equal(out[0].normalized.basis.startsWith('within-source percentile'), true);
  assert.ok(out[0].normalized.value < out[7].normalized.value);
  assert.ok(out[7].normalized.value > 90);
  assert.equal(out[0].normalized.sourceN, 8);
});

test('a thin cross-section is SHRUNK toward neutral instead of pretending to be a percentile', () => {
  const out = SN.normalizeSignals(cross('readthrough', [95, 20]));
  assert.match(out[0].normalized.basis, /shrunk toward neutral/);
  assert.equal(out[0].normalized.value, 72.5);   // 50 + (95-50)*0.5
  assert.equal(out[1].normalized.value, 35);
  assert.ok(out[0].normalized.value < 95, 'the extreme is removed, the order is kept');
});

test('a missing score is a MISSINGNESS INDICATOR — neutral, flagged, never a boost', () => {
  const [out] = SN.normalizeSignals([{ source: 'anomaly', ticker: 'X', rawConfidence: null }]);
  assert.equal(out.normalized.missing, true);
  assert.equal(out.normalized.value, SN.NEUTRAL);
});

test('an LLM read and a technical score are not compared as raw numbers — the prior is a ceiling', () => {
  assert.ok(SN.prior('readthrough') < SN.prior('screener'));
  assert.equal(SN.prior('brand-new-source'), SN.DEFAULT_PRIOR, 'an unregistered source is treated as a narrative read');
  const merged = SN.mergeConviction([
    { source: 'readthrough', normalized: { value: 99, prior: SN.prior('readthrough'), missing: false }, family: 'crossAsset' },
    { source: 'screener', normalized: { value: 80, prior: SN.prior('screener'), missing: false }, family: 'priceTrend' },
  ]);
  assert.equal(merged.decomposition[0].source, 'screener', 'the measured read is the base, not the loudest generated number');
});

test('MAX-CONFIDENCE MERGING IS GONE: the loudest source no longer sets the merged conviction', () => {
  const m = SN.mergeConviction([
    { source: 'toneshift', normalized: { value: 100, prior: SN.prior('toneshift'), missing: false }, family: 'fundamentalsRevisions' },
    { source: 'screener', normalized: { value: 60, prior: 1, missing: false }, family: 'priceTrend' },
  ]);
  assert.ok(m.conviction < 100, 'a 100 from a 0.4-prior source cannot become a 100 conviction');
  assert.ok(m.conviction > 60, 'but genuinely independent agreement still adds something');
});

test('CORRELATED AGREEMENT IS DISCOUNTED: same-family votes add far less than a new family', () => {
  const base = { source: 'screener', normalized: { value: 80, prior: 1, missing: false }, family: 'priceTrend' };
  const sameFam = SN.mergeConviction([base, { source: 'ignition', normalized: { value: 80, prior: 1, missing: false }, family: 'priceTrend' }]);
  const crossFam = SN.mergeConviction([base, { source: 'optionsflow', normalized: { value: 80, prior: 0.6, missing: false }, family: 'optionsPositioning' }]);
  assert.ok(crossFam.conviction > sameFam.conviction);
  assert.equal(sameFam.decomposition[1].sameFamily, true);
  assert.equal(crossFam.decomposition[1].sameFamily, false);
});

test('a CAP stops several correlated sources from compounding into false conviction', () => {
  const many = [
    { source: 'screener', normalized: { value: 90, prior: 1, missing: false }, family: 'priceTrend' },
    ...Array.from({ length: 6 }, (_, i) => ({ source: `s${i}`, normalized: { value: 90, prior: 1, missing: false }, family: `fam${i}` })),
  ];
  const m = SN.mergeConviction(many);
  assert.equal(m.capped, true);
  assert.ok(m.conviction <= 50 + (50 * SN.CAP_MULT) + 1e-9);
  assert.match(m.decomposition[m.decomposition.length - 1].reason, /cannot compound/);
});

test('a missing member contributes exactly zero (missingness is not evidence)', () => {
  const m = SN.mergeConviction([
    { source: 'screener', normalized: { value: 80, prior: 1, missing: false }, family: 'priceTrend' },
    { source: 'anomaly', normalized: { value: 50, prior: 0.4, missing: true }, family: 'volumeAccum' },
  ]);
  assert.equal(m.decomposition[1].contribution, 0);
  assert.equal(m.missing, true);
});

test('LEAD-ONLY rows carry an execution-uncertainty penalty (they do not escape the charge)', () => {
  const plan = SN.mergeConviction([{ source: 'screener', normalized: { value: 90, prior: 1, missing: false }, family: 'priceTrend' }]);
  const lead = SN.mergeConviction([{ source: 'screener', normalized: { value: 90, prior: 1, missing: false }, family: 'priceTrend' }], { leadOnly: () => true });
  assert.ok(lead.conviction < plan.conviction);
});

test('the decomposition is auditable and the plain-language explanation never claims a probability', () => {
  const m = SN.mergeConviction([
    { source: 'screener', normalized: { value: 85, prior: 1, missing: false }, family: 'priceTrend' },
    { source: 'ghost', normalized: { value: 70, prior: 1, missing: false }, family: 'volumeAccum' },
  ]);
  assert.equal(m.decomposition[0].role, 'base');
  assert.equal(m.decomposition[1].role, 'increment');
  for (const d of m.decomposition) assert.ok(d.reason, 'every contribution explains itself');
  const text = SN.explainConviction(m);
  assert.match(text, /relative setup score, not a probability/);
  assert.doesNotMatch(text, /probability of (rising|going up)/i);
});

test('the ranked signal exposes the full score decomposition', () => {
  const [sig] = D.rankSignals([D.makeSignal({ ticker: 'AAA', source: 'screener', horizon: 'swing', rawConfidence: 70, price: 10, entry: 10.2, stop: 9.5, target: 12, liquidity: { dollarVol: 5e7 } }).signal]
    .map(s => ({ ...s, normalized: { value: 88, basis: 'within-source percentile (same-day cross-section)', prior: 1, missing: false } })), { regime: {}, scoreboard: {} });
  const d = sig.scoreDecomposition;
  assert.equal(d.comparableConfidence, 88);
  assert.match(d.normalizationBasis, /within-source percentile/);
  assert.ok(d.formula.includes('costPenalty'));
  for (const k of ['confidence', 'regimeFit', 'execution', 'expectancyTilt', 'evidenceMult', 'costPenalty']) {
    assert.ok(Number.isFinite(d[k]), `${k} must be reported`);
  }
});

test('HISTORICAL RANK INFLUENCE uses the COST-NET record, not gross excess', () => {
  const summary = { groups: [{ section: 'screener', tier: 'Setup', horizons: { '5d': { avgExcess: 6, winRate: 60, n: 40, netExcessN: 40, avgNetExcess: 0.5 } } }] };
  const exp = D.expectancyFor('screener', 'Setup', 'swing', summary);
  assert.equal(exp.avgExcess, 0.5, 'the tilt reads net, not the flattering gross number');
  assert.equal(exp.grossAvgExcess, 6);
  assert.equal(exp.basis, 'cost-net');
  // gross remains a LABELED fallback when no net channel exists
  const grossOnly = D.expectancyFor('screener', 'Setup', 'swing', { groups: [{ section: 'screener', tier: 'Setup', horizons: { '5d': { avgExcess: 6, winRate: 60, n: 40 } } }] });
  assert.equal(grossOnly.avgExcess, 6);
  assert.match(grossOnly.basis, /gross/);
});

test('costs are not double-counted: the tilt is the SOURCE record, the penalty is THIS setup', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/decision.js'), 'utf8');
  assert.match(src, /NOT\s*\n?\s*\/\/\s*double-counting/i);
  // the composite multiplies the cost penalty exactly once
  const occurrences = (src.match(/costPenalty == null \? 1 : costPenalty/g) || []).length;
  assert.equal(occurrences, 1);
});

test('mergeSignals now produces a modelled conviction with its decomposition attached', () => {
  const a = { ticker: 'AAA', source: 'screener', horizon: 'swing', side: 'long', rawConfidence: 80, family: 'priceTrend', normalized: { value: 80, prior: 1, missing: false }, sources: ['screener'] };
  const b = { ticker: 'AAA', source: 'toneshift', horizon: 'swing', side: 'long', rawConfidence: 100, family: 'fundamentalsRevisions', normalized: { value: 100, prior: 0.4, missing: false }, sources: ['toneshift'] };
  const [merged] = D.mergeSignals([a, b]);
  assert.ok(merged.mergedConviction, 'the decomposition rides on the merged row');
  assert.equal(merged.rawConfidence, merged.mergedConviction.conviction);
  assert.ok(merged.rawConfidence < 100, 'no longer Math.max of incomparable scores');
  assert.equal(merged.normalized.value, merged.mergedConviction.conviction);
});
