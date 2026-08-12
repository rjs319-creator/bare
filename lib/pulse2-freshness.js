'use strict';
// 📡 MARKET PULSE v2 — STORY FRESHNESS: timestamp provenance, lifecycle reasons,
// horizon age gates, and recency-aware ranking.
//
// The one rule everything here serves: DISCOVERY TIME IS NOT PUBLICATION TIME.
// A six-day-old article the pipeline first sees today is six days old, not new;
// "the app just found it" may only ever be labeled as exactly that. Every source
// carries { publishedAt, updatedAt, discoveredAt, dateConfidence } and every event
// carries { eventOccurredAt, firstPublishedAt, firstSeenAt, lastSeenAt,
// lastCorroboratedAt }, so the three clocks (event, publication, discovery) can
// never masquerade as one another.
//
// Pure: no network, no store; every function takes an explicit `now`.

// ── vocabulary ──────────────────────────────────────────────────────────────
const DATE_CONFIDENCE = Object.freeze(['publisher', 'metadata', 'url', 'inferred', 'unknown']);
const CONFIDENCE_RANK = Object.freeze({ publisher: 4, metadata: 3, url: 2, inferred: 1, unknown: 0 });

const FRESHNESS_REASONS = Object.freeze([
  'NEW_PUBLICATION',      // genuinely recent publication about a recent event
  'NEW_MATERIAL_UPDATE',  // new substantive development on a known event
  'NEW_CORROBORATION',    // an additional independent lineage arrived
  'REDISCOVERED',         // OLD story first seen by this pipeline — never "fresh"
  'SYNDICATED_COPY',      // another copy of the same report — diagnostics only
  'ONGOING_EVENT',        // continuing coverage, nothing new
  'UNKNOWN',              // timestamps missing — cannot claim freshness
]);
// The only two reasons that may ever be presented as a NEW event.
const FRESH_REASONS = Object.freeze(['NEW_PUBLICATION', 'NEW_MATERIAL_UPDATE']);

// ── policy (hours unless noted) — every threshold env-overridable via PULSE2_<KEY> ──
const DEFAULT_POLICY = Object.freeze({
  DAY_MAX_EVENT_AGE_H: 24,        // Day view "current" needs the event within a day
  DAY_MAX_PUB_AGE_H: 18,          // …and a publication within 18h
  DAY_CONTEXT_MAX_AGE_D: 7,       // older than this leaves even the Day context group
  SWING_MAX_EVENT_AGE_D: 7,       // Swing window in calendar days
  FRESH_MAX_PUB_AGE_H: 6,         // "Fresh verified" needs a KNOWN publication ≤6h
  FRESH_MAX_EVENT_AGE_H: 12,      // …and an event ≤12h
  NEW_PUBLICATION_MAX_AGE_H: 24,  // first-seen older than this is REDISCOVERED, not new
  MATERIAL_UPDATE_FRESH_H: 12,    // a material update keeps an event "fresh" this long
});

/** Resolve the active policy: defaults overlaid with PULSE2_<KEY> env numbers. Pure-ish. */
function policyFromEnv(env = process.env) {
  const out = {};
  for (const k of Object.keys(DEFAULT_POLICY)) {
    const v = parseFloat(env['PULSE2_' + k]);
    out[k] = Number.isFinite(v) && v > 0 ? v : DEFAULT_POLICY[k];
  }
  return Object.freeze(out);
}

// ── date parsing ────────────────────────────────────────────────────────────
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_PLAUSIBLE_YEAR = 1995;
const MAX_PLAUSIBLE_YEAR = 2100;

