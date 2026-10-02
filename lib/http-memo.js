'use strict';
// FETCH MEMOIZATION — two layers in front of lib/http fetchWithTimeout.
//
// THE PAIN. Every chain in the 22:00 UTC burst self-fetches the daily candles it needs,
// so one ticker's Yahoo chart is pulled dozens of times a night, and the 2026-08 audit
// measured op=swingsearchgrade alone at ~2,800 fetches for ~149 DISTINCT names before a
// per-run memo was bolted on inside that one route. This module is the SHARED version
// of that memo, so every caller gets it by composing with fetchWithTimeout instead of
// each route growing its own.
//
//   L1 — in-process: in-flight dedupe (N concurrent callers of one key share ONE
//        promise) + a TTL cache bounded by entry count AND bytes with LRU eviction.
//        Lives as long as the serverless instance (Fluid compute keeps one warm across
//        the whole nightly burst, which is exactly when the fan-out happens).
//   L2 — Vercel Runtime Cache (`getCache()` from @vercel/functions): per-region KV with
//        TTL + tags, shared ACROSS invocations. Opt-in via HTTP_MEMO_L2=1 because it is
//        metered; outside Vercel the SDK falls back to its own in-memory map. Every L2
//        call is wrapped so a missing / failed cache can never break a fetch.
//
// HONESTY RULES (the cache must never launder a vendor failure into "data"):
//   • only `ok` responses are stored — a 429/5xx/404 is returned, never remembered;
//   • empty vendor shapes (`[]`, `{}`, null) and unparseable bodies are never stored;
//   • callers may pass `shouldCache(body)` for vendor-specific staleness checks (the
//     Yahoo chart path refuses a series that does not reach the due session);
//   • cached bodies are stored as TEXT and re-parsed per hit — a caller mutating its
//     copy can never poison the next caller's.
//   • secret query params (apikey/token/crumb) are stripped from every key so they
//     never reach L2 metadata or a log line.
//
// Operational switches: HTTP_MEMO=off bypasses both layers; HTTP_MEMO_L2=1 enables L2.
const { fetchWithTimeout } = require('./http');
const { logWarn } = require('./log');

const L1_MAX_ENTRIES = 1500;                       // ~3 scopes × 515 names of daily candles
const L1_MAX_BYTES = 64 * 1024 * 1024;             // well under the smallest function's memory
const MAX_ITEM_BYTES = 2 * 1024 * 1024;            // Runtime Cache item cap; L1 honours the same
const MS_PER_SEC = 1000;
const L2_FLAG_ENV = 'HTTP_MEMO_L2';
const KILL_SWITCH_ENV = 'HTTP_MEMO';
const L2_NAMESPACE = 'http-memo';
const SECRET_PARAMS = Object.freeze(['apikey', 'api_key', 'apiKey', 'token', 'crumb']);

const isMemoDisabled = () => String(process.env[KILL_SWITCH_ENV] || '').toLowerCase() === 'off';
const isL2Enabled = () => process.env[L2_FLAG_ENV] === '1';

// The cache key for a URL with every secret query param removed. Non-URL strings
// (callers may pass a pre-built key) pass through unchanged.
function redactedKey(url) {
  let u;
  try { u = new URL(url); } catch { return String(url); }
  for (const p of SECRET_PARAMS) u.searchParams.delete(p);
  return u.toString();
}

// Default cacheability: a real payload. `[]` / `{}` / null are what vendors return for
// an unknown symbol or a quota hiccup — remembering them would hide a later recovery.
function isCacheableBody(body) {
  if (body == null) return false;
  if (Array.isArray(body)) return body.length > 0;
  if (typeof body === 'object') return Object.keys(body).length > 0;
  return true;
}

// Lazily resolve the Vercel Runtime Cache. Returns null (and warns once) when the flag
// is off, the SDK is absent, or construction throws — the caller treats null as "no L2".
function defaultL2Factory() {
  if (!isL2Enabled()) return null;
  try {
    const { getCache } = require('@vercel/functions');
    return getCache({ namespace: L2_NAMESPACE });
  } catch (e) {
    logWarn('http-memo', 'L2 unavailable — @vercel/functions failed to load', { error: String((e && e.message) || e) });
    return null;
  }
}

