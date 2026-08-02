'use strict';
// EDGAR delisting-evidence derivation (pure parts of research/lib/edgar.js).
// Validated against real cases 2026-08-02: ATVI (Form 25-NSE 2023-10-13 +
// 8-K 2.01 same day → acquisition, effective 2023-10-23) and FRC (bank
// registrant — no EDGAR Form 25 exists; stays unconfirmed by design).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const edgar = require('../research/lib/edgar');

function submissions(rows) {
  return {
    filings: {
      recent: {
        form: rows.map((r) => r.form),
        filingDate: rows.map((r) => r.date),
        items: rows.map((r) => r.items || ''),
        accessionNumber: rows.map((r, i) => r.acc || `acc-${i}`),
      },
    },
  };
}

test('Form 25 + 8-K item 1.03 within window → bankruptcy delisting, effective filing+10d', () => {
  const ev = edgar.extractDelistingEvidence(submissions([
    { form: '25-NSE', date: '2023-06-20' },
    { form: '8-K', date: '2023-05-01', items: '1.03,9.01' },
    { form: '10-K', date: '2023-02-01' },
  ]));
  const d = edgar.deriveDelisting(ev, '2026-08-02T00:00:00.000Z');
  assert.equal(d.reasonCategory, 'bankruptcy');
  assert.equal(d.date, '2023-06-30', 'Rule 12d2-2: effective 10 days after filing');
  assert.equal(d.source, 'sec-edgar-form25');
  assert.equal(d.sourcePublishedAt, '2023-06-20');
  assert.equal(d.provenance, 'regulatory_filing');
});

test('Form 25 + 8-K item 2.01 near the notice → acquisition (the ATVI shape)', () => {
  const ev = edgar.extractDelistingEvidence(submissions([
    { form: '15-12G', date: '2023-10-23' },
    { form: '25-NSE', date: '2023-10-13' },
    { form: '8-K', date: '2023-10-13', items: '2.01,3.01,5.01' },
  ]));
  const d = edgar.deriveDelisting(ev, null);
  assert.equal(d.reasonCategory, 'acquisition');
  assert.equal(d.evidence.type, 'form25');
});

test('an old 2.01 far outside the window does NOT classify the delisting', () => {
  const ev = edgar.extractDelistingEvidence(submissions([
    { form: '25', date: '2024-01-10' },
    { form: '8-K', date: '2016-05-09', items: '2.01' },   // an unrelated old asset purchase
  ]));
  const d = edgar.deriveDelisting(ev, null);
  assert.equal(d.reasonCategory, null, 'confirmed delisting, reason honestly unverified');
});

test('a 1.03 filed long AFTER the Form 25 does not classify it (onlyBefore window)', () => {
  const ev = edgar.extractDelistingEvidence(submissions([
    { form: '25', date: '2022-01-10' },
    { form: '8-K', date: '2023-06-01', items: '1.03' },
  ]));
  assert.equal(edgar.deriveDelisting(ev, null).reasonCategory, null);
});

test('bankruptcy beats acquisition when both are in window (a 363 sale inside chapter 11)', () => {
  const ev = edgar.extractDelistingEvidence(submissions([
    { form: '25-NSE', date: '2023-06-20' },
    { form: '8-K', date: '2023-04-01', items: '1.03' },
    { form: '8-K', date: '2023-06-10', items: '2.01' },
  ]));
  assert.equal(edgar.deriveDelisting(ev, null).reasonCategory, 'bankruptcy');
});

test('Form 15 alone is a weaker anchor: deregistration at the filing date, reason unverified', () => {
  const ev = edgar.extractDelistingEvidence(submissions([{ form: '15-12B', date: '2024-05-05' }]));
  const d = edgar.deriveDelisting(ev, null);
  assert.equal(d.source, 'sec-edgar-form15');
  assert.equal(d.date, '2024-05-05');
  assert.equal(d.reasonCategory, null);
});

test('no delisting filings → null (an investor-filer CIK like FRC gains no confirmation)', () => {
  const ev = edgar.extractDelistingEvidence(submissions([
    { form: 'SC 13G/A', date: '2024-02-09' },
    { form: 'SC 13G', date: '2023-02-10' },
  ]));
  assert.equal(edgar.deriveDelisting(ev, null), null);
  assert.equal(edgar.extractDelistingEvidence({}).form25, null, 'missing filings block handled');
});

test('the LATEST of several Form 25 filings anchors the delisting', () => {
  const ev = edgar.extractDelistingEvidence(submissions([
    { form: '25', date: '2020-03-01' },
    { form: '25-NSE', date: '2024-02-01' },
  ]));
  assert.equal(ev.form25.filingDate, '2024-02-01');
});

test('padCik normalizes to the 10-digit EDGAR form', () => {
  assert.equal(edgar.padCik('718877'), '0000718877');
  assert.equal(edgar.padCik('0001652044'), '0001652044');
});
