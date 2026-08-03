'use strict';
// RESEARCH IDENTITY LAYER (identity-v3) — listingId, not ticker, is the primary
// research identity. This module turns "N symbol cache files that share one
// listingId" into ONE canonical observation stream plus a reconstructed ticker
// alias history, so a renamed ticker (CDAY→DAY, SCHN→RDUS, MCG→SHCO,
// AMSWA→LGTY) can never emit two panel rows for the same decision date.
//
// Alias intervals are RECONSTRUCTED from observed trading spans because the
// vendor's /symbol-change history is only ~3 months deep: within a listingId
// group, the symbol whose cached series ENDS earliest is the earlier alias; its
// last observed bar approximates the rename date. Intervals are half-open
// [effectiveFrom, effectiveTo) and labeled provenance
// 'reconstructed-from-observed-spans' — never presented as vendor fact.
//
// Groups whose members' overlapping bars DISAGREE (not the same underlying
// series) or whose members both trade to the present (two live listings sharing
// one id — a share-class or CUSIP collision in the master) are QUARANTINED:
// they are excluded from the panel and reported, never silently merged.
//
// Pure module: caller supplies secmaster records and per-symbol observed spans.

const IDENTITY_V3_VERSION = 'identity-v3';
const OVERLAP_TOLERANCE = 0.005;        // relative close disagreement that voids a merge
const MIN_OVERLAP_BARS = 5;             // fewer shared bars than this → cannot verify
const LIVE_TAIL_DAYS = 21;              // two members within this many days of the group max → both "live"

const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

// seriesConsistent(a, b) — a, b: [{ms, close}] ascending. Verifies the shared
// dates carry the same closes (same underlying listing, vendor-backfilled under
// both symbols). Returns { comparable, consistent, overlapBars, maxRelDiff }.
function seriesConsistent(a, b) {
  const bm = new Map((b || []).map((r) => [r.ms, r.close]));
  let overlap = 0, maxRelDiff = 0;
  for (const r of a || []) {
    const other = bm.get(r.ms);
    if (other === undefined) continue;
    overlap++;
    const rel = Math.abs(other - r.close) / Math.max(Math.abs(r.close), 1e-9);
    if (rel > maxRelDiff) maxRelDiff = rel;
  }
  if (overlap < MIN_OVERLAP_BARS) return { comparable: false, consistent: false, overlapBars: overlap, maxRelDiff: null };
  return { comparable: true, consistent: maxRelDiff <= OVERLAP_TOLERANCE, overlapBars: overlap, maxRelDiff: +maxRelDiff.toFixed(6) };
}

// buildIdentityGroups({ members }) — members: [{ symbol, listingId, firstBar,
// lastBar, bars, record }] all sharing ONE listingId, with observed span data.
// Optional `overlapCheck(symA, symB)` returns a seriesConsistent() result.
// Returns { group } or { quarantine } — never both.
function resolveGroup(listingId, members, overlapCheck = null) {
  const withSpan = members.filter((m) => m.firstBar && m.lastBar && m.bars > 0);
  if (!withSpan.length) {
    return { quarantine: { listingId, reason: 'no-observed-bars', symbols: members.map((m) => m.symbol) } };
  }
  if (withSpan.length === 1) {
    const m = withSpan[0];
    return {
      group: {
        listingId,
        canonicalSource: m.symbol,
        aliases: [{ symbol: m.symbol, effectiveFrom: m.firstBar, effectiveTo: null, provenance: 'single-symbol' }],
        members: withSpan.map((x) => x.symbol),
      },
    };
  }

  // Multi-symbol group: order by observed end (earliest-ending = earliest alias).
  const ordered = [...withSpan].sort((a, b) => (a.lastBar < b.lastBar ? -1 : a.lastBar > b.lastBar ? 1 : a.bars - b.bars));
  const maxLast = ordered[ordered.length - 1].lastBar;

  // Two (or more) members still trading at the group's data edge — not a
  // rename chain. Share classes / recycled CUSIP must not merge.
  const liveMembers = ordered.filter((m) => Date.parse(maxLast) - Date.parse(m.lastBar) <= LIVE_TAIL_DAYS * DAY);
  if (liveMembers.length > 1) {
    return { quarantine: { listingId, reason: 'multiple-live-members-share-listingId', symbols: ordered.map((m) => m.symbol) } };
  }

  // The successor (latest-ending) series must be a consistent superset of every
  // earlier alias on their overlapping dates. Any disagreement voids the merge.
  const successor = ordered[ordered.length - 1];
  if (overlapCheck) {
    for (const m of ordered.slice(0, -1)) {
      const cmp = overlapCheck(m.symbol, successor.symbol);
      if (!cmp.comparable) {
        return { quarantine: { listingId, reason: `overlap-unverifiable:${m.symbol}~${successor.symbol}`, symbols: ordered.map((x) => x.symbol) } };
      }
      if (!cmp.consistent) {
        return { quarantine: { listingId, reason: `overlap-disagrees:${m.symbol}~${successor.symbol}:maxRelDiff=${cmp.maxRelDiff}`, symbols: ordered.map((x) => x.symbol) } };
      }
    }
  }

  // Reconstruct alias intervals: alias k runs [prev end + 1, its lastBar + 1);
  // the successor's interval is open-ended.
  const aliases = [];
  for (let k = 0; k < ordered.length; k++) {
    const m = ordered[k];
    const from = k === 0 ? m.firstBar : addDays(ordered[k - 1].lastBar, 1);
    const to = k === ordered.length - 1 ? null : addDays(m.lastBar, 1);
    aliases.push({ symbol: m.symbol, effectiveFrom: from, effectiveTo: to, provenance: 'reconstructed-from-observed-spans' });
  }
  return {
    group: { listingId, canonicalSource: successor.symbol, aliases, members: ordered.map((m) => m.symbol) },
  };
}

