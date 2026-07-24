'use strict';
// 🧬 EVIDENCE CLUSTERING — dedup + event clustering (redesign stage C).
//
// THE PROBLEM this solves (the prompt's #1 acceptance criterion): a single underlying event
// — "Q3 EPS beat by $0.12" — gets written up by Reuters, CNBC, Benzinga, Yahoo, and ten
// aggregators. Counting those as ten confirmations is the oldest lie in news-driven trading.
// Clustering collapses derivative coverage under ONE primary event so consensus is measured
// over genuinely independent evidence, never headline volume.
//
// Approach (deterministic, no LLM): build a FINGERPRINT per event from the facts that make
// two write-ups "the same event" — ticker, event type, an event-date bucket, and the salient
// quantitative values — plus a normalized token set of the claim for near-duplicate detection.
// Events whose fingerprints match (or whose claims are near-identical) are merged into a
// cluster with one primary event + a tail of derivative coverage.
//
// Pure module: no I/O. Unit-testable in isolation.

// Stopwords stripped before tokenizing a claim (generic finance filler that would make
// unrelated claims look similar).
const STOP = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'its', 'it', 'as', 'at', 'by', 'with', 'from', 'that', 'this', 'has', 'have', 'be', 'will',
  'company', 'inc', 'corp', 'said', 'reports', 'reported', 'announces', 'announced', 'stock',
  'shares', 'quarter', 'year', 'after', 'amid', 'per', 'over', 'up', 'down',
]);

// Bucket a catalyst/detected date to the DAY so timestamps hours apart still cluster. Falls
// back to a stable 'nd' (no-date) bucket rather than fabricating one.
function dateBucket(ev) {
  const d = ev.catalystDate || ev.detectedAt || null;
  if (!d) return 'nd';
  const s = String(d);
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : 'nd';
}

// The salient number that distinguishes two same-type events on the same day (e.g. two
// different guidance figures). Rounded so trivially-different reprints still collide.
function magKey(ev) {
  const v = ev.surpriseMagnitude != null ? ev.surpriseMagnitude
    : ev.quantitativeMagnitude != null ? ev.quantitativeMagnitude
    : ev.newValue != null ? ev.newValue : null;
  if (v == null) return 'x';
  const abs = Math.abs(v);
  // coarse rounding — same order of magnitude & ~1-sig-fig collides
  const r = abs >= 100 ? Math.round(abs / 10) * 10 : abs >= 1 ? Math.round(abs) : +abs.toFixed(2);
  return String(r);
}

function tokenize(claim) {
  return new Set(
    String(claim || '')
      .toLowerCase()
      .replace(/[^a-z0-9%$.\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// A structural fingerprint: two events with the same fingerprint are the same underlying
// event by construction (same name, same kind, same day, same salient number).
function fingerprint(ev) {
  return [ev.ticker || '?', ev.eventType || '?', dateBucket(ev), magKey(ev)].join('|');
}

// The similarity threshold above which two same-ticker events are treated as the same event
// even if their fingerprints differ (near-duplicate claims — different phrasings of one fact).
const CLAIM_SIM_THRESHOLD = 0.6;

// Cluster a list of normalized events (see evidence-schema.normalizeEvent). Returns an array
// of clusters, each with:
//   primary            — the single best event (primary-source > highest materiality > novelty)
//   coverageCount      — total events collapsed into this cluster (incl. primary)
//   primarySourceCount — how many carried a genuine primary source
//   independentFamilies— distinct evidence families represented (usually 1 per cluster — a
//                        cluster IS one event; breadth comes from clusters, not coverage)
//   members            — every event in the cluster (primary first)
function clusterEvents(events) {
  const list = (events || []).filter(e => e && e.ticker && e.claim);
  const withTokens = list.map(e => ({ e, fp: fingerprint(e), tok: tokenize(e.claim) }));
  const clusters = [];

  for (const item of withTokens) {
    // Find an existing cluster this event belongs to: same ticker AND (same fingerprint OR
    // near-identical claim). Cross-ticker events never merge.
    let target = null;
    for (const c of clusters) {
      if (c.ticker !== item.e.ticker) continue;
      if (c.fingerprints.has(item.fp)) { target = c; break; }
      if (c.members.some(m => jaccard(m.tok, item.tok) >= CLAIM_SIM_THRESHOLD)) { target = c; break; }
    }
    if (!target) {
      target = { ticker: item.e.ticker, fingerprints: new Set(), members: [] };
      clusters.push(target);
    }
    target.fingerprints.add(item.fp);
    target.members.push(item);
  }

  return clusters.map(c => summarizeCluster(c.members.map(m => m.e)));
}

// Rank a cluster's members and expose the collapse. `primary` = the most authoritative
// write-up (real primary source wins; then materiality, then novelty, then extraction
// confidence). Derivative coverage is COUNTED but never re-weighted as new evidence.
function summarizeCluster(members) {
  const ranked = members.slice().sort((a, b) => {
    const pa = a.primarySourceCount > 0 ? 1 : 0, pb = b.primarySourceCount > 0 ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if ((b.materialityScore || 0) !== (a.materialityScore || 0)) return (b.materialityScore || 0) - (a.materialityScore || 0);
    if ((b.noveltyScore || 0) !== (a.noveltyScore || 0)) return (b.noveltyScore || 0) - (a.noveltyScore || 0);
    return (b.extractionConfidence || 0) - (a.extractionConfidence || 0);
  });
  const primary = ranked[0];
  const primarySourceCount = members.reduce((s, m) => s + (m.primarySourceCount || 0), 0);
  const families = [...new Set(members.map(m => m.family).filter(Boolean))];
  return {
    ticker: primary.ticker,
    fingerprint: fingerprint(primary),
    primary,
    coverageCount: members.length,           // total write-ups collapsed here
    derivativeCount: members.length - 1,      // reprints that add NO independent evidence
    primarySourceCount,
    hasPrimarySource: primarySourceCount > 0,
    independentFamilies: families,
    members: ranked,
  };
}

module.exports = {
  fingerprint, dateBucket, magKey, tokenize, jaccard,
  clusterEvents, summarizeCluster, CLAIM_SIM_THRESHOLD, STOP,
};
