'use strict';
// TRADE-ALERTS INGEST SCHEMA (v2) — immutable, provenance-first normalization.
//
// The external social collector (a browser box, OUTSIDE this repo) POSTs raw posts to
// /api/tracker?op=alertsingest. This module is the trust boundary: it validates and
// normalizes each raw post into an IMMUTABLE v2 evidence record with full provenance, or
// rejects it with a reason. Nothing downstream is allowed to trust a field this module
// did not vet.
//
// CORE RULES (mission-critical):
//  • The SERVER controls collectedAt — a collector-supplied collection time is ignored.
//  • Publication timestamps are validated: impossible-future / malformed dates are flagged
//    or rejected; they never silently become "now".
//  • Account identity is a STABLE platform user id (handles change and get recycled). A post
//    with no resolvable identity contributes to raw activity but earns NO account-history
//    credit and is NEVER pooled under a shared "?" bucket.
//  • The legacy {text, account, timestamp} contract still works, through a clearly-labeled
//    adapter that assigns DEGRADED provenance quality and no identity confidence.
//
// Pure + injected clock (`collectedAt`) so normalization is deterministic and testable.

const crypto = require('crypto');

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;

const MAX_TEXT_LEN = 4000;         // hard cap on stored post text (oversized ⇒ rejected)
const MAX_PUBLISHED_SKEW_MS = 2 * 60 * 1000;   // tolerate 2 min of collector clock skew into the future
const MAX_PAST_AGE_MS = 400 * 24 * 3600 * 1000; // > ~13 months old ⇒ suspicious, flag (don't reject)

const PLATFORMS = new Set(['x', 'twitter', 'stocktwits', 'reddit', 'discord', 'telegram', 'youtube', 'unknown']);
const POST_KINDS = new Set(['original', 'reply', 'quote', 'repost', 'edited']);

// Provenance quality grades the trust we place in the record's IDENTITY + timing chain.
//   full     — v2 with a stable canonical author id + valid published timestamp
//   partial  — v2 but missing some identity/timing fields
//   degraded — legacy adapter (no stable id, no engagement/media, timing is best-effort)
const PROVENANCE = { FULL: 'full', PARTIAL: 'partial', DEGRADED: 'degraded' };

