// Free universe-expansion ops (see lib/universe-expand.js).
//   op=universebuild   — ingest the free listed-ticker directory, mechanically
//                        filter → universe/candidates.json (no price fetch)
//   op=universescan    — resumable: fetch daily candles per candidate, apply the
//                        liquidity floor, shard qualified candles into the
//                        candles/expanded/ cache; record skips
//   op=universecompile — merge the expanded shards → candles/expanded.json
//   op=universecurate  — Fable review of the ambiguous tail (keep/skip)
//
// All FREE: NASDAQ Trader directory + Yahoo candles. Heavy/manual, warm-cron paced.

const CANDIDATES_PATH = 'universe/candidates.json';
const CURATION_PATH = 'universe/curation.json';
const EXP_SHARD_PREFIX = 'candles/expanded/';
const EXP_CACHE_PATH = 'candles/expanded.json';

// Liquidity floor — the "skip low-yield" gate applied during the candle build.
const MIN_DOLLAR_VOL = 2_000_000;   // avg $ volume/day (20d)
const MIN_PRICE = 3;                // skip sub-$3 penny/illiquid
const MIN_BARS = 200;               // enough history for the long-term read

// ── op=universebuild ───────────────────────────────────────────────────────
async function runUniverseBuild(req, res) {
  const { hasStore, writeJSON } = require('./store');
  const { fetchUniverseSources, mechanicalFilter } = require('./universe-expand');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  let rows;
  try { rows = await fetchUniverseSources(); }
  catch (e) { return res.json({ ok: false, error: 'source fetch: ' + String(e && e.message || e) }); }
  const { kept, dropped, total } = mechanicalFilter(rows);
  await writeJSON(CANDIDATES_PATH, { tickers: kept, dropped, total, builtAt: new Date().toISOString() }, 0);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, sourced: total, candidates: kept.length, dropped, note: 'Free NASDAQ-directory ingest + mechanical filter. Run op=universescan to apply the liquidity floor and build the expanded candle cache.' });
}

// Average daily dollar-volume over the last ~20 bars.
function avgDollarVol(candles) {
  const n = Math.min(20, candles.length);
  if (!n) return 0;
  let s = 0;
  for (let i = candles.length - n; i < candles.length; i++) s += (candles[i].close || 0) * (candles[i].volume || 0);
  return s / n;
}

