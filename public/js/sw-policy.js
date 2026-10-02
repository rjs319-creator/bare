// 📴 SERVICE-WORKER CACHE POLICY — pure, dependency-free, ONE source of truth for "may this
// request / response touch a cache?". Deliberately a CLASSIC script (no import/export) so the
// same file is loaded three ways:
//   • sw.js            → importScripts('/js/sw-policy.js')   → self.SW_POLICY
//   • fetch-json.js    → import './sw-policy.js' (side effect) → globalThis.SW_POLICY
//   • node --test      → require('../public/js/sw-policy.js') → module.exports
//
// Rules (see test/pwa-sw-policy.test.js for the executable version):
//   bypass   — non-GET, Authorization header, cross-origin, /api/warm, /sw.js, any tracker op that
//              writes/ticks/rebuilds (the cron fan-out), or a force/log/refresh lever. Network only,
//              never read from or written to a cache.
//   live     — /api/price, /api/chart, op=version|health|pushstatus. Network only.
//   snapshot — every other same-origin GET /api/* read: network-first, cached copy kept ONLY when
//              the body is a 200 JSON payload that is not an empty/degraded state.
//   static   — /js /css /icon.svg /manifest: served from the shell cache, revalidated in background.
//   navigate — the document: network-first, cached shell when offline.
(function (root) {
  'use strict';

  // Tracker ops that mutate state or run the heavy pipelines. Built from api/tracker.js
  // PRIVILEGED_OPS + SHARED_FORCE_OPS + INGEST_OPS token patterns so a NEW op that follows the
  // naming convention (…tick, …log, …resolve, …backfill, …build, …scan …) is excluded without a
  // policy change. `tick(?!er)` keeps read-only op=…ticker projections cacheable.
  const WRITE_OP_RE = /(tick(?!er)|log$|resolve|backfill|archive|build|scan|compile|curate|train|promote|rollback|verify|grade|assess|capture|refine|collect|tune|seed|subscribe|ingest|recalibrate)/i;
  const WRITE_OP_EXACT = new Set(['warmchain', 'track', 'narrative', 'emerging', 'runmanifest', 'fmpaudit']);
  // Query levers that turn a read into a recompute or a write (api/tracker.js strips them for
  // anonymous callers, but the SW must never replay a cached answer to one either).
  const LEVER_PARAMS = ['force', 'log', 'refresh'];
  const LIVE_OPS = new Set(['version', 'health', 'pushstatus']);
  const LIVE_PATHS = new Set(['/api/price', '/api/chart']);
  const BYPASS_PATHS = new Set(['/api/warm', '/sw.js']);
  const STATIC_RE = /^\/(js|css)\/.+\.(m?js|css)$|^\/(icon\.svg|manifest\.webmanifest)$/;
  const NAVIGATE_RE = /^\/(index\.html)?$/;
  // Per-poll cache-busters the app appends (`&_cb=${Date.now()}`) — one logical resource.
  const CACHE_BUSTER_PARAMS = ['_cb', '_t', '_ts'];

  // Top-level collection keys the routes use for their primary payload. A payload that carries
  // at least one of these and ALL of them empty is an empty state (nothing to show).
  const COLLECTION_KEYS = ['items', 'heldOut', 'sectors', 'rotation', 'groups', 'candidates', 'rows', 'signals', 'picks',
    'cards', 'alerts', 'results', 'strategies', 'decisions', 'entries', 'events', 'algos', 'pairs', 'quarters'];

  function parseUrl(url) {
    try { return new URL(String(url)); } catch { return null; }
  }

  function isWriteOp(op) {
    if (!op) return false;
    const o = String(op).toLowerCase();
    return WRITE_OP_EXACT.has(o) || WRITE_OP_RE.test(o);
  }

  function hasLever(params) {
    return LEVER_PARAMS.some((k) => params.has(k));
  }

  function isStaticAssetPath(pathname) {
    return STATIC_RE.test(String(pathname || ''));
  }

  /**
   * @param {{url:string, method?:string, hasAuth?:boolean, origin?:string}|null} req
   * @returns {'bypass'|'live'|'snapshot'|'static'|'navigate'}
   */
  function classifyRequest(req) {
    if (!req || typeof req !== 'object') return 'bypass';
    const u = parseUrl(req.url);
    if (!u) return 'bypass';
    if ((req.method || 'GET').toUpperCase() !== 'GET') return 'bypass';
    if (req.hasAuth) return 'bypass';
    if (req.origin && u.origin !== req.origin) return 'bypass';
    const path = u.pathname;
    if (BYPASS_PATHS.has(path)) return 'bypass';
    if (isStaticAssetPath(path)) return 'static';
    if (NAVIGATE_RE.test(path)) return 'navigate';
    if (LIVE_PATHS.has(path)) return 'live';
    if (path.startsWith('/api/')) {
      const op = u.searchParams.get('op');
      if (isWriteOp(op) || hasLever(u.searchParams)) return 'bypass';
      if (LIVE_OPS.has(String(op || '').toLowerCase())) return 'live';
      return 'snapshot';
    }
    if (path.startsWith('/feed/')) return 'snapshot';
    return 'bypass';
  }

  // The cache key for an API read: the URL minus per-poll cache-busters.
  function apiCacheKey(url) {
    const u = parseUrl(url);
    if (!u) return String(url);
    for (const k of CACHE_BUSTER_PARAMS) u.searchParams.delete(k);
    return u.toString().replace(/\?$/, '');
  }

  function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
  }

  // How the routes signal "nothing to show / do not trust this":
  //   ok:false · empty:true · persisted:false (Blob write failed) · degraded:true · an `error`
  //   field · any sources[].ok === false (partial read, mirrors session-board cacheHeaderFor)
  //   · every known primary collection empty · counts.signals === 0 (op=today).
  function isEmptyState(json) {
    if (!isPlainObject(json)) return true;
    if (json.ok === false || json.empty === true || json.persisted === false || json.degraded === true) return true;
    if (json.error != null && json.ok !== true) return true;
    if (Array.isArray(json.sources) && json.sources.some((s) => s && s.ok === false)) return true;
    if (isPlainObject(json.counts) && json.counts.signals === 0) return true;
    const present = COLLECTION_KEYS.filter((k) => Array.isArray(json[k]));
    if (present.length && present.every((k) => json[k].length === 0)) return true;
    return false;
  }

  /**
   * @param {{status:number, contentType?:string, json?:any, bodyText?:string}} res
   */
  function shouldCacheResponse(res) {
    if (!res || res.status !== 200) return false;
    const ct = String(res.contentType || '').toLowerCase();
    if (ct.includes('json')) return !isEmptyState(res.json);
    if (ct.includes('text/markdown') || ct.includes('text/plain')) return typeof res.bodyText === 'string' && res.bodyText.trim().length > 0;
    return false;
  }

  const API = Object.freeze({ classifyRequest, isEmptyState, shouldCacheResponse, apiCacheKey, isStaticAssetPath, isWriteOp });
  root.SW_POLICY = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : globalThis);
