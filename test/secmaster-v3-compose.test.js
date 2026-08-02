'use strict';
// secmaster-v3 FMP composition fixtures — the nine required corporate-action
// cases: active, confirmed bankruptcy, acquisition, ticker rename, multiple
// share classes, stale price feed (vendor gap), missing history, relisting,
// exchange transfer. Plus schema validation and build determinism.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SM3 = require('../research/16-secmaster-v3');

const RETRIEVED = {
  delisted: '2026-08-02T18:00:00.000Z',
  active: '2026-08-02T18:05:00.000Z',
  known: '2026-08-02T18:06:00.000Z',
  symbolChange: '2026-08-02T18:07:00.000Z',
  ma: '2026-08-02T18:08:00.000Z',
};

function fixtureInputs() {
  return {
    delistedRows: [
      // bankruptcy-like: no rename, no M&A match → reason stays UNVERIFIED (fail closed downstream)
      { symbol: 'DEADCO', companyName: 'Dead Company Inc.', exchange: 'NYSE', ipoDate: '2010-01-01', delistedDate: '2023-05-01' },
      // acquisition: matched by the M&A join below
      { symbol: 'TGT1', companyName: 'Target One Corp.', exchange: 'NASDAQ', ipoDate: '2015-06-01', delistedDate: '2024-03-15' },
      // rename: matched by the symbol-change join below
      { symbol: 'OLDT', companyName: 'Renamed Holdings', exchange: 'NASDAQ', ipoDate: '2012-01-01', delistedDate: '2026-07-01' },
      // relisting: also present in the active list under the SAME issuer name
      { symbol: 'BACK', companyName: 'Comeback Industries Inc.', exchange: 'NYSE', ipoDate: '2011-01-01', delistedDate: '2022-08-01' },
      // recycled ticker: also active but under a DIFFERENT issuer name
      { symbol: 'RCYC', companyName: 'Original Owner Corp.', exchange: 'NYSE', ipoDate: '2009-01-01', delistedDate: '2021-04-01' },
    ],
    activeSymbols: ['LIVE', 'GOOGL', 'GOOG', 'BACK', 'RCYC'],
    // stock-list ⊇ active ∪ delisted ∪ names the vendor knows but can't place:
    knownSymbols: ['LIVE', 'GOOGL', 'GOOG', 'BACK', 'RCYC', 'DEADCO', 'TGT1', 'OLDT', 'GHOST'],
    symbolChanges: [{ date: '2026-07-01', companyName: 'Renamed Holdings', oldSymbol: 'OLDT', newSymbol: 'NEWT' }],
    maRows: [{ symbol: 'ACQR', companyName: 'Acquirer PLC', cik: '0000000001', targetedSymbol: 'TGT1', targetedCompanyName: 'Target One Corp.', transactionDate: '2023-11-01', link: 'https://www.sec.gov/example-s4' }],
    profiles: {
      LIVE: { symbol: 'LIVE', companyName: 'Live Co', cik: '0000000010', isin: 'US0000000010', cusip: '000000101', exchange: 'NYSE', ipoDate: '2018-01-01', isActivelyTrading: true, isEtf: false, isAdr: false, isFund: false },
      GOOGL: { symbol: 'GOOGL', companyName: 'Alphabet Inc.', cik: '0001652044', isin: 'US02079K3059', cusip: '02079K305', exchange: 'NASDAQ', ipoDate: '2004-08-19', isActivelyTrading: true },
      GOOG: { symbol: 'GOOG', companyName: 'Alphabet Inc.', cik: '0001652044', isin: 'US02079K1079', cusip: '02079K107', exchange: 'NASDAQ', ipoDate: '2004-08-19', isActivelyTrading: true },
      BACK: { symbol: 'BACK', companyName: 'Comeback Industries Inc.', cik: '0000000020', cusip: '000000202', exchange: 'NYSE', ipoDate: '2011-01-01', isActivelyTrading: true },
      RCYC: { symbol: 'RCYC', companyName: 'Totally Different New Listing Ltd.', cik: '0000000030', cusip: '000000303', exchange: 'NYSE', ipoDate: '2024-01-01', isActivelyTrading: true },
    },
    retrievedAt: RETRIEVED,
  };
}

