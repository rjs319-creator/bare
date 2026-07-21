'use strict';
// 📡 MARKET PULSE — schema, sanitizers, and DETERMINISTIC state derivation.
//
// The redesign turns Pulse from a flat buzz list into an ATTENTION-LIFECYCLE system.
// The LLM (Haiku gather + Fable refine) supplies raw judgment; this module derives the
// user-facing lifecycle / action / evidence STATES with PURE functions so they are
// testable and never let LLM confidence masquerade as a measurement. Nothing here calls
// the network — all I/O lives in pulse-routes / pulse-enrich / pulse-store.
//
// HONEST LABELS: `popularity` is EDITORIAL PROMINENCE (an LLM estimate of how widely a
// story is discussed), not a measured mention count. `velocity` is an INFERRED buzz
// trend, not a repeat-observation rate. The field names are kept for storage continuity;
// the UI and disclaimers label them honestly.

// ── Raw LLM enums (unchanged — existing tests depend on these) ───────────────
const SENTIMENTS = ['bullish', 'bearish', 'mixed'];
const VELOCITIES = ['exploding', 'rising', 'steady', 'cooling'];
const CROWDINGS = ['early', 'building', 'crowded', 'capitulation'];

// ── Derived, user-facing vocabularies ────────────────────────────────────────
const CATEGORIES = ['ticker', 'macro'];
const HORIZONS = ['intraday', 'days', 'weeks', 'context'];
const LIFECYCLES = ['New', 'Emerging', 'Building', 'Crowded', 'Fading'];
const ACTION_STATES = [
  'INVESTIGATE NOW', 'EMERGING — WATCH', 'CONFIRMED MOMENTUM', 'WAIT FOR ENTRY',
  'TOO EXTENDED', 'CROWDED — DO NOT CHASE', 'CONTRARIAN WATCH', 'CONTEXT ONLY',
  'UNVERIFIED', 'STALE',
];
const EVIDENCE_STATES = [
  'Verified', 'Multi-source', 'Single-source', 'Search-summary only', 'Conflicted', 'Unverified',
];
const SOURCE_TYPES = ['news', 'social', 'video', 'filing', 'research', 'blog', 'unknown'];
const CREDIBILITIES = ['primary', 'mainstream', 'social', 'unknown'];

// Concise-insight length caps (chars). The whole point is short, scannable copy —
// verbose LLM prose is truncated, never rendered in full.
const LIMITS = {
  whatChanged: 140, whyItMatters: 200, traderRead: 220, noviceTranslation: 200,
  primaryRisk: 200, invalidation: 220,
};
// Enrichment thresholds (ATR units above the 20-session mean; relative volume).
const ATR_EXTENDED = 2.5;   // a move this far above the mean is "already gone"
const ATR_STRETCHED = 1.5;  // stretched — wait for structure rather than chase
const RELVOL_CONFIRM = 1.5; // volume this far above normal = a real, confirmed move

// ── Shared sanitization primitives ───────────────────────────────────────────
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const cleanTickers = arr => (Array.isArray(arr) ? arr : [])
  .map(t => String(t).toUpperCase().replace(/[^A-Z.^-]/g, '').slice(0, 8))
  .filter(Boolean)
  .slice(0, 6);

/** Extract a bare domain from a URL for de-duplication / independence checks. Pure. */
function domainOf(url) {
  const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  if (!m) return '';
  return m[1].toLowerCase().replace(/^www\./, '');
}

/**
 * Sanitize ONE structured source. Anti-fabrication: a `url` is retained ONLY if it
 * appears in `allowedUrls` (the set of URLs the web_search tool ACTUALLY returned).
 * A URL the model invented is dropped — never rendered as if the system visited it.
 * Returns null for a source with nothing usable. Pure.
 */
function sanitizeSource(s, allowedUrls) {
  if (!s || typeof s !== 'object') return null;
  const rawUrl = clip(s.url, 400);
  const urlOk = rawUrl && (!allowedUrls || allowedUrls.has(rawUrl));
  const url = urlOk ? rawUrl : null;
  const title = clip(s.title, 200);
  if (!url && !title) return null;
  return {
    url,
    title: title || null,
    domain: url ? domainOf(url) : null,
    publishedAt: /^\d{4}-\d{2}-\d{2}/.test(String(s.publishedAt || '')) ? clip(s.publishedAt, 30) : null,
    type: oneOf(s.type, SOURCE_TYPES, 'unknown'),
    claim: s.claim ? clip(s.claim, 200) : null,
    independent: s.independent !== false,        // default independent unless told otherwise
    credibility: oneOf(s.credibility, CREDIBILITIES, url ? 'unknown' : 'unknown'),
    fabricatedUrlDropped: !!(rawUrl && !urlOk),  // transparency flag for tests/UI
  };
}

