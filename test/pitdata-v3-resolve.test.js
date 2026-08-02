'use strict';
// PIT-DATA-V3 identity + resolver battery — the systematic rename/reuse/knowledge
// cases Phase 3 requires. This file also serves as the ticker-reuse test-coverage
// marker the reconciliation gate `tickerReuseTestCoverage` refers to.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/pitdata/v3/schema');
const I = require('../lib/pitdata/v3/identity');
const R = require('../lib/pitdata/v3/resolve');

const { PROSPECTIVE_REPLAY, RETROSPECTIVE_UNIVERSE_RECONSTRUCTION } = S.QUERY_POLICIES;

// Build a tiny world with injected facts. Returns { aliasShards, listingShards, add }.
function world() {
  const listingShards = {}, aliasShards = {};
  const aliasShardFor = (k) => (aliasShards[k] ||= { aliases: {} });
  const listingShardFor = (sym) => (listingShards[S.shardKeyFor(sym)] ||= { listings: {} });
  return {
    aliasShards, listingShards, aliasShardFor, listingShardFor,
    upsert(args) { return I.upsertListingV3(listingShardFor(args.symbol), aliasShardFor, args); },
    rename(listing, args) { return I.applyRename(listing, aliasShardFor, args); },
  };
}

const OBS = '2026-08-01T12:00:00.000Z';