test('fixture: ACTIVE security — active status, observedActiveThrough from the list retrieval time', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  const r = records.LIVE;
  assert.equal(r.status, 'active');
  assert.equal(r.observedActiveThrough, Date.parse(RETRIEVED.active));
  assert.equal(r.listingId, 'fmp:cusip:000000101', 'identity anchored on CUSIP, not ticker');
  assert.equal(r.issuer.cik, '0000000010');
  assert.equal(SM3.validateRecord(r).valid, true);
});

test('fixture: UNVERIFIED-REASON delisting (bankruptcy candidate) — confirmed date, reason explicitly unverified', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  const r = records.DEADCO;
  assert.equal(r.status, 'delisted');
  assert.equal(r.delisting.date, '2023-05-01');
  assert.equal(r.delisting.reasonCategory, null, 'FMP provides no reason; nothing is invented');
  assert.equal(r.verificationState, 'unverified-reason');
  assert.equal(SM3.validateRecord(r).valid, true);
});

test('fixture: ACQUISITION — SEC S-4 join classifies the delisting, never a failure haircut category', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  const r = records.TGT1;
  assert.equal(r.status, 'delisted');
  assert.equal(r.delisting.reasonCategory, 'acquisition');
  assert.match(r.delisting.reason, /Acquirer PLC/);
  assert.equal(r.delisting.evidence.type, 'sec-s4-via-fmp');
  assert.equal(r.delisting.evidence.link, 'https://www.sec.gov/example-s4');
  assert.equal(r.verificationState, 'verified-acquisition-announcement');
});

test('fixture: TICKER RENAME — symbol-change join; rename is never a failure and keeps ticker history', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  const r = records.OLDT;
  assert.equal(r.delisting.reasonCategory, 'rename');
  assert.equal(r.delisting.evidence.newSymbol, 'NEWT');
  assert.deepEqual(r.tickerHistory, [{ ticker: 'OLDT', to: '2026-07-01' }, { ticker: 'NEWT', from: '2026-07-01' }]);
});

test('fixture: MULTIPLE SHARE CLASSES — same CIK, distinct listingIds, siblings recorded, NEVER merged', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  assert.equal(records.GOOGL.listingId, 'fmp:cusip:02079K305');
  assert.equal(records.GOOG.listingId, 'fmp:cusip:02079K107');
  assert.notEqual(records.GOOGL.listingId, records.GOOG.listingId, 'share classes are distinct securities');
  assert.equal(records.GOOGL.issuer.cik, records.GOOG.issuer.cik, 'same issuer');
  assert.deepEqual(records.GOOGL.shareClassSiblings, ['GOOG']);
  assert.deepEqual(records.GOOG.shareClassSiblings, ['GOOGL']);
});

test('fixture: STALE PRICE FEED / vendor gap — known symbol, neither active nor delisted, fails closed as unknown', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  const r = records.GHOST;
  assert.equal(r.status, 'unknown');
  assert.equal(r.verificationState, 'vendor-gap-or-inactive-unconfirmed');
  assert.equal(r.delisting, null, 'a vendor gap NEVER fabricates a delisting');
});

test('fixture: MISSING HISTORY — a symbol absent from every feed simply has no record (fails closed downstream)', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  assert.equal(records.NEVERSEEN, undefined, 'outcome-v3 receives null and returns unresolved');
});

