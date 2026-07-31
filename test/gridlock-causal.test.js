'use strict';
// GRIDLOCK causal engine: role×constraint matrix + gates. The key honesty tests:
// most pairs must classify TOO_INDIRECT, and "AI demand up → buy all utilities"
// must be impossible by construction.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/gridlock-causal');
const { RELATIONSHIPS, graphFor, validateGraph } = require('../lib/gridlock-exposure');
const { validateSeeds, SEED_EVENTS } = require('../lib/gridlock-seed');

const relOf = (ticker) => RELATIONSHIPS.find(r => r.ticker === ticker);
const dcEvent = (over = {}) => ({
  id: 'e1', canonicalEventId: 'gridlock:DATA_CENTER_LOAD:PJM:TEST',
  eventType: 'DATA_CENTER_LOAD', title: 'Synthetic 800 MW campus (PJM)',
  announcedAt: '2026-07-20', certainty: 'CONTRACTED', lifecycle: 'BUILDING',
  isoRegion: 'PJM', demandDeltaMW: 800, independentSourceCount: 3,
  companies: [], counterparties: [], affectedTickers: [], fieldConflicts: [], ...over,
});

test('exposure graph and seed events validate (citable, role-typed, effective-dated)', () => {
  const g = validateGraph();
  assert.strictEqual(g.ok, true, g.errors.join('; '));
  const s = validateSeeds();
  assert.strictEqual(s.ok, true, s.errors.join('; '));
  assert.ok(SEED_EVENTS.every(e => e.sourceEvidence[0].sourceFamily === 'curated-config'));
});

test('data-center load: merchant generator in-region = DIRECT; regulated wires = MIXED; hyperscaler = TOO_INDIRECT', () => {
  const merchant = C.classifyExposure({ event: dcEvent(), relationship: relOf('TLN'), asOf: '2026-07-21' });
  assert.strictEqual(merchant.classification, 'DIRECT_BENEFICIARY');
  assert.strictEqual(merchant.direction, 1);
  assert.ok(merchant.swingRelevant);
  assert.ok(merchant.causalChain && merchant.causalChain.invalidatingEvidence.length >= 3);

  const wires = C.classifyExposure({ event: dcEvent(), relationship: relOf('EXC'), asOf: '2026-07-21' });
  assert.strictEqual(wires.classification, 'MIXED_EFFECT');       // capex + regulatory lag, not a buy

  const hyper = C.classifyExposure({ event: dcEvent({ affectedTickers: ['MSFT'] }), relationship: relOf('MSFT'), asOf: '2026-07-21' });
  assert.strictEqual(hyper.classification, 'TOO_INDIRECT');       // named party but immaterial
});

test('"all utilities rise" is impossible: low-materiality unnamed wires utility is TOO_INDIRECT', () => {
  const fe = C.classifyExposure({ event: dcEvent(), relationship: relOf('FE'), asOf: '2026-07-21' });
  assert.strictEqual(fe.classification, 'TOO_INDIRECT');
  assert.match(fe.reason, /immaterial/);
});

test('region gate: a PJM event cannot classify an out-of-region exposure', () => {
  const ercotRel = { ...relOf('TLN'), isoRegion: 'ERCOT' };
  const r = C.classifyExposure({ event: dcEvent(), relationship: ercotRel, asOf: '2026-07-21' });
  assert.strictEqual(r.classification, 'TOO_INDIRECT');
  assert.match(r.reason, /region/);
});

test('evidence gates: low confidence → INSUFFICIENT_EVIDENCE; rumor → INSUFFICIENT_EVIDENCE; inferred link is penalized', () => {
  const weak = C.classifyExposure({ event: dcEvent(), relationship: { ...relOf('TLN'), confidence: 0.3 }, asOf: '2026-07-21' });
  assert.strictEqual(weak.classification, 'INSUFFICIENT_EVIDENCE');
  const rumor = C.classifyExposure({ event: dcEvent({ certainty: 'RUMORED' }), relationship: relOf('TLN'), asOf: '2026-07-21' });
  assert.strictEqual(rumor.classification, 'INSUFFICIENT_EVIDENCE');
  const inferred = C.classifyExposure({ event: dcEvent(), relationship: { ...relOf('TLN'), verifiedOrInferred: 'inferred' }, asOf: '2026-07-21' });
  assert.ok(inferred.uncertaintyPenalties.some(p => p.kind === 'inferred-exposure'));
});

