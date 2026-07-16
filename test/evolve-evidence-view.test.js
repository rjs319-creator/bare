'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEvidenceView, CHAMPION, CHALLENGER } = require('../lib/evolve-evidence-view');

// A realistic op=evolveomegawf payload. `passed` drives the promotion decision.
function makePayload({ verdict = 'no-edge', purgedMean = -0.03, passed = false, positiveBlocks = 0,
  testedBlocks = 4, dsrPassing = 0, trials = 18 } = {}) {
  const purged = { ready: true, meanOOS: purgedMean, testedBlocks, positiveBlocks, passed, brier: 0.21 };
  return {
    ok: true, version: 'evolve-omega-wf-v1', margin: 0.02, embargo: 3, weighted: false,
    events: 3873, range: '5y', scope: 'large', generatedAt: '2026-07-15',
    regimeComposition: { 'risk-on': 2000, neutral: 1400, 'risk-off': 473 },
    uniqueness: { rawN: 3873, effectiveN: 3010.4, uniquenessRatio: 0.777 },
    deflatedSharpe: {
      trials, varSR: 0.02, expectedMaxSharpeNull: 0.32, passDSR: 0.95, passing: dsrPassing,
      survivors: dsrPassing ? ['gapgo|risk-on|fast'] : [],
      cells: [{ specialist: 'gapgo', regime: 'risk-on', horizon: 'fast', n: 40, sr: 0.016, dsr: 0, pass: dsrPassing > 0 }],
      verdict: dsrPassing ? 'cell(s) survive multiple-testing' : 'no cell survives multiple-testing',
    },
    pooled: { purged, leaky: { meanOOS: purgedMean + 0.05, brier: 0.2 }, leakageInflation: 0.05 },
    byHorizon: {
      fast: { n: 1300, uniqueness: { rawN: 1300, effectiveN: 1300, uniquenessRatio: 1.0 }, purged: { meanOOS: -0.02, testedBlocks: 4, positiveBlocks: 1, passed: false, brier: 0.22 }, leaky: {}, verdict: 'no-edge' },
      swing: { n: 1300, uniqueness: { rawN: 1300, effectiveN: 1131, uniquenessRatio: 0.87 }, purged: { meanOOS: -0.05, testedBlocks: 4, positiveBlocks: 0, passed: false, brier: 0.24 }, leaky: {}, verdict: 'no-edge' },
      position: { n: 1273, uniqueness: { rawN: 1273, effectiveN: 789, uniquenessRatio: 0.62 }, purged: { meanOOS: -0.03, testedBlocks: 3, positiveBlocks: 1, passed: false, brier: 0.23 }, leaky: {}, verdict: 'no-edge' },
    },
    verdict,
  };
}

test('no-edge payload → fail verdict, champion retained, no promotion', () => {
  const v = buildEvidenceView(makePayload());
  assert.strictEqual(v.available, true);
  assert.strictEqual(v.verdict.code, 'no-edge');
  assert.strictEqual(v.verdict.tone, 'fail');
  assert.strictEqual(v.championChallenger.promote, false);
  assert.strictEqual(v.promotion.promote, false);
  assert.match(v.championChallenger.decision, new RegExp(`${CHAMPION} retained`));
  assert.strictEqual(v.championChallenger.champion, CHAMPION);
  assert.strictEqual(v.championChallenger.challenger, CHALLENGER);
});

test('edge-holds-oos + passed → PROMOTE decision', () => {
  const v = buildEvidenceView(makePayload({ verdict: 'edge-holds-oos', purgedMean: 0.06, passed: true, positiveBlocks: 4 }));
  assert.strictEqual(v.verdict.tone, 'pass');
  assert.strictEqual(v.championChallenger.promote, true);
  assert.strictEqual(v.promotion.promote, true);
  assert.match(v.championChallenger.decision, new RegExp(`${CHALLENGER} clears`));
});

test('champion-challenger carries purged vs leaky IC and measured leakage', () => {
  const cc = buildEvidenceView(makePayload()).championChallenger;
  assert.strictEqual(cc.purgedMeanIC, -0.03);
  assert.strictEqual(cc.leakyMeanIC, 0.02);
  assert.strictEqual(cc.leakageInflation, 0.05); // rigor removes this much inflation
});

test('horizon rows map n, meanOOS, blocks, verdict, and uniqueness', () => {
  const rows = buildEvidenceView(makePayload()).horizons;
  assert.strictEqual(rows.length, 3);
  const pos = rows.find((r) => r.horizon === 'position');
  assert.strictEqual(pos.n, 1273);
  assert.strictEqual(pos.meanOOS, -0.03);
  assert.strictEqual(pos.positiveBlocks, 1);
  assert.strictEqual(pos.testedBlocks, 3);
  assert.strictEqual(pos.effectiveN, 789);
  assert.strictEqual(pos.verdict, 'no-edge');
});

test('DSR summary reports trials, survivors, best cell, and E[max|null]', () => {
  const d = buildEvidenceView(makePayload()).dsr;
  assert.strictEqual(d.trials, 18);
  assert.strictEqual(d.passing, 0);
  assert.strictEqual(d.expectedMaxNull, 0.32);
  assert.strictEqual(d.bestCell.specialist, 'gapgo');
  assert.match(d.plain, /0 of 18 cells survive/);
});

test('uniqueness ratio produces a plain-English independence line', () => {
  const u = buildEvidenceView(makePayload()).uniqueness;
  assert.strictEqual(u.rawN, 3873);
  assert.strictEqual(u.effectiveN, 3010.4);
  assert.match(u.plain, /78% of the raw labels are independent/);
});

test('surviving DSR cell → TRADE-eligible plain text', () => {
  const d = buildEvidenceView(makePayload({ dsrPassing: 1 })).dsr;
  assert.strictEqual(d.passing, 1);
  assert.match(d.plain, /survive the multiple-testing bar/);
  assert.match(d.plain, /TRADE-eligible/);
});

test('ok:false payload → unavailable view (fails closed, no fabricated verdict)', () => {
  const v = buildEvidenceView({ ok: false, note: 'Blob storage not configured' });
  assert.strictEqual(v.available, false);
  assert.match(v.note, /Blob storage/);
});

test('null payload → unavailable, does not throw', () => {
  const v = buildEvidenceView(null);
  assert.strictEqual(v.available, false);
});