test('fixture: RELISTING — same issuer name back on tape; historical delisting kept as history, not confirmation', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  const r = records.BACK;
  assert.equal(r.status, 'active');
  assert.equal(r.delisting, null, 'the old delisting must not fail-close current outcomes');
  assert.equal(r.delistingHistory.length, 1);
  assert.equal(r.relisting, 'relisted-same-issuer');
  assert.equal(r.identityConfidence, 'low', 'relistings are identity-suspect until verified');
});

test('fixture: RECYCLED TICKER — different issuer reusing a dead symbol is explicitly ambiguous', () => {
  const { records } = SM3.composeFmpRecords(fixtureInputs());
  const r = records.RCYC;
  assert.equal(r.status, 'active');
  assert.equal(r.relisting, 'ambiguous-relisting-or-ticker-reuse');
  assert.equal(r.verificationState, 'ambiguous-recycled-ticker');
  assert.equal(r.delistingHistory.length, 1, 'the prior listing’s delisting is preserved as history');
});

test('fixture: EXCHANGE TRANSFER — pitdata-v3 shard path carries exchange-move as a carry category, never a failure', () => {
  // The FMP feeds cannot distinguish an exchange transfer; the shard path can.
  const listing = {
    listingId: 'pitv3:tk:moved', identityConfidence: 'medium', identity: {},
    aliases: [{ value: 'MOVE' }],
    status: [{ value: 'delisted', effectiveFrom: '2024-06-01', knownAt: '2024-06-02',
      confirmation: { source: 'exchange-notice', recordedAt: '2024-06-02', reason: 'transfer NYSE→NASDAQ', reasonCategory: 'exchange-move' },
      provenance: 'prospective_live' }],
  };
  const records = SM3.recordsFromV3Shards({ M: { listings: { 'pitv3:tk:moved': listing } } });
  assert.equal(records.MOVE.status, 'delisted');
  assert.equal(records.MOVE.delisting.reasonCategory, 'exchange-move');
  const OV3 = require('../research/lib/outcome-v3');
  assert.equal(OV3.REASON_TREATMENT['exchange-move'], 'carry', 'an exchange transfer is never haircut');
});

test('profile contradiction downgrades to unknown (conflict recorded, fail closed)', () => {
  const inputs = fixtureInputs();
  inputs.profiles.LIVE = { ...inputs.profiles.LIVE, isActivelyTrading: false };
  const { records } = SM3.composeFmpRecords(inputs);
  assert.equal(records.LIVE.status, 'unknown');
  assert.equal(records.LIVE.conflict, true);
  assert.match(records.LIVE.verificationState, /conflict:active-list-vs-profile-inactive/);
});

test('determinism: identical inputs compose to byte-identical records', () => {
  const a = JSON.stringify(SM3.composeFmpRecords(fixtureInputs()));
  const b = JSON.stringify(SM3.composeFmpRecords(fixtureInputs()));
  assert.equal(a, b);
});

test('schema validation rejects fabricated or malformed records', () => {
  assert.equal(SM3.validateRecord(null).valid, false);
  assert.equal(SM3.validateRecord({ listingId: 'x', masterVersion: 'wrong', status: 'active' }).valid, false);
  const noConf = SM3.validateRecord({ listingId: 'x', masterVersion: SM3.VERSION, status: 'delisted', delisting: { date: '2024-01-01' } });
  assert.equal(noConf.valid, false, 'a delisted record without a complete confirmation is invalid');
  const histNotLive = SM3.validateRecord({ listingId: 'x', masterVersion: SM3.VERSION, status: 'active', delisting: { date: '2020-01-01', source: 's', confirmedAt: 't', provenance: 'p' } });
  assert.equal(histNotLive.valid, false, 'an active record may not carry a live delisting confirmation');
});

// ── two-source merge (PATH A prospective ⊕ FMP/EDGAR historical) ─────────────

