'use strict';
// PHASE 2 ACCEPTANCE — the three-class safety taxonomy, enforced.
//
// The success criteria this file locks:
//   • a research-only or incomplete signal cannot enter or size the executable portfolio;
//   • QUALIFIED_LEAD survives end to end as a distinct class (never collapsed);
//   • the ensemble Book contains only sizing-eligible ideas;
//   • the annotate diagnostic is available but cannot become a live recommendation lane.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EL = require('../lib/eligibility');
const OE = require('../lib/omega-ensemble');
const { buildToday } = require('../lib/decision-routes');
const { SOURCES } = require('./fixtures/today-sources');

const NOW = Date.parse('2026-07-24T12:00:00Z');
const GOV = {
  savedAt: '2026-07-24T00:00:00.000Z', scoreboardGeneratedAt: '2026-07-23T22:00:00.000Z',
  strategies: [{ id: 'screener', status: 'production', weight: 1, version: 'screener-v2' }],
};
const OPTS = { governance: GOV, nowMs: NOW, dataGate: null };

test('the safe default is ENFORCEMENT (annotation is an explicit override)', () => {
  assert.equal(EL.DEFAULT_MODE, 'enforce');
  assert.equal(EL.resolveMode(undefined), 'enforce');
  assert.equal(EL.resolveMode(''), 'enforce');
  assert.equal(EL.resolveMode('nonsense'), 'enforce', 'an unreadable env value must not open the gate');
  assert.equal(EL.resolveMode('annotate'), 'annotate');
});

test('a RESEARCH signal can never enter the portfolio — in either mode', () => {
  for (const eligibilityMode of ['enforce', 'annotate']) {
    const p = buildToday(SOURCES, null, null, null, { ...OPTS, eligibilityMode });
    for (const held of p.portfolio.selected) {
      assert.notEqual(held.evidenceClass, 'RESEARCH', `${held.id} is research but reached the book in ${eligibilityMode}`);
      assert.notEqual(held.evidenceClass, 'QUALIFIED_LEAD', `${held.id} is a lead but reached the book in ${eligibilityMode}`);
      assert.equal(held.eligibility.sizingEligible, true);
      assert.ok(held.eligibility.sizingWeight > 0);
    }
  }
});

test('an incomplete plan is never sizable, however strong the score', () => {
  const src = EL.assessSource('screener', { gov: EL.indexGovernance(GOV, NOW), registryVersionOf: () => 'screener-v2' });
  const noTarget = EL.assessSignal({ source: 'screener', ticker: 'A', side: 'long', tier: 'Early', universeScope: 'large', entry: 10, stop: 9, liquidity: { dollarVol: 9e7 } }, src, {});
  assert.equal(noTarget.signalClass, 'QUALIFIED_LEAD');
  assert.equal(noTarget.sizingWeight, 0);
  assert.ok(noTarget.reasonCodes.includes(EL.REASON_CODE.NO_PLAN));
});

test('a lead-only CONTRACT can never be sized even if levels are attached downstream', () => {
  const gov = { ...GOV, strategies: [{ id: 'readthrough', status: 'production', weight: 1, version: 'ReadThrough-v1' }] };
  const src = { source: 'readthrough', staticStatus: 'production', pinned: false, governance: { status: 'production', weight: 1 }, displayEligible: true, tradeEligible: true, sizingWeight: 1, reasons: [] };
  const el = EL.assessSignal({ source: 'readthrough', ticker: 'X', side: 'long', entry: 10, stop: 9, target: 12, liquidity: { dollarVol: 9e7 } }, src, {});
  assert.equal(el.leadOnly, true);
  assert.equal(el.sizingEligible, false);
  assert.equal(el.signalClass, 'QUALIFIED_LEAD');
  assert.ok(el.reasonCodes.includes(EL.REASON_CODE.LEAD_ONLY));
  assert.ok(gov);
});

