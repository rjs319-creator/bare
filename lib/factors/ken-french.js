'use strict';
// KEN FRENCH DATA LIBRARY LOADER (port of pandas-datareader's famafrench reader).
//
// Fetches the Dartmouth daily zips for the Fama-French 5 factors (2x3) and the momentum
// factor, inflates them, parses the CSV (prose preamble → header row → YYYYMMDD rows →
// blank line → copyright), validates, and merges them into ONE daily table cached in
// Blob at `factors/ff5mom-daily.json`. No key, no dependency.
//
// PUBLICATION LAG. French publishes with a ~1-month lag (the file created 2026-09-24
// ends 2026-08-31). The cache doc carries `lagDays` and a `stale` flag so the Scoreboard
// can say which windows French factors cover and which are carried by the ETF proxies
// (lib/factors/etf-proxies.js). Refreshed weekly by a nightly step (op=factorsrefresh);
// a refresh that fails writes nothing — the previous doc stays authoritative.
//
// Data terms: the French library permits research use; nothing here redistributes the
// raw files — the cache is a private, derived table.
const { unzipFirstEntry } = require('./zip-inflate');

const FACTOR_CACHE_VERSION = 'ff5mom-cache-v1';
const FACTOR_CACHE_PATH = 'factors/ff5mom-daily.json';
const FRENCH_BASE = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/';
const DATASETS = Object.freeze({ ff5: 'F-F_Research_Data_5_Factors_2x3_daily', mom: 'F-F_Momentum_Factor_daily' });
const FACTOR_KEYS = Object.freeze(['mktRf', 'smb', 'hml', 'rmw', 'cma', 'mom', 'rf']);
const COLUMN_MAP = Object.freeze({ 'Mkt-RF': 'mktRf', SMB: 'smb', HML: 'hml', RMW: 'rmw', CMA: 'cma', RF: 'rf', Mom: 'mom', MOM: 'mom' });
const MISSING_SENTINELS = new Set(['-99.99', '-999']);
const HISTORY_FROM = '2015-01-01';        // what the Scoreboard needs; the full 1963+ file is not
const REFRESH_INTERVAL_DAYS = 7;
const EXPECTED_LAG_DAYS = 45;             // normal cadence is ~30; beyond this the doc is `stale`
const FETCH_TIMEOUT_MS = 20000;           // measured: 150 KB zip, ~1-2 s from Vercel
const MS_PER_DAY = 86400000;
const MIN_ROWS = 100;

