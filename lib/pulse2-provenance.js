'use strict';
// 📡 MARKET PULSE v2 — SOURCE-TO-CLAIM PROVENANCE.
//
// v1 captured real web_search citations into a global sourcePool but never mapped them
// to individual themes, so evidence honestly (and uselessly) graded "Search-summary only".
// v2 keeps the anti-fabrication core — a URL survives ONLY if the search provider actually
// returned it — and adds:
//   • stable source IDs (model emits small `sourceUrls` arrays; we convert to IDs here);
//   • claim-level provenance: each material claim carries sourceRefs + an evidence type
//     + a derived status;
//   • source LINEAGE: syndicated copies of one report collapse into ONE evidence lineage —
//     five websites reprinting the same wire story are not five verifications.
//
// Pure: no network. Verification is derived from validated evidence, never from LLM
// confidence, popularity, prose quality, or ticker count.

const freshness = require('./pulse2-freshness');

const EVIDENCE_TYPES = Object.freeze([
  'PRIMARY',                 // filing, official release, regulator, the company itself
  'INDEPENDENT_REPORTING',   // a newsroom's own reporting
  'SOCIAL_DISCOVERY',        // social post surfaced it
  'COMMENTARY',              // opinion/analysis on known facts
  'UNVERIFIED',
]);

const CLAIM_STATUSES = Object.freeze([
  'VERIFIED',       // ≥2 independent lineages, at least one primary/independent
  'SUPPORTED',      // ≥2 lineages but not independence-clean, or 1 primary lineage
  'SINGLE_SOURCE',  // exactly one lineage
  'CONFLICTED',     // sources materially disagree
  'UNVERIFIED',     // no mapped evidence
  'STALE',          // evidence exists but predates the claim's relevance window
]);

const LINEAGE_TYPES = Object.freeze([
  'primary', 'independent-report', 'syndicated-copy', 'social-post', 'commentary', 'unknown',
]);

// Domains that publish PRIMARY material (filings/official releases).
const PRIMARY_DOMAINS = new Set([
  'sec.gov', 'federalreserve.gov', 'bls.gov', 'bea.gov', 'treasury.gov', 'fda.gov',
  'justice.gov', 'ftc.gov', 'whitehouse.gov', 'prnewswire.com', 'businesswire.com',
  'globenewswire.com',
]);
// Social platforms — discovery, not verification.
const SOCIAL_DOMAINS = new Set([
  'twitter.com', 'x.com', 'stocktwits.com', 'reddit.com', 'youtube.com', 'tiktok.com',
]);
// Known aggregators/syndicators — a wire story reprinted here is the SAME lineage.
const SYNDICATOR_DOMAINS = new Set([
  'finance.yahoo.com', 'msn.com', 'news.google.com', 'markets.businessinsider.com',
  'nasdaq.com', 'morningstar.com', 'aol.com',
]);

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

function domainOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, '') : '';
}

/** Normalize a title for syndication matching: lowercase, strip site suffixes/punct. Pure. */
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+[-|–—]\s+[^-|–—]{0,40}$/, '')   // trailing " - Site Name"
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deterministic short id from a string (djb2). Pure. */
function shortHash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Classify one source's lineage type from its domain. Pure. */
function lineageTypeOf(domain) {
  if (!domain) return 'unknown';
  if (PRIMARY_DOMAINS.has(domain)) return 'primary';
  if (SOCIAL_DOMAINS.has(domain)) return 'social-post';
  if (SYNDICATOR_DOMAINS.has(domain)) return 'syndicated-copy';
  return 'independent-report';
}

/**
 * Build the source index from REAL citations (extractCitations output shape:
 * [{url,title,domain,publishedAt}]). Assigns stable IDs (`src_<hash>` of the
 * CANONICAL url — tracking-parameter variants of one article are one source) and
 * groups syndicated copies into lineages: same canonical URL, or sources sharing
 * a normalized title, share a lineageId.
 *
 * Every source carries the timestamp-provenance block { publishedAt, updatedAt,
 * discoveredAt, dateConfidence } (see pulse2-freshness). Discovery time is never
 * used as publication time. When `asOfDate` is given, wrong-year and evergreen
 * pages are flagged `reference` — visible, but never fresh-news evidence.
 *
 * Returns { byId, byUrl, sources, lineages }. Pure.
 */
