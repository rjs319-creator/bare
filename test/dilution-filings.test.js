'use strict';
// DILUTION FILINGS — the EDGAR-backed dilution combination. Defects prevented: UNKNOWN
// reading as safe, a shelf being treated as an active sale, the 7d/90d takedown double-count,
// and headline + filing evidence failing to reach EXTREME when both are present.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const dil = require('../lib/dilution-filings');

const NOW = new Date('2026-08-11T15:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);

test('filing flags classify forms and windows correctly', () => {
  const f = dil.filingFlags([
    { form: '424B5', filingDate: daysAgo(3) },
    { form: 'S-3', filingDate: daysAgo(200) },
    { form: 'S-1', filingDate: daysAgo(60) },
    { form: '8-K', filingDate: daysAgo(10), items: '1.01,3.02' },
  ], NOW);
  assert.equal(f.recentTakedown7d, true);
  assert.equal(f.shelfOnFile400d, true);
  assert.equal(f.s1OnFile180d, true);
  assert.equal(f.unregisteredSales90d, true);
});

test('an old 424B is not a recent takedown', () => {
  const f = dil.filingFlags([{ form: '424B3', filingDate: daysAgo(300) }], NOW);
  assert.equal(f.recentTakedown7d, false);
  assert.equal(f.recentTakedown90d, false);
});

test('7-day takedown supersedes the 90-day increment (no double count)', () => {
  const flags = dil.filingFlags([{ form: '424B5', filingDate: daysAgo(2) }], NOW);
  const out = dil.combineDilutionRisk({ riskScore: 0, newsAvailable: true }, flags, { filingsChecked: true });
  assert.equal(out.filingPoints, 30, 'only the 7-day takedown increment — the 90-day one must not stack');
});

test('UNKNOWN stays UNKNOWN when neither news nor filings answered', () => {
  const out = dil.combineDilutionRisk({ riskScore: null, newsAvailable: false }, null, { filingsChecked: false });
  assert.equal(out.label, 'UNKNOWN');
  assert.equal(out.score, null);
});

test('clean filings with no news is still UNKNOWN, never LOW', () => {
  const flags = dil.filingFlags([], NOW);
  const out = dil.combineDilutionRisk({ riskScore: null, newsAvailable: false }, flags, { filingsChecked: true });
  assert.equal(out.label, 'UNKNOWN');
});

test('headline HIGH plus active takedown reaches EXTREME', () => {
  const flags = dil.filingFlags([
    { form: '424B5', filingDate: daysAgo(2) },
    { form: 'S-3', filingDate: daysAgo(30) },
  ], NOW);
  const out = dil.combineDilutionRisk(
    { riskScore: 60, newsAvailable: true, atmRisk: true, activeOfferingRisk: true },
    flags, { filingsChecked: true },
  );
  assert.equal(out.label, 'EXTREME');
  assert.ok(out.score >= 80);
  assert.equal(out.flags.active_ATM, true);
  assert.equal(out.flags.recent_offering, true);
  assert.equal(out.flags.shelf_registration, true);
});

test('a shelf alone is MODERATE-at-most capacity, not an EXTREME sale', () => {
  const flags = dil.filingFlags([{ form: 'S-3', filingDate: daysAgo(30) }], NOW);
  const out = dil.combineDilutionRisk({ riskScore: 0, newsAvailable: true }, flags, { filingsChecked: true });
  assert.equal(out.label, 'LOW');
  assert.match(out.filingEvidence.join(' '), /capacity, not a sale/);
});

test('assessDilution without a filings entry discloses the filings index was not consulted', () => {
  const out = dil.assessDilution('XYZ', { riskScore: 10, newsAvailable: true }, {}, NOW);
  assert.match(out.basis, /filings index not consulted/);
});
