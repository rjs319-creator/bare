'use strict';
// WIKIMEDIA REST PAGEVIEWS → per-article daily series (wiki-pageviews-v1).
//
// GET /metrics/pageviews/per-article/en.wikipedia/all-access/user/{title}/daily/{start}/{end}
// One request per article covers the whole range (history begins 2015-07-01). `user`
// agent type excludes spiders/automata. A 404 means "no data in range" and is recorded
// as an empty series, not an error. Raw series persist as compact [yyyymmdd, views]
// pairs under research/data (gitignored) — the committed artifact is only the study
// summary.

const fs = require('node:fs');
const path = require('node:path');
const { fetchJSON, makeLimiter } = require('./http-polite');

const WIKI_PAGEVIEWS_VERSION = 'wiki-pageviews-v1';
const PAGEVIEWS_BASE = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/';
const HISTORY_START = '20150701';

const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const isoOf = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

// Wikimedia wants spaces as underscores and the title percent-encoded; slashes inside a
// title must be encoded too or they split the path.
function encodeTitle(title) {
  return encodeURIComponent(String(title).trim().replace(/ /g, '_')).replace(/%3A/g, ':');
}

// Pure: API JSON → ascending [[yyyymmdd, views], …]. Exported for tests.
function parsePageviews(json) {
  const items = json && Array.isArray(json.items) ? json.items : [];
  const out = [];
  for (const it of items) {
    const ts = String(it.timestamp || '').slice(0, 8);
    const v = Number(it.views);
    if (!/^\d{8}$/.test(ts) || !Number.isFinite(v) || v < 0) continue;
    out.push([ts, v]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Pure: pairs → Map('YYYY-MM-DD' → views). Exported for the study.
function toDailyMap(pairs) {
  return new Map((pairs || []).map(([ts, v]) => [isoOf(ts), v]));
}

async function fetchArticleSeries(title, { start = HISTORY_START, end = yyyymmdd(new Date()), fetchImpl } = {}) {
  const url = `${PAGEVIEWS_BASE}${encodeTitle(title)}/daily/${start}/${end}`;
  const r = await fetchJSON(url, { fetchImpl });
  if (r.status === 404) return { title, ok: true, status: 404, days: [] };
  if (!r.ok) return { title, ok: false, status: r.status, days: [] };
  return { title, ok: true, status: r.status, days: parsePageviews(r.json) };
}

// Materialize { TICKER: title } into outDir/<TICKER>.json. Existing files are kept
// unless `refresh`. Never throws on a single article.
async function materialize(tickerToTitle, outDir, { refresh = false, concurrency = 2, minSpacingMs = 400, onProgress = null, fetchImpl, end } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const limit = makeLimiter({ concurrency, minSpacingMs });
  const counts = { requested: Object.keys(tickerToTitle).length, written: 0, skipped: 0, empty: 0, failed: 0 };
  const failures = [];
  await Promise.all(Object.entries(tickerToTitle).map(([ticker, title]) => limit(async () => {
    const file = path.join(outDir, `${ticker}.json`);
    if (!refresh && fs.existsSync(file)) { counts.skipped++; return; }
    let r;
    try { r = await fetchArticleSeries(title, { fetchImpl, end }); }
    catch (e) { r = { ok: false, status: String((e && e.message) || e), days: [] }; }
    if (!r.ok) { counts.failed++; failures.push({ ticker, title, status: r.status }); return; }
    if (!r.days.length) counts.empty++;
    fs.writeFileSync(file, JSON.stringify({ version: WIKI_PAGEVIEWS_VERSION, ticker, title, fetchedAt: new Date().toISOString(), days: r.days }));
    counts.written++;
    if (onProgress) onProgress({ ...counts });
  })));
  return { ...counts, failures };
}

function loadSeries(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(d.days) ? d : null;
  } catch { return null; }
}

module.exports = { WIKI_PAGEVIEWS_VERSION, HISTORY_START, encodeTitle, parsePageviews, toDailyMap, fetchArticleSeries, materialize, loadSeries };
