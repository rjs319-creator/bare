'use strict';
// PIT-DATA-V3 RESOLVERS — point-in-time symbol/security resolution over the v3
// listing shards + global alias index.
//
// Contract (fixes v2 defects 5/6 and the arbitrary-candidate pick):
//   * Lookup goes through the ALIAS INDEX keyed by the queried ticker's own first
//     letter — cross-shard renames resolve from either end.
//   * Alias EFFECTIVE INTERVALS are enforced, half-open [from, to): an expired
//     alias never resolves as the current listing; ticker reuse after delisting
//     returns the listing whose interval contains the queried time, or
//     'ambiguous' with ALL candidates when more than one remains.
//   * KNOWLEDGE POLICY is explicit (prospective_replay vs
//     retrospective_universe_reconstruction) and stamped on every result; the two
//     are never mixed silently. Replay without a knowledge cut fails closed.
//   * Full ISO timestamps are preserved — an intraday effectiveAt is compared as
//     given, not truncated to a calendar date.
//   * Results carry the ticker effective on the requested date, the resolved
//     classification and instrument type (the caller never re-supplies the
//     listing id to get them), listing status, and identityConfidence.
//   * No arbitrary selection: zero interval-valid candidates → 'unknown' (with
//     out-of-interval near-misses listed for diagnostics), >1 distinct listings →
//     'ambiguous'. Unknown NEVER defaults to resolved.

const S = require('./schema');
const I = require('./identity');

function policyOf(policy) {
  return policy === S.QUERY_POLICIES.RETROSPECTIVE_UNIVERSE_RECONSTRUCTION
    ? S.QUERY_POLICIES.RETROSPECTIVE_UNIVERSE_RECONSTRUCTION
    : S.QUERY_POLICIES.PROSPECTIVE_REPLAY;
}

// Latest-knowledge-wins selection among interval-valid, knowledge-admitted facts.
function factAt(intervals, { effectiveAt, knownAt, policy, factKind }) {
  const eligible = (intervals || []).filter((iv) =>
    S.inHalfOpenInterval(iv, effectiveAt)
    && S.knowledgeAdmits({ factKnownAt: iv.knownAt, queryKnownAt: knownAt, policy, factKind }));
  if (!eligible.length) return null;
  return eligible.sort((a, b) =>
    String(b.knownAt || '').localeCompare(String(a.knownAt || ''))
    || String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')))[0];
}

function statusAt(listing, when) {
  const iv = factAt(listing.status, { ...when, factKind: 'status' });
  return iv ? iv.value : 'unknown';
}

function aliasAt(listing, when) {
  const iv = factAt(listing.aliases, { ...when, factKind: 'alias' });
  return iv ? iv.value : null;
}

// Which listing did `symbol` refer to at effectiveAt (full ISO preserved), as
// known at knownAt, under `policy`?
function resolveSymbolAsOfV3({ symbol, effectiveAt, knownAt = null, policy = null }, { aliasShards, listingShards }) {
  const pol = policyOf(policy);
  const kAt = knownAt || effectiveAt;
  const base = { version: S.PITDATA_V3_VERSION, symbol: String(symbol || '').toUpperCase(), effectiveAt, knownAt: kAt, policy: pol,
    reconstructed: pol === S.QUERY_POLICIES.RETROSPECTIVE_UNIVERSE_RECONSTRUCTION };
  if (!symbol || !effectiveAt) return { ...base, status: 'unknown', reason: 'invalid-query' };
  if (pol === S.QUERY_POLICIES.PROSPECTIVE_REPLAY && !kAt) return { ...base, status: 'unknown', reason: 'replay-without-knowledge-cut' };

  const entries = I.entriesForAlias(aliasShards, symbol);
  if (!entries.length) return { ...base, status: 'unknown', reason: 'no-alias-known', candidates: [] };

  const admitted = entries.filter((e) =>
    S.knowledgeAdmits({ factKnownAt: e.knownAt, queryKnownAt: kAt, policy: pol, factKind: 'alias' }));
  const inInterval = admitted.filter((e) => S.inHalfOpenInterval(e, effectiveAt));
  const distinct = [...new Set(inInterval.map((e) => e.listingId))];

  if (distinct.length === 0) {
    // Expired/not-yet-effective aliases are near-misses, NEVER a silent pick.
    return {
      ...base, status: 'unknown', reason: admitted.length ? 'alias-not-effective-at-time' : 'alias-not-known-at-time',
      candidates: [],
      nearMisses: admitted.map((e) => ({ listingId: e.listingId, effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo })),
    };
  }
  if (distinct.length > 1) {
    return { ...base, status: 'ambiguous', reason: 'ticker-reused-or-multi-class', candidates: distinct };
  }

  const listing = I.findListing(listingShards, distinct[0]);
  if (!listing) return { ...base, status: 'unknown', reason: 'alias-points-to-missing-listing', candidates: distinct };
  const when = { effectiveAt, knownAt: kAt, policy: pol };
  return {
    ...base, status: 'resolved',
    listingId: listing.listingId,
    tickerAtDate: base.symbol,
    listingStatus: statusAt(listing, when),
    identityConfidence: listing.identityConfidence,
    identityCandidates: listing.identityCandidates || [],
    classification: classificationOf(listing, when),
    instrumentType: instrumentTypeOf(listing, when),
    candidates: distinct,
  };
}

function classificationOf(listing, when) {
  const iv = factAt(listing.classification, { ...when, factKind: 'classification' });
  if (!iv) return { status: 'unknown', reason: 'no-classification-known-at-time' };
  return { status: 'resolved', ...iv.value, knownAt: iv.knownAt, provenance: iv.provenance };
}

function instrumentTypeOf(listing, when) {
  const iv = factAt(listing.instrumentType, { ...when, factKind: 'instrumentType' });
  return iv ? { status: 'resolved', value: iv.value, knownAt: iv.knownAt } : { status: 'unknown' };
}

// listingId → state at a time. Returns the ticker effective on the requested
// date (not the current one) plus classification, so callers never round-trip.
function resolveSecurityAsOfV3({ securityId, effectiveAt, knownAt = null, policy = null }, { listingShards }) {
  const pol = policyOf(policy);
  const kAt = knownAt || effectiveAt;
  const base = { version: S.PITDATA_V3_VERSION, securityId, effectiveAt, knownAt: kAt, policy: pol,
    reconstructed: pol === S.QUERY_POLICIES.RETROSPECTIVE_UNIVERSE_RECONSTRUCTION };
  const listing = I.findListing(listingShards, securityId);
  if (!listing) return { ...base, status: 'unknown', reason: 'no-such-listing' };
  const when = { effectiveAt, knownAt: kAt, policy: pol };
  const ticker = aliasAt(listing, when);
  return {
    ...base, status: ticker ? 'resolved' : 'unknown',
    reason: ticker ? null : 'no-alias-effective-at-time',
    tickerAtDate: ticker,
    listingStatus: statusAt(listing, when),
    identityConfidence: listing.identityConfidence,
    classification: classificationOf(listing, when),
    instrumentType: instrumentTypeOf(listing, when),
  };
}

function allListingsV3(listingShards) {
  const out = [];
  for (const shard of Object.values(listingShards || {})) {
    for (const l of Object.values((shard && shard.listings) || {})) out.push(l);
  }
  return out;
}

module.exports = {
  resolveSymbolAsOfV3, resolveSecurityAsOfV3, allListingsV3,
  factAt, statusAt, aliasAt, classificationOf, instrumentTypeOf,
};
