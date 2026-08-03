'use strict';
// Tests for the historical secmaster core (research/lib/secmaster-hist.js):
// name normalization, layered ticker mapping with ambiguity quarantine,
// record assembly, partial-membership handling, and coverage honesty.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SH = require('../research/lib/secmaster-hist');

test('name normalization: legal suffixes, punctuation and case collapse to a joinable key', () => {
  assert.equal(SH.normalizeCompanyName('AirTran Holdings, Inc.'), SH.normalizeCompanyName('AIRTRAN HOLDINGS INC'));
  assert.equal(SH.normalizeCompanyName('The Kraft Heinz Company'), SH.normalizeCompanyName('KRAFT HEINZ CO'));
  assert.notEqual(SH.normalizeCompanyName('Apple Inc'), SH.normalizeCompanyName('Applied Signal Inc'));
});

test('ticker map: layer priority (secmaster > official > submissions > name join) and provenance tags', () => {
  const { byCik } = SH.buildTickerMap({
    secmasterRecords: { OLD: { issuer: { cik: '0001000001' } } },
    companyTickers: [{ cik: 1000001, ticker: 'NEW' }, { cik: 1000002, ticker: 'BBB' }],
    submissionsTickers: [{ cik: '1000003', tickers: ['CCC'] }],
    avRecords: [{ symbol: 'DDD', name: 'Delta Delisted Corp', assetType: 'Stock' }],
    form25Events: [{ cik: '1000004', companyName: 'DELTA DELISTED CORP' }],
  });
  const one = byCik.get('1000001');
  assert.equal(one[0].symbol, 'OLD');                    // secmaster wins primary
  assert.equal(one[0].source, 'secmaster-v3');
  assert.ok(one.some((e) => e.symbol === 'NEW'));        // conflicting layer kept with provenance
  assert.equal(byCik.get('1000002')[0].source, 'edgar-company-tickers');
  assert.equal(byCik.get('1000003')[0].symbol, 'CCC');
  assert.equal(byCik.get('1000004')[0].symbol, 'DDD');   // exact-unique name join
  assert.equal(byCik.get('1000004')[0].source, 'av-name-exact');
});

test('ticker map: ambiguous name joins are quarantined, never guessed; higher layers pre-empt the join', () => {
  const { byCik, ambiguities } = SH.buildTickerMap({
    avRecords: [
      { symbol: 'AMB1', name: 'Ambiguous Corp', assetType: 'Stock' },
      { symbol: 'AMB2', name: 'AMBIGUOUS CORP.', assetType: 'Stock' },
      { symbol: 'SAFE', name: 'Preempted Inc', assetType: 'Stock' },
    ],
    companyTickers: [{ cik: 2000002, ticker: 'PRE' }],
    form25Events: [
      { cik: '2000001', companyName: 'Ambiguous Corp' },
      { cik: '2000002', companyName: 'Preempted Inc' },   // has an official mapping — join skipped
    ],
  });
  assert.equal(byCik.get('2000001'), undefined, 'two candidates → no mapping');
  assert.equal(ambiguities.length, 1);
  assert.deepEqual(ambiguities[0].candidates.sort(), ['AMB1', 'AMB2']);
  assert.equal(byCik.get('2000002')[0].symbol, 'PRE', 'official mapping pre-empts the name join');
});

test('assembly: delisting date = LAST Form-25 effective date; reasons pending; membership partial-aware', () => {
  const events = [
    { cik: '3000001', companyName: 'Twice Filed Inc', formType: '25', filingDate: '2015-03-01', effectiveDate: '2015-03-11' },
    { cik: '3000001', companyName: 'Twice Filed Inc', formType: '25-NSE', filingDate: '2015-06-01', effectiveDate: '2015-06-11' },
    { cik: '3000002', companyName: 'Unmapped Holdings', formType: '25', filingDate: '2012-01-05', effectiveDate: '2012-01-15' },
  ];
  const { byCik } = SH.buildTickerMap({ companyTickers: [{ cik: 3000001, ticker: 'TWI' }], form25Events: events });
  const hist = SH.assembleHistMaster({
    form25Events: events,
    tickerMap: { byCik },
    monthlyMembership: { '2010-01': new Set(['TWI']), '2010-02': new Set([]) },
  });
  const r = hist.records['3000001'];
  assert.equal(r.delisting.date, '2015-06-11');
  assert.equal(r.delisting.reasonCategory, null, 'reasons honestly pending');
  assert.equal(r.primaryTicker, 'TWI');
  assert.deepEqual(r.membershipObserved, { monthsObserved: 1, firstYm: '2010-01', lastYm: '2010-01' });
  assert.equal(hist.records['3000002'].primaryTicker, null);
  assert.equal(hist.coverage.form25Ciks, 2);
  assert.equal(hist.coverage.tickerMapped, 1);
  assert.equal(hist.coverage.unmapped, 1);
  assert.equal(hist.coverage.membershipMonthsAvailable, 2);
  assert.match(hist.status, /PARTIAL/);
  assert.match(hist.status, /NOT survivorship-authoritative/);
  // Content hash moves with the records.
  const hist2 = SH.assembleHistMaster({ form25Events: events.slice(0, 2), tickerMap: { byCik }, monthlyMembership: {} });
  assert.notEqual(hist.contentHash, hist2.contentHash);
});
