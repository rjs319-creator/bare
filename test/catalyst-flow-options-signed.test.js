'use strict';
// CATALYST–FLOW SIGNED OPTIONS — the refusal contract.
//
// The single most damaging thing this experiment could do is let free option-chain volume
// masquerade as signed customer opening flow. These tests exist so that becomes impossible
// to do accidentally: an adapter that cannot identify participant, side and open/close is
// refused outright, family C stays MISSING rather than zero, and an unmeasured arm can
// never be reported as a finding about alpha.
const test = require('node:test');
const assert = require('node:assert');
const SG = require('../lib/catalyst-flow/options-signed');

const qualified = {
  name: 'cboe-open-close',
  identifiesParticipant: true, identifiesSide: true, identifiesOpenClose: true,
  exchanges: ['C1', 'C2', 'BZX', 'EDGX'], exchangeCoverageComplete: true,
  fetchSignedOpenClose: async () => ({ custBuyToOpenCallUsd: 1e6, custBuyToOpenPutUsd: 4e5, openingImbalanceNorm: 0.43, availableAtTs: '2024-05-03T02:00:00Z' }),
};

test('no provider ⇒ coverage false, E3 INSUFFICIENT_DATA, all three capabilities named as missing', () => {
  const c = SG.coverageReport(null);
  assert.strictEqual(c.optionsSignedCoverage, false);
  assert.strictEqual(c.armE3Status, 'INSUFFICIENT_DATA');
  assert.deepStrictEqual(c.missingCapabilities, ['identifiesParticipant', 'identifiesSide', 'identifiesOpenClose']);
});

test('a free option-CHAIN adapter is REFUSED — volume and OI are not participant/side/open-close', () => {
  const chain = { name: 'yahoo-chain', identifiesParticipant: false, identifiesSide: false, identifiesOpenClose: false, fetchSignedOpenClose: async () => ({ openingImbalanceNorm: 0.9 }) };
  const d = SG.describeAdapter(chain);
  assert.strictEqual(d.usable, false);
  assert.match(d.reason, /chain snapshot, not signed opening flow/);
});

test('declaring the capabilities without implementing the fetch is still refused', () => {
  const liar = { name: 'claims-a-lot', identifiesParticipant: true, identifiesSide: true, identifiesOpenClose: true };
  assert.strictEqual(SG.describeAdapter(liar).usable, false);
});

test('a partially-capable adapter cannot populate family C at ANY coverage level', async () => {
  const partial = { name: 'side-only', identifiesParticipant: false, identifiesSide: true, identifiesOpenClose: true, fetchSignedOpenClose: async () => ({ custBuyToOpenCallUsd: 5e5 }) };
  const r = await SG.fetchSignedFlow(partial, { symbol: 'ABC', session: '2024-05-02' });
  assert.strictEqual(r.coverage, false);
  assert.strictEqual(r.values.custBuyToOpenCallUsd, null, 'the adapter offered a value; it must not be taken');
});

test('MISSING IS NOT ZERO — every family-C value comes back null, never 0', async () => {
  const r = await SG.fetchSignedFlow(null, { symbol: 'ABC', session: '2024-05-02' });
  assert.strictEqual(r.coverage, false);
  const vals = Object.values(r.values);
  assert.ok(vals.length >= 13);
  assert.ok(vals.every((v) => v === null), 'a zero here would assert "balanced flow" — a measurement we never made');
});

test('a qualified adapter populates only DECLARED columns and cannot smuggle in new ones', async () => {
  const smuggler = { ...qualified, fetchSignedOpenClose: async () => ({ openingImbalanceNorm: 0.4, secretEdgeFactor: 99 }) };
  const r = await SG.fetchSignedFlow(smuggler, { symbol: 'ABC', session: '2024-05-02' });
  assert.strictEqual(r.coverage, true);
  assert.strictEqual(r.values.openingImbalanceNorm, 0.4);
  assert.strictEqual(r.values.secretEdgeFactor, undefined);
});

test('a provider error degrades to missing-with-a-reason, never to a partial vector', async () => {
  const broken = { ...qualified, fetchSignedOpenClose: async () => { throw new Error('402 payment required'); } };
  const r = await SG.fetchSignedFlow(broken, { symbol: 'ABC', session: '2024-05-02' });
  assert.strictEqual(r.coverage, false);
  assert.match(r.reason, /402/);
  assert.ok(Object.values(r.values).every((v) => v === null));
});

test('partial exchange coverage is never presented as full-market', () => {
  const c1only = { ...qualified, exchanges: ['C1'], exchangeCoverageComplete: false };
  const rep = SG.coverageReport(c1only);
  assert.strictEqual(rep.optionsSignedCoverage, true);
  assert.strictEqual(rep.exchangeCoverageComplete, false, 'C1 history is longer than the others and must stay distinguishable');
  assert.deepStrictEqual(rep.exchanges, ['C1']);
});

test('an EMPTY arm is INSUFFICIENT_DATA — never a verdict about alpha', () => {
  const v = SG.armVerdict({ coverage: false, pairedCohorts: 0, result: null });
  assert.strictEqual(v.verdict, 'INSUFFICIENT_DATA');
  assert.match(v.reason, /never measured/);

  // Coverage present but no paired cohorts is still not a finding.
  assert.strictEqual(SG.armVerdict({ coverage: true, pairedCohorts: 0 }).verdict, 'INSUFFICIENT_DATA');
  assert.strictEqual(SG.armVerdict({ coverage: true, pairedCohorts: 40, result: { avg: 1 } }).verdict, 'MEASURED');
});

test('the exploratory free-chain arm carries its non-substitutability in the value itself', () => {
  const x = SG.exploratoryChainArm({ callPutVolumeRatio: 2.1 });
  assert.strictEqual(x.isSignedOpeningFlow, false);
  assert.strictEqual(x.substitutableForFamilyC, false);
  assert.strictEqual(x.comparableToE3, false);
  assert.match(x.caveat, /cannot determine participant, side, or open\/close/);
});
