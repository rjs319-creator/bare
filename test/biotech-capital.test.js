'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyCapitalState, classifyOfferingHeadline } = require('../lib/biotech-capital');
const { CAPITAL_STATES: S } = require('../lib/biotech-config');

test('classifyOfferingHeadline: keyword detection for offering types', () => {
  assert.equal(classifyOfferingHeadline('XYZ prices $50M public offering').pricedOffering, true);
  assert.equal(classifyOfferingHeadline('XYZ announces proposed public offering').announcedOffering, true);
  assert.equal(classifyOfferingHeadline('XYZ enters at-the-market program').atm, true);
  assert.equal(classifyOfferingHeadline('XYZ 1-for-10 reverse stock split').reverseSplit, true);
  assert.equal(classifyOfferingHeadline('XYZ reports Phase 2 data').pricedOffering, false);
});

test('classifyCapitalState: a recent 424B5 takedown → PENDING_OFFERING, High dilution', () => {
  const r = classifyCapitalState({ asOf: '2026-07-23', hasFilings: true,
    offeringFilings: [{ form: '424B5', filingDate: '2026-07-21', accession: 'a1' }] });
  assert.equal(r.state, S.PENDING_OFFERING);
  assert.equal(r.dilutionRisk, 'High');
});

test('classifyCapitalState: announced-but-unpriced offering → PENDING_OFFERING', () => {
  const r = classifyCapitalState({ asOf: '2026-07-23', hasNews: true,
    newsFlags: { announcedOffering: true } });
  assert.equal(r.state, S.PENDING_OFFERING);
});

test('classifyCapitalState: a COMPLETED priced offering clears the overhang → relief', () => {
  const r = classifyCapitalState({ asOf: '2026-07-23', hasNews: true,
    newsFlags: { pricedOffering: true }, mostRecentOfferingDate: '2026-07-10' });
  assert.equal(r.state, S.COMPLETED_FINANCING_RELIEF);
  assert.equal(r.dilutionRisk, 'Low');
});

test('classifyCapitalState: active ATM is distinct from a completed deal', () => {
  const r = classifyCapitalState({ asOf: '2026-07-23', hasNews: true, newsFlags: { atm: true } });
  assert.equal(r.state, S.ACTIVE_ATM);
  assert.equal(r.dilutionRisk, 'High');
});

test('classifyCapitalState: a bare shelf is CAPACITY, not an imminent offering', () => {
  const r = classifyCapitalState({ asOf: '2026-07-23', hasFilings: true,
    offeringFilings: [{ form: 'S-3', filingDate: '2026-01-01', accession: 's1' }] });
  assert.equal(r.state, S.UNKNOWN, 'shelf alone does not become PENDING');
  assert.ok(r.evidence.some(e => /capacity/.test(e)));
});

test('classifyCapitalState: reverse split / distress → SEVERE_DILUTION_RISK', () => {
  const r = classifyCapitalState({ asOf: '2026-07-23', hasNews: true, newsFlags: { reverseSplit: true } });
  assert.equal(r.state, S.SEVERE_DILUTION_RISK);
});

test('classifyCapitalState: no cash/runway data → cannot assert funded; degrades honestly', () => {
  const r = classifyCapitalState({ asOf: '2026-07-23' });
  assert.equal(r.state, S.UNKNOWN);
  assert.equal(r.fundedThroughCatalyst, null, 'never fabricates a funded verdict');
  assert.ok(r.evidence.some(e => /cash & runway unavailable/.test(e)));
  assert.equal(r.dataQuality, 'MISSING');
});
