// Persistent pick log, backed by Vercel Blob. One JSON file per trading day
// under picks/<YYYY-MM-DD>.json holding that day's array of pick records.
//
// Degrades gracefully: with no BLOB_READ_WRITE_TOKEN (store not yet provisioned)
// reads return [] and writes throw a clear error, so the rest of the app keeps
// working before the Blob store exists.
const PREFIX = 'picks/';

function hasStore() { return !!process.env.BLOB_READ_WRITE_TOKEN; }

// Overwrite the given day's file with the full pick array (idempotent per day).
// sp500 = the S&P 500 (SPY) closing level that day, stored as a permanent market
// anchor alongside the picks (optional; null when unavailable).
async function writeDay(date, picks, sp500 = null) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, picks, sp500, savedAt: new Date().toISOString() });
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
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.picks)) all.push(...j.picks);
    } catch { /* skip unreadable day */ }
  }));
  return all;
}

// Count records in a single day's ledger file (picks[] or signals[]). Returns -1
// when the file is absent or unreadable. Used to guard against a DEGRADED run
// (a data-source threw) overwriting a more complete existing snapshot — see the
// safeToWrite guard in apex-routes. Cache-busts so it reads the freshest copy.
async function readDayCount(prefix, date) {
  if (!hasStore()) return -1;
  const { list } = require('@vercel/blob');
  const path = `${prefix}${date}.json`;
  try {
    const r = await list({ prefix: path, limit: 1 });
    const b = (r.blobs || []).find(x => x.pathname === path);
    if (!b) return -1;
    const res = await fetch(b.url + (b.url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return -1;
    const j = await res.json();
    const arr = Array.isArray(j.picks) ? j.picks : (Array.isArray(j.signals) ? j.signals : null);
    return arr ? arr.length : -1;
  } catch { return -1; }
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
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
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
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
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
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
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
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.records)) days.push({ date: j.date, records: j.records });
    } catch { /* skip unreadable day */ }
  }));
  return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ── Earnings-call tone (roadmap Step 3) ────────────────────────────────────
// Daily ledger of tone-scored picks for the Scoreboard (tone/<date>.json), plus a
// permanent per-call cache (tone/cache/<sym>-<period>.json) so a call is scored once.
const TONE_PREFIX = 'tone/';
const TONE_DAILY_RE = /^tone\/\d{4}-\d{2}-\d{2}\.json$/;   // excludes tone/cache/*

async function writeToneDay(date, signals) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, signals, savedAt: new Date().toISOString() });
  return put(`${TONE_PREFIX}${date}.json`, body, {
    access: 'public', contentType: 'application/json',
    allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 300,
  });
}

async function readAllTone() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: TONE_PREFIX, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);
  const all = [];
  await Promise.all(blobs.filter(b => TONE_DAILY_RE.test(b.pathname)).map(async b => {
    try {
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.signals)) all.push(...j.signals);
    } catch { /* skip unreadable day */ }
  }));
  return all;
}
// Permanent per-call cache (never re-score the same earnings call).
const readToneCache = key => readJSON(`${TONE_PREFIX}cache/${key}.json`, null);
const writeToneCache = (key, obj) => writeJSON(`${TONE_PREFIX}cache/${key}.json`, obj, 0);

// ── Fast-vs-sticky attention (roadmap Step 4) ──────────────────────────────
// Daily ledger of Sticky/Fast-classified names for the Scoreboard.
const ATTN_PREFIX = 'attention/';
const ATTN_DAILY_RE = /^attention\/\d{4}-\d{2}-\d{2}\.json$/;

async function writeAttentionDay(date, signals) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, signals, savedAt: new Date().toISOString() });
  return put(`${ATTN_PREFIX}${date}.json`, body, {
    access: 'public', contentType: 'application/json',
    allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 300,
  });
}

