'use strict';
// Prevents: incomparable periods entering revenue math (annual rows as quarters, Q4
// arithmetic), amended filings double-counting, unit mistakes, fabricated values when
// tags are inconsistent, and 8-K item scans missing the exact Item 1.05 designation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const SEC = require('../lib/tech-evidence/adapters/sec-facts');
const SIG = require('../lib/tech-evidence/signals');

const NOW = new Date('2026-08-11T15:00:00Z');
const MAPPING = { ticker: 'MDB', cik: '0001441816' };

const usd = (start, end, val, filed, form = '10-Q') => ({ start, end, val, filed, form, fy: 2026, fp: 'Q2', accn: `acc-${end}-${val}` });

function payloadWith(revRows, tag = 'RevenueFromContractWithCustomerExcludingAssessedTax') {
  return { facts: { 'us-gaap': { [tag]: { units: { USD: revRows } } } } };
}

test('extractFacts keeps only directly tagged quarters — annual/YTD rows rejected', () => {
  const rows = SEC.extractFacts(payloadWith([
    usd('2026-02-01', '2026-04-30', 450e6, '2026-06-05'),          // real quarter (89d)
    usd('2025-05-01', '2026-04-30', 1.7e9, '2026-06-05', '10-K'),  // annual — reject
    usd('2025-11-01', '2026-04-30', 900e6, '2026-06-05'),          // 6-month YTD — reject
  ]), SEC.TAGS[0]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].val, 450e6);
});

test('amended duplicate (same period+value) collapses to the EARLIEST filing; a changed value stays as a revision row', () => {
  const rows = SEC.extractFacts(payloadWith([
    usd('2026-02-01', '2026-04-30', 450e6, '2026-06-05'),
    usd('2026-02-01', '2026-04-30', 450e6, '2026-07-20', '10-Q/A'), // amendment, same value
    usd('2026-02-01', '2026-04-30', 455e6, '2026-07-25', '10-Q/A'), // restated value — kept separately
  ]), SEC.TAGS[0]);
  assert.equal(rows.length, 2);
  const original = rows.find(r => r.val === 450e6);
  assert.equal(original.filed, '2026-06-05', 'first public availability wins for the unchanged value');
  assert.ok(rows.find(r => r.val === 455e6), 'the restatement is preserved as its own row');
});

test('instant tags reject duration rows; shares tag uses its own unit', () => {
  const p = { facts: { 'us-gaap': { AccountsReceivableNetCurrent: { units: { USD: [
    { end: '2026-04-30', val: 300e6, filed: '2026-06-05', form: '10-Q' },
    { start: '2026-02-01', end: '2026-04-30', val: 1, filed: '2026-06-05', form: '10-Q' }, // duration — reject
  ] } } }, dei: { EntityCommonStockSharesOutstanding: { units: { shares: [
    { end: '2026-06-01', val: 82e6, filed: '2026-06-05', form: '10-Q' },
  ] } } } } };
  const ar = SEC.extractFacts(p, SEC.TAGS.find(t => t.measure === 'accountsReceivable'));
  assert.equal(ar.length, 1);
  const sh = SEC.extractFacts(p, SEC.TAGS.find(t => t.measure === 'sharesOutstanding'));
  assert.equal(sh.length, 1);
  assert.equal(sh[0].unit, 'shares');
});

test('missing/inconsistent tags produce zero observations — never a fabricated value', () => {
  assert.equal(SEC.extractFacts({ facts: {} }, SEC.TAGS[0]).length, 0);
  assert.equal(SEC.extractFacts(null, SEC.TAGS[0]).length, 0);
  const obs = SEC.factsToObservations({ facts: {} }, { mapping: MAPPING, retrievedAt: NOW.toISOString(), basis: 'live' });
  assert.equal(obs.length, 0);
});

test('cyber8kObservations flags exactly Item 1.05 (not 1.01/8.01 lookalikes)', () => {
  const filings = [
    { form: '8-K', filingDate: '2026-08-05', accession: 'a1', items: '1.05,9.01', url: 'https://www.sec.gov/x' },
    { form: '8-K', filingDate: '2026-08-04', accession: 'a2', items: '1.01,8.01', url: 'https://www.sec.gov/y' },
    { form: '8-K', filingDate: '2026-08-03', accession: 'a3', items: '10.5', url: 'https://www.sec.gov/z' },
  ];
  const obs = SEC.cyber8kObservations(filings, { mapping: MAPPING, retrievedAt: NOW.toISOString(), basis: 'live' });
  assert.equal(obs.length, 1);
  assert.equal(obs[0].detail.accession, 'a1');
});

test('revenue acceleration is point-in-time: a quarter filed AFTER the cutoff is invisible', () => {
  // 9 quarters of history so YoY pairs exist; latest filed 2026-06-05.
  const rows = [];
  // build quarters ~91d apart with start dates
  const ends = ['2024-04-30', '2024-07-31', '2024-10-31', '2025-01-31', '2025-04-30', '2025-07-31', '2025-10-31', '2026-01-31', '2026-04-30'];
  const vals = [300, 310, 320, 330, 345, 356, 368, 380, 430].map(v => v * 1e6); // last quarter accelerates
  ends.forEach((end, i) => {
    const start = new Date(new Date(end + 'T00:00:00Z').getTime() - 89 * 86400000).toISOString().slice(0, 10);
    const filed = new Date(new Date(end + 'T00:00:00Z').getTime() + 36 * 86400000).toISOString().slice(0, 10);
    rows.push(usd(start, end, vals[i], filed));
  });
  const facts = SEC.extractFacts(payloadWith(rows), SEC.TAGS[0])
    .map(r => ({ measure: 'revenue', start: r.start, end: r.end, val: r.val, filed: r.filed }));
  // cutoff right after the last filing (filed 2026-06-05): available and fresh
  const at = SIG.revenueAcceleration(facts, '2026-06-08');
  assert.equal(at.available, true);
  assert.ok(at.surprise > 0, 'ΔYoY must be positive for the accelerating quarter');
  // cutoff BEFORE the last filing: the new quarter must be invisible → stale/no event
  const before = SIG.revenueAcceleration(facts, '2026-06-01');
  assert.equal(before.available, false, 'no event window before the filing is public');
});
