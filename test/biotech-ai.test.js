'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEvidenceBundle, parseAssessment } = require('../lib/biotech-ai');

test('buildEvidenceBundle: filings are PRIMARY, news secondary, stable ids', () => {
  const b = buildEvidenceBundle({
    filings: [{ form: 'S-3', filingDate: '2026-07-01', url: 'u' }],
    news: [{ title: 'XYZ up on data', datetime: '2026-07-02' }],
  });
  assert.equal(b[0].id, 'f1');
  assert.equal(b[0].primary, true);
  assert.equal(b[1].id, 'n1');
  assert.equal(b[1].primary, false);
});

const cands = [{ ticker: 'VKTX', bundle: [{ id: 'f1', primary: true }, { id: 'n1', primary: false }] }, { ticker: 'CRSP', bundle: [{ id: 'n1', primary: false }] }];

test('parseAssessment: drops tickers not in the candidate set (no hallucinated names)', () => {
  const { items } = parseAssessment({ items: [
    { ticker: 'VKTX', classification: 'DATA', evidence: 'Verified', citations: ['f1'], reason: 'x', confidence: 4 },
    { ticker: 'ZZZZ', classification: 'FDA', evidence: 'Verified', citations: ['f1'], reason: 'x', confidence: 5 },
  ] }, cands);
  assert.equal(items.length, 1);
  assert.equal(items[0].ticker, 'VKTX');
});

test('parseAssessment: rejects citations not present in that ticker\'s bundle', () => {
  const { items } = parseAssessment({ items: [
    { ticker: 'VKTX', classification: 'DATA', evidence: 'Inferred', citations: ['f1', 'n9', 'zzz'], reason: 'x', confidence: 3 },
  ] }, cands);
  assert.deepEqual(items[0].citations, ['f1'], 'only bundle ids survive');
});

test('parseAssessment: "Verified" without a cited PRIMARY source is downgraded (grounding enforced)', () => {
  // CRSP bundle has only a secondary news id; claiming Verified must be downgraded.
  const { items } = parseAssessment({ items: [
    { ticker: 'CRSP', classification: 'DATA', evidence: 'Verified', citations: ['n1'], reason: 'x', confidence: 5 },
  ] }, cands);
  assert.equal(items[0].evidence, 'Inferred', 'no primary citation → not Verified');
  assert.equal(items[0].groundedPrimary, false);
});

test('parseAssessment: Verified survives when a PRIMARY id is cited', () => {
  const { items } = parseAssessment({ items: [
    { ticker: 'VKTX', classification: 'FDA', evidence: 'Verified', citations: ['f1'], reason: 'approval', confidence: 5 },
  ] }, cands);
  assert.equal(items[0].evidence, 'Verified');
  assert.equal(items[0].groundedPrimary, true);
});

test('parseAssessment: no citations + Verified → None (nothing supports it)', () => {
  const { items } = parseAssessment({ items: [
    { ticker: 'VKTX', classification: 'DATA', evidence: 'Verified', citations: [], reason: 'x', confidence: 2 },
  ] }, cands);
  assert.equal(items[0].evidence, 'None');
});