function buildSourceIndex(citations, { discoveredAt = null, now = null, asOfDate = null } = {}) {
  const sources = [];
  const byUrl = new Map();
  const byCanonical = new Map();
  const titleGroups = new Map();   // normalized title → lineageId

  for (const c of Array.isArray(citations) ? citations : []) {
    if (!c || !c.url || byUrl.has(c.url)) continue;
    const canonicalUrl = freshness.canonicalizeUrl(c.url);
    const existing = byCanonical.get(canonicalUrl);
    if (existing) { byUrl.set(c.url, existing); continue; }   // tracking-param twin
    const domain = c.domain || domainOf(c.url);
    const id = 'src_' + shortHash(canonicalUrl);
    const normTitle = normalizeTitle(c.title);
    const ts = freshness.normalizeSourceTimestamps({
      url: c.url, html: c.html, providerPublishedAt: c.publishedAt, discoveredAt, now,
    });
    const src = {
      id,
      url: clip(c.url, 400),
      canonicalUrl: clip(canonicalUrl, 400),
      title: c.title ? clip(c.title, 200) : null,
      domain,
      publishedAt: ts.publishedAt,
      updatedAt: ts.updatedAt,
      discoveredAt: ts.discoveredAt,
      dateConfidence: ts.dateConfidence,
      lineageType: lineageTypeOf(domain),
      lineageId: null,
      reference: null,
    };
    src.reference = asOfDate ? freshness.referenceReasonOf(src, { asOfDate }) : null;
    // Lineage grouping: same normalized title ⇒ same underlying report.
    if (normTitle && normTitle.split(' ').length >= 4) {
      if (!titleGroups.has(normTitle)) titleGroups.set(normTitle, 'lin_' + shortHash(normTitle));
      src.lineageId = titleGroups.get(normTitle);
      if (titleGroups.get(normTitle) !== 'lin_' + shortHash(canonicalUrl) && src.lineageType === 'independent-report') {
        // Another source already owns this title — later copies are syndication.
        const first = sources.find(s => s.lineageId === src.lineageId);
        if (first) src.lineageType = 'syndicated-copy';
      }
    } else {
      src.lineageId = 'lin_' + shortHash(canonicalUrl);
    }
    sources.push(src);
    byUrl.set(src.url, src);
    byUrl.set(canonicalUrl, src);   // canonical alias — model-emitted variants still match
    byCanonical.set(canonicalUrl, src);
  }

  const byId = new Map(sources.map(s => [s.id, s]));
  const lineages = new Map();
  for (const s of sources) {
    if (!lineages.has(s.lineageId)) lineages.set(s.lineageId, []);
    lineages.get(s.lineageId).push(s.id);
  }
  return { byId, byUrl, sources, lineages };
}

/**
 * Resolve a model-emitted URL list into validated sourceRefs (IDs). A URL that the
 * search provider did not return is DROPPED (anti-fabrication), and the drop is
 * counted for transparency. Pure.
 * @returns {{sourceRefs:string[], droppedUrls:number}}
 */
function resolveSourceRefs(urls, index) {
  const refs = [];
  let dropped = 0;
  for (const u of Array.isArray(urls) ? urls : []) {
    const raw = String(u || '').trim();
    const src = index && index.byUrl
      ? (index.byUrl.get(raw) || index.byUrl.get(freshness.canonicalizeUrl(raw)))
      : null;
    if (src) { if (!refs.includes(src.id)) refs.push(src.id); }
    else if (u) dropped++;
  }
  return { sourceRefs: refs.slice(0, 6), droppedUrls: dropped };
}

/** Count DISTINCT evidence lineages behind a set of sourceRefs (syndicated copies of
 *  one report count once; wrong-year/evergreen `reference` pages count never). Pure. */
function independentLineageCount(sourceRefs, index) {
  const lins = new Set();
  for (const id of sourceRefs || []) {
    const s = index && index.byId ? index.byId.get(id) : null;
    if (s && s.lineageType !== 'social-post' && !s.reference) lins.add(s.lineageId);
  }
  return lins.size;
}

/** Best (most authoritative) evidence type across sourceRefs. Pure. */
function bestEvidenceType(sourceRefs, index) {
  let best = 'UNVERIFIED';
  const rank = { PRIMARY: 4, INDEPENDENT_REPORTING: 3, SOCIAL_DISCOVERY: 2, COMMENTARY: 1, UNVERIFIED: 0 };
  for (const id of sourceRefs || []) {
    const s = index && index.byId ? index.byId.get(id) : null;
    if (!s) continue;
    const t = s.lineageType === 'primary' ? 'PRIMARY'
      : s.lineageType === 'independent-report' || s.lineageType === 'syndicated-copy' ? 'INDEPENDENT_REPORTING'
      : s.lineageType === 'social-post' ? 'SOCIAL_DISCOVERY' : 'COMMENTARY';
    if (rank[t] > rank[best]) best = t;
  }
  return best;
}

/**
 * Derive one claim's status from its validated evidence. Pure, deterministic:
 *   CONFLICTED   caller flagged material disagreement between sources
 *   VERIFIED     ≥2 independent lineages AND best type is PRIMARY/INDEPENDENT_REPORTING
 *   SUPPORTED    1 primary lineage, or ≥2 lineages without the independence bar
 *   SINGLE_SOURCE exactly 1 non-primary lineage
 *   UNVERIFIED   no mapped evidence
 */