// ── op=universescan — resumable: fetch candles, apply the liquidity floor, shard ──
async function runUniverseScan(req, res) {
  const { hasStore, readJSON, writeJSON } = require('./store');
  const { fetchDailyHistory } = require('./screener');
  const { encode } = require('./candle-cache');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });

  const doc = await readJSON(CANDIDATES_PATH, null);
  const list = (doc && doc.tickers) || [];
  if (!list.length) return res.json({ ok: false, error: 'No candidates — run op=universebuild first.' });

  // Skip anything the Fable curation (Phase 3) flagged as low-yield.
  const curation = await readJSON(CURATION_PATH, null).catch(() => null);
  const skipSet = new Set(((curation && curation.skip) || []).map(s => String(s).toUpperCase()));

  const limit = Math.max(20, Math.min(200, parseInt(req.query.limit, 10) || 150));
  // ?cursor=1 (used by the warm cron) auto-advances through the list and wraps —
  // so the scan self-completes over a few days and then refreshes continuously.
  const useCursor = req.query.cursor === '1';
  let start = Math.max(0, parseInt(req.query.start, 10) || 0);
  if (useCursor) { const cur = await readJSON('universe/scan-cursor.json', null); start = (cur && cur.next) || 0; if (start >= list.length) start = 0; }
  const batch = list.slice(start, start + limit).filter(c => !skipSet.has(c.symbol));

  const t0 = Date.now();
  const qualifiedMap = new Map();
  const stats = { qualified: 0, thinVol: 0, lowPrice: 0, shortHist: 0, noData: 0 };
  let i = 0;
  const worker = async () => {
    while (i < batch.length) {
      const c = batch[i++];
      if (Date.now() - t0 > 45000) return;
      try {
        const d = await fetchDailyHistory(c.symbol, '1y');
        const candles = d && d.candles;
        if (!candles || candles.length < MIN_BARS) { stats.shortHist += candles ? 1 : 0; stats.noData += candles ? 0 : 1; continue; }
        const px = candles[candles.length - 1].close;
        if (px < MIN_PRICE) { stats.lowPrice++; continue; }
        if (avgDollarVol(candles) < MIN_DOLLAR_VOL) { stats.thinVol++; continue; }
        qualifiedMap.set(c.symbol, { candles, meta: { shortName: c.name, longName: c.name, exchangeName: c.exchange } });
        stats.qualified++;
      } catch { stats.noData++; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  // Shard the qualified candles (idempotent by start — no read-modify-write).
  // Per-entry provenance (defect #3): every entry carries its OWN fetch time and
  // scope, so a later multi-shard compile can never make an old fetch look fresh.
  const shardAt = new Date().toISOString();
  await writeJSON(`${EXP_SHARD_PREFIX}${String(start).padStart(5, '0')}.json`,
    { data: encode(qualifiedMap, { fetchedAt: shardAt, generatedAt: shardAt, scope: 'expanded' }), start, count: qualifiedMap.size, at: shardAt }, 0);

  const advanced = start + list.slice(start, start + limit).length;
  const nextStart = advanced < list.length ? advanced : null;
  if (useCursor) await writeJSON('universe/scan-cursor.json', { next: nextStart == null ? 0 : nextStart, at: new Date().toISOString() }, 0);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, start, processed: batch.length, ...stats, nextStart,
    note: nextStart != null ? `resume: op=universescan&start=${nextStart}` : 'scan complete — run op=universecompile to assemble the expanded candle cache' });
}

// ── op=universecompile — merge expanded shards → candles/expanded.json ──
//
// PURE MERGE (defect #3 — mixed-vintage universe). The old merge Object.assign'd
// shards in network-completion order (a race, not a recency ordering) and stamped
// the compiled doc with a CURRENT document-level timestamp — so a ticker fetched
// two weeks ago read as "built today" to every doc-level freshness check.
// This merge:
//   • is DETERMINISTIC: on a ticker conflict the entry with the newer last bar
//     wins (tie → newer shard fetch time), independent of fetch order;
//   • PRESERVES per-entry provenance: entries carry their own `p` (fetch time,
//     shard time, scope); legacy shards without `p` get one derived from the
//     shard's own `at` — the compile step can only ever attest what the shard
//     attested, NEVER upgrade an entry to the compile date;
//   • reports shard-vintage stats so staleness is visible at the doc level too.
// Doc-level `updatedAt` remains the COMPILE time (it gates whether the doc is
// usable at all); per-entry freshness is adjudicated by lib/cohort-freshness at
// scan time from `lastBarDate` — the field a compile cannot forge.
function mergeShards(shardDocs) {
  const data = {};
  const chosen = new Map();   // ticker → { lastBar, at } of the entry currently kept
  const stats = { shards: 0, entries: 0, conflicts: 0, oldestShardAt: null, newestShardAt: null };
  for (const j of shardDocs) {
    if (!j || !j.data) continue;
    stats.shards++;
    const at = j.at || null;
    if (at) {
      if (!stats.oldestShardAt || at < stats.oldestShardAt) stats.oldestShardAt = at;
      if (!stats.newestShardAt || at > stats.newestShardAt) stats.newestShardAt = at;
    }
    for (const [t, e] of Object.entries(j.data)) {
      if (!e || !Array.isArray(e.c) || !e.c.length) continue;
      const lastBar = (e.c[e.c.length - 1] && e.c[e.c.length - 1][0]) || null;
      const entryAt = (e.p && e.p.f) || at;
      // Never upgrade freshness: an entry without provenance inherits its SHARD's
      // fetch time (the honest upper bound), not the compile time.
      const withProv = e.p ? e : { ...e, p: { f: at, g: at, s: 'expanded', b: null, a: null } };
      const prev = chosen.get(t);
      if (!prev) { data[t] = withProv; chosen.set(t, { lastBar, at: entryAt }); stats.entries++; continue; }
      stats.conflicts++;
      const newer = String(lastBar || '') > String(prev.lastBar || '')
        || (String(lastBar || '') === String(prev.lastBar || '') && String(entryAt || '') > String(prev.at || ''));
      if (newer) { data[t] = withProv; chosen.set(t, { lastBar, at: entryAt }); }
    }
  }
  return { data, stats };
}

