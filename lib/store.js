// Persistent pick log, backed by Vercel Blob. One JSON file per trading day
// under picks/<YYYY-MM-DD>.json holding that day's array of pick records.
//
// Degrades gracefully: with no BLOB_READ_WRITE_TOKEN (store not yet provisioned)
// reads return [] and writes throw a clear error, so the rest of the app keeps
// working before the Blob store exists.
const PREFIX = 'picks/';

function hasStore() { return !!process.env.BLOB_READ_WRITE_TOKEN; }

// Overwrite the given day's file with the full pick array (idempotent per day).
async function writeDay(date, picks) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, picks, savedAt: new Date().toISOString() });
  return put(`${PREFIX}${date}.json`, body, {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 300, // today's file may be rewritten; let edits propagate
  });
}

// Read and flatten every logged pick across all days.
async function readAllPicks() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: PREFIX, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);

  const all = [];
  await Promise.all(blobs.map(async b => {
    try {
      const res = await fetch(b.url, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.picks)) all.push(...j.picks);
    } catch { /* skip unreadable day */ }
  }));
  return all;
}

// ── Apex Runner signal ledger (Module 3 drift detection) ───────────────────
// One JSON file per trading day under apex/<YYYY-MM-DD>.json holding that day's
// array of Apex/Loaded signal records (ticker, score, pillar breakdown, regime,
// entry/pivot/stop). Same Blob store, separate prefix.
const APEX_PREFIX = 'apex/';

async function writeApexDay(date, signals) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, signals, savedAt: new Date().toISOString() });
  return put(`${APEX_PREFIX}${date}.json`, body, {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    cacheControlMaxAge: 300,
  });
}

// Daily ledger files only: apex/YYYY-MM-DD.json. Singleton docs that also live
// under apex/ (model.json, narrative.json, backfill.json) must NOT be read as
// live signals — the backfill seed especially must not pollute live drift health.
const DAILY_RE = /^apex\/\d{4}-\d{2}-\d{2}\.json$/;

async function readAllApex() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: APEX_PREFIX, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);

  const all = [];
  await Promise.all(blobs.filter(b => DAILY_RE.test(b.pathname)).map(async b => {
    try {
      const res = await fetch(b.url, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.signals)) all.push(...j.signals);
    } catch { /* skip unreadable day */ }
  }));
  return all;
}

// ── Ghost Accumulation Index ledger ────────────────────────────────────────
// One JSON file per trading day under ghost/<YYYY-MM-DD>.json holding that day's
// GHOST/STALKING signal records. Kept in its OWN prefix (not apex/) so the
// Phase-2 adaptive engine resolves a clean Ghost-only ledger.
const GHOST_PREFIX = 'ghost/';
const GHOST_DAILY_RE = /^ghost\/\d{4}-\d{2}-\d{2}\.json$/;

async function writeGhostDay(date, signals) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, signals, savedAt: new Date().toISOString() });
  return put(`${GHOST_PREFIX}${date}.json`, body, {
    access: 'public', contentType: 'application/json',
    allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 300,
  });
}

async function readAllGhost() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: GHOST_PREFIX, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);
  const all = [];
  await Promise.all(blobs.filter(b => GHOST_DAILY_RE.test(b.pathname)).map(async b => {
    try {
      const res = await fetch(b.url, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.signals)) all.push(...j.signals);
    } catch { /* skip unreadable day */ }
  }));
  return all;
}

// ── Edge Book ledger (Sleeve A conviction longs + Sleeve B CERN forced-flow) ──
// One JSON file per day under edge/<YYYY-MM-DD>.json holding that day's two-sleeve
// paper book. This is what lets us measure each sleeve's realized beat-SPY rate
// and — the whole overlay thesis — the cross-sleeve return correlation over time.
const EDGE_PREFIX = 'edge/';
const EDGE_DAILY_RE = /^edge\/\d{4}-\d{2}-\d{2}\.json$/;

async function writeEdgeDay(date, picks) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, picks, savedAt: new Date().toISOString() });
  return put(`${EDGE_PREFIX}${date}.json`, body, {
    access: 'public', contentType: 'application/json',
    allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 300,
  });
}

