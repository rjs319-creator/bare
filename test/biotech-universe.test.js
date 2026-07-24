'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildUniverse, coverageReport, isFalsePositiveBiotech, normSym } = require('../lib/biotech-universe');

test('buildUniverse: curated + biotech-named expanded, deduped, with membership metadata', () => {
  const u = buildUniverse({ expanded: [
    { symbol: 'zbio', name: 'Zeta Therapeutics Inc' },       // biotech stem, not curated → expanded member
    { symbol: 'BSGM', name: 'BioSig Diagnostics Inc' },       // biotech-named BUT diagnostics → excluded
    { symbol: 'ISRG', name: 'Intuitive Surgical Instruments' }, // not biotech-named at all → skipped
    { symbol: 'BNGO', name: 'Bionano Genomics Inc' },         // genomic stem → member
  ] });
  const syms = u.members.map(m => m.symbol);
  assert.ok(syms.includes('ZBIO'), 'biotech name added + uppercased');
  assert.ok(syms.includes('BNGO'));
  assert.ok(!syms.includes('BSGM'), 'diagnostics false positive excluded');
  assert.ok(!syms.includes('ISRG'), 'non-biotech name not a member');
  assert.ok(u.excluded.some(e => e.symbol === 'BSGM'));
  const zbio = u.members.find(m => m.symbol === 'ZBIO');
  assert.equal(zbio.source, 'expanded');
  assert.ok(zbio.discoveryMethod.includes('stem'));
  assert.equal(u.survivorshipSafe, false, 'honest: no delisted-inclusive PIT master');
});

test('buildUniverse: false-positive filter blocks medtech/diagnostics/cannabis/shell names', () => {
  assert.equal(isFalsePositiveBiotech('Acme Diagnostic Imaging'), true);
  assert.equal(isFalsePositiveBiotech('Green Leaf Cannabis Corp'), true);
  assert.equal(isFalsePositiveBiotech('Foo Acquisition Corp'), true);
  assert.equal(isFalsePositiveBiotech('Viking Therapeutics'), false);
});

test('buildUniverse: generic bio-token match is flagged uncertain, not silently assumed biotech', () => {
  const u = buildUniverse({ expanded: [{ symbol: 'BIOX', name: 'Bioxcel Something' }] });
  const m = u.members.find(x => x.symbol === 'BIOX');
  assert.ok(m, 'bio-token name is included');
  assert.equal(m.uncertain, true, 'flagged uncertain');
  assert.ok(u.uncertainCount >= 1);
});

test('buildUniverse: PIT membership retains delisted names (active=false) from a secmaster', () => {
  const records = { DEAD: { symbol: 'DEAD', securityId: 'DEAD', status: 'removed', firstSeen: '2020-01-01', removedDate: '2023-06-01' } };
  const u = buildUniverse({ curated: ['DEAD', 'LLY'], expanded: [], asOf: '2024-01-01', secmasterRecords: records });
  const dead = u.members.find(m => m.symbol === 'DEAD');
  assert.ok(dead, 'delisted name retained in research universe');
  assert.equal(dead.active, false, 'marked inactive as-of the date');
});

test('coverageReport: reports candle coverage, staleness and missing reasons', () => {
  const members = [{ symbol: 'A', active: true }, { symbol: 'B', active: true }, { symbol: 'C', active: false }];
  const lookup = s => s === 'A' ? { hasCandles: true, lastDate: '2026-07-22' }
    : s === 'B' ? { hasCandles: true, lastDate: '2026-06-01' } : null;
  const cov = coverageReport(members, lookup, { asOf: '2026-07-23', staleAfterDays: 4 });
  assert.equal(cov.universeSize, 3);
  assert.equal(cov.withCandles, 2);
  assert.equal(cov.staleCandles, 1, 'B is stale');
  assert.equal(cov.missingCandles, 1, 'C has no candles');
  assert.ok(cov.missingReasons['delisted/inactive'] >= 1);
});

test('normSym normalizes ticker variants', () => {
  assert.equal(normSym(' vktx '), 'VKTX');
  assert.equal(normSym('brk.b'), 'BRK.B');
});