// Body text of a Response. Real Responses always have text(); the repo's older fetch
// doubles only implement json(), so accept either rather than fail a test harness.
async function responseText(r) {
  if (typeof r.text === 'function') return r.text();
  if (typeof r.json === 'function') return JSON.stringify(await r.json());
  throw new TypeError('memoFetchJSON: response has neither text() nor json()');
}

function parseJsonText(text) {
  try { return { body: JSON.parse(text), invalid: false }; }
  catch { return { body: null, invalid: true }; }
}

function validateArgs(url, ttlMs) {
  if (typeof url !== 'string' || !url) throw new TypeError('memoFetchJSON: url must be a non-empty string');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('memoFetchJSON: ttlMs must be a positive number');
}

/**
 * Build an independent memo instance. The module exports one default instance; tests
 * (and anything needing isolation) build their own with an injected clock / L2.
 * @param {object} [o]
 *   now          clock returning epoch ms (default Date.now)
 *   l2           () => cache | null — resolved lazily on first use
 *   maxEntries / maxBytes / maxItemBytes — L1 bounds
 */
function createHttpMemo({ now = Date.now, l2 = defaultL2Factory, maxEntries = L1_MAX_ENTRIES, maxBytes = L1_MAX_BYTES, maxItemBytes = MAX_ITEM_BYTES } = {}) {
  const entries = new Map();      // key → { text, status, bytes, expiresAt, tag } (Map order = LRU order)
  const inflight = new Map();     // key → Promise<result>
  let totalBytes = 0;
  let l2Cache;                    // undefined = not yet resolved; null = none
  const stats = { hits: 0, misses: 0, inflightDedupes: 0, l2Hits: 0, l2Errors: 0, evictions: 0, uncacheable: 0, bypassed: 0 };

  const resolveL2 = () => {
    if (l2Cache !== undefined) return l2Cache;
    try { l2Cache = (typeof l2 === 'function' ? l2() : l2) || null; }
    catch (e) { stats.l2Errors++; l2Cache = null; logWarn('http-memo', 'L2 factory threw', { error: String((e && e.message) || e) }); }
    return l2Cache;
  };

  const dropEntry = (key) => {
    const e = entries.get(key);
    if (!e) return;
    totalBytes -= e.bytes;
    entries.delete(key);
  };

  const evictUntilFits = (incomingBytes) => {
    while (entries.size && (entries.size >= maxEntries || totalBytes + incomingBytes > maxBytes)) {
      const oldest = entries.keys().next().value;   // Map iteration order = insertion = LRU
      dropEntry(oldest);
      stats.evictions++;
    }
  };

  const l1Get = (key) => {
    const e = entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= now()) { dropEntry(key); return null; }
    entries.delete(key); entries.set(key, e);       // refresh recency
    return e;
  };

  const l1Set = (key, { text, status }, ttlMs, tag) => {
    const bytes = text.length;
    if (bytes > maxItemBytes) { stats.uncacheable++; return false; }
    dropEntry(key);
    evictUntilFits(bytes);
    entries.set(key, { text, status, bytes, expiresAt: now() + ttlMs, tag });
    totalBytes += bytes;
    return true;
  };

  const l2Get = async (key) => {
    const cache = resolveL2();
    if (!cache) return null;
    try {
      const v = await cache.get(key);
      return (v && typeof v.text === 'string' && Number.isFinite(v.status)) ? v : null;
    } catch { stats.l2Errors++; return null; }
  };

  const l2Set = async (key, value, ttlMs, tag) => {
    const cache = resolveL2();
    if (!cache) return;
    try { await cache.set(key, value, { ttl: Math.ceil(ttlMs / MS_PER_SEC), tags: [tag] }); }
    catch { stats.l2Errors++; }
  };

  const toResult = (status, text, cached) => {
    const { body, invalid } = parseJsonText(text);
    return invalid ? { ok: false, status, body: null, cached, invalidJson: true } : { ok: true, status, body, cached };
  };

  // The uncached path: L2 → network. Only an ok, parseable, cacheable body is stored.
  const load = async (key, url, { ttlMs, tag, init, shouldCache, fetchImpl }) => {
    const fromL2 = await l2Get(key);
    if (fromL2) {
      stats.l2Hits++;
      l1Set(key, fromL2, ttlMs, tag);
      return toResult(fromL2.status, fromL2.text, 'l2');
    }
    const r = await fetchImpl(url, init);
    if (!r.ok) return { ok: false, status: r.status, body: null, cached: false };
    const text = await responseText(r);
    const result = toResult(r.status, text, false);
    const cacheable = result.ok && isCacheableBody(result.body) && (!shouldCache || shouldCache(result.body) === true);
    if (!cacheable) { stats.uncacheable++; return result; }
    const stored = l1Set(key, { text, status: r.status }, ttlMs, tag);
    if (stored) await l2Set(key, { text, status: r.status }, ttlMs, tag);
    return result;
  };

  /**
   * GET `url` as JSON through both cache layers.
   * @param {string} url
   * @param {object} opts
   *   ttlMs       required — how long an ok body may be served from cache
   *   tag         grouping for expireTag (default 'default'); also namespaces the key
   *   init        fetch init forwarded to fetchWithTimeout (timeoutMs/retries/headers…)
   *   cacheKey    override the key (default: the URL with secret params stripped)
   *   shouldCache (body) => boolean — extra vendor-specific cacheability check
   *   fetchImpl   test seam (default fetchWithTimeout)
   * @returns {Promise<{ok:boolean,status:number,body:any,cached:false|'l1'|'l2'|'inflight',invalidJson?:true}>}
   *   Throws only when the fetch itself threw (network/timeout) — like fetchWithTimeout.
   */
  async function memoFetchJSON(url, opts = {}) {
    const { ttlMs, tag = 'default', init = {}, cacheKey, shouldCache, fetchImpl = fetchWithTimeout } = opts;
    validateArgs(url, ttlMs);
    if (isMemoDisabled()) {
      stats.bypassed++;
      const r = await fetchImpl(url, init);
      return r.ok ? toResult(r.status, await responseText(r), false) : { ok: false, status: r.status, body: null, cached: false };
    }
    const key = `${tag}:${cacheKey || redactedKey(url)}`;
    const hit = l1Get(key);
    if (hit) { stats.hits++; return toResult(hit.status, hit.text, 'l1'); }
    const pending = inflight.get(key);
    if (pending) { stats.inflightDedupes++; return pending.then(r => ({ ...r, cached: r.cached || 'inflight' })); }
    stats.misses++;
    const p = load(key, url, { ttlMs, tag, init, shouldCache, fetchImpl }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // Drop every entry carrying `tag` from both layers (L2 best-effort).
  async function expireTag(tag) {
    for (const [key, e] of [...entries]) if (e.tag === tag) dropEntry(key);
    const cache = resolveL2();
    if (!cache) return;
    try { await cache.expireTag(tag); } catch { stats.l2Errors++; }
  }

  function getStats() {
    return { ...stats, size: entries.size, bytes: totalBytes, inflight: inflight.size, l2: resolveL2() ? 'on' : 'off' };
  }

  function reset() {
    entries.clear(); inflight.clear(); totalBytes = 0;
    for (const k of Object.keys(stats)) stats[k] = 0;
  }

  return { memoFetchJSON, expireTag, getStats, reset };
}

// ── default instance (what production callers use) ───────────────────────────
const DEFAULT = createHttpMemo();

module.exports = {
  memoFetchJSON: (url, opts) => DEFAULT.memoFetchJSON(url, opts),
  expireTag: (tag) => DEFAULT.expireTag(tag),
  getHttpMemoStats: () => DEFAULT.getStats(),
  resetHttpMemo: () => DEFAULT.reset(),
  createHttpMemo, redactedKey, isCacheableBody,
  L1_MAX_ENTRIES, L1_MAX_BYTES, MAX_ITEM_BYTES, L2_FLAG_ENV, KILL_SWITCH_ENV,
};
