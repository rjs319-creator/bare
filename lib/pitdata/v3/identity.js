'use strict';
// PIT-DATA-V3 IDENTITY — stable internal listing IDs and the global alias index.
//
// TICKER IS AN ALIAS, NOT AN IDENTITY. A listing gets ONE internal id when it is
// first observed and keeps it across every rename. Identity strength comes from
// the identifiers actually available:
//   * FIGI / share-class FIGI → instrument identity ('high')
//   * SEC CIK → ISSUER identity only. CIK alone NEVER merges share classes: the
//     id key always includes the first-seen symbol, so BRK.A / BRK.B under one
//     CIK stay two listings.
//   * exchange / listing-start metadata → corroboration
// Missing identifiers do not break collection: the listing keeps an internal id,
// reports identityConfidence, preserves competing candidates, and ambiguous
// resolution FAILS CLOSED downstream.
//
// THE ALIAS INDEX fixes v2 DEFECT 5 (cross-shard renames): entries are keyed by
// EVERY HISTORICAL TICKER under the alias's OWN first letter — not the current
// ticker's shard — so resolving an old ticker never depends on knowing what the
// name became. Each entry carries its half-open effective interval, source,
// knownAt and listingId (v2 DEFECT 6: intervals were recorded but ignored).
//
// Pure module: no network, no clock, no store.

const crypto = require('crypto');
const S = require('./schema');

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// CIKs arrive zero-padded from some sources (FMP '0000320193') and bare from
// others (SEC 320193). ONE canonical form, or the same issuer looks like an
// identity conflict and enrichment forks a duplicate listing.
const normCik = (c) => {
  const s = String(c ?? '').replace(/^0+/, '');
  return s.length ? s : null;
};

// Deterministic, assigned-once listing id. Precedence mirrors identifier
// strength; the symbol stays inside every key so a shared CIK can never merge
// two share classes. Rename safety: the id is derived ONCE at first observation
// and persisted on the listing — later renames update aliases, never the id.
function assignListingId({ symbol, figi = null, cik = null, ipoDate = null, firstObservedAt = null }) {
  const sym = String(symbol || '').toUpperCase();
  const ck = normCik(cik);
  if (figi) return `pitv3:figi:${sha16(`${figi}`)}`;
  if (ck && ipoDate) return `pitv3:cik:${sha16(`${ck}|${ipoDate}|${sym}`)}`;
  if (ck) return `pitv3:cik:${sha16(`${ck}|?|${sym}`)}`;
  if (ipoDate) return `pitv3:tk:${sha16(`${sym}|ipo:${ipoDate}`)}`;
  // Ticker-only: include first-observation time so ticker REUSE creates a NEW
  // listing instead of silently colliding with the dead one.
  return `pitv3:tk:${sha16(`${sym}|seen:${firstObservedAt || '?'}`)}`;
}

function identityConfidenceFor({ figi = null, cik = null, ipoDate = null, exchange = null }) {
  if (figi) return 'high';
  if (cik && ipoDate) return 'medium';
  if (cik || ipoDate) return 'medium-low';
  if (exchange) return 'low';
  return 'low';
}

// A v3 listing record. All attribute tracks are APPEND-ONLY interval lists; a
// correction appends a superseding interval (later knownAt wins at read time).
function makeListingV3({ listingId, symbol, figi = null, cik = null, ipoDate = null, exchange = null, firstObservedAt = null }) {
  return {
    schema: 'PitListingV3', version: S.PITDATA_V3_VERSION,
    listingId,
    symbol: String(symbol || '').toUpperCase(),   // symbol AT FIRST OBSERVATION — display only, never an identity
    identity: {
      figi: figi || null, cik: cik || null, ipoDate: ipoDate || null, exchange: exchange || null,
      vendorIds: {},                              // source name → vendor identifier
      firstObservedAt: firstObservedAt || null,
    },
    identityConfidence: identityConfidenceFor({ figi, cik, ipoDate, exchange }),
    // Competing identity candidates are PRESERVED, never merged away; ambiguous
    // resolution fails closed on this list downstream.
    identityCandidates: [],
    aliases: [],          // makeIntervalV3(value: ticker) — mirrored into the alias index
    status: [],           // makeIntervalV3(value: 'active'|'delisted', confirmation for delisted)
    classification: [],   // makeIntervalV3(value: {sector, industry, instrumentType, country, currency})
    instrumentType: [],   // makeIntervalV3(value: 'common_stock'|'etf'|...)
    actions: [],          // corporate actions: {type, exDate, detail, knownAt, source, provenance}
    actionsCollected: false,
  };
}

