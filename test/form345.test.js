'use strict';
// SEC bulk Form 3/4/5 dataset parsers (research/lib/form345.js). The output contract is
// lib/edgar.js parseForm4's transaction shape, so the frozen cluster constructor in
// research/69-insider-cluster.js consumes bulk rows unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../research/lib/form345');
const { quarterList, perYear } = require('../research/97-form345-build');
const S = require('../research/69-insider-cluster');

test('toIso: SEC DD-MON-YYYY dates convert; ISO passes; junk is null', () => {
  assert.equal(F.toIso('31-MAR-2025'), '2025-03-31');
  assert.equal(F.toIso('1-jan-2022'), '2022-01-01');
  assert.equal(F.toIso('2024-02-29'), '2024-02-29');
  assert.equal(F.toIso(''), null);
  assert.equal(F.toIso('31-XYZ-2025'), null);
});

test('parseTsv: header-keyed rows, blank cells preserved, literal quotes kept, CRLF tolerated', () => {
  const rows = F.parseTsv('A\tB\tC\r\n1\t\tx "q"\r\n2\ty\t\r\n\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { A: '1', B: '', C: 'x "q"' });
  assert.deepEqual(rows[1], { A: '2', B: 'y', C: '' });
});

test('cleanSymbol: upper-cases, strips suffix noise, rejects placeholders', () => {
  assert.equal(F.cleanSymbol(' tbla '), 'TBLA');
  assert.equal(F.cleanSymbol('BRK.B'), 'BRK.B');
  assert.equal(F.cleanSymbol('N/A'), null);
  assert.equal(F.cleanSymbol(''), null);
  assert.equal(F.cleanSymbol('ABC WS'), 'ABC');
});

const SUB = [
  { ACCESSION_NUMBER: 'A1', FILING_DATE: '02-JUL-2025', DOCUMENT_TYPE: '4', ISSUERCIK: '1', ISSUERTRADINGSYMBOL: 'XYZ', AFF10B5ONE: '0' },
  { ACCESSION_NUMBER: 'A2', FILING_DATE: '03-JUL-2025', DOCUMENT_TYPE: '4/A', ISSUERCIK: '1', ISSUERTRADINGSYMBOL: 'XYZ', AFF10B5ONE: 'true' },
  { ACCESSION_NUMBER: 'A3', FILING_DATE: '04-JUL-2025', DOCUMENT_TYPE: '4', ISSUERCIK: '77', ISSUERTRADINGSYMBOL: '', AFF10B5ONE: '' },
  { ACCESSION_NUMBER: 'A4', FILING_DATE: '05-JUL-2025', DOCUMENT_TYPE: '3', ISSUERCIK: '1', ISSUERTRADINGSYMBOL: 'XYZ', AFF10B5ONE: '0' },
];
const OWN = [
  { ACCESSION_NUMBER: 'A1', RPTOWNERCIK: '11', RPTOWNERNAME: 'Smith Jane', RPTOWNER_RELATIONSHIP: 'Director,Officer' },
  { ACCESSION_NUMBER: 'A1', RPTOWNERCIK: '12', RPTOWNERNAME: 'Fund LP', RPTOWNER_RELATIONSHIP: 'TenPercentOwner' },
  { ACCESSION_NUMBER: 'A2', RPTOWNERCIK: '13', RPTOWNERNAME: 'Doe John', RPTOWNER_RELATIONSHIP: 'Officer' },
  { ACCESSION_NUMBER: 'A3', RPTOWNERCIK: '14', RPTOWNERNAME: 'Roe R', RPTOWNER_RELATIONSHIP: 'Director' },
  { ACCESSION_NUMBER: 'A4', RPTOWNERCIK: '15', RPTOWNERNAME: 'Poe P', RPTOWNER_RELATIONSHIP: 'Director' },
];
const tx = (o) => ({ ACCESSION_NUMBER: 'A1', TRANS_DATE: '30-JUN-2025', TRANS_FORM_TYPE: '4', TRANS_CODE: 'P', TRANS_TIMELINESS: '', TRANS_SHARES: '1000', TRANS_PRICEPERSHARE: '12.5', TRANS_ACQUIRED_DISP_CD: 'A', ...o });
const TRANS = [
  tx({}),                                                        // joint filing → 2 owner rows
  tx({ ACCESSION_NUMBER: 'A2', TRANS_TIMELINESS: 'L' }),          // amended, 10b5-1, late
  tx({ ACCESSION_NUMBER: 'A3' }),                                 // blank symbol → CIK map
  tx({ ACCESSION_NUMBER: 'A4' }),                                 // Form 3 submission → docType
  tx({ TRANS_CODE: 'S', TRANS_ACQUIRED_DISP_CD: 'D' }),          // sale
  tx({ TRANS_CODE: 'A' }),                                        // grant
  tx({ TRANS_ACQUIRED_DISP_CD: 'D' }),                            // P but disposed (data quirk)
  tx({ TRANS_SHARES: '' }),                                       // blank shares
  tx({ TRANS_FORM_TYPE: '5' }),                                   // Form 5 line
  tx({ ACCESSION_NUMBER: 'NOPE' }),                               // no submission
];

test('extractBuys: keeps open-market P/A form-4 rows, one tx per owner, edgar-shaped, and counts every exclusion', () => {
  const r = F.extractBuys({ submissions: SUB, trans: TRANS, owners: OWN }, { cikToTicker: { '0000000077': 'QQQ' } });
  assert.deepEqual(Object.keys(r.byTicker).sort(), ['QQQ', 'XYZ']);
  assert.equal(r.byTicker.XYZ.length, 3, 'A1 → 2 owners, A2 → 1 owner');
  assert.equal(r.byTicker.QQQ.length, 1);
  const a1 = r.byTicker.XYZ.filter(t => t.accession === 'A1');
  assert.deepEqual(a1.map(t => t.owner).sort(), ['Fund LP', 'Smith Jane']);
  assert.equal(a1[0].date, '2025-06-30');
  assert.equal(a1[0].filingDate, '2025-07-02');
  assert.equal(a1[0].value, 12500);
  assert.equal(a1.find(t => t.owner === 'Smith Jane').isOfficer, true);
  assert.equal(a1.find(t => t.owner === 'Fund LP').isTenPct, true);
  const a2 = r.byTicker.XYZ.find(t => t.accession === 'A2');
  assert.equal(a2.tenB51, true);
  assert.equal(a2.amended, true);
  assert.equal(a2.timeliness, 'L');
  assert.equal(r.byTicker.QQQ[0].tickerSource, 'cikMap');
  assert.equal(r.counts.resolvedByCik, 1);
  assert.deepEqual(r.exclusions, { formType: 1, code: 2, acquiredDisposed: 1, sharesOrPrice: 1, noSubmission: 1, docType: 1, noOwner: 0, noTicker: 0 });
  // Sum of kept transaction rows + excluded rows == input rows (nothing silent).
  const excluded = Object.values(r.exclusions).reduce((s, x) => s + x, 0);
  assert.equal(excluded + 3, TRANS.length, '3 transaction rows kept (A1, A2, A3)');
  for (const t of [...r.byTicker.XYZ, ...r.byTicker.QQQ]) for (const k of F.EDGAR_TX_KEYS) assert.ok(k in t, `edgar key ${k}`);
});

test('extractBuys: blank symbol with no CIK map entry is excluded as noTicker; empty input is safe', () => {
  const r = F.extractBuys({ submissions: SUB, trans: [tx({ ACCESSION_NUMBER: 'A3' })], owners: OWN });
  assert.equal(r.exclusions.noTicker, 1);
  assert.deepEqual(F.extractBuys({}).byTicker, {});
});

test('bulk rows feed the frozen cluster constructor unchanged', () => {
  const r = F.extractBuys({ submissions: SUB, trans: TRANS, owners: OWN }, { cikToTicker: { '0000000077': 'QQQ' } });
  const ev = S.clusterEvents(r.byTicker.XYZ);
  assert.equal(ev.length, 0, 'three owners within the window but combined $37,500 is under the frozen $50k floor');
});

test('bulk rows feed the frozen cluster constructor unchanged (dollar floor cleared)', () => {
  const big = [tx({ TRANS_SHARES: '5000' }), tx({ ACCESSION_NUMBER: 'A2', TRANS_SHARES: '5000' })];
  const r = F.extractBuys({ submissions: SUB, trans: big, owners: OWN });
  const ev = S.clusterEvents(r.byTicker.XYZ);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].owners, 3);
  assert.equal(ev[0].eventDate, '2025-07-03', 'event dated at the LATEST filing date');
});

test('quarterList / perYear helpers', () => {
  assert.deepEqual(quarterList('2021q2', '2022q1'), ['2021q2', '2021q3', '2021q4', '2022q1']);
  const py = perYear([{ code: 'P', filingDate: '2023-02-01', value: 10 }, { code: 'S', filingDate: '2023-02-01', value: 99 }, { code: 'P', filingDate: '2024-01-01', shares: 2, price: 3 }], ['2023', '2024']);
  assert.deepEqual(py, { 2023: { n: 1, usd: 10 }, 2024: { n: 1, usd: 6 } });
});
