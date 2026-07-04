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
      const res = await fetch(b.url, { cache: 'no-store' });
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
    try { const res = await fetch(b.url, { cache: 'no-store' }); if (!res.ok) return; const j = await res.json();
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

module.exports = {
  hasStore, writeDay, readAllPicks, PREFIX, writeApexDay, readAllApex, APEX_PREFIX,
  writeCoreDay, readAllCore, CORE_PREFIX,
  readCoreFeatures, writeCoreFeatures, readCoreState, writeCoreState,
  readCoreResolved, writeCoreResolved, readCoreBook, writeCoreBook,
  writeGhostDay, readAllGhost, GHOST_PREFIX,
  writeToneDay, readAllTone, readToneCache, writeToneCache, TONE_PREFIX,
  writeEdgeDay, readAllEdge, EDGE_PREFIX,
  writeArchiveDay, readAllArchive, ARCHIVE_PREFIX,
  readModel, writeModel, readNarrative, writeNarrative, readBackfill, writeBackfill,
  readResolved, writeResolved, readExits, writeExits, readLongShort, writeLongShort, readPead, writePead,
  readInsider, writeInsider, readFundamentals, writeFundShard, readCern, writeCern,
  readFade, writeFade, writeFadeDay, readAllFade, readAllFadeDays, FADE_LEDGER,
  readTrendEng, writeTrendEng, writeTrendDay, readAllTrendDays, TREND_LEDGER,
  readDaytradeEng, writeDaytradeEng, writeDaytradeDay, readAllDaytradeDays, DAYTRADE_LEDGER,
  readConfluenceEng, writeConfluenceEng, writeConfluenceDay, readAllConfluenceDays, CONFLUENCE_LEDGER,
  writeCoilDay, readAllCoilDays, COIL_LEDGER,
  writeGapDay, readAllGapDays, GAP_LEDGER,
  writeTimingDay, readAllTimingDays, TIMING_LEDGER,
  writePredictDay, readAllPredictDays, PREDICT_LEDGER,
  writePredmktDay, readAllPredmktDays, PREDMKT_LEDGER,
  readSharpEvents, writeSharpEvents,
  writeBriefDay, readAllBriefDays, BRIEF_LEDGER,
  readNotifyFeed, writeNotifyFeed,
  writeCStudyDay, readAllCStudyDays, CSTUDY_LEDGER,
  readJSON, writeJSON,   // generic Blob doc helpers (used by the trade-alert ops)
};
