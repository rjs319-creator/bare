// Service worker for Market News & Signals — installable PWA, notifications, server-sent Web Push,
// and (since the offline-first pass) an app-shell cache plus last-good API snapshots.
//
// ── CACHE-BUMP PROCEDURE (deploys) ────────────────────────────────────────────────────────────
// Static assets are served from the shell cache and REVALIDATED IN THE BACKGROUND, so a deploy
// without a bump is picked up on the reader's NEXT load. Bump VERSION whenever a deploy changes
// a static asset (any public/js, public/css, index.html) so open pages get the "update ready"
// toast immediately and the old caches are dropped on activate. A bump is cheap; a missed bump
// only delays pickup by one load. Never cache-bust by renaming files — the PRECACHE list and
// index.html reference them by path.
const VERSION = 'v2';
const CACHE_PREFIX = 'mna-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const API_CACHE = `${CACHE_PREFIX}api-${VERSION}`;
const MAX_API_ENTRIES = 60;

// One source of truth for what may touch a cache (also used by fetch-json.js and the tests).
importScripts('/js/sw-policy.js');

// The app shell. Every path MUST exist (one 404 fails the whole install — test/pwa-shell-pins
// pins that). New modules not listed here are still cached on first use by the static route.
const PRECACHE = [
  '/', '/index.html', '/css/app.css', '/icon.svg', '/manifest.webmanifest',
  '/js/app.js', '/js/atlas.js', '/js/cern.js', '/js/cfl-lab.js', '/js/command-palette.js',
  '/js/dilution-badge.js', '/js/evidence-badge.js',
  '/js/fetch-json.js', '/js/flow-badge.js', '/js/format.js', '/js/gridlock.js', '/js/ignition-live.js',
  '/js/last-good.js', '/js/learn-data.js', '/js/live-price.js',
  '/js/lowfloat.js', '/js/notify-prefs.js', '/js/omega-ensemble.js',
  '/js/opportunities.js', '/js/palette-index.js', '/js/pattern-chart.js',
  '/js/premove.js', '/js/psrl-lab.js', '/js/pulse2-render.js', '/js/quickhit.js', '/js/risk-budget.js',
  '/js/session-board.js', '/js/sw-policy.js', '/js/swing-supervisor.js',
  '/js/tech-command-render.js', '/js/tech-command.js', '/js/tech-evidence-render.js', '/js/themes.js',
  '/js/ticker-lookup.js', '/js/toasts.js', '/js/today.js',
  '/js/vendor/fuse-7.1.0.min.mjs', '/js/vendor/idb-keyval-6.2.2.umd.js', '/js/vendor/notyf-3.10.0.min.js',
  '/js/vendor/sortable-3.2.3.min.js',
  // chart engine (PR #431) — vendored lazily-imported ESM + its wrappers
  '/js/chart-engine.js', '/js/chart-primitives.js', '/js/sector-treemap.js',
  '/js/vendor/lightweight-charts-5.2.1.standalone.mjs', '/js/vendor/d3-hierarchy-3.1.2.esm.js',
];
const SERVED_HEADER = 'x-sw-served';
const CACHED_AT_HEADER = 'x-sw-cached-at';

// ── install: precache the shell (bypassing the HTTP cache so a bump really refetches) ────────────
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(PRECACHE.map((p) => new Request(p, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

// ── activate: drop every other version's caches, take over open pages, tell them ────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    const stale = names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== SHELL_CACHE && n !== API_CACHE);
    await Promise.all(stale.map((n) => caches.delete(n)));
    await self.clients.claim();
    await broadcast({ type: 'sw-activated', version: VERSION, isUpdate: stale.length > 0 });
  })());
});

async function broadcast(msg) {
  try {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { try { c.postMessage(msg); } catch {} }
  } catch {}
}

// A copy of `res` with extra headers (Response headers are immutable once constructed).
async function withHeaders(res, extra) {
  const body = await res.clone().arrayBuffer();
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

// Oldest-first trim (Cache API keys come back in insertion order).
async function trimCache(cache, max) {
  try {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
  } catch {}
}

// ── fetch strategies ────────────────────────────────────────────────────────────────────────────
// static: cached copy first (instant, offline-safe), revalidate in the background on a 200.
async function staticResponse(e, req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const refresh = fetch(req).then(async (res) => {
    if (res && res.status === 200) await cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { e.waitUntil(refresh); return cached; }
  const res = await refresh;
  return res || Response.error();
}

// navigate: the live document when online, the cached shell when not.
async function navigateResponse(req) {
  try {
    const res = await fetch(req);
    if (res && res.status === 200) return res;
    throw new Error(`HTTP ${res && res.status}`);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
  }
}

// snapshot: network-first; a 200 non-empty JSON body is remembered; on failure the remembered copy
// is served tagged x-sw-served:cache so fetch-json.js flags it stale (never silently fresh).
async function cacheApiResponse(key, res) {
  try {
    const contentType = res.headers.get('content-type') || '';
    const text = await res.clone().text();
    let json = null;
    if (contentType.includes('json')) { try { json = JSON.parse(text); } catch { json = null; } }
    if (!SW_POLICY.shouldCacheResponse({ status: res.status, contentType, json, bodyText: text })) return;
    const cache = await caches.open(API_CACHE);
    await cache.put(key, await withHeaders(res, { [CACHED_AT_HEADER]: new Date().toISOString() }));
    await trimCache(cache, MAX_API_ENTRIES);
  } catch {}
}

async function cachedApiResponse(key) {
  try {
    const cache = await caches.open(API_CACHE);
    const hit = await cache.match(key);
    return hit ? withHeaders(hit, { [SERVED_HEADER]: 'cache' }) : null;
  } catch { return null; }
}

async function snapshotResponse(e, req) {
  const key = SW_POLICY.apiCacheKey(req.url);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) { e.waitUntil(cacheApiResponse(key, res.clone())); return res; }
    return (await cachedApiResponse(key)) || res;
  } catch (err) {
    const cached = await cachedApiResponse(key);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const kind = SW_POLICY.classifyRequest({ url: req.url, method: req.method, origin: self.location.origin, hasAuth: req.headers.has('authorization') });
  switch (kind) {
    case 'bypass':
    case 'live':
      return;                                   // the network handles it; no cache is touched
    case 'static':
      e.respondWith(staticResponse(e, req)); return;
    case 'navigate':
      e.respondWith(navigateResponse(req)); return;
    case 'snapshot':
      e.respondWith(snapshotResponse(e, req)); return;
    default:
      return;
  }
});

// Clicking a notification focuses an existing tab or opens the app at #momentum.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/#momentum';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(target); } catch {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

// Server-sent Web Push. Payload: {title, body, tag, kind, sev} (see lib/push-notify.js).
// tag = server alert id → duplicate deliveries of the same alert collapse into one
// notification. renotify only for confirmed triggers ('entry'): an early watch is
// explicitly not a trade, so a re-delivered one must not buzz the phone again.
// Open tabs also get the payload as a message so the page can show an in-app toast.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  const title = d.title || 'Market Signal';
  const data = d.data || { url: '/#momentum' };
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: d.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: d.tag || 'market-signal',
      renotify: d.kind !== 'early_watch',
      data,
      vibrate: [100, 50, 100],
    }),
    broadcast({ type: 'push', title, body: d.body || '', kind: d.kind || null, tag: d.tag || null, url: data.url || null }),
  ]));
});