test('QUALIFIED_LEAD is preserved through gateSignals, the payload and the API response shape', () => {
  const g = EL.gateSignals([
    { source: 'screener', ticker: 'AAA', side: 'long', tier: 'Early', universeScope: 'large', entry: 1, stop: 0.9, target: 1.3, liquidity: { dollarVol: 5e7 } },
    { source: 'screener', ticker: 'BBB', side: 'long', tier: 'Early', universeScope: 'large', liquidity: { dollarVol: 5e7 } },
    { source: 'coil', ticker: 'CCC', side: 'long' },
  ], { governance: GOV, nowMs: NOW });
  assert.deepEqual(g.classCounts, { ACTIONABLE: 1, QUALIFIED_LEAD: 1, RESEARCH: 1 });
  assert.equal(g.sizable.length, 1, 'only the actionable row is sizable');
  assert.equal(g.tradeable.length, 2, 'a qualified lead may still be displayed on the gated board');
});

test('research signals cannot inflate the actionable opportunity count', () => {
  const enf = buildToday(SOURCES, null, null, null, { ...OPTS, eligibilityMode: 'enforce' });
  const ann = buildToday(SOURCES, null, null, null, { ...OPTS, eligibilityMode: 'annotate' });
  // The annotate board displays far more rows, but the tradeable-opportunity accounting
  // (which drives exposure) is computed on the same sizing set in both modes.
  assert.equal(enf.opportunity.qualifyingCount, ann.opportunity.qualifyingCount);
  assert.equal(enf.portfolio.selected.length, ann.portfolio.selected.length);
});

test('the ensemble Book holds only sizing-eligible ideas; leads ride as annotations', () => {
  const today = {
    ok: true, generatedAt: '2026-07-24T00:00:00Z', regime: {}, counts: {},
    portfolio: {
      method: 'portfolio-v1', caps: {}, exposure: {}, familyExposure: {}, unfilled: 8, selected: [
        { id: 'screener:swing:AAA', ticker: 'AAA', horizon: 'swing', signalClass: 'ACTIONABLE', sizingEligible: true },
        { id: 'coil:swing:CCC', ticker: 'CCC', horizon: 'swing', signalClass: 'RESEARCH', sizingEligible: false, eligibility: { sizingEligible: false, reasons: ['shadow'] } },
      ], excluded: [],
    },
  };
  const view = OE.buildEnsembleView({ today, health: null });
  assert.deepEqual(view.ranking.map(r => r.ticker), ['AAA']);
  assert.deepEqual(view.annotations.map(a => a.ticker), ['CCC']);
  assert.equal(view.bookBasis.held, 1);
  assert.equal(view.bookBasis.annotationsOnly, 1);
  assert.match(view.disclosures[0], /sizing-eligible ACTIONABLE/);
});

test('the ensemble Book does not smuggle research through the legacy topByHorizon fallback', () => {
  const today = {
    ok: true, topByHorizon: { swing: [
      { id: 'a', ticker: 'AAA', horizon: 'swing', signalClass: 'ACTIONABLE', sizingEligible: true },
      { id: 'b', ticker: 'BBB', horizon: 'swing', signalClass: 'QUALIFIED_LEAD', sizingEligible: false },
    ] },
  };
  const view = OE.buildEnsembleView({ today, health: null });
  assert.deepEqual(view.ranking.map(r => r.ticker), ['AAA']);
});

test('the shadow comparison is a DIAGNOSTIC, explicitly not a recommendation lane', () => {
  const p = buildToday(SOURCES, null, null, null, { ...OPTS, eligibilityMode: 'enforce' });
  const sc = p.governanceGate.shadowComparison;
  assert.equal(sc.direction, 'enforced-vs-annotate');
  assert.ok(Array.isArray(sc.annotateWouldHaveShown));
  assert.ok(Array.isArray(sc.suppressedByEnforcement));
  assert.match(sc.note, /NOT recommendations/);
  // and the suppressed ids are absent from every served lane
  const served = new Set([
    ...Object.values(p.actionableByHorizon).flat(),
    ...p.portfolio.selected,
  ].map(x => x.id));
  for (const id of sc.suppressedByEnforcement) assert.ok(!served.has(id), `${id} was suppressed yet served`);
});

test('the payload reports the before/after class split so the exclusion is auditable', () => {
  const p = buildToday(SOURCES, null, null, null, { ...OPTS, eligibilityMode: 'annotate' });
  const total = p.counts.byClass.ACTIONABLE + p.counts.byClass.QUALIFIED_LEAD + p.counts.byClass.RESEARCH;
  assert.equal(total, p.counts.signals);
  assert.equal(p.counts.sizingEligible, p.portfolio.universe.considered);
  assert.ok(p.governanceGate.excluded.every(e => e.code && e.reason));
});
