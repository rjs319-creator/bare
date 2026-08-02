'use strict';
// PIT-DATA-V2 SCHEMA (pit-data-v2) — bitemporal security identity, shadow system.
//
// Consolidation target for the two disconnected masters (lib/security-master.js
// `secmaster-v1`, research/lib/secmaster.js `pit-secmaster-v1`). Built BESIDE them:
// nothing consumes these records for live decisions until the reconciliation coverage
// gates pass (lib/pitdata/reconcile.js), and survivorshipSafe stays false throughout.
//
// Core invariants encoded here:
//  * TICKER IS AN ALIAS, NOT AN IDENTITY. A listing has a deterministic internal
//    listingId; the same ticker across two listing windows is two listings.
//  * TWO TIME AXES. `effectiveFrom/effectiveTo` say when a fact was true in the world;
//    `knownAt` says when THIS SYSTEM learned it. Current API state is never presented
//    as historical knowledge: backfilled facts carry knownAt = ingest time and
//    provenance 'historical_reconstruction'.
//  * DELISTING NEEDS CONFIRMATION. Only an authoritative source (vendor delisted
//    record, corporate action) sets status 'delisted'; a symbol merely absent from a
//    current listing pull is 'unknown', which FAILS CLOSED everywhere downstream.
//
// Pure module: no network, no clock, no store.

const crypto = require('crypto');
const { redactSecrets } = require('../redact');

const PITDATA_VERSION = 'pit-data-v2';

const PROVENANCE = Object.freeze({
  PROSPECTIVE_LIVE: 'prospective_live',
  HISTORICAL_RECONSTRUCTION: 'historical_reconstruction',
});

const LISTING_STATUS = Object.freeze(['active', 'delisted', 'unknown']);

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// Deterministic internal listing id. Natural key = symbol + IPO date (+ CIK when
// known). Two listings that reuse a ticker differ on ipoDate/cik and get distinct
// ids; when BOTH discriminators are unknown the id collides by construction and the
// record must carry identityConfidence 'low' — ambiguity is surfaced, never hidden.
function listingIdFor({ symbol, ipoDate = null, cik = null }) {
  return 'pitv2:' + sha16(`${String(symbol || '').toUpperCase()}|ipo:${ipoDate || '?'}|cik:${cik || '?'}`);
}

function identityConfidenceFor({ ipoDate = null, cik = null, figi = null }) {
  if (figi) return 'high';                       // share-class-level identity
  if (cik && ipoDate) return 'medium';
  if (cik || ipoDate) return 'medium-low';
  return 'low';                                  // ticker-only — reuse-collision possible
}

// Content-addressed raw-response descriptor. The payload hash IS the storage key, so
// re-ingesting identical data is naturally idempotent. Params are sanitized (never a
// key) and the four timestamps are kept distinct on purpose.
function makeRawSnapshot({ endpoint, params = {}, payload, effectiveAt = null, sourcePublishedAt = null, knownAt, ingestedAt, provenance }) {
  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (/^(apikey|api_key|token)$/i.test(k)) continue;
    clean[k] = v;
  }
  const body = JSON.stringify(payload);
  const responseHash = crypto.createHash('sha256').update(body).digest('hex');
  return Object.freeze({
    schema: 'PitRawSnapshot', version: PITDATA_VERSION,
    endpoint: redactSecrets(endpoint), params: Object.freeze(clean),
    responseHash,
    effectiveAt, sourcePublishedAt, knownAt: knownAt || null, ingestedAt: ingestedAt || null,
    provenance: provenance === PROVENANCE.PROSPECTIVE_LIVE ? provenance : PROVENANCE.HISTORICAL_RECONSTRUCTION,
    bytes: body.length,
  });
}

// One effective-dated, known-dated fact interval.
function makeInterval({ value, effectiveFrom = null, effectiveTo = null, knownAt, source, provenance, confirmation = null }) {
  return Object.freeze({
    value, effectiveFrom, effectiveTo,
    knownAt: knownAt || null, source: source || null,
    provenance: provenance === PROVENANCE.PROSPECTIVE_LIVE ? provenance : PROVENANCE.HISTORICAL_RECONSTRUCTION,
    confirmation,   // delisting/status intervals: the authoritative evidence, or null
  });
}

// A listing record: identity + effective-dated attribute tracks.
function makeListing({ listingId, symbol, exchange = null, cik = null, figi = null, ipoDate = null }) {
  return {
    schema: 'PitListing', version: PITDATA_VERSION,
    listingId, symbol: String(symbol || '').toUpperCase(),
    exchange, cik: cik || null, figi: figi || null, ipoDate: ipoDate || null,
    identityConfidence: identityConfidenceFor({ ipoDate, cik, figi }),
    aliases: [],          // makeInterval(value: ticker string)
    status: [],           // makeInterval(value: LISTING_STATUS, confirmation for 'delisted')
    classification: [],   // makeInterval(value: {sector, industry})
    actions: [],          // {type, exDate, detail, knownAt, source, provenance}
    actionsCollected: false,  // corporateActionsBetween fails closed until a collector has run for this listing
  };
}

// "Known by DATE" means known by the END of that date: a date-only knownAt query is
// normalized to 23:59:59Z so it compares correctly against full-ISO ingest stamps
// (otherwise same-day knowledge would string-compare as future knowledge).
function normalizeKnownAt(k) {
  return k && k.length === 10 ? `${k}T23:59:59.999Z` : k;
}

// Bitemporal as-of selection: facts true at `effectiveAt` AND known by `knownAt`.
// No matching interval → null (the caller maps null to its fail-closed state).
function asOfInterval(intervals, { effectiveAt, knownAt = null }) {
  if (!Array.isArray(intervals) || !effectiveAt) return null;
  const kq = normalizeKnownAt(knownAt);
  const eligible = intervals.filter((iv) => {
    if (kq && iv.knownAt && iv.knownAt > kq) return false;   // not yet known
    if (iv.effectiveFrom && iv.effectiveFrom > effectiveAt) return false;
    if (iv.effectiveTo && iv.effectiveTo < effectiveAt) return false;
    return true;
  });
  if (!eligible.length) return null;
  // Latest knowledge wins among eligible intervals (most recent knownAt, then effectiveFrom).
  return eligible.sort((a, b) =>
    String(b.knownAt || '').localeCompare(String(a.knownAt || ''))
    || String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')))[0];
}

const shardKeyFor = (symbol) => {
  const c = String(symbol || '').toUpperCase()[0];
  return c >= 'A' && c <= 'Z' ? c : '0';
};

module.exports = {
  PITDATA_VERSION, PROVENANCE, LISTING_STATUS,
  listingIdFor, identityConfidenceFor, makeRawSnapshot, makeInterval, makeListing,
  asOfInterval, normalizeKnownAt, shardKeyFor,
};