/** Parse a loose date value into an ISO string (date-only stays date-only). Pure. */
function parseDateLoose(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  const s = String(v).trim();
  if (DATE_ONLY_RE.test(s)) {
    const y = +s.slice(0, 4);
    return y >= MIN_PLAUSIBLE_YEAR && y <= MAX_PLAUSIBLE_YEAR ? s : null;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return y >= MIN_PLAUSIBLE_YEAR && y <= MAX_PLAUSIBLE_YEAR ? d.toISOString() : null;
}

const RELATIVE_AGE_RE = /^(\d+)\s*(minute|min|hour|hr|day|week|month)s?\s+ago$/i;
const RELATIVE_UNIT_MS = Object.freeze({
  minute: 60000, min: 60000, hour: 3600000, hr: 3600000,
  day: 86400000, week: 604800000, month: 2592000000,
});

/**
 * Parse a provider "page age" (absolute date OR "3 hours ago" relative form) into
 * an ISO timestamp. Relative forms resolve against the INJECTED now — never the
 * wall clock. Pure.
 */
function parsePageAge(pageAge, nowISO) {
  if (pageAge == null || pageAge === '') return null;
  const rel = String(pageAge).trim().match(RELATIVE_AGE_RE);
  if (rel) {
    const nowMs = Date.parse(nowISO || '');
    if (!Number.isFinite(nowMs)) return null;
    return new Date(nowMs - (+rel[1]) * RELATIVE_UNIT_MS[rel[2].toLowerCase()]).toISOString();
  }
  return parseDateLoose(pageAge);
}

// ── HTML date extraction (JSON-LD → article/OG metadata → <time datetime>) ──
const JSONLD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const META_PUBLISHED_NAMES = Object.freeze([
  'article:published_time', 'og:published_time', 'article:published',
  'date', 'pubdate', 'publishdate', 'publish-date', 'parsely-pub-date',
  'sailthru.date', 'dc.date', 'dc.date.issued', 'datepublished',
]);
const META_MODIFIED_NAMES = Object.freeze([
  'article:modified_time', 'og:updated_time', 'article:modified',
  'lastmod', 'last-modified', 'datemodified',
]);
const TIME_DATETIME_RE = /<time[^>]*\bdatetime\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** Walk one parsed JSON-LD value collecting datePublished/dateModified. Pure. */
function walkJsonLd(node, acc, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { for (const n of node) walkJsonLd(n, acc, depth + 1); return; }
  if (typeof node !== 'object') return;
  const pub = parseDateLoose(node.datePublished);
  const mod = parseDateLoose(node.dateModified);
  if (pub) acc.published.push(pub);
  if (mod) acc.modified.push(mod);
  if (node['@graph']) walkJsonLd(node['@graph'], acc, depth + 1);
  if (node.mainEntity) walkJsonLd(node.mainEntity, acc, depth + 1);
}

/** Pull dated <meta> values matching a name/property list from raw HTML. Pure. */
function metaDates(html, names) {
  const out = [];
  const re = /<meta[^>]*(?:property|name|itemprop)\s*=\s*["']([^"']+)["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const re2 = /<meta[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*(?:property|name|itemprop)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (names.includes(m[1].toLowerCase())) { const d = parseDateLoose(m[2]); if (d) out.push(d); }
  }
  while ((m = re2.exec(html))) {
    if (names.includes(m[2].toLowerCase())) { const d = parseDateLoose(m[1]); if (d) out.push(d); }
  }
  return out;
}

const earliest = arr => (arr.length ? arr.slice().sort()[0] : null);
const latest = arr => (arr.length ? arr.slice().sort()[arr.length - 1] : null);

/**
 * Extract publication/update times from an article's HTML, in confidence order:
 * JSON-LD (`publisher`) → article/OG meta and <time datetime> (`metadata`).
 * Returns { publishedAt, updatedAt, dateConfidence } (nulls when absent). Pure.
 */
function extractDatesFromHtml(html) {
  if (!html || typeof html !== 'string') return { publishedAt: null, updatedAt: null, dateConfidence: 'unknown' };
  const acc = { published: [], modified: [] };
  let m;
  JSONLD_RE.lastIndex = 0;
  while ((m = JSONLD_RE.exec(html))) {
    try { walkJsonLd(JSON.parse(m[1]), acc); } catch { /* malformed block — skip */ }
  }
  if (acc.published.length || acc.modified.length) {
    return { publishedAt: earliest(acc.published), updatedAt: latest(acc.modified), dateConfidence: acc.published.length ? 'publisher' : 'metadata' };
  }
  const metaPub = metaDates(html, META_PUBLISHED_NAMES);
  const metaMod = metaDates(html, META_MODIFIED_NAMES);
  const times = [];
  TIME_DATETIME_RE.lastIndex = 0;
  while ((m = TIME_DATETIME_RE.exec(html))) { const d = parseDateLoose(m[1]); if (d) times.push(d); }
  const pub = earliest(metaPub) || earliest(times);
  if (pub || metaMod.length) return { publishedAt: pub, updatedAt: latest(metaMod), dateConfidence: 'metadata' };
  return { publishedAt: null, updatedAt: null, dateConfidence: 'unknown' };
}

// ── URL handling ────────────────────────────────────────────────────────────
const URL_DATE_RE = /\/((?:19|20)\d{2})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/;
const URL_DATE_DASH_RE = /(?:^|[/_-])((?:19|20)\d{2})-(\d{2})-(\d{2})(?:[/_.-]|$)/;

/** Date encoded in a URL path (a LOWER-confidence fallback). Pure. */
function dateFromUrl(url) {
  let path = '';
  try { path = new URL(String(url)).pathname; } catch { return null; }
  const m = path.match(URL_DATE_RE) || path.match(URL_DATE_DASH_RE);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < MIN_PLAUSIBLE_YEAR || y > MAX_PLAUSIBLE_YEAR || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const TRACKING_PARAM_PREFIX_RE = /^(utm_|mc_|hsa_|pk_|guce_)/i;
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'ref', 'ref_src', 'referrer',
  'cmpid', 'smid', 'ncid', 'sref', 'partner', 'yptr', 'guccounter', 'soc_src',
  'soc_trk', '_hsenc', '_hsmi', 'ito', 'taid', 'tpcc', 'srnd', 'cndid', 'ocid',
]);