// ── Alias index ───────────────────────────────────────────────────────────────
// aliasShards: { '<A-Z|0>': { aliases: { TICKER: [entry, …] } } } — the shard key
// is the ALIAS's own first letter, so cross-shard renames are found by construction.
function aliasShardKey(alias) { return S.shardKeyFor(alias); }

function makeAliasEntry({ alias, listingId, effectiveFrom = null, effectiveTo = null, knownAt, source, provenance }) {
  return Object.freeze({
    alias: String(alias || '').toUpperCase(), listingId,
    effectiveFrom, effectiveTo,               // half-open [from, to)
    intervalSemantics: S.INTERVAL_SEMANTICS,
    knownAt: knownAt || null, source: source || null,
    provenance: provenance === S.PROVENANCE.PROSPECTIVE_LIVE
      ? S.PROVENANCE.PROSPECTIVE_LIVE : S.PROVENANCE.HISTORICAL_RECONSTRUCTION,
  });
}

// Append an alias entry into its OWN shard (in place on the shard doc the caller
// owns). Duplicate-safe: an identical (alias, listingId, interval) entry is a
// no-op, so idempotent re-collection cannot bloat the index.
function addAliasEntry(aliasShard, entry) {
  const map = (aliasShard.aliases ||= {});
  const list = (map[entry.alias] ||= []);
  const dup = list.some((e) => e.listingId === entry.listingId
    && e.effectiveFrom === entry.effectiveFrom && e.effectiveTo === entry.effectiveTo);
  if (!dup) list.push(entry);
  return aliasShard;
}

function entriesForAlias(aliasShards, symbol) {
  const sym = String(symbol || '').toUpperCase();
  const shard = (aliasShards || {})[aliasShardKey(sym)];
  return ((shard && shard.aliases && shard.aliases[sym]) || []);
}

// ── Listing upserts (append-only) ─────────────────────────────────────────────
// listingShards: { '<A-Z|0>': { listings: { listingId: listing } } } — sharded by
// the listing's FIRST-OBSERVED symbol. Lookup by ticker goes through the alias
// index, never through this shard key.
function findListing(listingShards, listingId) {
  for (const shard of Object.values(listingShards || {})) {
    const l = shard && shard.listings && shard.listings[listingId];
    if (l) return l;
  }
  return null;
}