function shardRec(status, extra = {}) {
  return {
    listingId: 'pitv3:tk:abc', masterVersion: SM3.VERSION, identityConfidence: 'medium',
    status, observedActiveThrough: status === 'active' ? Date.parse('2026-08-02') : null,
    delisting: status === 'delisted' ? {
      date: '2026-07-15', source: 'fmp-delisted-companies', confirmedAt: '2026-07-16',
      reason: null, reasonCategory: null, provenance: 'prospective_live',
    } : null, ...extra,
  };
}

test('merge: a PATH-A confirmed delisting wins over the reconstruction, keeping identity enrichment', () => {
  const fmp = SM3.composeFmpRecords(fixtureInputs()).records;
  const { records, stats } = SM3.mergeRecords({ LIVE: shardRec('delisted') }, fmp);
  assert.equal(records.LIVE.status, 'delisted');
  assert.equal(records.LIVE.listingId, 'pitv3:tk:abc', 'prospective listing id wins');
  assert.equal(records.LIVE.delisting.provenance, 'prospective_live');
  assert.equal(records.LIVE.issuer.cik, '0000000010', 'FMP identity enrichment retained');
  assert.equal(records.LIVE.fmpListingId, 'fmp:cusip:000000101');
  assert.equal(stats.shardDelistWins, 1);
  assert.equal(SM3.validateRecord(records.LIVE).valid, true);
});

test('merge: a reconstruction delisting BEATS a shard active claim (stock-list semantics defect)', () => {
  // The pitdata-v3 collector derives 'active' from FMP stock-list membership,
  // which includes long-dead names. A confirmed delisting (delisted-feed or
  // EDGAR) with no actively-trading corroboration must therefore win; the
  // shard's contrary claim is preserved for audit, never silently dropped.
  const fmp = SM3.composeFmpRecords(fixtureInputs()).records;
  assert.equal(fmp.DEADCO.status, 'delisted');
  const { records, stats } = SM3.mergeRecords({ DEADCO: shardRec('active') }, fmp);
  assert.equal(records.DEADCO.status, 'delisted');
  assert.ok(records.DEADCO.shardClaimedActive, 'the shard claim is auditable');
  assert.equal(records.DEADCO.verificationState, 'merged:reconstruction-delisting-over-shard-active');
  assert.equal(stats.delistOverShardActive, 1);
  assert.equal(SM3.validateRecord(records.DEADCO).valid, true);
  // A GENUINE relisting (delisted + actively trading now) stays active-with-
  // history — compose() resolved it before the merge, so no delisting is lost.
  const back = SM3.mergeRecords({ BACK: shardRec('active') }, fmp).records.BACK;
  assert.equal(back.status, 'active');
  assert.equal(back.delistingHistory.length, 1);
});

test('merge: PATH-A unknown defers to the reconstruction; a PATH-A alias conflict stays fail-closed', () => {
  const fmp = SM3.composeFmpRecords(fixtureInputs()).records;
  const { records } = SM3.mergeRecords({
    TGT1: shardRec('unknown', { delisting: null }),
    LIVE: { ...shardRec('unknown', { delisting: null }), conflict: true, candidates: ['pitv3:tk:abc', 'pitv3:tk:xyz'] },
  }, fmp);
  assert.equal(records.TGT1.status, 'delisted', 'reconstruction fills the unknown');
  assert.equal(records.TGT1.delisting.reasonCategory, 'acquisition');
  assert.equal(records.LIVE.status, 'unknown', 'alias conflict fails closed even when FMP thinks it knows');
  assert.equal(records.LIVE.conflict, true);
});

test('merge: disjoint symbols pass through; merge is deterministic', () => {
  const fmp = SM3.composeFmpRecords(fixtureInputs()).records;
  const shard = { ONLYA: shardRec('active') };
  const m1 = SM3.mergeRecords(shard, fmp);
  assert.equal(m1.records.ONLYA.status, 'active');
  assert.ok(m1.records.GOOGL, 'fmp-only records pass through');
  assert.equal(JSON.stringify(m1), JSON.stringify(SM3.mergeRecords(shard, fmp)));
});