const datasetUrl = (key) => `${FRENCH_BASE}${DATASETS[key]}_CSV.zip`;
const toIsoDate = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
const daysBetween = (fromIso, toDate) => Math.round((toDate.getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / MS_PER_DAY);

function parseValue(raw) {
  const s = raw.trim();
  if (!s || MISSING_SENTINELS.has(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// First daily table in the file: { columns: [mapped keys], rows: [{date, values}] }.
function parseFrenchCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  const headerIdx = lines.findIndex(l => /^\s*,\s*[A-Za-z]/.test(l));
  if (headerIdx < 0) throw new Error('ken-french: no factor table header row found in body');
  const columns = lines[headerIdx].split(',').slice(1).map(c => COLUMN_MAP[c.trim()] || c.trim());
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;                                  // blank line ends the daily table
    const cells = line.split(',');
    const d = cells[0].trim();
    if (!/^\d{8}$/.test(d)) throw new Error(`ken-french: unexpected row ${JSON.stringify(line.slice(0, 40))}`);
    rows.push({ date: toIsoDate(d), values: cells.slice(1).map(parseValue) });
  }
  return { columns, rows };
}

// Inner join FF5 and MOM on date → compact rows [date, ...FACTOR_KEYS] in canonical order.
function mergeFactorTables(ff5, mom, { from = null } = {}) {
  const momIdx = mom.columns.indexOf('mom');
  if (momIdx < 0) throw new Error('ken-french: momentum table lacks a Mom column');
  const momByDate = new Map(mom.rows.map(r => [r.date, r.values[momIdx]]));
  const col = Object.fromEntries(ff5.columns.map((c, i) => [c, i]));
  for (const k of ['mktRf', 'smb', 'hml', 'rmw', 'cma', 'rf']) if (col[k] == null) throw new Error(`ken-french: FF5 table lacks ${k}`);
  const rows = [];
  for (const r of ff5.rows) {
    if (from && r.date < from) continue;
    if (!momByDate.has(r.date)) continue;
    rows.push([r.date, r.values[col.mktRf], r.values[col.smb], r.values[col.hml], r.values[col.rmw], r.values[col.cma], momByDate.get(r.date), r.values[col.rf]]);
  }
  return { factors: [...FACTOR_KEYS], rows };
}

function buildCacheDoc(table, { now = new Date() } = {}) {
  const lastDate = table.rows.length ? table.rows[table.rows.length - 1][0] : null;
  const lagDays = lastDate ? daysBetween(lastDate, now) : null;
  return {
    version: FACTOR_CACHE_VERSION,
    source: 'Kenneth R. French Data Library (Dartmouth) — F-F_Research_Data_5_Factors_2x3_daily + F-F_Momentum_Factor_daily',
    units: 'percent per day',
    fetchedAt: now.toISOString(),
    firstDate: table.rows.length ? table.rows[0][0] : null,
    lastDate,
    lagDays,
    stale: lagDays == null || lagDays > EXPECTED_LAG_DAYS,
    expectedLagDays: EXPECTED_LAG_DAYS,
    factors: [...table.factors],
    rows: table.rows,
  };
}

function validateCacheDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { valid: false, errors: ['not an object'] };
  if (doc.version !== FACTOR_CACHE_VERSION) errors.push('version mismatch');
  if (!Array.isArray(doc.factors) || doc.factors.join() !== FACTOR_KEYS.join()) errors.push('factor order mismatch');
  if (!Array.isArray(doc.rows) || !doc.rows.length) errors.push('rows missing');
  else if (doc.rows.some(r => !Array.isArray(r) || r.length !== FACTOR_KEYS.length + 1 || !/^\d{4}-\d{2}-\d{2}$/.test(r[0]))) errors.push('row shape invalid');
  if (typeof doc.lastDate !== 'string') errors.push('lastDate missing');
  return { valid: errors.length === 0, errors };
}

function needsRefresh(doc, { now = new Date(), force = false } = {}) {
  if (force || !doc || typeof doc.fetchedAt !== 'string') return true;
  const age = (now.getTime() - new Date(doc.fetchedAt).getTime()) / MS_PER_DAY;
  return !Number.isFinite(age) || age >= REFRESH_INTERVAL_DAYS;
}

async function fetchFrenchDataset(key, { fetchImpl } = {}) {
  const url = datasetUrl(key);
  const r = await fetchImpl(url, { timeoutMs: FETCH_TIMEOUT_MS, headers: { 'User-Agent': 'market-news-app factor loader' } });
  if (!r || !r.ok) throw new Error(`ken-french: ${DATASETS[key]} HTTP ${r ? r.status : 'no response'}`);
  const { text } = unzipFirstEntry(Buffer.from(await r.arrayBuffer()));
  return parseFrenchCsv(text);
}

async function fetchFF5Mom({ fetchImpl, from = HISTORY_FROM, minRows = MIN_ROWS } = {}) {
  const [ff5, mom] = await Promise.all([fetchFrenchDataset('ff5', { fetchImpl }), fetchFrenchDataset('mom', { fetchImpl })]);
  const table = mergeFactorTables(ff5, mom, { from });
  if (table.rows.length < minRows) throw new Error(`ken-french: only ${table.rows.length} merged rows (<${minRows}) — refusing to cache`);
  return table;
}

// Weekly refresh. `store` = { readJSON, writeJSON } (lib/store.js shape). Fails closed:
// any vendor/parse error leaves the existing doc untouched and is reported, not thrown.
async function refreshFactorCache({ store, fetchImpl = defaultFetch, now = () => new Date(), force = false, minRows = MIN_ROWS } = {}) {
  const current = await store.readJSON(FACTOR_CACHE_PATH, null).catch(() => null);
  if (!needsRefresh(current, { now: now(), force })) {
    return { refreshed: false, reason: `inside the ${REFRESH_INTERVAL_DAYS}-day cadence (fetched ${current.fetchedAt})`, lastDate: current.lastDate, lagDays: current.lagDays };
  }
  try {
    const table = await fetchFF5Mom({ fetchImpl, minRows });
    const doc = buildCacheDoc(table, { now: now() });
    const v = validateCacheDoc(doc);
    if (!v.valid) return { refreshed: false, error: `built doc invalid: ${v.errors.join('; ')}` };
    await store.writeJSON(FACTOR_CACHE_PATH, doc, 300);
    return { refreshed: true, rows: doc.rows.length, firstDate: doc.firstDate, lastDate: doc.lastDate, lagDays: doc.lagDays, stale: doc.stale };
  } catch (e) {
    return { refreshed: false, error: String((e && e.message) || e), previousLastDate: current ? current.lastDate : null };
  }
}

// Validated read of the cached table (null when absent/invalid — callers fall back to proxies).
async function loadFactorTable(store) {
  const doc = await store.readJSON(FACTOR_CACHE_PATH, null).catch(() => null);
  return doc && validateCacheDoc(doc).valid ? doc : null;
}

function defaultFetch(url, opts) { return require('../http').fetchWithTimeout(url, opts); }

module.exports = {
  FACTOR_CACHE_VERSION, FACTOR_CACHE_PATH, FACTOR_KEYS, DATASETS, HISTORY_FROM, REFRESH_INTERVAL_DAYS, EXPECTED_LAG_DAYS,
  datasetUrl, parseFrenchCsv, mergeFactorTables, buildCacheDoc, validateCacheDoc, needsRefresh,
  fetchFrenchDataset, fetchFF5Mom, refreshFactorCache, loadFactorTable,
};