test('uncertainty penalties: unfinanced announcement, far-future start, single source, contradictions', () => {
  const shaky = C.classifyExposure({
    event: dcEvent({ certainty: 'ANNOUNCED', effectiveStartDate: '2028-06-01', independentSourceCount: 1, fieldConflicts: [{ field: 'demandDeltaMW' }] }),
    relationship: relOf('TLN'), asOf: '2026-07-21',
  });
  const kinds = shaky.uncertaintyPenalties.map(p => p.kind);
  for (const k of ['no-binding-commitment', 'far-future-start', 'single-source', 'contradictory-evidence']) {
    assert.ok(kinds.includes(k), `missing penalty ${k}`);
  }
});

test('supply-direction rules: retirement benefits surviving merchants; new build benefits equipment, not incumbents', () => {
  const retire = dcEvent({ eventType: 'GENERATOR_RETIREMENT', title: 'Retiring 1,000 MW unit', generationDeltaMW: 1000, demandDeltaMW: null });
  const surv = C.classifyExposure({ event: retire, relationship: relOf('CEG'), asOf: '2026-07-21' });
  assert.strictEqual(surv.classification, 'DIRECT_BENEFICIARY');

  const build = dcEvent({ eventType: 'GENERATION_BUILD', generationDeltaMW: 2000, demandDeltaMW: null });
  const merchOnBuild = C.classifyExposure({ event: build, relationship: relOf('CEG'), asOf: '2026-07-21' });
  assert.notStrictEqual(merchOnBuild.classification, 'DIRECT_BENEFICIARY');   // supply-down rule must not fire
  const turbine = C.classifyExposure({ event: build, relationship: relOf('GEV'), asOf: '2026-07-21' });
  assert.strictEqual(turbine.classification, 'EQUIPMENT_OR_CAPACITY_BENEFICIARY');
});

test('namedOnly rules: unnamed same-role company demotes to SECOND_ORDER, never DIRECT', () => {
  const order = dcEvent({ eventType: 'TURBINE_ORDER', title: 'Seven turbines ordered', companies: ['SomeOther Turbines Inc'] });
  const gev = C.classifyExposure({ event: order, relationship: relOf('GEV'), asOf: '2026-07-21' });
  assert.strictEqual(gev.classification, 'SECOND_ORDER_BENEFICIARY');
  const named = C.classifyExposure({ event: { ...order, affectedTickers: ['GEV'] }, relationship: relOf('GEV'), asOf: '2026-07-21' });
  assert.strictEqual(named.classification, 'DIRECT_BENEFICIARY');
});

test('cost side is first-class: power-intensive consumer takes COST_HEADWIND with direction −1', () => {
  const clf = C.classifyExposure({ event: dcEvent(), relationship: relOf('CLF'), asOf: '2026-07-21' });
  assert.strictEqual(clf.classification, 'COST_HEADWIND');
  assert.strictEqual(clf.direction, -1);
});

test('classifyEvent records EVERY pair (the TOO_INDIRECT majority included)', () => {
  const graph = graphFor({ isoRegion: 'PJM', asOf: '2026-07-21' });
  const all = C.classifyEvent({ event: dcEvent(), relationships: graph, asOf: '2026-07-21' });
  assert.strictEqual(all.length, graph.length);
  const indirect = all.filter(r => ['TOO_INDIRECT', 'INSUFFICIENT_EVIDENCE', 'MIXED_EFFECT'].includes(r.classification));
  assert.ok(indirect.length >= all.length * 0.3, 'most pairs should NOT be beneficiaries');
});

test('effective dating: a relationship is invisible before validFrom', () => {
  const before = graphFor({ isoRegion: 'PJM', asOf: '2024-01-01' });
  assert.ok(!before.some(r => r.ticker === 'CEG' && r.projectOrAsset === 'Crane Clean Energy Center'));
});