/**
 * Canonicalize a URL for identity/dedup: lowercase scheme+host, drop www., strip
 * the fragment and tracking parameters, sort surviving parameters, trim trailing
 * slashes. Display URLs are untouched — this is a MATCHING key. Pure.
 */
function canonicalizeUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return String(url || '').trim(); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM_PREFIX_RE.test(k) && !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const q = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${u.protocol.toLowerCase()}//${host}${path}${q}`;
}

// ── wrong-year + evergreen source screens ───────────────────────────────────
const EXPLICIT_YEAR_RE = /\b((?:19|20)\d{2})\b/g;

/** Explicit 4-digit years stated in a title or URL path. Pure. */
function explicitYears({ title, url } = {}) {
  const years = new Set();
  const scan = s => {
    let m; EXPLICIT_YEAR_RE.lastIndex = 0;
    while ((m = EXPLICIT_YEAR_RE.exec(String(s || '')))) {
      const y = +m[1];
      if (y >= MIN_PLAUSIBLE_YEAR && y <= MAX_PLAUSIBLE_YEAR) years.add(y);
    }
  };
  scan(title);
  try { scan(decodeURIComponent(new URL(String(url)).pathname).replace(/[/_-]/g, ' ')); } catch { /* no URL */ }
  return [...years].sort();
}

const WINDOW_LOOKBACK_DAYS = 7;

/**
 * True when a source EXPLICITLY dates itself outside the requested news window
 * (an article that says 2025 cannot support a fresh 2026 narrative). The window
 * allows the as-of year and the year of (as-of − 7d) so year boundaries don't
 * false-positive. Pure.
 */
function yearOutsideWindow(src, { asOfDate } = {}) {
  const asOfMs = Date.parse(String(asOfDate || '').slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(asOfMs)) return false;
  const allowed = new Set([
    new Date(asOfMs).getUTCFullYear(),
    new Date(asOfMs - WINDOW_LOOKBACK_DAYS * 86400000).getUTCFullYear(),
  ]);
  const stated = explicitYears(src);
  if (stated.length && stated.every(y => !allowed.has(y))) return true;
  const pubYear = src && src.publishedAt ? +String(src.publishedAt).slice(0, 4) : null;
  return pubYear != null && !allowed.has(pubYear);
}

const EVERGREEN_PATH_RE = /\/(earnings-calendar|economic-calendar|ipo-calendar|calendar|dividends?|quote|quotes|symbols?|ticker|topics?|tags?|category|categories|sitemap|markets?)(\/|$)/i;

/**
 * Evergreen landing / undated calendar-index pages are REFERENCE material, not
 * fresh-news evidence: no publication date AND an index-like path (or a bare
 * near-root page). Pure.
 */
function isEvergreenReference(src) {
  if (!src || src.publishedAt) return false;
  let path = null;
  try { path = new URL(String(src.url)).pathname; } catch { return false; }
  if (EVERGREEN_PATH_RE.test(path)) return true;
  const depth = path.split('/').filter(Boolean).length;
  return depth <= 1 && !dateFromUrl(src.url);
}

/**
 * Screen one source against the news window: returns null (usable) or the
 * downgrade reason ('year-mismatch' | 'evergreen'). Reference sources may still
 * be shown, but never count as fresh-news evidence lineage. Pure.
 */
