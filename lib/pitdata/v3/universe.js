'use strict';
// PIT-DATA-V3 UNIVERSE — versioned point-in-time investable-universe policy for
// US common stocks, and the immutable daily UniverseSnapshot.
//
// Fixes v2 DEFECT 7 and generalizes it: UNKNOWN DATA NEVER PASSES A REQUESTED
// FILTER. A policy that filters on exchange REJECTS-AS-UNAVAILABLE a listing
// whose exchange is unknown; instrument type must be POSITIVELY confirmed
// 'common_stock' (a vendor 'stock' row is 'stock-unverified' until a profile
// corroborates — /stock-list is NOT assumed to contain only eligible securities).
//
// Every excluded listing carries a reason code; the snapshot partitions the full
// listing population into selected / rejected / unavailable and is content-
// addressed (snapshotId = hash of the canonical body) so it can be pinned by
// decision records. survivorshipSafe stays FALSE until the reconciliation gates
// AND the separate human promotion artifact exist.
//
// Pure module: no network, no clock, no store.

const S = require('./schema');
const R = require('./resolve');

// The versioned policy. Changing ANY threshold requires a new policyVersion —
// snapshots pin the version they were built under.
const UNIVERSE_POLICY_V3 = Object.freeze({
  policyVersion: 'us-common-v3.0',
  instrumentTypes: Object.freeze(['common_stock']),
  countries: Object.freeze(['US']),
  currencies: Object.freeze(['USD']),
  exchanges: Object.freeze(['NASDAQ', 'NYSE', 'AMEX']),
  minPrice: 1,               // point-in-time close
  minMarketCap: 50e6,        // point-in-time cap
  minAdvDollar: 250_000,     // point-in-time 20d dollar ADV
});

// Reason codes are part of the artifact contract — stable strings, not prose.
const REASONS = Object.freeze({
  NOT_ACTIVE: 'not-active-at-effectiveAt',
  DELISTED: 'delisted-before-effectiveAt',
  STATUS_UNKNOWN: 'status-unknown-fails-closed',
  INSTRUMENT_NOT_COMMON: 'instrument-type-not-common-stock',
  INSTRUMENT_UNKNOWN: 'instrument-type-unknown-fails-closed',
  EXCHANGE_NOT_ALLOWED: 'exchange-not-in-policy',
  EXCHANGE_UNKNOWN: 'exchange-unknown-fails-closed',
  COUNTRY_NOT_ALLOWED: 'country-not-in-policy',
  COUNTRY_UNKNOWN: 'country-unknown-fails-closed',
  CURRENCY_NOT_ALLOWED: 'currency-not-in-policy',
  CURRENCY_UNKNOWN: 'currency-unknown-fails-closed',
  PRICE_BELOW_MIN: 'price-below-policy-min',
  PRICE_UNKNOWN: 'pit-price-unavailable',
  CAP_BELOW_MIN: 'market-cap-below-policy-min',
  CAP_UNKNOWN: 'pit-market-cap-unavailable',
  ADV_BELOW_MIN: 'adv-below-policy-min',
  ADV_UNKNOWN: 'pit-adv-unavailable',
});

