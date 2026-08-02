'use strict';
// PIT-DATA-V2 RESOLVERS — the five point-in-time interfaces, pure over supplied
// identity shards. Every unknown FAILS CLOSED: an unresolvable symbol/security/
// classification returns status 'unknown', and universeAt never counts an unknown
// listing as active. `knownAt` defaults to effectiveAt (you may not use knowledge
// from after the decision you are reconstructing).

const S = require('./schema');

function allListings(shards) {
  const out = [];
  for (const shard of Object.values(shards || {})) {
    for (const l of Object.values((shard && shard.listings) || {})) out.push(l);
  }
  return out;
}

function listingsForSymbol(shards, symbol) {
  const key = S.shardKeyFor(symbol);
  const shard = (shards || {})[key];
  const sym = String(symbol || '').toUpperCase();
  return Object.values((shard && shard.listings) || {}).filter((l) => {
    if (l.symbol === sym) return true;
    return (l.aliases || []).some((a) => String(a.value || '').toUpperCase() === sym);
  });
}

function statusAt(listing, when) {
  const iv = S.asOfInterval(listing.status || [], when);
  return iv ? iv.value : 'unknown';
}

// resolveSymbolAsOf: which LISTING did this ticker refer to at effectiveAt, as known
// at knownAt? Ticker reuse yields 'ambiguous' with all candidates — never a merge.
function resolveSymbolAsOf({ symbol, effectiveAt, knownAt = null }, shards) {
  const when = { effectiveAt, knownAt: knownAt || effectiveAt };
  // Every listing that ever carried the ticker stays visible as a candidate —
  // including status-unknown ones — so reuse can be detected, never merged away.
  const cands = listingsForSymbol(shards, symbol)
    .map((l) => ({ listing: l, status: statusAt(l, when) }));
  if (!cands.length) return { status: 'unknown', symbol, reason: 'no-listing-known', candidates: [] };
  const live = cands.filter((c) => c.status === 'active');
  if (live.length === 1) {
    const l = live[0].listing;
    return { status: 'resolved', listingId: l.listingId, identityConfidence: l.identityConfidence, listingStatus: 'active', candidates: cands.map((c) => c.listing.listingId) };
  }
  if (live.length > 1) return { status: 'ambiguous', symbol, reason: 'ticker-reused-or-multi-class', candidates: live.map((c) => c.listing.listingId) };
  // No active listing at that time — report the best-known non-active one, honestly.
  const l = cands[0].listing;
  return { status: 'resolved', listingId: l.listingId, identityConfidence: l.identityConfidence, listingStatus: cands[0].status, candidates: cands.map((c) => c.listing.listingId) };
}

function resolveSecurityAsOf({ securityId, effectiveAt, knownAt = null }, shards) {
  const when = { effectiveAt, knownAt: knownAt || effectiveAt };
  for (const l of allListings(shards)) {
    if (l.listingId !== securityId) continue;
    const alias = S.asOfInterval(l.aliases || [], when);
    return {
      status: 'resolved', listingId: l.listingId,
      symbolAt: alias ? alias.value : l.symbol,
      listingStatus: statusAt(l, when),
      identityConfidence: l.identityConfidence,
    };
  }
  return { status: 'unknown', securityId, reason: 'no-such-listing' };
}

// universeAt: full tri-partition with reasons. UNKNOWN NEVER DEFAULTS TO ACTIVE.
function universeAt({ effectiveAt, knownAt = null, filters = {} } = {}, shards) {
  const when = { effectiveAt, knownAt: knownAt || effectiveAt };
  const selected = [], rejected = [], unknown = [];
  for (const l of allListings(shards)) {
    const st = statusAt(l, when);
    if (st === 'active') {
      if (filters.exchange && l.exchange && l.exchange !== filters.exchange) {
        rejected.push({ listingId: l.listingId, symbol: l.symbol, reason: `exchange-filter:${filters.exchange}` });
      } else selected.push({ listingId: l.listingId, symbol: l.symbol, identityConfidence: l.identityConfidence });
    } else if (st === 'delisted') {
      rejected.push({ listingId: l.listingId, symbol: l.symbol, reason: 'delisted-before-effectiveAt' });
    } else {
      unknown.push({ listingId: l.listingId, symbol: l.symbol, reason: 'status-unknown-fails-closed' });
    }
  }
  return {
    version: S.PITDATA_VERSION, effectiveAt, knownAt: when.knownAt,
    counts: { selected: selected.length, rejected: rejected.length, unknown: unknown.length },
    selected, rejected, unknown,
    survivorshipSafe: false,   // stays false until reconciliation coverage gates pass
  };
}

function classificationAt({ securityId, effectiveAt, knownAt = null }, shards) {
  const when = { effectiveAt, knownAt: knownAt || effectiveAt };
  for (const l of allListings(shards)) {
    if (l.listingId !== securityId) continue;
    const iv = S.asOfInterval(l.classification || [], when);
    if (!iv) return { status: 'unknown', securityId, reason: 'no-classification-known-at-time' };
    return { status: 'resolved', securityId, sector: iv.value.sector || null, industry: iv.value.industry || null, knownAt: iv.knownAt, provenance: iv.provenance };
  }
  return { status: 'unknown', securityId, reason: 'no-such-listing' };
}

function corporateActionsBetween({ securityId, start, end, knownAt = null }, shards) {
  for (const l of allListings(shards)) {
    if (l.listingId !== securityId) continue;
    if (!l.actionsCollected) {
      // API capability failure / never-collected is NOT the same as "no actions".
      return { status: 'unknown', securityId, reason: 'actions-never-collected', actions: [] };
    }
    const kq = S.normalizeKnownAt(knownAt);
    const actions = (l.actions || []).filter((a) => {
      if (kq && a.knownAt && a.knownAt > kq) return false;
      return (!start || a.exDate >= start) && (!end || a.exDate <= end);
    });
    return { status: 'resolved', securityId, actions };
  }
  return { status: 'unknown', securityId, reason: 'no-such-listing', actions: [] };
}

module.exports = {
  resolveSymbolAsOf, resolveSecurityAsOf, universeAt, classificationAt, corporateActionsBetween,
  listingsForSymbol, allListings,
};