// Record one observed listing fact set. Appends intervals; never rewrites an
// existing one (corrections supersede via knownAt at read time).
function upsertListingV3(listingShard, aliasShardsByKey, {
  symbol, figi = null, cik = null, ipoDate = null, exchange = null,
  status = null, statusFrom = null, statusTo = null, confirmation = null,
  instrumentType = null, sector = null, industry = null, country = null, currency = null,
  observedAt, provenance, source,
}, helpers = {}) {
  const symUpper = String(symbol || '').toUpperCase();
  cik = normCik(cik);
  // RESOLVE-BEFORE-CREATE: if exactly one existing listing currently claims this
  // ticker (open interval, or interval containing the delisting date), merge the
  // fact into THAT listing instead of minting a second identity — a delisted-feed
  // row for a renamed name must land on the renamed listing. Identity conflicts
  // (different cik/figi) still create a separate listing so ambiguity is
  // preserved, never merged away.
  let l = null, listingId = null;
  const idxShard = aliasShardsByKey(aliasShardKey(symUpper));
  const claimEntries = (((idxShard.aliases || {})[symUpper]) || []).filter((e) =>
    !e.effectiveTo || (statusFrom && e.effectiveFrom && e.effectiveFrom <= statusFrom && statusFrom < e.effectiveTo));
  const claimIds = [...new Set(claimEntries.map((e) => e.listingId))];
  if (claimIds.length === 1) {
    const found = helpers.findListing
      ? helpers.findListing(claimIds[0])
      : ((listingShard.listings || {})[claimIds[0]] || null);
    if (found) {
      const conflict = (cik && found.identity.cik && found.identity.cik !== cik)
        || (figi && found.identity.figi && found.identity.figi !== figi);
      if (!conflict) { l = found; listingId = found.listingId; }
      else if (!found.identityCandidates.includes(claimIds[0])) {
        found.identityCandidates.push(claimIds[0]);   // preserved competing candidate
      }
    }
  }
  const listings = (listingShard.listings ||= {});
  if (!l) {
    listingId = assignListingId({ symbol, figi, cik, ipoDate, firstObservedAt: observedAt });
    l = (listings[listingId] ||= makeListingV3({ listingId, symbol, figi, cik, ipoDate, exchange, firstObservedAt: observedAt }));
  }
  if (exchange && !l.identity.exchange) l.identity.exchange = exchange;
  if (cik && !l.identity.cik) l.identity.cik = cik;
  if (figi && !l.identity.figi) l.identity.figi = figi;
  if (ipoDate && !l.identity.ipoDate) l.identity.ipoDate = ipoDate;   // listing-start metadata; the id itself never changes
  l.identityConfidence = identityConfidenceFor(l.identity);

  const iv = (value, extra = {}) => S.makeIntervalV3({ value, knownAt: observedAt, source, provenance, ...extra });

  // Current-alias interval. For an active observation WITHOUT an ipoDate the
  // alias starts at the observation date: current API state never claims
  // historical knowledge (same invariant as v2, kept deliberately).
  // IDEMPOTENT DAILY RE-OBSERVATION: an open alias/status interval that already
  // covers the same fact is NOT re-appended — append-only means corrections add
  // facts, not that every sighting duplicates the store.
  const sym = symUpper;
  const aliasTo = status === 'delisted' ? (statusTo || statusFrom) : null;
  const openAlias = (l.aliases || []).some((a) => a.value === sym && !a.effectiveTo);
  if (status === 'delisted' && aliasTo && openAlias) {
    // The ticker dies with the listing: close the open era at the delist date.
    closeOpenInterval(l.aliases, (a) => a.value === sym, aliasTo);
    const shard = aliasShardsByKey(aliasShardKey(sym));
    closeOpenInterval(((shard.aliases ||= {})[sym] ||= []), (e) => e.listingId === listingId, aliasTo);
  } else {
    const hasAlias = (l.aliases || []).some((a) => a.value === sym && (a.effectiveTo || null) === (aliasTo || null));
    if (!hasAlias && !(status === 'active' && openAlias)) {
      const from = ipoDate || (status === 'active' ? String(observedAt || '').slice(0, 10) : statusFrom) || null;
      l.aliases.push(iv(sym, { effectiveFrom: from, effectiveTo: aliasTo }));
      const shard = aliasShardsByKey(aliasShardKey(sym));
      addAliasEntry(shard, makeAliasEntry({ alias: sym, listingId, effectiveFrom: from, effectiveTo: aliasTo, knownAt: observedAt, source, provenance }));
    }
  }

  if (status === 'delisted' && statusFrom) {
    const hasDelisted = (l.status || []).some((s) => s.value === 'delisted' && s.effectiveFrom === statusFrom);
    if (!hasDelisted) {
      closeOpenInterval(l.status, (s) => s.value === 'active', statusFrom);
      if (ipoDate && !(l.status || []).some((s) => s.value === 'active')) {
        l.status.push(iv('active', { effectiveFrom: ipoDate, effectiveTo: statusFrom }));
      }
      l.status.push(iv('delisted', { effectiveFrom: statusFrom, confirmation }));
    }
  } else if (status === 'active') {
    const hasOpenActive = (l.status || []).some((s) => s.value === 'active' && !s.effectiveTo);
    if (!hasOpenActive) l.status.push(iv('active', { effectiveFrom: ipoDate || String(observedAt || '').slice(0, 10) || null }));
  }
  if (instrumentType) {
    const hasType = (l.instrumentType || []).some((s) => s.value === instrumentType && !s.effectiveTo);
    if (!hasType) l.instrumentType.push(iv(instrumentType));
  }
  if (sector || industry || country || currency) {
    const cls = { sector: sector || null, industry: industry || null, country: country || null, currency: currency || null };
    const last = (l.classification || [])[l.classification.length - 1];
    if (!last || JSON.stringify(last.value) !== JSON.stringify(cls)) l.classification.push(iv(cls));
  }
  return { listingId, listing: l };
}

