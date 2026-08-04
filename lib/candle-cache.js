// Incremental candle cache for the screener. The cold screener scan is dominated
// by ~515 latency-bound Yahoo chart calls (~23s). Daily EOD candles are static
// except for the newest bar, so we cache the whole scope's candles in ONE Blob
// doc per scope and read that (one bandwidth-bound download, ~1s) instead.
//
// Self-populating: the daily warm cron (requests carry `x-warm: 1`) rebuilds the
// cache; ordinary user requests only READ it (never pay the build or the write).
// Storage is compact — only the meta fields screenTicker actually uses
// (shortName/longName/exchangeName) plus candle tuples [date,o,h,l,c,v].
const { readJSON, writeJSON, hasStore } = require('./store');

const KEY = scope => `candles/${scope}.json`;
const MAX_BARS = 300;                         // ~1y of daily bars; bounds the doc size
const FRESH_USE_MS = 26 * 60 * 60 * 1000;     // any request may READ a cache younger than this
const REBUILD_MS = 12 * 60 * 60 * 1000;       // a warm request REBUILDS a cache older than this

// `prov` (optional) stamps PER-ENTRY provenance (defect #3 — mixed-vintage
// universe): { fetchedAt, generatedAt, scope, priceBasis, adjustment }. Compiled
// multi-shard docs carry entries fetched on DIFFERENT days, so the document-level
// timestamp can never attest an entry's freshness — the entry itself must.
function encode(map, prov = null) {
  const data = {};
  for (const [t, v] of map) {
    if (!v || !Array.isArray(v.candles) || !v.candles.length) continue;
    const m = v.meta || {};
    data[t] = {
      m: [m.shortName || '', m.longName || '', m.exchangeName || ''],
      // 7th element = adjClose (split+dividend adjusted). Older 6-tuple docs decode with
      // adjClose:null and are simply rebuilt on the next warm cron — no version break needed.
      c: v.candles.slice(-MAX_BARS).map(k => [k.date, k.open, k.high, k.low, k.close, k.volume, k.adjClose == null ? null : k.adjClose]),
    };
    if (prov) {
      data[t].p = {
        f: prov.fetchedAt || null,                                   // sourceFetchedAt (ISO)
        g: prov.generatedAt || prov.fetchedAt || null,               // shardGeneratedAt (ISO)
        s: prov.scope || null,                                       // sourceScope
        b: v.priceBasis || prov.priceBasis || null,                  // price basis metadata
        a: v.adjustment || prov.adjustment || null,                  // corporate-action/adjustment status
      };
    }
  }
  return data;
}

// Decode one stored entry. Always surfaces a `provenance` block; legacy entries
// (no `p`) decode with null source fields and `lastBarDate` DERIVED from the
// final candle — the one per-entry temporal fact old documents actually carry.
function decodeEntry(e) {
  if (!e || !Array.isArray(e.c)) return null;
  const candles = e.c.map(([date, open, high, low, close, volume, adjClose = null]) => ({ date, open, high, low, close, volume, adjClose }));
  const p = e.p || null;
  return {
    meta: { shortName: e.m?.[0] || '', longName: e.m?.[1] || '', exchangeName: e.m?.[2] || '' },
    candles,
    provenance: {
      lastBarDate: candles.length ? candles[candles.length - 1].date : null,
      sourceFetchedAt: p ? (p.f || null) : null,
      shardGeneratedAt: p ? (p.g || null) : null,
      sourceScope: p ? (p.s || null) : null,
      priceBasis: p ? (p.b || null) : null,
      adjustment: p ? (p.a || null) : null,
    },
  };
}

// Load the cache doc for a scope (or null). Caller decides freshness via cacheState.
async function loadCandleCache(scope) {
  if (!hasStore()) return null;
  try {
    const doc = await readJSON(KEY(scope), null);
    return doc && doc.data ? doc : null;
  } catch { return null; }
}

// Decide how a request should use the loaded cache.
function cacheState(doc, isWarm) {
  const ageMs = doc ? Date.now() - (doc.updatedAt || 0) : Infinity;
  const fresh = doc && ageMs < FRESH_USE_MS;
  // Warm (cron) requests rebuild a cache older than REBUILD_MS so the new daily bar
  // gets captured; within a single cron run later variants still read the just-built
  // cache (age << REBUILD_MS) instead of re-fetching.
  const use = fresh && !(isWarm && ageMs >= REBUILD_MS);
  return { use, ageMs, builtDate: doc?.builtDate || null };
}

function cacheGet(doc, t) {
  return decodeEntry(doc?.data?.[t]);
}

// Persist the FULL scope map (only call for the unfiltered universe on warm requests).
// Single-run rebuilds are uniform-vintage, so per-entry provenance = this run.
async function saveCandleCache(scope, fullMap) {
  if (!hasStore() || !fullMap.size) return;
  const nowIso = new Date().toISOString();
  await writeJSON(KEY(scope), {
    updatedAt: Date.now(),
    builtDate: nowIso.slice(0, 10),
    n: fullMap.size,
    data: encode(fullMap, { fetchedAt: nowIso, generatedAt: nowIso, scope }),
  }, 0);
}

module.exports = { loadCandleCache, cacheState, cacheGet, saveCandleCache, encode, decodeEntry, MAX_BARS };
