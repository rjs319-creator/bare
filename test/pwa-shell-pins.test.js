'use strict';
// 📴 PWA SHELL PINS — the deploy-facing contract of the offline-first service worker and the
// vendored micro-kit. Source-string pins (the files are browser-only), each one a thing that
// silently breaks offline mode or the toasts if it regresses:
//   • sw.js carries a VERSION constant (the cache-bump lever: bump it on every deploy that
//     changes a static asset), imports the shared policy, precaches only files that EXIST (a
//     single 404 fails install), never caches a non-200, and announces activation.
//   • index.html loads the three classic vendor scripts before the module entry.
//   • every vendored file ships its license next to it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const PUB = join(ROOT, 'public');
const SW = readFileSync(join(PUB, 'sw.js'), 'utf8');
const HTML = readFileSync(join(PUB, 'index.html'), 'utf8');
const CSS = readFileSync(join(PUB, 'css', 'app.css'), 'utf8');
const APP = readFileSync(join(PUB, 'js', 'app.js'), 'utf8');

test('sw.js: VERSION constant, shared policy via importScripts, versioned cache names, old-cache cleanup', () => {
  assert.match(SW, /^const VERSION = '[\w.-]+';$/m, 'a single VERSION constant is the cache-bump lever');
  assert.match(SW, /importScripts\('\/js\/sw-policy\.js'\)/);
  assert.match(SW, /`\$\{CACHE_PREFIX\}shell-\$\{VERSION\}`/);
  assert.match(SW, /`\$\{CACHE_PREFIX\}api-\$\{VERSION\}`/);
  assert.match(SW, /caches\.keys\(\)/, 'activate enumerates caches to delete stale versions');
  assert.match(SW, /caches\.delete\(/);
  assert.match(SW, /self\.clients\.claim\(\)/);
});

test('sw.js: the fetch handler routes by the shared classifier and never caches a non-200 or an empty state', () => {
  assert.match(SW, /self\.addEventListener\('fetch'/);
  assert.match(SW, /SW_POLICY\.classifyRequest\(/);
  assert.match(SW, /SW_POLICY\.shouldCacheResponse\(/, 'the ONLY gate before cache.put for API bodies');
  assert.match(SW, /hasAuth: req\.headers\.has\('authorization'\)/i);
  assert.match(SW, /case 'bypass':[\s\S]*?return;/, 'bypass = do not call respondWith at all');
  assert.match(SW, /x-sw-served/);
  assert.match(SW, /x-sw-cached-at/);
  assert.match(SW, /MAX_API_ENTRIES\s*=\s*\d+/, 'the API cache is bounded');
  assert.match(SW, /res\.status === 200/, 'static assets are only cached on a 200');
});

test('sw.js: announces activation to open pages and mirrors a push to them', () => {
  assert.match(SW, /type: 'sw-activated'/);
  assert.match(SW, /isUpdate/);
  assert.match(SW, /type: 'push'/);
  assert.match(SW, /postMessage\(/);
});

test('sw.js: every precached path exists on disk (one 404 fails the whole install)', () => {
  const m = SW.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(m, 'PRECACHE list');
  const paths = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(paths.length > 40, `precache covers the shell (${paths.length})`);
  for (const p of ['/', '/index.html', '/css/app.css', '/js/app.js', '/icon.svg', '/manifest.webmanifest', '/js/sw-policy.js',
    '/js/vendor/idb-keyval-6.2.2.umd.js', '/js/vendor/sortable-3.2.3.min.js', '/js/vendor/notyf-3.10.0.min.js', '/js/vendor/fuse-7.1.0.min.mjs']) {
    assert.ok(paths.includes(p), `${p} precached`);
  }
  for (const p of paths) {
    const file = p === '/' ? '/index.html' : p;
    assert.ok(existsSync(join(PUB, file)), `precached ${p} must exist under public/`);
  }
  assert.ok(!paths.includes('/sw.js'), 'the worker never precaches itself');
  assert.equal(new Set(paths).size, paths.length, 'no duplicates');
});

test('sw.js parses as a classic script and sw-policy.js is syntactically importScripts-safe', () => {
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function(SW.replace(/importScripts\([^)]*\);?/, '')));
  assert.doesNotThrow(() => new Function(readFileSync(join(PUB, 'js', 'sw-policy.js'), 'utf8')));
});

test('index.html loads the vendored classic scripts (deferred) BEFORE the module entry point', () => {
  const tags = ['/js/vendor/idb-keyval-6.2.2.umd.js', '/js/vendor/sortable-3.2.3.min.js', '/js/vendor/notyf-3.10.0.min.js'];
  const entry = HTML.indexOf('<script type="module" src="/js/app.js">');
  assert.ok(entry > -1);
  for (const t of tags) {
    const i = HTML.indexOf(`<script src="${t}" defer></script>`);
    assert.ok(i > -1, `${t} referenced`);
    assert.ok(i < entry, `${t} before app.js`);
  }
  assert.ok(!HTML.includes('fuse-7.1.0'), 'Fuse is lazy-imported by the palette, not a page script');
});

test('every vendored library ships its license and a header naming version + license', () => {
  const dir = join(PUB, 'js', 'vendor');
  const files = readdirSync(dir);
  const libs = files.filter((f) => /\.(m?js)$/.test(f));
  assert.deepEqual(libs.sort(), [
    'd3-hierarchy-3.1.2.esm.js', 'fuse-7.1.0.min.mjs', 'idb-keyval-6.2.2.umd.js',
    'lightweight-charts-5.2.1.standalone.mjs', 'notyf-3.10.0.min.js', 'sortable-3.2.3.min.js',
  ]);
  // The chart engine's vendor files (PR #431) keep their upstream LICENSE names.
  const LICENSE_BY_LIB = {
    'd3-hierarchy-3.1.2.esm.js': 'LICENSE-d3-hierarchy',
    'lightweight-charts-5.2.1.standalone.mjs': 'LICENSE-lightweight-charts',
  };
  for (const lib of libs) {
    const lic = LICENSE_BY_LIB[lib] || lib.replace(/\.(umd\.js|min\.m?js)$/, '.LICENSE');
    assert.ok(files.includes(lic), `${lic} next to ${lib}`);
    assert.ok(statSync(join(dir, lic)).size > 100);
    const head = readFileSync(join(dir, lib), 'utf8').slice(0, 400);
    assert.match(head, /Apache|MIT|Unlicense|ISC/, `${lib} header names its license`);
  }
  assert.ok(/GPL/.test(readFileSync(join(dir, 'fuse-7.1.0.LICENSE'), 'utf8')) === false, 'no GPL');
});

test('app.css inlines the Notyf stylesheet and the micro-kit styles', () => {
  assert.match(CSS, /\.notyf\{/, 'notyf.min.css inlined');
  assert.match(CSS, /notyf v?3\.10\.0/i, 'provenance comment');
  assert.match(CSS, /\.lg-strip/);
  assert.match(CSS, /table\.sortable th/);
});

test('app.js wires the service-worker message channel to toasts (and nothing else about the SW changed)', () => {
  assert.match(APP, /import \{ initServiceWorkerMessages \} from '\.\/toasts\.js'/);
  assert.match(APP, /navigator\.serviceWorker\.register\('\/sw\.js'\)\.then\(r => \{ swReg = r; \}\)\.catch\(\(\) => \{\}\);\n\s*initServiceWorkerMessages\(\);/);
});

test('gen-full-source only globs top-level public/js (vendor minified bundles stay out of APP-FULL-SOURCE.md)', () => {
  const gen = readFileSync(join(ROOT, 'scripts', 'gen-full-source.js'), 'utf8');
  assert.match(gen, /'public\/js\/\*\.js'/);
  assert.ok(!/public\/js\/\*\*/.test(gen));
});