function referenceReasonOf(src, { asOfDate } = {}) {
  if (yearOutsideWindow(src, { asOfDate })) return 'year-mismatch';
  if (isEvergreenReference(src)) return 'evergreen';
  return null;
}

// ── source timestamp normalization ──────────────────────────────────────────
/**
 * Normalize one source's timestamps in the mandated priority order:
 *   1-3. HTML (JSON-LD `publisher` → OG/article meta + <time> `metadata`)
 *   4.   provider/API timestamp (`metadata`)
 *   5.   date in the canonical URL (`url`)
 *   6.   null + `unknown`
 * discoveredAt is ALWAYS the pipeline's own clock and is never a fallback for
 * publishedAt. Pure.
 */
function normalizeSourceTimestamps({ url, html, providerPublishedAt, discoveredAt, now } = {}) {
  const nowISO = now || discoveredAt || null;
  const base = { publishedAt: null, updatedAt: null, discoveredAt: discoveredAt || nowISO, dateConfidence: 'unknown' };
  const fromHtml = extractDatesFromHtml(html);
  if (fromHtml.publishedAt) return { ...base, ...fromHtml };
  const provider = parsePageAge(providerPublishedAt, nowISO);
  if (provider) return { ...base, publishedAt: provider, updatedAt: fromHtml.updatedAt, dateConfidence: 'metadata' };
  const fromUrl = dateFromUrl(url);
  if (fromUrl) return { ...base, publishedAt: fromUrl, updatedAt: fromHtml.updatedAt, dateConfidence: 'url' };
  return { ...base, updatedAt: fromHtml.updatedAt };
}

// ── ages ────────────────────────────────────────────────────────────────────
const MS_PER_HOUR = 3600000;

/** ISO → epoch ms. Date-only values anchor at 00:00:00Z (documented policy). Pure. */
function toMs(iso) {
  if (!iso) return null;
  const s = String(iso);
  const ms = Date.parse(DATE_ONLY_RE.test(s) ? s + 'T00:00:00Z' : s);
  return Number.isFinite(ms) ? ms : null;
}

/** Age in (float) hours of an ISO timestamp at `now`; null when unknown. Pure. */
function ageHours(iso, now) {
  const t = toMs(iso);
  const n = toMs(now instanceof Date ? now.toISOString() : now);
  if (t == null || n == null) return null;
  return Math.max(0, (n - t) / MS_PER_HOUR);
}

/** The three ages of an event record (tolerates legacy records). Pure. */
function eventAges(ev, now) {
  const e = ev || {};
  const occurred = e.eventOccurredAt || e.eventDate;
  const publicationAgeHours = ageHours(e.firstPublishedAt, now);
  let eventAgeHours = ageHours(occurred, now);
  // A date-only event date anchors at 00:00Z, over-aging a same-day event by up to
  // a day. When the first publication falls on that same date, the publication
  // clock is the better estimate of when the development actually hit the tape.
  if (eventAgeHours != null && publicationAgeHours != null
      && DATE_ONLY_RE.test(String(occurred))
      && String(e.firstPublishedAt).slice(0, 10) === String(occurred)) {
    eventAgeHours = publicationAgeHours;
  }
  return { eventAgeHours, publicationAgeHours, discoveredAgeHours: ageHours(e.firstSeenAt || e.firstSeen, now) };
}

const LOW_CONFIDENCE = new Set(['inferred', 'unknown']);
const hasKnownTimestamps = ev =>
  !!((ev && (ev.eventOccurredAt || ev.eventDate)) || (ev && ev.firstPublishedAt))
  && !LOW_CONFIDENCE.has((ev && ev.dateConfidence) || 'unknown');

// ── lifecycle reason ────────────────────────────────────────────────────────
/**
 * Classify WHY an event reads as new/active right now. Recent discovery alone
 * NEVER yields a fresh reason — an old story first seen today is REDISCOVERED.
 * Pure.
 */
