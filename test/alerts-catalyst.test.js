'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ca = require('../lib/alerts-catalyst');

test('earnings claim with a near-dated report → VERIFIED_SECONDARY', () => {
  const r = ca.verifyCatalyst({ catalysts: ['earnings'], ticker: 'AAA', asOfDate: '2026-07-21' }, { earnings: { nextDate: '2026-07-28' } });
  assert.equal(r.status, ca.STATUS.VERIFIED_SECONDARY);
});

test('earnings claim already reported → FALSE_OR_STALE', () => {
  const r = ca.verifyCatalyst({ catalysts: ['earnings'], ticker: 'AAA', asOfDate: '2026-07-21' }, { earnings: { nextDate: '2026-07-10' } });
  assert.equal(r.status, ca.STATUS.FALSE_OR_STALE);
});

test('no adapter available → UNVERIFIED, degraded honestly (never upgraded on faith)', () => {
  const r = ca.verifyCatalyst({ catalysts: ['earnings'], ticker: 'AAA', asOfDate: '2026-07-21' }, {});
  assert.equal(r.status, ca.STATUS.UNVERIFIED);
});

test('a claimed catalyst with no independent corroboration is SOCIAL_ONLY', () => {
  const r = ca.verifyCatalyst({ catalysts: ['squeeze'], ticker: 'AAA', asOfDate: '2026-07-21' }, { news: [] });
  assert.equal(r.status, ca.STATUS.SOCIAL_ONLY);
});

test('a matching primary filing → VERIFIED_PRIMARY', () => {
  const r = ca.verifyCatalyst({ catalysts: ['m&a'], ticker: 'AAA', asOfDate: '2026-07-21' }, { filings: [{ type: 'm&a', date: '2026-07-20', url: 'https://sec.gov/x' }] });
  assert.equal(r.status, ca.STATUS.VERIFIED_PRIMARY);
});

test('no claim → nothing to verify (UNVERIFIED)', () => {
  assert.equal(ca.verifyCatalyst({ catalysts: [], ticker: 'AAA' }, {}).status, ca.STATUS.UNVERIFIED);
});

test('only VERIFIED_* counts as independent catalyst evidence', () => {
  assert.equal(ca.isVerified(ca.STATUS.VERIFIED_PRIMARY), true);
  assert.equal(ca.isVerified(ca.STATUS.SOCIAL_ONLY), false);
  assert.equal(ca.isVerified(ca.STATUS.UNVERIFIED), false);
});
