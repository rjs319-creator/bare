'use strict';
// CATALYST–FLOW SERVING + ARTIFACT — the read-only contract and the earned-mode rule.
//
// Two things are guarded here. First, that `CATALYST_FLOW_MODE=live` does NOT make the
// engine live: promotion is earned by recorded evidence, and a config value can never
// stand in for it. Second, that the artifact refuses to describe a LambdaMART score as
// anything other than ordinal — presenting a relevance score as a return or a probability
// is the single most misleading thing this pipeline could publish.
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/catalyst-flow/artifact');
const SRV = require('../lib/catalyst-flow/serving');
const CFG = require('../lib/catalyst-flow/config');

const goodArtifact = (over = {}) => A.buildArtifact({
  decisionDate: '2026-06-10',
  generatedAt: '2026-06-10T22:00:00Z',
  arm: 'E2_CATALYST_RANKER',
  ranks: [
    { symbol: 'aaa', score: 1.4, sector: 'Technology', estimatedEdge: 0.02, estRoundTripCostPct: 0.36 },
    { symbol: 'bbb', score: 1.1, sector: 'Energy', estimatedEdge: 0.015, estRoundTripCostPct: 0.36 },
  ],
  modelMeta: { objective: 'lambdarank', metric: 'ndcg', ndcgEvalAt: [10] },
  ...over,
});

test('flags default to OFF — the app must build and serve with nothing configured', () => {
  const f = CFG.flags({});
  assert.strictEqual(f.enabled, false);
  assert.strictEqual(f.mode, 'shadow');
  assert.strictEqual(f.modelPath, null);
  assert.strictEqual(f.estimatesProvider, null);
  assert.strictEqual(f.signedOptionsProvider, null);
});

test('an unrecognised mode value falls back to shadow rather than being honoured', () => {
  assert.strictEqual(CFG.flags({ CATALYST_FLOW_MODE: 'production!!' }).mode, 'shadow');
});

test('a well-formed artifact validates and declares every score as ordinal', () => {
  const doc = goodArtifact();
  const v = A.validateArtifact(doc);
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  assert.ok(doc.ranks.every((r) => r.scoreMeaning === 'ordinal-lambdamart-relevance'));
  assert.strictEqual(doc.ranks[0].symbol, 'AAA');
  assert.deepStrictEqual(doc.ranks.map((r) => r.rank), [1, 2]);
});

test('an artifact whose score claims to be a probability or a return is REJECTED', () => {
  const doc = goodArtifact();
  doc.ranks[0].scoreMeaning = 'win-probability';
  const v = A.validateArtifact(doc);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /does not declare its score as ordinal/.test(e)));
});

test('an E3 artifact without signed-options coverage is refused — the arm was never measurable', () => {
  const doc = goodArtifact({ arm: 'E3_CATALYST_FLOW_RANKER', optionsSignedCoverage: false });
  const v = A.validateArtifact(doc);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /signed-options coverage/.test(e)));
});

test('duplicate symbols and unknown arms are rejected', () => {
  const dup = goodArtifact();
  dup.ranks.push({ ...dup.ranks[0], rank: 3 });
  assert.strictEqual(A.validateArtifact(dup).ok, false);
  assert.strictEqual(A.validateArtifact(goodArtifact({ arm: 'E9_MYSTERY' })).ok, false);
});

test('freshness is measured in SESSIONS — a Friday artifact is not stale on Monday', () => {
  const sessions = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-15'];
  const doc = goodArtifact({ decisionDate: '2026-06-12' });
  const monday = A.freshness(doc, { sessions, today: '2026-06-15' });
  assert.strictEqual(monday.ageSessions, 1);
  assert.strictEqual(monday.fresh, true);

  const old = A.freshness(goodArtifact({ decisionDate: '2026-06-08' }), { sessions, today: '2026-06-15' });
  assert.strictEqual(old.ageSessions, 5);
  assert.strictEqual(old.fresh, false);
});

test('promotion gates default to NOT PASSED — silence is never consent', () => {
  const g = SRV.evaluateGates(goodArtifact());
  assert.strictEqual(g.allPassed, false);
  assert.deepStrictEqual(g.failing.sort(), [...CFG.PROMOTION_GATES].filter((x) => x !== 'signedOptionsCoverage').sort());
});

test('CATALYST_FLOW_MODE=live does NOT make it live — the gates decide', () => {
  const m = SRV.resolveMode(goodArtifact(), { CATALYST_FLOW_MODE: 'live' });
  assert.strictEqual(m.mode, 'shadow');
  assert.ok(m.failingGates.length > 0);
  assert.match(m.reason, /promotion gate\(s\) not passed/);
});

test('mode becomes live only when EVERY gate is recorded as passed', () => {
  const doc = goodArtifact({
    pitClass: 'IMMUTABLE_PIT',
    dataQuality: {
      delistingsIncluded: true, ablationSurvivesFDR: true,
      positiveNetOfStressCost: true, deflatedSharpePositive: true, holdoutUntouched: true,
    },
  });
  assert.strictEqual(SRV.resolveMode(doc, { CATALYST_FLOW_MODE: 'live' }).mode, 'live');
  assert.strictEqual(SRV.resolveMode(doc, { CATALYST_FLOW_MODE: 'shadow' }).mode, 'shadow');
});

test('readLatestRanking reports DISABLED by default and never invents a ranking', async () => {
  const view = await SRV.readLatestRanking({ env: {} });
  assert.strictEqual(view.state, 'DISABLED');
  assert.strictEqual(view.artifact, null);
  assert.strictEqual(view.weight, 0);
  assert.strictEqual(view.influencesLivePicks, false);
  assert.match(view.reason, /off by default/);
});

test('enabled but with no storage reports UNAVAILABLE — there is no fallback path', async () => {
  const view = await SRV.readLatestRanking({ env: { CATALYST_FLOW_ENABLED: '1' } });
  assert.strictEqual(view.state, 'UNAVAILABLE');
  assert.strictEqual(view.artifact, null);
});

test('limitations are DERIVED from the artifact, so they cannot drift from what was measured', () => {
  const lim = SRV.limitationsOf(goodArtifact());
  assert.ok(lim.some((l) => /EXPLORATORY/.test(l)), 'exploratory provenance must be stated');
  assert.ok(lim.some((l) => /MISSING \(not zero\)/.test(l)), 'absent signed flow must be stated');
  assert.ok(lim.some((l) => /not expected returns and not probabilities/.test(l)));

  const clean = SRV.limitationsOf(goodArtifact({
    pitClass: 'IMMUTABLE_PIT', optionsSignedCoverage: true,
    dataQuality: { delistingsIncluded: true },
  }));
  assert.ok(!clean.some((l) => /EXPLORATORY/.test(l)));
  assert.ok(clean.some((l) => /not expected returns/.test(l)), 'the ordinal caveat is unconditional');
});