function classifyFreshnessReason(ev, now, policy = DEFAULT_POLICY) {
  if (!ev) return 'UNKNOWN';
  const matAge = ageHours(ev.lastMaterialUpdateAt, now);
  if (matAge != null && matAge <= policy.MATERIAL_UPDATE_FRESH_H) return 'NEW_MATERIAL_UPDATE';
  const { eventAgeHours: ea, publicationAgeHours: pa } = eventAges(ev, now);
  if ((ev.observationCount || 0) <= 1) {
    if (ea == null && pa == null) return 'UNKNOWN';
    const oldest = Math.max(ea ?? 0, pa ?? 0);
    if (oldest > policy.NEW_PUBLICATION_MAX_AGE_H) return 'REDISCOVERED';
    return 'NEW_PUBLICATION';
  }
  if (ev.newLineageLastObs) return 'NEW_CORROBORATION';
  if (ev.syndicatedLastObs) return 'SYNDICATED_COPY';
  return 'ONGOING_EVENT';
}

// ── horizon gates ───────────────────────────────────────────────────────────
/**
 * "Fresh verified" admission: only NEW_PUBLICATION / NEW_MATERIAL_UPDATE, with a
 * KNOWN publication ≤ FRESH_MAX_PUB_AGE_H and event ≤ FRESH_MAX_EVENT_AGE_H.
 * Unknown or low-confidence timestamps can never enter. Pure.
 */
function freshVerifiedGate(ev, now, policy = DEFAULT_POLICY) {
  const reason = classifyFreshnessReason(ev, now, policy);
  if (!FRESH_REASONS.includes(reason)) return { pass: false, reason, why: `lifecycle is ${reason}, not a new publication or material update` };
  if (LOW_CONFIDENCE.has((ev && ev.dateConfidence) || 'unknown')) return { pass: false, reason, why: 'publication time unknown or low-confidence' };
  const { eventAgeHours: ea, publicationAgeHours: pa } = eventAges(ev, now);
  const matAge = ageHours(ev && ev.lastMaterialUpdateAt, now);
  const effPa = reason === 'NEW_MATERIAL_UPDATE' && matAge != null ? Math.min(matAge, pa ?? matAge) : pa;
  const effEa = reason === 'NEW_MATERIAL_UPDATE' && matAge != null ? Math.min(matAge, ea ?? matAge) : ea;
  if (effPa == null) return { pass: false, reason, why: 'no known publication time' };
  if (effPa > policy.FRESH_MAX_PUB_AGE_H) return { pass: false, reason, why: `publication is ${effPa.toFixed(1)}h old (limit ${policy.FRESH_MAX_PUB_AGE_H}h)` };
  if (effEa != null && effEa > policy.FRESH_MAX_EVENT_AGE_H) return { pass: false, reason, why: `event is ${effEa.toFixed(1)}h old (limit ${policy.FRESH_MAX_EVENT_AGE_H}h)` };
  return { pass: true, reason, why: null };
}

/**
 * Day-horizon gate → { group, why }:
 *   'current'  event ≤24h AND publication ≤18h (or a material update inside the
 *              day window — the only way an old event becomes current again);
 *   'context'  undated/low-confidence items and 1-7 day-old events, rendered in
 *              a clearly separated "Earlier / undated context" group;
 *   'excluded' older than the context window.
 * Pure.
 */
function dayGate(ev, now, policy = DEFAULT_POLICY) {
  const reason = classifyFreshnessReason(ev, now, policy);
  const matAge = ageHours(ev && ev.lastMaterialUpdateAt, now);
  if (reason === 'NEW_MATERIAL_UPDATE' && matAge != null && matAge <= policy.DAY_MAX_PUB_AGE_H) {
    return { group: 'current', reason, why: 'material update inside the day window' };
  }
  const { eventAgeHours: ea, publicationAgeHours: pa } = eventAges(ev, now);
  if (!hasKnownTimestamps(ev) || (ea == null && pa == null)) {
    return { group: 'context', reason, why: 'timestamps missing or low-confidence — shown as undated context only' };
  }
  const effEa = ea ?? pa;
  if (effEa <= policy.DAY_MAX_EVENT_AGE_H && pa != null && pa <= policy.DAY_MAX_PUB_AGE_H) {
    return { group: 'current', reason, why: null };
  }
  if (effEa <= policy.DAY_MAX_EVENT_AGE_H) {
    return { group: 'context', reason, why: 'event is recent but its publication time is older or unknown' };
  }
  if (effEa <= policy.DAY_CONTEXT_MAX_AGE_D * 24) {
    return { group: 'context', reason, why: `event is ${(effEa / 24).toFixed(1)}d old — multi-day context, not a day-trade story` };
  }
  return { group: 'excluded', reason, why: `event is ${(effEa / 24).toFixed(1)}d old — outside the day view entirely` };
}

