'use strict';
// PIT-DATA-V3 universe policy: fail-closed filters, instrument typing, immutable
// content-addressed snapshots.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/pitdata/v3/schema');
const I = require('../lib/pitdata/v3/identity');
const U = require('../lib/pitdata/v3/universe');

const OBS = '2026-08-01T12:00:00.000Z';

function world() {
  const listingShards = {}, aliasShards = {};
  const aliasShardFor = (k) => (aliasShards[k] ||= { aliases: {} });
  const listingShardFor = (sym) => (listingShards[S.shardKeyFor(sym)] ||= { listings: {} });
  return {
    listingShards,
    upsert(args) { return I.upsertListingV3(listingShardFor(args.symbol), aliasShardFor, args); },
  };
}

const fullMd = { close: 50, marketCap: 5e9, advDollar: 5e6 };

function commonStock(w, symbol, extra = {}) {
  return w.upsert({
    symbol, ipoDate: '2015-01-01', exchange: 'NASDAQ', status: 'active',
    instrumentType: 'common_stock', sector: 'Tech', industry: 'SW', country: 'US', currency: 'USD',
    observedAt: OBS, provenance: 'prospective_live', source: 't', ...extra,
  });
}

test('a fully-classified US common stock is selected; the snapshot is immutable and content-addressed', () => {
  const w = world();
  commonStock(w, 'GOOD');
  const snap = U.buildUniverseSnapshot({
    effectiveAt: '2026-08-01T15:00:00.000Z', knownAt: '2026-08-01T15:00:00.000Z',
    listingShards: w.listingShards, marketDataFor: () => fullMd,
  });
  assert.equal(snap.counts.selected, 1);
  assert.equal(snap.policyVersion, 'us-common-v3.0');
  assert.ok(snap.snapshotId && snap.snapshotId.length === 64);
  assert.equal(Object.isFrozen(snap), true);
  assert.equal(snap.survivorshipSafe, false, 'a snapshot can never claim safety on its own');
});

test('unknown exchange FAILS a requested exchange filter (defect 7 fixed): unavailable, not selected', () => {
  const w = world();
  const { listing } = commonStock(w, 'NOEX');
  listing.identity.exchange = null;
  const snap = U.buildUniverseSnapshot({ effectiveAt: OBS, listingShards: w.listingShards, marketDataFor: () => fullMd });
  assert.equal(snap.counts.selected, 0);
  assert.equal(snap.unavailable[0].reason, U.REASONS.EXCHANGE_UNKNOWN);
});

test('ETFs, warrants, units and unverified stock rows never enter the common-stock universe', () => {
  const w = world();
  commonStock(w, 'ETFX', { instrumentType: 'etf' });
  commonStock(w, 'WART', { instrumentType: 'warrant' });
  commonStock(w, 'UNIT', { instrumentType: 'unit' });
  commonStock(w, 'MAYB', { instrumentType: 'stock-unverified' });   // /stock-list 'stock' row, no profile corroboration
  commonStock(w, 'NONE', { instrumentType: null });                 // no type at all
  const snap = U.buildUniverseSnapshot({ effectiveAt: OBS, listingShards: w.listingShards, marketDataFor: () => fullMd });
  assert.equal(snap.counts.selected, 0);
  const reasons = [...snap.rejected, ...snap.unavailable].map((r) => r.reason);
  assert.ok(reasons.includes(U.REASONS.INSTRUMENT_NOT_COMMON));
  assert.ok(reasons.includes(U.REASONS.INSTRUMENT_UNKNOWN), 'unverified/unknown fails closed, never passes');
});

test('status-unknown fails closed; confirmed-delisted is rejected with its reason code', () => {
  const w = world();
  w.upsert({ symbol: 'MYST', observedAt: OBS, provenance: 'prospective_live', source: 't' });   // no status at all
  w.upsert({ symbol: 'DEAD', ipoDate: '2010-01-01', status: 'delisted', statusFrom: '2020-01-01',
    confirmation: { source: 'fmp-delisted-companies', delistedDate: '2020-01-01' }, observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  const snap = U.buildUniverseSnapshot({ effectiveAt: '2026-01-01', knownAt: '2026-08-02', listingShards: w.listingShards, marketDataFor: () => fullMd });
  assert.equal(snap.counts.selected, 0);
  assert.ok(snap.unavailable.some((r) => r.reason === U.REASONS.STATUS_UNKNOWN));
  assert.ok(snap.rejected.some((r) => r.reason === U.REASONS.DELISTED));
});

test('missing PIT price/cap/ADV is UNAVAILABLE — today\'s values are never assumed historical', () => {
  const w = world();
  commonStock(w, 'NOMD');
  const snap = U.buildUniverseSnapshot({ effectiveAt: OBS, listingShards: w.listingShards, marketDataFor: () => null });
  assert.equal(snap.counts.selected, 0);
  assert.equal(snap.unavailable[0].reason, U.REASONS.PRICE_UNKNOWN);
});

test('every exclusion carries a reason code and the coverage stats add up', () => {
  const w = world();
  commonStock(w, 'GOOD');
  commonStock(w, 'CHEP');   // penny
  commonStock(w, 'FRGN', { country: 'DE', currency: 'EUR' });
  const md = { GOOD: fullMd, CHEP: { close: 0.5, marketCap: 5e9, advDollar: 5e6 }, FRGN: fullMd };
  const snap = U.buildUniverseSnapshot({ effectiveAt: OBS, listingShards: w.listingShards, marketDataFor: (l) => md[l.symbol] });
  assert.equal(snap.counts.total, 3);
  assert.equal(snap.counts.selected + snap.counts.rejected + snap.counts.unavailable, 3);
  assert.ok(snap.rejected.every((r) => typeof r.reason === 'string' && r.reason.length));
  assert.ok(snap.coverage.reasonCounts[U.REASONS.PRICE_BELOW_MIN] >= 1);
  assert.ok(snap.coverage.reasonCounts[U.REASONS.COUNTRY_NOT_ALLOWED] >= 1);
});

test('reconstruction policy marks the snapshot reconstructed and not point-in-time-safe', () => {
  const w = world();
  commonStock(w, 'GOOD');
  const snap = U.buildUniverseSnapshot({
    effectiveAt: '2023-01-01', knownAt: '2026-08-02',
    policy: S.QUERY_POLICIES.RETROSPECTIVE_UNIVERSE_RECONSTRUCTION,
    listingShards: w.listingShards, marketDataFor: () => fullMd,
  });
  assert.equal(snap.reconstructed, true);
  assert.equal(snap.pointInTimeSafe, false);
});