async function runUniverseCompile(req, res) {
  const { hasStore } = require('./store');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const { list } = require('@vercel/blob');
  const { writeJSON } = require('./store');

  const blobs = []; let cursor;
  do { const r = await list({ prefix: EXP_SHARD_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const SHARD_RE = /^candles\/expanded\/\d+\.json$/;
  const shardDocs = [];
  await Promise.all(blobs.filter(b => SHARD_RE.test(b.pathname)).map(async b => {
    try { const r = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return; const j = await r.json(); if (j && j.data) shardDocs.push(j); } catch { /* skip */ }
  }));
  const { data, stats } = mergeShards(shardDocs);
  const n = Object.keys(data).length;
  await writeJSON(EXP_CACHE_PATH, {
    updatedAt: Date.now(),                                  // compile time — gates doc usability, NOT entry freshness
    builtDate: new Date().toISOString().slice(0, 10),
    entryFreshness: 'per-entry',                            // consumers must adjudicate per entry (lib/cohort-freshness)
    shardStats: stats,
    n, data,
  }, 0);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, compiledNames: n, shards: blobs.length, shardStats: stats,
    note: `Expanded candle cache assembled (${n} names; shard vintage ${stats.oldestShardAt || '?'} → ${stats.newestShardAt || '?'}). Entry freshness is PER-ENTRY — scans gate on lastBarDate, not this doc's timestamp.` });
}

// ── op=universecurate — Fable review of the ambiguous tail (resumable) ──
async function runUniverseCurate(req, res) {
  const { hasStore, readJSON, writeJSON } = require('./store');
  const { curateBatch } = require('./universe-fable');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });

  const doc = await readJSON(CANDIDATES_PATH, null);
  const list = (doc && doc.tickers) || [];
  if (!list.length) return res.json({ ok: false, error: 'No candidates — run op=universebuild first.' });

  const start = Math.max(0, parseInt(req.query.start, 10) || 0);
  const limit = Math.max(20, Math.min(150, parseInt(req.query.limit, 10) || 120));
  const batch = list.slice(start, start + limit);

  const flagged = await curateBatch(batch);
  if (flagged == null) return res.json({ ok: false, error: 'Fable curation unavailable (no key / call failed).', start });

  const cur = (await readJSON(CURATION_PATH, null)) || { skip: [], flagged: [], reviewed: 0 };
  const skipSet = new Set((cur.skip || []).map(s => String(s).toUpperCase()));
  for (const f of flagged) if (!skipSet.has(f.ticker)) { skipSet.add(f.ticker); cur.flagged.push(f); }
  cur.skip = [...skipSet];
  cur.reviewed = (cur.reviewed || 0) + batch.length;
  cur.updatedAt = new Date().toISOString();
  await writeJSON(CURATION_PATH, cur, 0);

  const nextStart = start + batch.length < list.length ? start + batch.length : null;
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, start, reviewed: batch.length, skippedThisBatch: flagged.length, totalSkip: cur.skip.length, nextStart,
    note: nextStart != null ? `resume: op=universecurate&start=${nextStart}` : 'curation complete' });
}

module.exports = {
  runUniverseBuild, runUniverseScan, runUniverseCompile, runUniverseCurate, mergeShards,
  CANDIDATES_PATH, CURATION_PATH, EXP_SHARD_PREFIX, EXP_CACHE_PATH, MIN_DOLLAR_VOL, MIN_PRICE, MIN_BARS,
};