// canonicalTickerAt(group, dateIso) → the alias active on that date (half-open
// intervals). Before the first interval → null (alias not yet effective —
// callers must treat the identity as unknown at that date, fail closed).
function canonicalTickerAt(group, dateIso) {
  if (!group || !Array.isArray(group.aliases)) return null;
  for (const a of group.aliases) {
    const fromOk = !a.effectiveFrom || dateIso >= a.effectiveFrom;
    const toOk = a.effectiveTo == null || dateIso < a.effectiveTo;
    if (fromOk && toOk) return a.symbol;
  }
  return null;
}

// buildIdentityIndex({ symbols, records, spanOf, overlapCheck }) — the panel
// builder's entry point.
//   symbols      — candidate symbols (universe)
//   records      — symbol → secmaster record (listingId or null)
//   spanOf       — symbol → { firstBar, lastBar, bars } | null
//   overlapCheck — (symA, symB) → seriesConsistent() result
// Returns:
//   groups        — listingId → resolved group (canonical source + aliases)
//   symbolToGroup — symbol → listingId (only for resolved groups)
//   noIdentity    — symbols with no listingId (excluded from panel, fail closed)
//   quarantined   — [{ listingId, reason, symbols }]
//   report        — identity-quality summary for the manifest / audit gate
function buildIdentityIndex({ symbols, records, spanOf, overlapCheck }) {
  const byLid = new Map();
  const noIdentity = [];
  for (const sym of symbols) {
    const rec = records[sym] || null;
    const lid = rec && rec.listingId;
    if (!lid) { noIdentity.push(sym); continue; }
    const span = spanOf(sym) || {};
    if (!byLid.has(lid)) byLid.set(lid, []);
    byLid.get(lid).push({ symbol: sym, listingId: lid, firstBar: span.firstBar || null, lastBar: span.lastBar || null, bars: span.bars || 0, record: rec });
  }
  const groups = new Map();
  const quarantined = [];
  let multiSymbolGroups = 0;
  for (const [lid, members] of byLid.entries()) {
    if (members.length > 1) multiSymbolGroups++;
    const res = resolveGroup(lid, members, overlapCheck);
    if (res.quarantine) quarantined.push(res.quarantine);
    else groups.set(lid, res.group);
  }
  const symbolToGroup = new Map();
  for (const [lid, g] of groups.entries()) for (const s of g.members) symbolToGroup.set(s, lid);
  return {
    version: IDENTITY_V3_VERSION,
    groups, symbolToGroup, noIdentity, quarantined,
    report: {
      version: IDENTITY_V3_VERSION,
      candidateSymbols: symbols.length,
      resolvedGroups: groups.size,
      multiSymbolGroups,
      aliasChains: [...groups.values()].filter((g) => g.aliases.length > 1)
        .map((g) => ({ listingId: g.listingId, chain: g.aliases.map((a) => `${a.symbol}[${a.effectiveFrom}..${a.effectiveTo || 'open'})`) })),
      noIdentitySymbols: noIdentity.length,
      quarantinedGroups: quarantined.length,
      quarantineReasons: quarantined.map((q) => ({ listingId: q.listingId, reason: q.reason, symbols: q.symbols })),
    },
  };
}

module.exports = {
  IDENTITY_V3_VERSION, OVERLAP_TOLERANCE, MIN_OVERLAP_BARS, LIVE_TAIL_DAYS,
  seriesConsistent, resolveGroup, canonicalTickerAt, buildIdentityIndex,
};