/** Sanitize + de-duplicate a raw structured-source array against the real citation set. Pure. */
function sanitizeSources(arr, allowedUrls) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(arr) ? arr : []) {
    const c = sanitizeSource(s, allowedUrls);
    if (!c) continue;
    const key = c.url || ('t:' + (c.title || '').toLowerCase());
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 8) break;
  }
  return out;
}

/** Clip the concise-insight bundle. Missing fields stay null (never invented). Pure. */
function sanitizeInsight(it) {
  const f = k => (it[k] ? clip(it[k], LIMITS[k]) : null);
  return {
    whatChanged: f('whatChanged'),
    whyItMatters: f('whyItMatters'),
    traderRead: f('traderRead'),
    noviceTranslation: f('noviceTranslation'),
    primaryRisk: f('primaryRisk'),
    invalidation: f('invalidation'),
    horizon: oneOf(it.horizon, HORIZONS, 'context'),
  };
}

/**
 * Sanitize one raw/refined item into the render shape. Pure.
 * `refined` adds the desk read (crowding/contrarian). `allowedUrls` (optional Set) gates
 * structured-source URLs so a hallucinated link never survives. Keeps ALL legacy fields
 * and defaults so existing behavior/tests are preserved; new fields are additive.
 */
function sanitizeItem(it, refined, allowedUrls) {
  const base = {
    headline: clip(it.headline, 240),
    tickers: cleanTickers(it.tickers),
    category: oneOf(it.category, CATEGORIES, (cleanTickers(it.tickers).length ? 'ticker' : 'macro')),
    idea: clip(it.idea, 600),
    whyMoves: clip(it.whyMoves || '', 400),
    sentiment: oneOf(it.sentiment, SENTIMENTS, 'mixed'),
    popularity: Math.max(1, Math.min(100, parseInt(it.popularity, 10) || 50)),
    velocity: oneOf(it.velocity, VELOCITIES, 'steady'),
    sources: clip(it.sources || '', 300),                       // legacy free-text summary
    sourceList: sanitizeSources(it.sourceList, allowedUrls),    // structured, validated
    caution: it.caution ? clip(it.caution, 300) : null,
    ...sanitizeInsight(it),
  };
  if (!refined) return base;
  return {
    ...base,
    crowding: oneOf(it.crowding, CROWDINGS, 'building'),
    contrarian: clip(it.contrarian || '', 400),
    contrarianThesis: it.contrarianThesis === true,   // explicit, testable contrarian call only
    conflicted: it.conflicted === true,
  };
}

// ── Deterministic state derivation ───────────────────────────────────────────

/** Evidence grade from the STRUCTURED sources — not from LLM confidence. Pure. */
function deriveEvidenceState({ sourceList = [], sources = '', conflicted = false } = {}) {
  if (conflicted) return 'Conflicted';
  const withUrl = (sourceList || []).filter(s => s && s.url);
  const domains = new Set(withUrl.map(s => s.domain).filter(Boolean));
  const independentDomains = new Set(withUrl.filter(s => s.independent).map(s => s.domain).filter(Boolean));
  if (independentDomains.size >= 3) return 'Verified';
  if (domains.size >= 2) return 'Multi-source';
  if (domains.size === 1) return 'Single-source';
  return sources ? 'Search-summary only' : 'Unverified';
}

/** Independent-source count (distinct domains, independent-flagged). Pure. */
function independentSourceCount(sourceList = []) {
  return new Set((sourceList || []).filter(s => s && s.url && s.independent).map(s => s.domain).filter(Boolean)).size;
}

/**
 * Lifecycle stage from crowd positioning + trend + episode age. Pure.
 * New → Emerging → Building → Crowded → Fading.
 */
function deriveLifecycle({ velocity = 'steady', crowding = 'building', ageDays = 0, sourceCount = 0 } = {}) {
  if (velocity === 'cooling' || crowding === 'capitulation') return 'Fading';
  if (crowding === 'crowded') return 'Crowded';
  if (crowding === 'building') return 'Building';
  // early / unknown crowding
  if (ageDays <= 0 && sourceCount <= 1) return 'New';
  return 'Emerging';
}

/** Does cached price/volume context CONFIRM the attention move? Pure. */
function priceConfirms(enrichment) {
  if (!enrichment) return false;
  const up = (enrichment.dayReturn || 0) > 0 || (enrichment.ret3 || 0) > 0;
  const vol = (enrichment.relVol || 0) >= RELVOL_CONFIRM;
  return up && vol;
}

/** Is the move already extended (chasing is poor R:R)? Pure. Returns 'extended'|'stretched'|null. */
function extensionState(enrichment) {
  if (!enrichment || enrichment.atrExt == null) return null;
  if (enrichment.atrExt >= ATR_EXTENDED) return 'extended';
  if (enrichment.atrExt >= ATR_STRETCHED) return 'stretched';
  return null;
}