async function readAllEdge() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: EDGE_PREFIX, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);
  const all = [];
  await Promise.all(blobs.filter(b => EDGE_DAILY_RE.test(b.pathname)).map(async b => {
    try {
      const res = await fetch(b.url, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.picks)) all.push(...j.picks);
    } catch { /* skip unreadable day */ }
  }));
  return all;
}

// ── Daily data archive (mention counts + options baselines) ────────────────
// One JSON file per day under archive/<YYYY-MM-DD>.json holding that day's
// per-ticker panel { ticker, mentions, social, options{...} }. This is the
// UNRECOVERABLE data capture — options chains and social-mention counts can't
// be reconstructed historically, so we snapshot them daily.
const ARCHIVE_PREFIX = 'archive/';
const ARCHIVE_DAILY_RE = /^archive\/\d{4}-\d{2}-\d{2}\.json$/;

async function writeArchiveDay(date, records, extra = {}) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, records, ...extra, savedAt: new Date().toISOString() });
  return put(`${ARCHIVE_PREFIX}${date}.json`, body, {
    access: 'public', contentType: 'application/json',
    allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 300,
  });
}

async function readAllArchive() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: ARCHIVE_PREFIX, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => ARCHIVE_DAILY_RE.test(b.pathname)).map(async b => {
    try {
      const res = await fetch(b.url, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.records)) days.push({ date: j.date, records: j.records });
    } catch { /* skip unreadable day */ }
  }));
  return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ── Singleton JSON docs (model versions + weekly narrative) ────────────────
// Small single-file state under apex/, read/written whole.
async function readJSON(path, fallback) {
  if (!hasStore()) return fallback;
  const { list } = require('@vercel/blob');
  try {
    const r = await list({ prefix: path, limit: 1 });
    const hit = r.blobs.find(b => b.pathname === path);
    if (!hit) return fallback;
    // Cache-bust the CDN URL: an overwritten Blob can otherwise serve a stale
    // copy within its cacheControlMaxAge window, which corrupts read-modify-write.
    const url = hit.url + (hit.url.includes('?') ? '&' : '?') + '_=' + Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch { return fallback; }
}
async function writeJSON(path, obj, cacheMaxAge = 60) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  return put(path, JSON.stringify(obj), {
    access: 'public', contentType: 'application/json',
    allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: cacheMaxAge,
  });
}

const MODEL_PATH = 'apex/model.json';        // { versions: [...], activeId }
const NARRATIVE_PATH = 'apex/narrative.json'; // { tag, label, summary, weekOf, updatedAt }
const BACKFILL_PATH = 'apex/backfill.json';   // { signals: [...], stats, generatedAt }
const RESOLVED_PATH = 'apex/resolved.json';   // { "ticker|tier|date": { outcome, r, hold, exitDate } }
const EXITS_PATH = 'apex/exits.json';         // exit-strategy study { summary, selections, generatedAt }
const LONGSHORT_PATH = 'apex/longshort.json'; // market-neutral selection test { fractions, datesUsed, ... }
const PEAD_PATH = 'apex/pead.json';           // post-earnings-drift study
const INSIDER_PATH = 'apex/insider.json';     // EDGAR Form 4 history { updatedAt, tickers:{T:[txs]} }
const FUND_PATH = 'apex/fundamentals.json';   // Finnhub quarterly series { updatedAt, tickers:{T:[{period,sps,eps}]} }
const CERN_PATH = 'apex/cern.json';           // CERN engine state (the moat — never delete the archive)
const readCern = () => readJSON(CERN_PATH, null);
const writeCern = s => writeJSON(CERN_PATH, s, 0);  // single daily writer; freshness matters for the UI

const FADE_PATH = 'apex/fade.json';           // self-improving inverted-V fade engine state (per-stock posteriors)
const FADE_LEDGER = 'fade/';                  // daily live fade signals awaiting resolution (fade/<date>.json)
const FADE_DAILY_RE = /^fade\/\d{4}-\d{2}-\d{2}\.json$/;
const readFade = () => readJSON(FADE_PATH, null);
const writeFade = s => writeJSON(FADE_PATH, s, 0);
const writeFadeDay = (date, signals) => writeJSON(`${FADE_LEDGER}${date}.json`, { date, signals, savedAt: new Date().toISOString() }, 0);
async function readAllFadeDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: FADE_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => FADE_DAILY_RE.test(b.pathname)).map(async b => {
    try {
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.signals)) days.push({ date: j.date || b.pathname.slice(FADE_LEDGER.length, -5), signals: j.signals });
    } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}