function deriveClaimStatus({ sourceRefs = [], conflicted = false } = {}, index) {
  if (conflicted) return 'CONFLICTED';
  const lineages = independentLineageCount(sourceRefs, index);
  // Evidence that exists but is ONLY wrong-year/evergreen reference pages is STALE:
  // it may inform context, never a current narrative.
  if (lineages === 0 && (sourceRefs || []).some(id => {
    const s = index && index.byId ? index.byId.get(id) : null;
    return s && s.reference;
  })) return 'STALE';
  const best = bestEvidenceType(sourceRefs, index);
  if (lineages >= 2 && (best === 'PRIMARY' || best === 'INDEPENDENT_REPORTING')) return 'VERIFIED';
  if (best === 'PRIMARY' || lineages >= 2) return 'SUPPORTED';
  if (lineages === 1) return 'SINGLE_SOURCE';
  return 'UNVERIFIED';
}

/**
 * Sanitize a model-emitted claim list into validated PulseClaims. Each claim:
 * { claimId, text, sourceRefs, evidenceType, status }. Model URLs are validated
 * against the real citation index; unmatched URLs are dropped. Pure.
 */
function sanitizeClaims(rawClaims, index, { maxClaims = 5 } = {}) {
  const out = [];
  for (const rc of Array.isArray(rawClaims) ? rawClaims : []) {
    if (!rc || !rc.text) continue;
    const { sourceRefs, droppedUrls } = resolveSourceRefs(rc.sourceUrls, index);
    const conflicted = rc.conflicted === true;
    const status = deriveClaimStatus({ sourceRefs, conflicted }, index);
    out.push({
      claimId: 'clm_' + shortHash(clip(rc.text, 300)),
      text: clip(rc.text, 300),
      sourceRefs,
      evidenceType: sourceRefs.length ? bestEvidenceType(sourceRefs, index) : 'UNVERIFIED',
      status,
      droppedUrls,
    });
    if (out.length >= maxClaims) break;
  }
  return out;
}

/**
 * Item-level evidence rollup from its claims. Pure.
 * VERIFIED > SUPPORTED > SINGLE_SOURCE > UNVERIFIED, with CONFLICTED dominating.
 */
function rollupEvidence(claims) {
  const cs = Array.isArray(claims) ? claims : [];
  if (!cs.length) return 'UNVERIFIED';
  if (cs.some(c => c.status === 'CONFLICTED')) return 'CONFLICTED';
  const order = ['VERIFIED', 'SUPPORTED', 'SINGLE_SOURCE', 'STALE', 'UNVERIFIED'];
  // The MATERIAL claim standard: the item grades by its best-supported claim, but only
  // counts as VERIFIED if its FIRST (most material) claim is at least SUPPORTED.
  const best = order.find(st => cs.some(c => c.status === st)) || 'UNVERIFIED';
  if (best === 'VERIFIED' && (cs[0].status === 'UNVERIFIED' || cs[0].status === 'SINGLE_SOURCE')) return 'SUPPORTED';
  return best;
}

/**
 * Roll up the timestamp story of one item's claim sources: the EARLIEST known
 * publication among non-reference sources (with its confidence), how many
 * distinct sources support the item, and how many were reference-screened. Pure.
 */
function summarizeClaimSources(claims, index) {
  const seen = new Set();
  let publishedAt = null, dateConfidence = 'unknown', referenceCount = 0;
  for (const cl of Array.isArray(claims) ? claims : []) {
    for (const id of cl.sourceRefs || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const s = index && index.byId ? index.byId.get(id) : null;
      if (!s) continue;
      if (s.reference) { referenceCount++; continue; }
      if (s.publishedAt && (!publishedAt || freshness.toMs(s.publishedAt) < freshness.toMs(publishedAt))) {
        publishedAt = s.publishedAt;
        dateConfidence = s.dateConfidence || 'metadata';
      }
    }
  }
  return { publishedAt, dateConfidence: publishedAt ? dateConfidence : 'unknown', sourceCount: seen.size, referenceCount };
}

/** Serialize the parts of an index worth persisting (id → source card). Pure. */
function indexToJSON(index) {
  return (index && index.sources ? index.sources : []).map(s => ({ ...s }));
}
/** Rebuild an index from persisted source cards. Pure. */
function indexFromJSON(sources) {
  const byId = new Map(); const byUrl = new Map(); const lineages = new Map();
  const list = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || !s.id) continue;
    list.push(s); byId.set(s.id, s);
    if (s.url) byUrl.set(s.url, s);
    if (s.canonicalUrl) byUrl.set(s.canonicalUrl, s);
    if (s.lineageId) {
      if (!lineages.has(s.lineageId)) lineages.set(s.lineageId, []);
      lineages.get(s.lineageId).push(s.id);
    }
  }
  return { byId, byUrl, sources: list, lineages };
}

module.exports = {
  EVIDENCE_TYPES, CLAIM_STATUSES, LINEAGE_TYPES,
  PRIMARY_DOMAINS, SOCIAL_DOMAINS, SYNDICATOR_DOMAINS,
  domainOf, normalizeTitle, shortHash, lineageTypeOf,
  buildSourceIndex, resolveSourceRefs, independentLineageCount, bestEvidenceType,
  deriveClaimStatus, sanitizeClaims, rollupEvidence, summarizeClaimSources,
  indexToJSON, indexFromJSON,
};
