'use strict';
// In-memory stand-in for @vercel/blob, installed into require.cache BEFORE lib/store.js
// lazily requires the real package (the test/store-exact-match-read.test.js pattern).
// Models exactly what compare-and-swap depends on: list() rows carry an `etag`, put()
// with `ifMatch` throws BlobPreconditionFailedError when the stored etag differs, and
// put() with `allowOverwrite:false` refuses an existing pathname. Every write mints a new
// etag. `hooks.beforePut` lets a test play the role of a CONCURRENT WRITER landing between
// a reader's list() and its put() — a real race, not a forced throw.

class FakeBlobPreconditionFailedError extends Error {
  constructor() { super('Precondition failed: ETag mismatch.'); this.name = 'BlobPreconditionFailedError'; }
}

const BASE_URL = 'https://blob.test/';

function createFakeBlob() {
  const docs = new Map();          // pathname -> { body, etag }
  const putCalls = [];
  const hooks = { beforePut: null };
  let seq = 0;
  const mint = () => `"etag-${++seq}"`;

  const rowFor = (pathname) => ({ pathname, url: `${BASE_URL}${pathname}`, etag: docs.get(pathname).etag });

  // Direct store manipulation for arranging state / asserting outcomes.
  const seed = (pathname, value) => { docs.set(pathname, { body: JSON.stringify(value), etag: mint() }); return docs.get(pathname).etag; };
  const read = (pathname) => (docs.has(pathname) ? JSON.parse(docs.get(pathname).body) : undefined);
  const etagOf = (pathname) => (docs.has(pathname) ? docs.get(pathname).etag : null);

  async function list({ prefix, limit }) {
    const rows = [...docs.keys()].filter((p) => p.startsWith(prefix)).map(rowFor);
    return { blobs: rows.slice(0, typeof limit === 'number' ? limit : 1000), cursor: undefined };
  }

  async function head(urlOrPathname) {
    const pathname = String(urlOrPathname).replace(BASE_URL, '').split('?')[0];
    if (!docs.has(pathname)) { const e = new Error('not found'); e.name = 'BlobNotFoundError'; throw e; }
    return { ...rowFor(pathname), size: docs.get(pathname).body.length };
  }

  async function put(pathname, body, opts = {}) {
    if (hooks.beforePut) { const h = hooks.beforePut; hooks.beforePut = null; await h(); }
    putCalls.push({ pathname, opts: { ...opts } });
    const cur = docs.get(pathname);
    if (opts.ifMatch) {
      if (!cur || cur.etag !== opts.ifMatch) throw new FakeBlobPreconditionFailedError();
    } else if (opts.allowOverwrite === false && cur) {
      throw new Error(`The blob "${pathname}" already exists, use allowOverwrite: true to overwrite it`);
    }
    docs.set(pathname, { body: String(body), etag: mint() });
    return { pathname, url: `${BASE_URL}${pathname}`, etag: docs.get(pathname).etag };
  }

  // Public-URL body fetch (lib/store.js reads bodies over fetch, not the SDK).
  async function fetchImpl(url) {
    const pathname = String(url).replace(BASE_URL, '').split('?')[0];
    const d = docs.get(pathname);
    if (!d) return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
    return { ok: true, status: 200, headers: new Map([['etag', d.etag]]), json: async () => JSON.parse(d.body) };
  }

  const exports = { list, head, put, BlobPreconditionFailedError: FakeBlobPreconditionFailedError };
  return { exports, docs, putCalls, hooks, seed, read, etagOf, fetchImpl, mint };
}

// Install the fake as the resolved @vercel/blob module. Returns null when the real
// package cannot resolve (dependency-free CI) so callers can skip.
function installFakeBlob() {
  let blobId = null;
  try { blobId = require.resolve('@vercel/blob'); } catch { return null; }
  const fake = createFakeBlob();
  require.cache[blobId] = { id: blobId, filename: blobId, loaded: true, exports: fake.exports };
  global.fetch = fake.fetchImpl;
  return fake;
}

module.exports = { createFakeBlob, installFakeBlob, FakeBlobPreconditionFailedError };