// ── Content hashing (exact-dedupe + copy detection) ──────────────────────────
// Normalizes whitespace/case and strips URLs so a repost with a tracking-param
// difference still hashes identically to the original body.
function normalizeForHash(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function contentHash(text) {
  return crypto.createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex').slice(0, 32);
}

// ── Identity ─────────────────────────────────────────────────────────────────
// Canonical account key = platform + stable author id. Handles are NOT identity (they
// change and get recycled). Returns null when no stable id is resolvable.
function canonicalAuthorId(raw) {
  const id = raw && (raw.authorId ?? raw.author_id ?? raw.userId ?? raw.user_id);
  if (id == null) return null;
  const s = String(id).trim();
  return s && s !== '?' && s.length <= 64 ? s : null;
}
function platformOf(raw) {
  const p = String((raw && raw.platform) || '').toLowerCase().trim();
  if (p === 'twitter') return 'x';
  return PLATFORMS.has(p) ? p : 'unknown';
}
// The account key used for track-record credit. null ⇒ unknown identity (no credit).
function accountKey(platform, authorId) {
  return authorId ? `${platform}:${authorId}` : null;
}

// ── Timestamp validation ─────────────────────────────────────────────────────
// Returns { iso, valid, flag } — never throws. An unparseable or impossibly-future date
// is flagged (and iso is null) rather than coerced to "now", so it can't leak lookahead.
function validatePublished(rawTs, collectedAtMs) {
  if (rawTs == null || rawTs === '') return { iso: null, valid: false, flag: 'missing_published_ts' };
  const ms = Date.parse(rawTs);
  if (Number.isNaN(ms)) return { iso: null, valid: false, flag: 'malformed_published_ts' };
  if (ms > collectedAtMs + MAX_PUBLISHED_SKEW_MS) return { iso: null, valid: false, flag: 'future_published_ts' };
  const flag = (collectedAtMs - ms) > MAX_PAST_AGE_MS ? 'stale_published_ts' : null;
  return { iso: new Date(ms).toISOString(), valid: true, flag };
}

const domainOf = url => {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
};
const uniq = arr => [...new Set(arr)];

/**
 * Normalize ONE raw v2 post into an immutable evidence record.
 * @param {object} raw           collector-supplied post
 * @param {object} ctx           { collectedAtMs, collectorId, collectorVersion }
 * @returns {{ ok:boolean, record?:object, errors?:string[], flags?:string[] }}
 */
function normalizeV2Post(raw, { collectedAtMs, collectorId = 'unknown', collectorVersion = 'unknown' } = {}) {
  const errors = [];
  const flags = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not_an_object'] };

  const text = raw.text;
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['missing_text'] };
  if (text.length > MAX_TEXT_LEN) return { ok: false, errors: ['oversized_text'] };

  const platform = platformOf(raw);
  const authorId = canonicalAuthorId(raw);
  if (!authorId) flags.push('unknown_identity');   // allowed in raw activity; no account credit

  const pub = validatePublished(raw.publishedAt ?? raw.published_at ?? raw.timestamp, collectedAtMs);
  if (pub.flag) flags.push(pub.flag);

  const kind = POST_KINDS.has(String(raw.kind || '').toLowerCase()) ? String(raw.kind).toLowerCase() : 'original';
  const refUrls = Array.isArray(raw.referencedUrls || raw.urls) ? (raw.referencedUrls || raw.urls).filter(u => typeof u === 'string').slice(0, 20) : [];
  const refDomains = uniq(refUrls.map(domainOf).filter(Boolean));

  const key = accountKey(platform, authorId);
  const provenanceQuality = authorId && pub.valid ? PROVENANCE.FULL : PROVENANCE.PARTIAL;

  const record = {
    schemaVersion: SCHEMA_VERSION,
    // ── identity (immutable) ──
    platform,
    authorId,                                   // stable platform user id (null ⇒ unknown)
    accountKey: key,                            // credit key; null ⇒ no track-record credit
    handle: raw.handle ? String(raw.handle).slice(0, 64) : null,        // may change over time
    displayName: raw.displayName ? String(raw.displayName).slice(0, 128) : null,
    identityKnown: !!authorId,
    // ── post identity ──
    postId: raw.postId != null ? String(raw.postId).slice(0, 64) : null,
    postUrl: typeof raw.postUrl === 'string' ? raw.postUrl.slice(0, 400) : null,
    text: text.slice(0, MAX_TEXT_LEN),
    contentHash: contentHash(text),
    kind,
    parentPostId: raw.parentPostId != null ? String(raw.parentPostId).slice(0, 64) : null,
    quotedPostId: raw.quotedPostId != null ? String(raw.quotedPostId).slice(0, 64) : null,
    referencedUrls: refUrls,
    referencedDomains: refDomains,
    // ── timing (SERVER controls collectedAt) ──
    publishedAt: pub.iso,
    publishedValid: pub.valid,
    collectedAt: new Date(collectedAtMs).toISOString(),
    collectorId: String(collectorId).slice(0, 64),
    collectorVersion: String(collectorVersion).slice(0, 32),
    // ── snapshots (nullable — never fabricated) ──
    media: Array.isArray(raw.media) ? raw.media.slice(0, 8).map(m => ({
      type: m && m.type ? String(m.type).slice(0, 16) : 'unknown',
      hash: m && m.hash ? String(m.hash).slice(0, 64) : null,
    })) : [],
    engagement: sanitizeEngagement(raw.engagement),
    followers: intOrNull(raw.followers),
    following: intOrNull(raw.following),
    // ── integrity flags ──
    paidPromotion: raw.paidPromotion === true,
    positionDisclosed: raw.positionDisclosed === true,
    provenanceQuality,
    collectorFlags: Array.isArray(raw.flags) ? raw.flags.map(f => String(f).slice(0, 40)).slice(0, 12) : [],
    dataQualityFlags: flags,
  };

  return { ok: true, record, flags };
}