// Evaluate ONE listing against the policy at a point in time.
//   marketData: optional PIT lookup { close, marketCap, advDollar } | null —
//   null/missing values are UNAVAILABLE, never assumed passing.
// Returns { bucket: 'selected'|'rejected'|'unavailable', reason }.
function evaluateListing(listing, { effectiveAt, knownAt, policy = null, universePolicy = UNIVERSE_POLICY_V3, marketData = null }) {
  const when = { effectiveAt, knownAt, policy };
  const st = R.statusAt(listing, when);
  if (st === 'unknown') return { bucket: 'unavailable', reason: REASONS.STATUS_UNKNOWN };
  if (st === 'delisted') return { bucket: 'rejected', reason: REASONS.DELISTED };
  if (st !== 'active') return { bucket: 'rejected', reason: REASONS.NOT_ACTIVE };

  const it = R.instrumentTypeOf(listing, when);
  if (it.status !== 'resolved' || it.value === 'stock-unverified') {
    return { bucket: 'unavailable', reason: REASONS.INSTRUMENT_UNKNOWN };
  }
  if (!universePolicy.instrumentTypes.includes(it.value)) {
    return { bucket: 'rejected', reason: REASONS.INSTRUMENT_NOT_COMMON };
  }

  const exch = listing.identity && listing.identity.exchange;
  if (universePolicy.exchanges && universePolicy.exchanges.length) {
    if (!exch) return { bucket: 'unavailable', reason: REASONS.EXCHANGE_UNKNOWN };   // unknown FAILS the filter
    if (!universePolicy.exchanges.includes(String(exch).toUpperCase())) {
      return { bucket: 'rejected', reason: REASONS.EXCHANGE_NOT_ALLOWED };
    }
  }

  const cls = R.classificationOf(listing, when);
  if (universePolicy.countries && universePolicy.countries.length) {
    if (cls.status !== 'resolved' || !cls.country) return { bucket: 'unavailable', reason: REASONS.COUNTRY_UNKNOWN };
    if (!universePolicy.countries.includes(String(cls.country).toUpperCase())) {
      return { bucket: 'rejected', reason: REASONS.COUNTRY_NOT_ALLOWED };
    }
  }
  if (universePolicy.currencies && universePolicy.currencies.length) {
    if (cls.status !== 'resolved' || !cls.currency) return { bucket: 'unavailable', reason: REASONS.CURRENCY_UNKNOWN };
    if (!universePolicy.currencies.includes(String(cls.currency).toUpperCase())) {
      return { bucket: 'rejected', reason: REASONS.CURRENCY_NOT_ALLOWED };
    }
  }

  const md = marketData || {};
  if (universePolicy.minPrice != null) {
    if (!(md.close > 0)) return { bucket: 'unavailable', reason: REASONS.PRICE_UNKNOWN };
    if (md.close < universePolicy.minPrice) return { bucket: 'rejected', reason: REASONS.PRICE_BELOW_MIN };
  }
  if (universePolicy.minMarketCap != null) {
    if (!(md.marketCap > 0)) return { bucket: 'unavailable', reason: REASONS.CAP_UNKNOWN };
    if (md.marketCap < universePolicy.minMarketCap) return { bucket: 'rejected', reason: REASONS.CAP_BELOW_MIN };
  }
  if (universePolicy.minAdvDollar != null) {
    if (!(md.advDollar > 0)) return { bucket: 'unavailable', reason: REASONS.ADV_UNKNOWN };
    if (md.advDollar < universePolicy.minAdvDollar) return { bucket: 'rejected', reason: REASONS.ADV_BELOW_MIN };
  }

  return { bucket: 'selected', reason: null };
}

// Build the immutable daily UniverseSnapshot over the full listing population.
//   marketDataFor(listing) -> { close, marketCap, advDollar } | null (PIT values
//   as known at knownAt — the caller supplies genuinely point-in-time data or
//   null; TODAY's float/sector/profile is never accepted as historical).
function buildUniverseSnapshot({
  effectiveAt, knownAt = null, policy = S.QUERY_POLICIES.PROSPECTIVE_REPLAY,
  universePolicy = UNIVERSE_POLICY_V3, listingShards, marketDataFor = () => null,
  securityMasterVersion = null,
}) {
  const kAt = knownAt || effectiveAt;
  const selected = [], rejected = [], unavailable = [];
  const reasonCounts = {};
  let reconstructedFacts = 0, prospectiveFacts = 0;
  for (const listing of R.allListingsV3(listingShards)) {
    const md = marketDataFor(listing);
    const { bucket, reason } = evaluateListing(listing, { effectiveAt, knownAt: kAt, policy, universePolicy, marketData: md });
    const row = { listingId: listing.listingId, symbol: listing.symbol, identityConfidence: listing.identityConfidence, reason };
    if (bucket === 'selected') selected.push(row);
    else if (bucket === 'rejected') { rejected.push(row); reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; }
    else { unavailable.push(row); reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; }
    for (const iv of listing.status || []) {
      if (iv.provenance === S.PROVENANCE.PROSPECTIVE_LIVE) prospectiveFacts++; else reconstructedFacts++;
    }
  }
  const body = {
    schema: 'UniverseSnapshotV3', version: S.PITDATA_V3_VERSION,
    decisionTimestamp: effectiveAt, knownAt: kAt,
    policyVersion: universePolicy.policyVersion,
    queryPolicy: policy,
    reconstructed: policy === S.QUERY_POLICIES.RETROSPECTIVE_UNIVERSE_RECONSTRUCTION,
    securityMasterVersion,
    counts: { selected: selected.length, rejected: rejected.length, unavailable: unavailable.length,
      total: selected.length + rejected.length + unavailable.length },
    coverage: {
      selectedFrac: null, reasonCounts,
      lowConfidenceSelected: selected.filter((r) => r.identityConfidence === 'low').length,
      provenance: { prospectiveFacts, reconstructedFacts },
    },
    selected, rejected, unavailable,
    // Stays false until reconciliation gates pass AND a human promotion artifact
    // exists — a snapshot can never claim safety on its own.
    survivorshipSafe: false,
    pointInTimeSafe: policy === S.QUERY_POLICIES.PROSPECTIVE_REPLAY,
  };
  body.coverage.selectedFrac = body.counts.total ? +(body.counts.selected / body.counts.total).toFixed(4) : null;
  const snapshotId = S.contentHashOf(body);
  return Object.freeze({ ...body, snapshotId, contentHash: snapshotId });
}

module.exports = { UNIVERSE_POLICY_V3, REASONS, evaluateListing, buildUniverseSnapshot };