// A rename closes the OLD alias at the rename date (half-open: the old ticker is
// no longer valid ON the rename date) and opens the new alias from it. Both
// entries land in their OWN alias shards, so A→Z renames resolve from either end.
//
// Any OPEN interval for the old ticker (from an earlier active observation) is
// CLOSED at the rename date, in the listing track AND the alias index. The raw
// observation layer stays append-only; this derived identity state is corrected
// so an expired ticker can never keep matching through a stale open interval.
function closeOpenInterval(list, matches, effectiveTo) {
  for (let i = 0; i < list.length; i++) {
    const iv = list[i];
    if (!iv.effectiveTo && matches(iv)) list[i] = Object.freeze({ ...iv, effectiveTo });
  }
}

function applyRename(listing, aliasShardsByKey, { oldSymbol, newSymbol, renameDate, observedAt, provenance, source }) {
  const oldSym = String(oldSymbol).toUpperCase();
  const newSym = String(newSymbol).toUpperCase();
  const oldFrom = listing.identity.ipoDate || null;

  const hadOpenOld = (listing.aliases || []).some((a) => a.value === oldSym && !a.effectiveTo);
  closeOpenInterval(listing.aliases, (iv) => iv.value === oldSym, renameDate);
  if (!hadOpenOld) {
    listing.aliases.push(S.makeIntervalV3({ value: oldSym, effectiveFrom: oldFrom, effectiveTo: renameDate, knownAt: observedAt, source, provenance }));
  }
  if (!(listing.aliases || []).some((a) => a.value === newSym && !a.effectiveTo)) {
    listing.aliases.push(S.makeIntervalV3({ value: newSym, effectiveFrom: renameDate, knownAt: observedAt, source, provenance }));
  }

  const oldShard = aliasShardsByKey(aliasShardKey(oldSym));
  const oldEntries = ((oldShard.aliases ||= {})[oldSym] ||= []);
  const hadOpenIdx = oldEntries.some((e) => e.listingId === listing.listingId && !e.effectiveTo);
  closeOpenInterval(oldEntries, (e) => e.listingId === listing.listingId, renameDate);
  if (!hadOpenIdx) {
    addAliasEntry(oldShard, makeAliasEntry({ alias: oldSym, listingId: listing.listingId, effectiveFrom: oldFrom, effectiveTo: renameDate, knownAt: observedAt, source, provenance }));
  }
  addAliasEntry(aliasShardsByKey(aliasShardKey(newSym)),
    makeAliasEntry({ alias: newSym, listingId: listing.listingId, effectiveFrom: renameDate, knownAt: observedAt, source, provenance }));
  return listing;
}

module.exports = {
  normCik, assignListingId, identityConfidenceFor, makeListingV3,
  aliasShardKey, makeAliasEntry, addAliasEntry, entriesForAlias,
  findListing, upsertListingV3, applyRename,
};