function intOrNull(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; }
function sanitizeEngagement(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {};
  for (const k of ['likes', 'reposts', 'replies', 'quotes', 'views', 'bookmarks']) {
    const n = intOrNull(e[k]);
    if (n != null) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Legacy adapter: the historical {text, account, timestamp} contract. Produces a v2-shaped
 * record with DEGRADED provenance and no stable identity. The legacy `account` is a HANDLE,
 * not an id — so it can seed raw activity but must not be trusted as a canonical author id.
 */
function adaptLegacyPost(raw, { collectedAtMs, collectorId = 'legacy', collectorVersion = 'v1' } = {}) {
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return { ok: false, errors: ['missing_text'] };
  if (raw.text.length > MAX_TEXT_LEN) return { ok: false, errors: ['oversized_text'] };
  const handle = raw.account && raw.account !== '?' ? String(raw.account).slice(0, 64) : null;
  const pub = validatePublished(raw.timestamp, collectedAtMs);
  // A legacy handle is a WEAK, non-canonical identity: it keys a "legacy handle" pseudo-account
  // so repeated legacy posts from the same handle can still cluster, but it is explicitly NOT a
  // stable platform id and carries degraded provenance (no identity confidence).
  const legacyKey = handle ? `legacy:${handle.toLowerCase()}` : null;
  const record = {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    platform: 'unknown',
    authorId: null,
    accountKey: legacyKey,
    handle,
    displayName: null,
    identityKnown: false,               // legacy handles are NOT stable ids
    postId: null,
    postUrl: null,
    text: raw.text.slice(0, MAX_TEXT_LEN),
    contentHash: contentHash(raw.text),
    kind: 'original',
    parentPostId: null,
    quotedPostId: null,
    referencedUrls: [],
    referencedDomains: [],
    publishedAt: pub.iso,
    publishedValid: pub.valid,
    collectedAt: new Date(collectedAtMs).toISOString(),
    collectorId: String(collectorId).slice(0, 64),
    collectorVersion: String(collectorVersion).slice(0, 32),
    media: [],
    engagement: null,
    followers: null,
    following: null,
    paidPromotion: false,
    positionDisclosed: false,
    provenanceQuality: PROVENANCE.DEGRADED,
    collectorFlags: [],
    dataQualityFlags: ['legacy_adapter', ...(pub.flag ? [pub.flag] : [])],
  };
  return { ok: true, record };
}

/**
 * Detect whether an incoming payload row is a v2 post or a legacy {text, account, timestamp}.
 * A row is "v2" if it carries any v2-only identity/provenance field.
 */
function isV2Payload(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return raw.authorId != null || raw.author_id != null || raw.userId != null ||
    raw.postId != null || raw.platform != null || raw.schemaVersion != null;
}

/**
 * Normalize a heterogeneous incoming batch. Routes each row to v2 or legacy, dropping
 * (with a reason) any that fail validation. The server clock is applied uniformly.
 */
function normalizeBatch(rows, { collectedAtMs, collectorId, collectorVersion } = {}) {
  const ts = collectedAtMs || Date.now();
  const records = [];
  const rejected = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const res = isV2Payload(raw)
      ? normalizeV2Post(raw, { collectedAtMs: ts, collectorId, collectorVersion })
      : adaptLegacyPost(raw, { collectedAtMs: ts, collectorId, collectorVersion });
    if (res.ok) records.push(res.record);
    else rejected.push({ errors: res.errors, sample: raw && typeof raw.text === 'string' ? raw.text.slice(0, 60) : null });
  }
  return { records, rejected, collectedAt: new Date(ts).toISOString() };
}

module.exports = {
  SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, PROVENANCE, MAX_TEXT_LEN, MAX_PUBLISHED_SKEW_MS,
  contentHash, normalizeForHash, canonicalAuthorId, platformOf, accountKey,
  validatePublished, normalizeV2Post, adaptLegacyPost, isV2Payload, normalizeBatch,
};