async function readAllFade() {
  const days = await readAllFadeDays();
  return days.flatMap(d => d.signals);
}

const TREND_PATH = 'apex/trend-eng.json';     // Trend-Rider per-stock learner state
const TREND_LEDGER = 'trend/';                // daily {light, basket} snapshots (trend/<date>.json)
const TREND_DAILY_RE = /^trend\/\d{4}-\d{2}-\d{2}\.json$/;
const readTrendEng = () => readJSON(TREND_PATH, null);
const writeTrendEng = s => writeJSON(TREND_PATH, s, 0);
const writeTrendDay = (date, obj) => writeJSON(`${TREND_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllTrendDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: TREND_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => TREND_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

const readModel = () => readJSON(MODEL_PATH, { versions: [], activeId: null });
const writeModel = m => writeJSON(MODEL_PATH, m);
const readNarrative = () => readJSON(NARRATIVE_PATH, null);
const writeNarrative = n => writeJSON(NARRATIVE_PATH, n);
const readBackfill = () => readJSON(BACKFILL_PATH, null);
const writeBackfill = b => writeJSON(BACKFILL_PATH, b);
const readResolved = () => readJSON(RESOLVED_PATH, {});
const writeResolved = r => writeJSON(RESOLVED_PATH, r);
const readExits = () => readJSON(EXITS_PATH, null);
const writeExits = e => writeJSON(EXITS_PATH, e);
const readLongShort = () => readJSON(LONGSHORT_PATH, null);
const writeLongShort = e => writeJSON(LONGSHORT_PATH, e);
const readPead = () => readJSON(PEAD_PATH, null);
const writePead = e => writeJSON(PEAD_PATH, e);
const readInsider = () => readJSON(INSIDER_PATH, { tickers: {}, updatedAt: null });
const writeInsider = e => writeJSON(INSIDER_PATH, e, 0);  // no CDN cache — safe read-modify-write under rapid ingest
// Fundamentals are built in batches by a resumable op. To avoid the Blob
// read-modify-write race (a batch reading the shared doc before the previous
// batch's write has propagated → lost updates), each batch writes its OWN shard
// file and the reader AGGREGATES all shards. Sharding = no RMW = no lost updates.
const FUND_SHARD_PREFIX = 'apex/fundshard/';
const FUND_SHARD_RE = /^apex\/fundshard\/[\w.-]+\.json$/;
const writeFundShard = (key, tickersObj) => writeJSON(`${FUND_SHARD_PREFIX}${key}.json`, { tickers: tickersObj, updatedAt: new Date().toISOString() }, 60);
async function readFundamentals() {
  if (!hasStore()) return { tickers: {}, updatedAt: null };
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do { const r = await list({ prefix: FUND_SHARD_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const out = { tickers: {}, updatedAt: null };
  await Promise.all(blobs.filter(b => FUND_SHARD_RE.test(b.pathname)).map(async b => {
    try {
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (j && j.tickers) { Object.assign(out.tickers, j.tickers); if (!out.updatedAt || (j.updatedAt && j.updatedAt > out.updatedAt)) out.updatedAt = j.updatedAt; }
    } catch {}
  }));
  return out;
}

module.exports = {
  hasStore, writeDay, readAllPicks, PREFIX, writeApexDay, readAllApex, APEX_PREFIX,
  writeGhostDay, readAllGhost, GHOST_PREFIX,
  writeEdgeDay, readAllEdge, EDGE_PREFIX,
  writeArchiveDay, readAllArchive, ARCHIVE_PREFIX,
  readModel, writeModel, readNarrative, writeNarrative, readBackfill, writeBackfill,
  readResolved, writeResolved, readExits, writeExits, readLongShort, writeLongShort, readPead, writePead,
  readInsider, writeInsider, readFundamentals, writeFundShard, readCern, writeCern,
  readFade, writeFade, writeFadeDay, readAllFade, readAllFadeDays, FADE_LEDGER,
  readTrendEng, writeTrendEng, writeTrendDay, readAllTrendDays, TREND_LEDGER,
  readJSON, writeJSON,   // generic Blob doc helpers (used by the trade-alert ops)
};