/**
 * Research ACTION state — the single most useful label. Pure, precedence-ordered.
 * These are research states (INVESTIGATE / WATCH / WAIT / DO-NOT-CHASE), never buy/sell
 * orders. `enrichment` may be null (no cached price context) → falls back to lifecycle.
 */
function deriveActionState({ category, lifecycle, evidence, enrichment, contrarianThesis, stale } = {}) {
  if (stale) return 'STALE';
  if (category === 'macro') return 'CONTEXT ONLY';
  if (evidence === 'Unverified') return 'UNVERIFIED';
  const ext = extensionState(enrichment);
  if (ext === 'extended') return 'TOO EXTENDED';
  if (lifecycle === 'Crowded') return 'CROWDED — DO NOT CHASE';
  if (contrarianThesis) return 'CONTRARIAN WATCH';
  if (lifecycle === 'Fading') return 'CONTEXT ONLY';
  if (lifecycle === 'Building') {
    if (priceConfirms(enrichment) && !ext) return 'CONFIRMED MOMENTUM';
    if (ext === 'stretched') return 'WAIT FOR ENTRY';
    return 'EMERGING — WATCH';
  }
  // New / Emerging
  if (ext === 'stretched') return 'WAIT FOR ENTRY';
  const strongEvidence = evidence === 'Verified' || evidence === 'Multi-source';
  if (strongEvidence && !ext) return 'INVESTIGATE NOW';
  return 'EMERGING — WATCH';
}

/**
 * Attach derived states to an item, given its episode age and (optional) enrichment.
 * Returns a NEW object (immutable). This is the single place raw judgment becomes a state.
 */
function deriveStates(item, { ageDays = 0, enrichment = null, stale = false } = {}) {
  const sourceCount = independentSourceCount(item.sourceList);
  const evidence = deriveEvidenceState({ sourceList: item.sourceList, sources: item.sources, conflicted: item.conflicted });
  const lifecycle = deriveLifecycle({ velocity: item.velocity, crowding: item.crowding, ageDays, sourceCount });
  const action = deriveActionState({
    category: item.category, lifecycle, evidence, enrichment,
    contrarianThesis: item.contrarianThesis, stale,
  });
  return {
    ...item,
    evidenceState: evidence,
    lifecycleState: lifecycle,
    actionState: action,
    independentSources: sourceCount,
    enrichment: enrichment || item.enrichment || null,
  };
}

// ── Buzz ranking (legacy; used for the raw gather stage) ──────────────────────
const VEL_W = { exploding: 3, rising: 2, steady: 1, cooling: 0 };
function rankByBuzz(items, cap) {
  items.forEach(it => { it._score = it.popularity + VEL_W[it.velocity] * 8; });
  items.sort((a, b) => b._score - a._score);
  items.forEach((it, i) => { it.rank = i + 1; delete it._score; });
  return items.slice(0, cap);
}

/** STAGE 1 parse: Haiku's raw gather → sanitized, buzz-ranked list (capped). Pure. */
function parsePulse(msg, cap = 10, allowedUrls) {
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_pulse');
  const raw = (tool && tool.input && Array.isArray(tool.input.items)) ? tool.input.items : [];
  const items = raw.filter(it => it && it.headline && it.idea).map(it => sanitizeItem(it, false, allowedUrls));
  return rankByBuzz(items, cap);
}

/** STAGE 2 parse: Fable's refined list → sanitized, keeps Fable's ordering. Pure. */
function parseRefinedPulse(input, cap = 10, allowedUrls) {
  const raw = (input && Array.isArray(input.items)) ? input.items : [];
  const items = raw.filter(it => it && it.headline && it.idea).map(it => sanitizeItem(it, true, allowedUrls));
  items.forEach((it, i) => { it.rank = i + 1; });   // trust Fable's rank order
  return items.slice(0, cap);
}

module.exports = {
  SENTIMENTS, VELOCITIES, CROWDINGS, CATEGORIES, HORIZONS,
  LIFECYCLES, ACTION_STATES, EVIDENCE_STATES, SOURCE_TYPES, CREDIBILITIES,
  ATR_EXTENDED, ATR_STRETCHED, RELVOL_CONFIRM, LIMITS,
  clip, oneOf, cleanTickers, domainOf,
  sanitizeSource, sanitizeSources, sanitizeInsight, sanitizeItem,
  deriveEvidenceState, independentSourceCount, deriveLifecycle,
  priceConfirms, extensionState, deriveActionState, deriveStates,
  rankByBuzz, parsePulse, parseRefinedPulse,
};