/** Swing-horizon gate: events within SWING_MAX_EVENT_AGE_D (or materially updated
 *  within it) are current; undated items are context; older are excluded. Pure. */
function swingGate(ev, now, policy = DEFAULT_POLICY) {
  const reason = classifyFreshnessReason(ev, now, policy);
  const limitH = policy.SWING_MAX_EVENT_AGE_D * 24;
  const matAge = ageHours(ev && ev.lastMaterialUpdateAt, now);
  if (reason === 'NEW_MATERIAL_UPDATE' && matAge != null && matAge <= limitH) {
    return { group: 'current', reason, why: 'material update inside the swing window' };
  }
  const { eventAgeHours: ea, publicationAgeHours: pa } = eventAges(ev, now);
  const effEa = ea ?? pa;
  if (effEa == null) return { group: 'context', reason, why: 'timestamps missing — context only' };
  if (effEa <= limitH) return { group: 'current', reason, why: null };
  return { group: 'excluded', reason, why: `event is ${(effEa / 24).toFixed(1)}d old (swing window ${policy.SWING_MAX_EVENT_AGE_D}d)` };
}

/** Investor-horizon gate: no hard cutoff — everything is current, but its age is
 *  always exposed for display. Pure. */
function investorGate(ev, now, policy = DEFAULT_POLICY) {
  const reason = classifyFreshnessReason(ev, now, policy);
  const { eventAgeHours: ea, publicationAgeHours: pa } = eventAges(ev, now);
  const effEa = ea ?? pa;
  return { group: 'current', reason, why: effEa == null ? 'age unknown — dates missing' : null };
}

const GATES = Object.freeze({ day: dayGate, swing: swingGate, investor: investorGate });

// ── recency-aware ranking ───────────────────────────────────────────────────
const TRADE_STATE_SCORE = Object.freeze({
  PRICE_CONFIRMED: 50, ARMED: 42, WATCH: 34, INVESTIGATE: 26,
  CONTEXT_ONLY: 18, DATA_STALE: 14, CONTRADICTED: 8, INVALIDATED: 4, EXPIRED: 0,
});
const EVIDENCE_SCORE = Object.freeze({
  VERIFIED: 8, SUPPORTED: 6, SINGLE_SOURCE: 3, STALE: 1, CONFLICTED: 0, UNVERIFIED: 1,
});
const HORIZON_DECAY_HOURS = Object.freeze({ day: 12, swing: 72, investor: 336 });
const HORIZON_EVENT_WINDOW_H = Object.freeze({ day: 24, swing: 168, investor: 720 });
const HORIZON_PUB_WINDOW_H = Object.freeze({ day: 18, swing: 168, investor: 720 });
const FRESHNESS_WEIGHT = 10;
const MATERIAL_UPDATE_BONUS = 4;
const LINEAGE_SCORE_CAP = 4;
const PRICE_CONFIRMATION_SCORE = 5;
const EVENT_AGE_PENALTY_MAX = 8;
const PUB_AGE_PENALTY_MAX = 4;
const DUPLICATE_PENALTY = 4;
const UNKNOWN_TIMESTAMP_PENALTY = 5;
const CONFIRMING_REACTIONS = new Set(['REACTING_AS_EXPECTED', 'PRICE_CONFIRMED']);

/**
 * Recency-aware rank score. Trade state stays dominant BETWEEN states; within a
 * state, exponential freshness decay + age penalties decide, so a 3-hour-old
 * story always outranks an otherwise-equal 3-day-old one. Pure.
 */
