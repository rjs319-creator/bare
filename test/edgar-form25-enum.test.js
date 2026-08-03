'use strict';
// Tests for the EDGAR full-index Form-25 enumeration core
// (research/lib/edgar-index.js): header-derived fixed-width parsing, Form 25
// vs amendment separation, tamper-evident partitions, quarter grid, and the
// coverage validator.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const EI = require('../research/lib/edgar-index');

const IDX = [
  'Description:           Quarterly form index',
  'Last Data Received:    2024-06-30',
  '',
  'Form Type   Company Name                                                  CIK         Date Filed  File Name',
  '---------------------------------------------------------------------------------------------------------------',
  '10-K        SOME  ODDLY   SPACED, INC.                                    1000001     2024-04-02  edgar/data/1000001/0001.txt',
  '25          AIRTRAN HOLDINGS INC                                          1000002     2024-05-10  edgar/data/1000002/0002.txt',
  '25-NSE      New York Stock Exchange LLC                                   1000003     2024-05-15  edgar/data/1000003/0003.txt',
  '25-NSE/A    New York Stock Exchange LLC                                   1000003     2024-05-20  edgar/data/1000003/0004.txt',
  '8-K         WHATEVER CORP                                                 1000004     2024-06-01  edgar/data/1000004/0005.txt',
].join('\n');

test('form.idx parsing: header-derived columns survive arbitrary spacing in company names', () => {
  const { error, rows } = EI.parseFormIdx(IDX);
  assert.equal(error, null);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].companyName, 'SOME  ODDLY   SPACED, INC.');
  assert.equal(rows[1].formType, '25');
  assert.equal(rows[1].cik, '1000002');
  assert.equal(rows[1].dateFiled, '2024-05-10');
  assert.equal(EI.parseFormIdx('no header here').error, 'form.idx header not found');
});

test('extractForm25: events vs amendments; effective date = filing + 10 (Rule 12d2-2(d))', () => {
  const { rows } = EI.parseFormIdx(IDX);
  const { events, amendments } = EI.extractForm25(rows);
  assert.equal(events.length, 2);
  assert.equal(amendments.length, 1);
  assert.equal(events[0].effectiveDate, '2024-05-20');
  assert.equal(amendments[0].formType, '25-NSE/A');
});

test('partitions are content-addressed and tamper-evident', () => {
  const { rows } = EI.parseFormIdx(IDX);
  const { events, amendments } = EI.extractForm25(rows);
  const p = EI.form25Partition({ quarter: '2024-Q2', events, amendments, retrievedAt: 'T' });
  assert.equal(EI.partitionValid(p), true);
  assert.equal(EI.partitionValid({ ...p, events: events.slice(1) }), false);
});

test('quarter grid covers 2010-Q1 through the requested end quarter', () => {
  const qs = EI.quartersBetween(2010, 2011, 3);
  assert.deepEqual(qs, ['2010-Q1', '2010-Q2', '2010-Q3', '2010-Q4', '2011-Q1', '2011-Q2', '2011-Q3']);
  assert.match(EI.quarterUrl('2010-Q1'), /full-index\/2010\/QTR1\/form\.idx$/);
});

test('coverage validator: CIK join with leading-zero tolerance, ±45d on the effective date, misses disclosed', () => {
  const events = [
    { cik: '0001000002', filingDate: '2024-05-10', effectiveDate: '2024-05-20' },
    { cik: '1000003', filingDate: '2020-01-05', effectiveDate: '2020-01-15' },
  ];
  const known = [
    { symbol: 'AAA', cik: '1000002', date: '2024-05-25' },      // 5d off effective → covered (zero-padded CIK joins)
    { symbol: 'BBB', cik: '0001000003', date: '2020-02-10' },   // 26d → covered
    { symbol: 'CCC', cik: '1000009', date: '2022-01-01' },      // no Form 25 → miss
    { symbol: 'DDD', cik: null, date: '2022-01-01' },           // no CIK → excluded from the denominator
  ];
  const cov = EI.coverageVsKnownDelistings(events, known);
  assert.equal(cov.knownWithCik, 3);
  assert.equal(cov.covered, 2);
  assert.equal(cov.misses.length, 1);
  assert.equal(cov.misses[0].symbol, 'CCC');
});