function renamedWorld({ oldSym = 'AAA', newSym = 'ZZZ', renameDate = '2024-01-15', ipoDate = '2015-05-01' } = {}) {
  const w = world();
  const { listing } = w.upsert({ symbol: oldSym, ipoDate, exchange: 'NYSE', status: 'active', observedAt: '2020-01-01T00:00:00.000Z', provenance: 'historical_reconstruction', source: 't' });
  w.rename(listing, { oldSymbol: oldSym, newSymbol: newSym, renameDate, observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  return { w, listing };
}

test('A→Z rename: OLD ticker resolves to the SAME listing during its valid interval (cross-shard, defect 5 fixed)', () => {
  const { w, listing } = renamedWorld();
  const r = R.resolveSymbolAsOfV3({ symbol: 'AAA', effectiveAt: '2023-06-01', knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(r.status, 'resolved');
  assert.equal(r.listingId, listing.listingId);
  assert.equal(r.tickerAtDate, 'AAA', 'the ticker EFFECTIVE on the requested date, not the current one');
});

test('Z→A rename resolves symmetrically (shard order is irrelevant)', () => {
  const { w, listing } = renamedWorld({ oldSym: 'ZZZ', newSym: 'AAA' });
  const r = R.resolveSymbolAsOfV3({ symbol: 'ZZZ', effectiveAt: '2023-06-01', knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(r.status, 'resolved');
  assert.equal(r.listingId, listing.listingId);
});

test('rename boundary is half-open: old ticker valid the day BEFORE, invalid ON the rename date; new valid FROM it', () => {
  const { w, listing } = renamedWorld();
  const q = (symbol, effectiveAt) => R.resolveSymbolAsOfV3({ symbol, effectiveAt, knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(q('AAA', '2024-01-14').status, 'resolved', 'day before: old alias valid');
  assert.equal(q('AAA', '2024-01-15').status, 'unknown', 'ON the rename date the old alias is out (half-open [from,to))');
  assert.equal(q('AAA', '2024-01-16').status, 'unknown', 'day after: still out');
  assert.equal(q('ZZZ', '2024-01-15').status, 'resolved', 'new alias valid FROM the rename date (inclusive)');
  assert.equal(q('ZZZ', '2024-01-15').listingId, listing.listingId);
});

test('multiple sequential renames: every historical ticker resolves inside its own interval only', () => {
  const w = world();
  const { listing } = w.upsert({ symbol: 'ONE', ipoDate: '2010-01-01', status: 'active', observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  w.rename(listing, { oldSymbol: 'ONE', newSymbol: 'TWO', renameDate: '2015-01-01', observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  w.rename(listing, { oldSymbol: 'TWO', newSymbol: 'THREE', renameDate: '2020-01-01', observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  // Close TWO's open interval created by the first rename: applyRename opened TWO from 2015 with no end,
  // then the second rename appended TWO ending 2020 — the resolver must prefer interval-valid entries.
  const q = (symbol, effectiveAt) => R.resolveSymbolAsOfV3({ symbol, effectiveAt, knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(q('ONE', '2012-06-01').listingId, listing.listingId);
  assert.equal(q('TWO', '2017-06-01').listingId, listing.listingId);
  assert.equal(q('THREE', '2022-06-01').listingId, listing.listingId);
  assert.equal(q('ONE', '2022-06-01').status, 'unknown', 'expired alias never resolves as current');
});

test('expired alias does not resolve as the active current listing (defect 6 fixed)', () => {
  const { w } = renamedWorld();
  const r = R.resolveSymbolAsOfV3({ symbol: 'AAA', effectiveAt: '2025-06-01', knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'alias-not-effective-at-time');
  assert.ok(r.nearMisses.length >= 1, 'near-misses reported for diagnostics, never silently picked');
});

test('ticker reuse after delisting: each era resolves to ITS listing; overlap returns ambiguous, never a merge', () => {
  const w = world();
  // Era 1: DEADCO trades 2010→2018 then delists, under ticker 'RE'.
  w.upsert({ symbol: 'RE', ipoDate: '2010-01-01', status: 'delisted', statusFrom: '2018-06-01', observedAt: OBS,
    confirmation: { source: 'fmp-delisted-companies', delistedDate: '2018-06-01' }, provenance: 'historical_reconstruction', source: 't' });
  // Era 2: a NEW company takes 'RE' from 2021.
  const { listing: l2 } = w.upsert({ symbol: 'RE', ipoDate: '2021-03-01', status: 'active', observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  const q = (effectiveAt) => R.resolveSymbolAsOfV3({ symbol: 'RE', effectiveAt, knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  const era1 = q('2015-01-01');
  assert.equal(era1.status, 'resolved');
  assert.notEqual(era1.listingId, l2.listingId, 'old era resolves to the OLD listing');
  const era2 = q('2023-01-01');
  assert.equal(era2.status, 'resolved');
  assert.equal(era2.listingId, l2.listingId);
  // Between delisting and re-listing: nothing valid.
  assert.equal(q('2019-06-01').status, 'unknown');
});

test('two listings claiming the same ticker over the SAME interval → ambiguous with all candidates', () => {
  const w = world();
  w.upsert({ symbol: 'DUP', ipoDate: '2020-01-01', cik: '111', status: 'active', observedAt: OBS, provenance: 'historical_reconstruction', source: 'src-a' });
  w.upsert({ symbol: 'DUP', ipoDate: '2020-06-01', cik: '222', status: 'active', observedAt: OBS, provenance: 'historical_reconstruction', source: 'src-b' });
  const r = R.resolveSymbolAsOfV3({ symbol: 'DUP', effectiveAt: '2021-01-01', knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2, 'conflicting sources both preserved — ambiguity fails closed');
});

test('multiple share classes under ONE CIK stay TWO listings (CIK is issuer identity, not share-class identity)', () => {
  const a = I.assignListingId({ symbol: 'BRK.A', cik: '1067983', ipoDate: '1980-01-01' });
  const b = I.assignListingId({ symbol: 'BRK.B', cik: '1067983', ipoDate: '1996-05-09' });
  assert.notEqual(a, b);
  const c = I.assignListingId({ symbol: 'BRK.B', cik: '1067983', ipoDate: '1996-05-09' });
  assert.equal(b, c, 'deterministic — assigned once');
});

test('unknown IPO date: listing keeps an internal id with reduced confidence; ticker-only reuse gets a DISTINCT id', () => {
  const known = I.assignListingId({ symbol: 'X', cik: '9', ipoDate: '2020-01-01' });
  const noIpo = I.assignListingId({ symbol: 'X', cik: '9' });
  assert.notEqual(known, noIpo);
  assert.equal(I.identityConfidenceFor({ cik: '9' }), 'medium-low');
  assert.equal(I.identityConfidenceFor({}), 'low');
  assert.equal(I.identityConfidenceFor({ figi: 'BBG000B9XRY4' }), 'high');
  const t1 = I.assignListingId({ symbol: 'Y', firstObservedAt: '2020-01-01T00:00:00Z' });
  const t2 = I.assignListingId({ symbol: 'Y', firstObservedAt: '2024-01-01T00:00:00Z' });
  assert.notEqual(t1, t2, 'ticker-only ids keyed by first observation — reuse cannot collide');
});

test('knowledge acquired AFTER the decision is invisible under prospective_replay but stable facts admit under reconstruction', () => {
  const w = world();
  // Delisting fact learned 2026-08-01 about an event on 2023-03-01.
  w.upsert({ symbol: 'LATE', ipoDate: '2015-01-01', status: 'delisted', statusFrom: '2023-03-01', observedAt: OBS,
    confirmation: { source: 'fmp-delisted-companies', delistedDate: '2023-03-01' }, provenance: 'historical_reconstruction', source: 't' });
  const args = { symbol: 'LATE', effectiveAt: '2023-01-15', knownAt: '2023-01-15' };
  const replay = R.resolveSymbolAsOfV3({ ...args, policy: PROSPECTIVE_REPLAY }, { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(replay.status, 'unknown', 'replay: the fact was not known at the decision time — fails closed');
  const recon = R.resolveSymbolAsOfV3({ ...args, policy: RETROSPECTIVE_UNIVERSE_RECONSTRUCTION }, { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(recon.status, 'resolved', 'reconstruction: later-acquired STABLE listing fact admitted');
  assert.equal(recon.reconstructed, true, 'and clearly marked reconstructed');
  assert.equal(recon.listingStatus, 'active', 'active at that date under the reconstructed listing life');
});

test('replay without a knowledge cut fails closed; policies are never mixed silently', () => {
  const { w } = renamedWorld();
  const r = R.resolveSymbolAsOfV3({ symbol: 'AAA', effectiveAt: null, policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(r.status, 'unknown');
  const ok = R.resolveSymbolAsOfV3({ symbol: 'AAA', effectiveAt: '2023-06-01', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(ok.policy, PROSPECTIVE_REPLAY, 'every result stamps its policy');
});

test('delisting and rename on neighboring dates keep distinct, non-overlapping alias eras', () => {
  const w = world();
  const { listing } = w.upsert({ symbol: 'NBR', ipoDate: '2015-01-01', status: 'active', observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  w.rename(listing, { oldSymbol: 'NBR', newSymbol: 'NBX', renameDate: '2023-03-01', observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  // Delisted the very next day under the NEW name.
  w.upsert({ symbol: 'NBX', ipoDate: '2015-01-01', status: 'delisted', statusFrom: '2023-03-02', observedAt: OBS,
    confirmation: { source: 'fmp-delisted-companies', delistedDate: '2023-03-02' }, provenance: 'historical_reconstruction', source: 't' });
  const q = (symbol, effectiveAt) => R.resolveSymbolAsOfV3({ symbol, effectiveAt, knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(q('NBR', '2023-02-28').status, 'resolved');
  assert.equal(q('NBX', '2023-03-01').status, 'resolved');
});

test('intraday timestamps are preserved — a rename at a date boundary distinguishes morning from afternoon queries', () => {
  const w = world();
  const { listing } = w.upsert({ symbol: 'INTRA', ipoDate: '2020-01-01', status: 'active', observedAt: OBS, provenance: 'historical_reconstruction', source: 't' });
  listing.aliases.push(S.makeIntervalV3({ value: 'INTRA', effectiveFrom: '2020-01-01', effectiveTo: '2024-05-10T13:30:00.000Z', knownAt: OBS, source: 't', provenance: 'historical_reconstruction' }));
  I.addAliasEntry(w.aliasShardFor('I'), I.makeAliasEntry({ alias: 'INTRA2', listingId: listing.listingId, effectiveFrom: '2024-05-10T13:30:00.000Z', knownAt: OBS, source: 't', provenance: 'historical_reconstruction' }));
  const q = (effectiveAt) => R.resolveSymbolAsOfV3({ symbol: 'INTRA2', effectiveAt, knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { aliasShards: w.aliasShards, listingShards: w.listingShards });
  assert.equal(q('2024-05-10T09:00:00.000Z').status, 'unknown', 'morning: not yet effective');
  assert.equal(q('2024-05-10T14:00:00.000Z').status, 'resolved', 'afternoon: effective — no calendar-day truncation');
});

test('resolveSecurityAsOfV3 returns ticker-at-date AND classification — no second lookup needed', () => {
  const w = world();
  const { listing } = w.upsert({
    symbol: 'CLS', ipoDate: '2020-01-01', status: 'active', instrumentType: 'common_stock',
    sector: 'Tech', industry: 'Software', country: 'US', currency: 'USD',
    observedAt: OBS, provenance: 'prospective_live', source: 't',
  });
  const r = R.resolveSecurityAsOfV3({ securityId: listing.listingId, effectiveAt: '2026-08-02', knownAt: '2026-08-02', policy: PROSPECTIVE_REPLAY },
    { listingShards: w.listingShards });
  assert.equal(r.status, 'resolved');
  assert.equal(r.tickerAtDate, 'CLS');
  assert.equal(r.classification.sector, 'Tech');
  assert.equal(r.instrumentType.value, 'common_stock');
});

test('daily re-observation is idempotent: 5 collect days do not grow the alias/status tracks', () => {
  const w = world();
  for (let d = 0; d < 5; d++) {
    w.upsert({ symbol: 'IDEM', exchange: 'NASDAQ', status: 'active', observedAt: `2026-08-0${d + 1}T12:00:00.000Z`, provenance: 'prospective_live', source: 't' });
  }
  const shard = w.listingShards[S.shardKeyFor('IDEM')];
  const listing = Object.values(shard.listings)[0];
  assert.equal(listing.aliases.length, 1);
  assert.equal(listing.status.length, 1);
});