function rankScore({ tradeState, evidence, reaction, freshness = {}, duplicate = false, lineages = 0 } = {}, horizon = 'day') {
  const decay = HORIZON_DECAY_HOURS[horizon] || HORIZON_DECAY_HOURS.day;
  const evWindow = HORIZON_EVENT_WINDOW_H[horizon] || HORIZON_EVENT_WINDOW_H.day;
  const pubWindow = HORIZON_PUB_WINDOW_H[horizon] || HORIZON_PUB_WINDOW_H.day;
  const ea = freshness.eventAgeHours;
  const pa = freshness.publicationAgeHours;
  const age = ea ?? pa;
  const freshnessScore = age == null ? 0 : FRESHNESS_WEIGHT * Math.exp(-age / decay);
  const materialityScore = Math.min(LINEAGE_SCORE_CAP, lineages || 0)
    + (freshness.reason === 'NEW_MATERIAL_UPDATE' ? MATERIAL_UPDATE_BONUS : 0);
  const eventAgePenalty = ea == null ? 0 : Math.min(EVENT_AGE_PENALTY_MAX, EVENT_AGE_PENALTY_MAX * ea / evWindow);
  const pubAgePenalty = pa == null ? 0 : Math.min(PUB_AGE_PENALTY_MAX, PUB_AGE_PENALTY_MAX * pa / pubWindow);
  const unknownPenalty = age == null ? UNKNOWN_TIMESTAMP_PENALTY : 0;
  const dupPenalty = duplicate || freshness.reason === 'SYNDICATED_COPY' ? DUPLICATE_PENALTY : 0;
  return (TRADE_STATE_SCORE[tradeState] ?? 0)
    + materialityScore
    + (EVIDENCE_SCORE[evidence] ?? 0)
    + (CONFIRMING_REACTIONS.has(reaction) ? PRICE_CONFIRMATION_SCORE : 0)
    + freshnessScore
    - eventAgePenalty
    - pubAgePenalty
    - dupPenalty
    - unknownPenalty;
}

const descIso = (a, b) => {
  if (a === b) return 0;
  if (a == null) return 1;              // unknown timestamps sort last
  if (b == null) return -1;
  return toMs(a) > toMs(b) ? -1 : toMs(a) < toMs(b) ? 1 : 0;
};

/**
 * Deterministic comparator for ranked cards (never relies on input order):
 * rankScore desc → eventOccurredAt desc → firstPublishedAt desc →
 * lastCorroboratedAt desc → stable event id asc. Pure.
 */
function compareRanked(a, b) {
  const fa = (a && a.freshness) || {}, fb = (b && b.freshness) || {};
  const sa = fa.rankScore ?? -Infinity, sb = fb.rankScore ?? -Infinity;
  if (sa !== sb) return sb - sa;
  return descIso(fa.eventOccurredAt, fb.eventOccurredAt)
    || descIso(fa.firstPublishedAt, fb.firstPublishedAt)
    || descIso(fa.lastCorroboratedAt, fb.lastCorroboratedAt)
    || String((a && a.eventId) || '').localeCompare(String((b && b.eventId) || ''));
}

const round1 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/**
 * The freshness block a view card carries to the client: reason, group, the three
 * timestamps, ages, confidence, and the precomputed rank score. Pure.
 */
function cardFreshness(ev, now, { horizon = 'day', tradeState, reaction, duplicate = false, policy = DEFAULT_POLICY } = {}) {
  const gate = (GATES[horizon] || dayGate)(ev, now, policy);
  const { eventAgeHours: ea, publicationAgeHours: pa } = eventAges(ev, now);
  const block = {
    reason: gate.reason,
    group: gate.group,
    gateWhy: gate.why,
    eventOccurredAt: (ev && (ev.eventOccurredAt || ev.eventDate)) || null,
    firstPublishedAt: (ev && ev.firstPublishedAt) || null,
    discoveredAt: (ev && (ev.firstSeenAt || ev.firstSeen)) || null,
    lastCorroboratedAt: (ev && ev.lastCorroboratedAt) || null,
    dateConfidence: (ev && ev.dateConfidence) || 'unknown',
    eventAgeHours: round1(ea),
    publicationAgeHours: round1(pa),
  };
  block.rankScore = round1(rankScore({
    tradeState, evidence: ev && ev.evidence, reaction,
    freshness: { ...block, eventAgeHours: ea, publicationAgeHours: pa },
    duplicate, lineages: (ev && ev.independentLineages) || 0,
  }, horizon));
  return block;
}

module.exports = {
  DATE_CONFIDENCE, CONFIDENCE_RANK, FRESHNESS_REASONS, FRESH_REASONS,
  DEFAULT_POLICY, policyFromEnv,
  parseDateLoose, parsePageAge, extractDatesFromHtml, dateFromUrl,
  canonicalizeUrl, explicitYears, yearOutsideWindow, isEvergreenReference, referenceReasonOf,
  normalizeSourceTimestamps, toMs, ageHours, eventAges, hasKnownTimestamps,
  classifyFreshnessReason, freshVerifiedGate, dayGate, swingGate, investorGate,
  TRADE_STATE_SCORE, EVIDENCE_SCORE, HORIZON_DECAY_HOURS,
  rankScore, compareRanked, cardFreshness,
};