async function readAllAttention() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = [];
  let cursor;
  do {
    const r = await list({ prefix: ATTN_PREFIX, cursor, limit: 1000 });
    blobs.push(...r.blobs);
    cursor = r.cursor;
  } while (cursor);
  const all = [];
  await Promise.all(blobs.filter(b => ATTN_DAILY_RE.test(b.pathname)).map(async b => {
    try {
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j.signals)) all.push(...j.signals);
    } catch { /* skip unreadable day */ }
  }));
  return all;
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

// Day-Trade momentum/rel-vol screener: per-stock learner state + daily pick ledger.
const DAYTRADE_PATH = 'apex/daytrade-eng.json';
const DAYTRADE_LEDGER = 'daytrade/';            // daily picks (daytrade/<date>.json)
const DAYTRADE_DAILY_RE = /^daytrade\/\d{4}-\d{2}-\d{2}\.json$/;
const readDaytradeEng = () => readJSON(DAYTRADE_PATH, null);
const writeDaytradeEng = s => writeJSON(DAYTRADE_PATH, s, 0);
const writeDaytradeDay = (date, obj) => writeJSON(`${DAYTRADE_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllDaytradeDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: DAYTRADE_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => DAYTRADE_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// ── Fader-regime intraday capture (5-min session bars for day-trade picks) ──
// One doc per completed session under intraday/<date>.json, tagged with the session's
// macro regime, so the regime-conditional opening-range-gate hypothesis can be
// re-validated once neutral/risk-off fader days accrue. See lib/intraday-capture.js.
const INTRADAY_LEDGER = 'intraday/';
const INTRADAY_DAILY_RE = /^intraday\/\d{4}-\d{2}-\d{2}\.json$/;
const writeIntradayDay = (date, obj) => writeJSON(`${INTRADAY_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllIntradayDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: INTRADAY_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => INTRADAY_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; days.push(await res.json()); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Confluence screener (5 classic strategies): per-stock learner state + daily ledger.
// Per-strategy learned weights live in apex/confluence-strat.json via readJSON/writeJSON.
const CONFLUENCE_PATH = 'apex/confluence-eng.json';
const CONFLUENCE_LEDGER = 'confluence/';
const CONFLUENCE_DAILY_RE = /^confluence\/\d{4}-\d{2}-\d{2}\.json$/;
const readConfluenceEng = () => readJSON(CONFLUENCE_PATH, null);
const writeConfluenceEng = s => writeJSON(CONFLUENCE_PATH, s, 0);
const writeConfluenceDay = (date, obj) => writeJSON(`${CONFLUENCE_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllConfluenceDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: CONFLUENCE_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => CONFLUENCE_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Coil Radar: daily ledger of logged pre-explosion picks, auto-resolved against the
// abnormal-break outcome so the calibrated probability self-validates (coil/<date>.json).
const COIL_LEDGER = 'coil/';
const COIL_DAILY_RE = /^coil\/\d{4}-\d{2}-\d{2}\.json$/;
const writeCoilDay = (date, obj) => writeJSON(`${COIL_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllCoilDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: COIL_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => COIL_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Down-Day Mode: daily ledger of oversold-bounce longs logged on red tapes, auto-resolved
// forward (3-session excess vs SPY) so the red-day reversion edge self-confirms (downday/<date>.json).
const DOWNDAY_LEDGER = 'downday/';
const DOWNDAY_DAILY_RE = /^downday\/\d{4}-\d{2}-\d{2}\.json$/;
const writeDownDay = (date, obj) => writeJSON(`${DOWNDAY_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllDownDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: DOWNDAY_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => DOWNDAY_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Gap-Down Continuation: daily ledger of logged gap-down SHORT picks, auto-resolved forward
// (3-session SHORT excess vs SPY) so the mirror-of-Gap&Go edge self-confirms (gapdown/<date>.json).
const GAPDOWN_LEDGER = 'gapdown/';
const GAPDOWN_DAILY_RE = /^gapdown\/\d{4}-\d{2}-\d{2}\.json$/;
const writeGapDownDay = (date, obj) => writeJSON(`${GAPDOWN_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllGapDownDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: GAPDOWN_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => GAPDOWN_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Gap-and-Go: daily ledger of logged unscheduled gap-up picks, auto-resolved forward
// (3-session excess vs SPY) so the validated event edge self-confirms live (gap/<date>.json).
const GAP_LEDGER = 'gap/';
const GAP_DAILY_RE = /^gap\/\d{4}-\d{2}-\d{2}\.json$/;
const writeGapDay = (date, obj) => writeJSON(`${GAP_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllGapDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: GAP_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => GAP_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Read-Through: daily ledger of surfaced second-order beneficiaries (counterfactual archive
// — every surfaced name logged, Fresh or Moved). The dated regex excludes the latest.json
// serve-cache which shares the readthrough/ prefix. Resolved via the Scoreboard.
const RT_LEDGER = 'readthrough/';
const RT_DAILY_RE = /^readthrough\/\d{4}-\d{2}-\d{2}\.json$/;
const writeReadThroughDay = (date, obj) => writeJSON(`${RT_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllReadThroughDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: RT_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => RT_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Anomaly-First: daily ledger of no-news movers investigated by the AI (Accumulation /
// Explained / Noise). Dated regex excludes the latest.json serve-cache. Scoreboard-resolved.
const ANOM_LEDGER = 'anomaly/';
const ANOM_DAILY_RE = /^anomaly\/\d{4}-\d{2}-\d{2}\.json$/;
const writeAnomalyDay = (date, obj) => writeJSON(`${ANOM_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllAnomalyDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: ANOM_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => ANOM_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Biotech Radar: daily ledger of surfaced biotech runners with their /100 score-tier
// (Hot / Emerging / Watch). Benchmarked vs XBI. Dated regex excludes the latest.json serve-cache.
const BIO_LEDGER = 'biotech/';
const BIO_DAILY_RE = /^biotech\/\d{4}-\d{2}-\d{2}\.json$/;
const writeBiotechDay = (date, obj) => writeJSON(`${BIO_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllBiotechDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: BIO_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => BIO_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Second Wave: daily ledger of first-leg movers forecast for a reflexive second wave
// (Primed / Early / Faded). Dated regex excludes the latest.json serve-cache.
const SW_LEDGER = 'secondwave/';
const SW_DAILY_RE = /^secondwave\/\d{4}-\d{2}-\d{2}\.json$/;
const writeSecondWaveDay = (date, obj) => writeJSON(`${SW_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllSecondWaveDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: SW_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => SW_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Cross-Asset: daily ledger of US stocks with a leading cross-asset tell (Lead/Inline/Weak).
const CA_LEDGER = 'crossasset/';
const CA_DAILY_RE = /^crossasset\/\d{4}-\d{2}-\d{2}\.json$/;
const writeCrossAssetDay = (date, obj) => writeJSON(`${CA_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllCrossAssetDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: CA_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => CA_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Tone Shift: daily ledger of earnings-call tone DELTAs vs the prior quarter (Brightening/
// Stable/Darkening).
const TS_LEDGER = 'toneshift/';
const TS_DAILY_RE = /^toneshift\/\d{4}-\d{2}-\d{2}\.json$/;
const writeToneShiftDay = (date, obj) => writeJSON(`${TS_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllToneShiftDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: TS_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => TS_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Dual-horizon read: daily ledger of the trending universe tagged with its
// short×long quadrant, so the "pullback-buy vs bear-bounce" read is ACCOUNTABLE —
// resolved to forward excess-vs-SPY by quadrant via op=dualreadbook.
const DUALREAD_LEDGER = 'dualread/day/';
const DUALREAD_DAILY_RE = /^dualread\/day\/\d{4}-\d{2}-\d{2}\.json$/;
const writeDualReadDay = (date, picks) => writeJSON(`${DUALREAD_LEDGER}${date}.json`, { date, picks, savedAt: new Date().toISOString() }, 0);
async function readAllDualReadDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: DUALREAD_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => DUALREAD_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Dual-read backfill: SHARDED point-in-time replay rows (one shard per build batch,
// keyed by scope+start). Sharded — not a single doc — to avoid the Blob
// read-modify-write race that loses updates on rapid batches (same fix as the
// fundamentals build). readDualReadBackfillRows lists + merges + dedups all shards.
const DUALREAD_BF_PREFIX = 'dualread/backfill/';
const DUALREAD_BF_RE = /^dualread\/backfill\/[\w.-]+\.json$/;
const writeDualReadShard = (key, obj) => writeJSON(`${DUALREAD_BF_PREFIX}${key}.json`, { ...obj, updatedAt: new Date().toISOString() }, 0);
async function readDualReadBackfillRows() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: DUALREAD_BF_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const merged = []; const seen = new Set();
  await Promise.all(blobs.filter(b => DUALREAD_BF_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json();
      for (const r of (j && j.rows) || []) { const k = `${r.ticker}|${r.date}`; if (!seen.has(k)) { seen.add(k); merged.push(r); } } } catch { /* skip shard */ }
  }));
  return merged;
}

// Dual Confirmed: daily ledger of the both-horizons-aligned picks (entry price +
// conviction) so the tab is ACCOUNTABLE — resolved to forward excess-vs-SPY by
// op=alignedbook.
const ALIGNED_LEDGER = 'aligned/day/';
const ALIGNED_DAILY_RE = /^aligned\/day\/\d{4}-\d{2}-\d{2}\.json$/;
const writeAlignedDay = (date, picks) => writeJSON(`${ALIGNED_LEDGER}${date}.json`, { date, picks, savedAt: new Date().toISOString() }, 0);
async function readAllAlignedDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: ALIGNED_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => ALIGNED_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Timing light: daily ledger of graded picks (grade + factor values + entry price) so the
// entry-timing grade is ACCOUNTABLE — resolved to forward returns by op=timingbook.
const TIMING_LEDGER = 'timing/';
const TIMING_DAILY_RE = /^timing\/\d{4}-\d{2}-\d{2}\.json$/;
const writeTimingDay = (date, obj) => writeJSON(`${TIMING_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllTimingDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: TIMING_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => TIMING_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Forecast: daily ledger of falsifiable, auto-resolved predictions (predict/<date>.json).
const PREDICT_LEDGER = 'predict/';
const PREDICT_DAILY_RE = /^predict\/\d{4}-\d{2}-\d{2}\.json$/;
const writePredictDay = (date, obj) => writeJSON(`${PREDICT_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllPredictDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: PREDICT_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => PREDICT_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Crowd: daily snapshots of prediction-market 24h volume (predmkt/<date>.json),
// used to build a per-market baseline so "unusual" volume becomes meaningful.
const PREDMKT_LEDGER = 'predmkt/';
const PREDMKT_DAILY_RE = /^predmkt\/\d{4}-\d{2}-\d{2}\.json$/;
const writePredmktDay = (date, obj) => writeJSON(`${PREDMKT_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllPredmktDays(limitDays = 21) {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: PREDMKT_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const recent = blobs.filter(b => PREDMKT_DAILY_RE.test(b.pathname)).sort((a, b) => (a.pathname < b.pathname ? 1 : -1)).slice(0, limitDays);
  const days = [];
  await Promise.all(recent.map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; days.push(await res.json()); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Brief validation ledger — daily snapshot of the Prediction Brief's stance + the
// SPY close at that moment, auto-graded forward (brief/<date>.json).
const BRIEF_LEDGER = 'brief/';
const BRIEF_DAILY_RE = /^brief\/\d{4}-\d{2}-\d{2}\.json$/;
const writeBriefDay = (date, obj) => writeJSON(`${BRIEF_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllBriefDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: BRIEF_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => BRIEF_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; days.push(await res.json()); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Crowd-leads study — daily log of themed crowd swings + the implicated sector's
// expected direction, auto-graded forward against the sector ETF (cstudy/<date>.json).
const CSTUDY_LEDGER = 'cstudy/';
const CSTUDY_DAILY_RE = /^cstudy\/\d{4}-\d{2}-\d{2}\.json$/;
const writeCStudyDay = (date, obj) => writeJSON(`${CSTUDY_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllCStudyDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: CSTUDY_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => CSTUDY_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; days.push(await res.json()); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

// Predict alerts feed — durable, cron-fed notifications (sharp flags, stance flips,
// major crowd swings). Distinct from the X-ingest 'alerts/' namespace. Single doc.
const NOTIFY_PATH = 'notify/feed.json';
const readNotifyFeed = () => readJSON(NOTIFY_PATH, { items: [] });
const writeNotifyFeed = obj => writeJSON(NOTIFY_PATH, obj, 0);

// Sharp-money event log — a rolling record of flagged informed-activity events so
// they persist (and stay visible) even after the live flag fades. Single doc.
const SHARP_EVENTS_PATH = 'sharp/events.json';
const readSharpEvents = () => readJSON(SHARP_EVENTS_PATH, { events: [] });
const writeSharpEvents = obj => writeJSON(SHARP_EVENTS_PATH, obj, 0);

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

// ── Core Momentum ledger (the survivorship-safe small/mid sector-neutral 12-1 sleeve) ──
// One JSON file per quarterly rebalance under core/<YYYY-MM-DD>.json holding that book's
// signals. Singleton caches (features/buildstate/resolved/book) also live under core/ but
// are excluded from the daily-ledger read so they never pollute live drift health.
const CORE_PREFIX = 'core/';
const CORE_DAILY_RE = /^core\/\d{4}-\d{2}-\d{2}\.json$/;
const CORE_FEATURES = 'core/features.json';     // { updatedAt, names: { SYM: {sector,marketCap,m121,vol63,adv20,price,asOf} } }
const CORE_STATE = 'core/buildstate.json';      // { universeAsOf, symbols:[...], cursor }
const CORE_RESOLVED = 'core/resolved.json';     // { "ticker|date": { outcome, r, hold, exitDate } }
const CORE_BOOK = 'core/book.json';             // last computed book snapshot (for fast tab reads)

async function writeCoreDay(date, signals, extra = {}) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  const { put } = require('@vercel/blob');
  const body = JSON.stringify({ date, signals, ...extra, savedAt: new Date().toISOString() });
  return put(`${CORE_PREFIX}${date}.json`, body, {
    access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 300,
  });
}
async function readAllCore() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: CORE_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const all = [];
  await Promise.all(blobs.filter(b => CORE_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json();
      if (Array.isArray(j.signals)) all.push(...j.signals.map(s => ({ ...s, date: s.date || j.date }))); } catch { /* skip */ }
  }));
  return all;
}
const readCoreFeatures = () => readJSON(CORE_FEATURES, null);
const writeCoreFeatures = o => writeJSON(CORE_FEATURES, o, 0);
const readCoreState = () => readJSON(CORE_STATE, null);
const writeCoreState = o => writeJSON(CORE_STATE, o, 0);
const readCoreResolved = () => readJSON(CORE_RESOLVED, {});
const writeCoreResolved = o => writeJSON(CORE_RESOLVED, o, 0);
const readCoreBook = () => readJSON(CORE_BOOK, null);
const writeCoreBook = o => writeJSON(CORE_BOOK, o, 60);

// ── EVOLVE — Adaptive Pre-Move Discovery Engine ──────────────────────────────
// The daily ledger (evolve/<date>.json) holds that day's feature snapshots +
// predictions + the point-in-time regime vector together (they are 1:1 per prediction
// and the regime is one row/day) — so evolve_feature_snapshots + evolve_predictions +
// evolve_regime_snapshots are one physical doc, read back as full day objects. The
// singleton docs cover the rest of the schema: resolved event-labels, aggregated
// specialist performance, the versioned model registry + calibrator, the drift log,
// and the experiment log. Follows the app's existing writeXDay/readModel conventions.
const EVOLVE_PREFIX = 'evolve/';
const EVOLVE_DAILY_RE = /^evolve\/\d{4}-\d{2}-\d{2}\.json$/;
async function writeEvolveDay(date, obj) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  return writeJSON(`${EVOLVE_PREFIX}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
}
async function readEvolveDay(date) { return readJSON(`${EVOLVE_PREFIX}${date}.json`, null); }
async function readAllEvolveDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: EVOLVE_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => EVOLVE_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (res.ok) days.push(await res.json()); }
    catch { /* skip unreadable day */ }
  }));
  return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}
const EVOLVE_MODEL_PATH = 'evolve/model.json';       // { versions:[], activeId, calibrator }
const EVOLVE_PERF_PATH = 'evolve/specialist-perf.json'; // aggregated specialist_performance
const EVOLVE_RESOLVED_PATH = 'evolve/resolved.json'; // event_labels keyed by prediction id
const EVOLVE_DRIFT_PATH = 'evolve/drift.json';       // drift_events log { events:[] }
const EVOLVE_EXPERIMENTS_PATH = 'evolve/experiments.json'; // experiments log
const readEvolveModel = () => readJSON(EVOLVE_MODEL_PATH, { versions: [], activeId: null, calibrator: null });
const writeEvolveModel = m => writeJSON(EVOLVE_MODEL_PATH, m, 0);
const readEvolvePerf = () => readJSON(EVOLVE_PERF_PATH, { bySpecialist: {}, updatedAt: null });
const writeEvolvePerf = p => writeJSON(EVOLVE_PERF_PATH, p, 0);
const readEvolveResolved = () => readJSON(EVOLVE_RESOLVED_PATH, {});
const writeEvolveResolved = r => writeJSON(EVOLVE_RESOLVED_PATH, r, 0);
const readEvolveDrift = () => readJSON(EVOLVE_DRIFT_PATH, { events: [] });
const writeEvolveDrift = d => writeJSON(EVOLVE_DRIFT_PATH, d, 0);
const readEvolveExperiments = () => readJSON(EVOLVE_EXPERIMENTS_PATH, { experiments: [] });
const writeEvolveExperiments = e => writeJSON(EVOLVE_EXPERIMENTS_PATH, e, 0);

// ── Momentum Ignition ledger (daily ignition picks for EOD Scoreboard tracking) ──
const IGNITION_PREFIX = 'ignition/';
const IGNITION_DAILY_RE = /^ignition\/\d{4}-\d{2}-\d{2}\.json$/;
async function writeIgnitionDay(date, picks) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  return writeJSON(`${IGNITION_PREFIX}${date}.json`, { date, picks, savedAt: new Date().toISOString() }, 0);
}
async function readAllIgnition() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: IGNITION_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const all = [];
  await Promise.all(blobs.filter(b => IGNITION_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (res.ok) { const j = await res.json(); if (Array.isArray(j.picks)) all.push(...j.picks); } }
    catch { /* skip */ }
  }));
  return all;
}

// ── OMEGA-SWING ledger (daily Prime/Qualified/Watch picks for EOD Scoreboard tracking) ──
const OMEGA_PREFIX = 'omega/';
const OMEGA_DAILY_RE = /^omega\/\d{4}-\d{2}-\d{2}\.json$/;
async function writeOmegaDay(date, picks) {
  if (!hasStore()) throw new Error('Blob storage not configured (BLOB_READ_WRITE_TOKEN missing).');
  return writeJSON(`${OMEGA_PREFIX}${date}.json`, { date, picks, savedAt: new Date().toISOString() }, 0);
}
async function readAllOmega() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: OMEGA_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const all = [];
  await Promise.all(blobs.filter(b => OMEGA_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (res.ok) { const j = await res.json(); if (Array.isArray(j.picks)) all.push(...j.picks); } }
    catch { /* skip */ }
  }));
  return all;
}

// Challenger decision layer — SHADOW daily board ledger (shadow/<date>.json), a resolved-
// outcome map (shadow/resolved.json), and an eval cache (shadow/eval.json). Tamper-evident
// hash-chained prediction records live separately in the `challenger` immutable-ledger stream.
const SHADOW_LEDGER = 'shadow/';
const SHADOW_DAILY_RE = /^shadow\/\d{4}-\d{2}-\d{2}\.json$/;
const writeShadowDay = (date, obj) => writeJSON(`${SHADOW_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllShadowDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: SHADOW_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => SHADOW_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}
const readShadowResolved = () => readJSON('shadow/resolved.json', {});
const writeShadowResolved = (m) => writeJSON('shadow/resolved.json', m, 0);
const readShadowEval = () => readJSON('shadow/eval.json', null);
const writeShadowEval = (o) => writeJSON('shadow/eval.json', o, 0);

// ORBIT — SHADOW daily prediction ledger (orbit/<date>.json), a resolved-outcome
// map (orbit/resolved.json), a walk-forward eval cache (orbit/eval.json), and a
// frozen model artifact (orbit/model.json). Tamper-evident records mirror into the
// `orbit` immutable-ledger stream. Fully isolated from production keys.
const ORBIT_LEDGER = 'orbit/';
const ORBIT_DAILY_RE = /^orbit\/\d{4}-\d{2}-\d{2}\.json$/;
const writeOrbitDay = (date, obj) => writeJSON(`${ORBIT_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllOrbitDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: ORBIT_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => ORBIT_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}
const readOrbitResolved = () => readJSON('orbit/resolved.json', {});
const writeOrbitResolved = (m) => writeJSON('orbit/resolved.json', m, 0);
const readOrbitEval = () => readJSON('orbit/eval.json', null);
const writeOrbitEval = (o) => writeJSON('orbit/eval.json', o, 0);
const readOrbitModel = () => readJSON('orbit/model.json', null);
const writeOrbitModel = (o) => writeJSON('orbit/model.json', o, 0);

// ORBIT-ML — SHADOW cross-sectional ranker ledger (orbit-ml/<date>.json), resolved
// outcomes (orbit-ml/resolved.json), frozen ranker artifact (orbit-ml/model.json),
// and walk-forward eval cache (orbit-ml/eval.json). Isolated from production keys.
const ORBIT_ML_LEDGER = 'orbit-ml/';
const ORBIT_ML_DAILY_RE = /^orbit-ml\/\d{4}-\d{2}-\d{2}\.json$/;
const writeOrbitMlDay = (date, obj) => writeJSON(`${ORBIT_ML_LEDGER}${date}.json`, { date, ...obj, savedAt: new Date().toISOString() }, 0);
async function readAllOrbitMlDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: ORBIT_ML_LEDGER, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter(b => ORBIT_ML_DAILY_RE.test(b.pathname)).map(async b => {
    try { const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' }); if (!res.ok) return; const j = await res.json(); days.push(j); } catch { /* skip */ }
  }));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}
const readOrbitMlResolved = () => readJSON('orbit-ml/resolved.json', {});
const writeOrbitMlResolved = (m) => writeJSON('orbit-ml/resolved.json', m, 0);
const readOrbitMlEval = () => readJSON('orbit-ml/eval.json', null);
const writeOrbitMlEval = (o) => writeJSON('orbit-ml/eval.json', o, 0);
const readOrbitMlModel = () => readJSON('orbit-ml/model.json', null);
const writeOrbitMlModel = (o) => writeJSON('orbit-ml/model.json', o, 0);

module.exports = {
  writeOrbitDay, readAllOrbitDays, ORBIT_LEDGER,
  readOrbitResolved, writeOrbitResolved, readOrbitEval, writeOrbitEval, readOrbitModel, writeOrbitModel,
  writeOrbitMlDay, readAllOrbitMlDays, ORBIT_ML_LEDGER,
  readOrbitMlResolved, writeOrbitMlResolved, readOrbitMlEval, writeOrbitMlEval, readOrbitMlModel, writeOrbitMlModel,
  writeShadowDay, readAllShadowDays, SHADOW_LEDGER,
  readShadowResolved, writeShadowResolved, readShadowEval, writeShadowEval,
  writeIgnitionDay, readAllIgnition, IGNITION_PREFIX,
  writeOmegaDay, readAllOmega, OMEGA_PREFIX,
  hasStore, writeDay, readAllPicks, readDayCount, PREFIX, writeApexDay, readAllApex, APEX_PREFIX,
  writeCoreDay, readAllCore, CORE_PREFIX,
  readCoreFeatures, writeCoreFeatures, readCoreState, writeCoreState,
  readCoreResolved, writeCoreResolved, readCoreBook, writeCoreBook,
  writeGhostDay, readAllGhost, GHOST_PREFIX,
  writeToneDay, readAllTone, readToneCache, writeToneCache, TONE_PREFIX,
  writeAttentionDay, readAllAttention, ATTN_PREFIX,
  writeEdgeDay, readAllEdge, EDGE_PREFIX,
  writeArchiveDay, readAllArchive, ARCHIVE_PREFIX,
  readModel, writeModel, readNarrative, writeNarrative, readBackfill, writeBackfill,
  readResolved, writeResolved, readExits, writeExits, readLongShort, writeLongShort, readPead, writePead,
  readInsider, writeInsider, readFundamentals, writeFundShard, readCern, writeCern,
  readFade, writeFade, writeFadeDay, readAllFade, readAllFadeDays, FADE_LEDGER,
  readTrendEng, writeTrendEng, writeTrendDay, readAllTrendDays, TREND_LEDGER,
  readDaytradeEng, writeDaytradeEng, writeDaytradeDay, readAllDaytradeDays, DAYTRADE_LEDGER,
  writeIntradayDay, readAllIntradayDays, INTRADAY_LEDGER,
  readConfluenceEng, writeConfluenceEng, writeConfluenceDay, readAllConfluenceDays, CONFLUENCE_LEDGER,
  writeCoilDay, readAllCoilDays, COIL_LEDGER,
  writeGapDay, readAllGapDays, GAP_LEDGER,
  writeDownDay, readAllDownDays, DOWNDAY_LEDGER,
  writeGapDownDay, readAllGapDownDays, GAPDOWN_LEDGER,
  writeReadThroughDay, readAllReadThroughDays,
  writeAnomalyDay, readAllAnomalyDays,
  writeBiotechDay, readAllBiotechDays,
  writeSecondWaveDay, readAllSecondWaveDays,
  writeCrossAssetDay, readAllCrossAssetDays,
  writeToneShiftDay, readAllToneShiftDays,
  writeTimingDay, readAllTimingDays, TIMING_LEDGER,
  writeDualReadDay, readAllDualReadDays, DUALREAD_LEDGER,
  writeDualReadShard, readDualReadBackfillRows,
  writeAlignedDay, readAllAlignedDays, ALIGNED_LEDGER,
  writePredictDay, readAllPredictDays, PREDICT_LEDGER,
  writePredmktDay, readAllPredmktDays, PREDMKT_LEDGER,
  readSharpEvents, writeSharpEvents,
  writeBriefDay, readAllBriefDays, BRIEF_LEDGER,
  readNotifyFeed, writeNotifyFeed,
  writeCStudyDay, readAllCStudyDays, CSTUDY_LEDGER,
  writeEvolveDay, readEvolveDay, readAllEvolveDays, EVOLVE_PREFIX,
  readEvolveModel, writeEvolveModel, readEvolvePerf, writeEvolvePerf,
  readEvolveResolved, writeEvolveResolved, readEvolveDrift, writeEvolveDrift,
  readEvolveExperiments, writeEvolveExperiments,
  readJSON, writeJSON,   // generic Blob doc helpers (used by the trade-alert ops)
};
