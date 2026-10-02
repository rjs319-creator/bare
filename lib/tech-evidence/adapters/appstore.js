'use strict';
// App-store rating counters — consumer sleeve of Tech Operational Evidence.
//
// iOS:     https://itunes.apple.com/lookup?id=<trackId>   (stable public JSON: userRatingCount,
//          averageUserRating, version, currentVersionReleaseDate)
//          https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/100/apps.json (chart
//          rank for the few apps that are in the top 100 that day; absence = no rank, never 0;
//          the feed 502s intermittently — fail soft, coverage note only)
// Android: https://play.google.com/store/apps/details?id=<pkg>&hl=en&gl=us is an HTML page.
//          Ratings live in an AF_initDataCallback script keyed 'ds:5' at path [1,2,51]:
//          [51][2][1] = rating count, [51][0][1] = score — a minimal port of the MIT
//          facundoolano/google-play-scraper `app()` extractor (request + regex + JSON path
//          only; no cheerio/got). BRITTLE (undocumented layout, can drift without notice)
//          and ToS-GRAY (Play's terms discourage automated access); every failure degrades
//          to a missing snapshot and a stated error, never a zero or a guessed count.
// Counters are CURRENT cumulative values: snapshot nightly, derive velocity forward. No
// public history exists, so there is no backfill. Raw counts are public listing data —
// the licensed analytics in lib/nsl/providers.js (data.ai / Sensor Tower download
// estimates) are a different product and are NOT what this adapter collects.

const { guardedFetch, adapterResult, mapWithBudget } = require('./common');
const SCHEMA = require('../schema');

const CHART_URL = 'https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/100/apps.json';
const PLAY_MAX_BYTES = 4 * 1024 * 1024;   // details pages run ~1.2 MB
const PLAY_HEADERS = Object.freeze({
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
});

const lookupUrl = (id) => `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=us`;
const playUrl = (pkg) => `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=us`;

const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// ── parsers (pure) ───────────────────────────────────────────────────────────
function parseItunesLookup(body, expectedId) {
  const results = body && Array.isArray(body.results) ? body.results : [];
  if (!results.length) return { app: null, error: 'no result for app id' };
  const r = results[0];
  if (String(r.trackId) !== String(expectedId)) return { app: null, error: `id mismatch: asked ${expectedId}, got ${r.trackId}` };
  const ratingCount = finite(r.userRatingCount);
  if (ratingCount == null) return { app: null, error: 'userRatingCount missing' };
  return {
    app: {
      ratingCount, averageRating: finite(r.averageUserRating),
      version: r.version ? String(r.version).slice(0, 40) : null,
      versionReleasedAt: r.currentVersionReleaseDate || null,
      seller: r.sellerName ? String(r.sellerName).slice(0, 120) : null,
      title: r.trackName ? String(r.trackName).slice(0, 120) : null,
    },
    error: null,
  };
}

const AF_SCRIPT_RE = />AF_initDataCallback[\s\S]*?<\/script/g;
const AF_KEY_RE = /(ds:\d+)'/;
const AF_DATA_RE = /data:([\s\S]*?), sideChannel: {}}\);/;

function playDs5(html) {
  for (const script of String(html || '').match(AF_SCRIPT_RE) || []) {
    const key = script.match(AF_KEY_RE);
    if (!key || key[1] !== 'ds:5') continue;
    const data = script.match(AF_DATA_RE);
    if (!data) return null;
    try { return JSON.parse(data[1]); } catch { return null; }
  }
  return null;
}

const pathGet = (root, path) => path.reduce((acc, k) => (acc != null && typeof acc === 'object' ? acc[k] : undefined), root);

function parsePlayDetails(html) {
  const ds5 = playDs5(html);
  if (!ds5) return { app: null, error: 'Play layout drift: no parseable ds:5 block' };
  const ratingCount = finite(pathGet(ds5, [1, 2, 51, 2, 1]));
  if (ratingCount == null) return { app: null, error: 'Play layout drift: ratings path [1,2,51,2,1] empty' };
  return {
    app: {
      ratingCount, averageRating: finite(pathGet(ds5, [1, 2, 51, 0, 1])),
      version: (() => { const v = pathGet(ds5, [1, 2, 140, 0, 0, 0]); return v ? String(v).slice(0, 40) : null; })(),
      developer: (() => { const d = pathGet(ds5, [1, 2, 68, 0]); return d ? String(d).slice(0, 120) : null; })(),
      title: (() => { const t = pathGet(ds5, [1, 2, 0, 0]); return t ? String(t).slice(0, 120) : null; })(),
    },
    error: null,
  };
}

function parseChartFeed(body) {
  const results = body && body.feed && Array.isArray(body.feed.results) ? body.feed.results : null;
  if (!results) return { byId: {}, error: 'malformed chart feed: no feed.results[]' };
  const byId = {};
  results.forEach((r, i) => { if (r && r.id != null && byId[String(r.id)] === undefined) byId[String(r.id)] = i + 1; });
  return { byId, error: null };
}

// ── collection ───────────────────────────────────────────────────────────────
async function fetchChart({ fetchImpl }) {
  const r = await guardedFetch(CHART_URL, { fetchImpl, retries: 0 });
  if (!r.ok) return { ok: false, byId: {}, note: `chart feed ${r.error} (${r.category})` };
  const parsed = parseChartFeed(r.body);
  return parsed.error ? { ok: false, byId: {}, note: parsed.error } : { ok: true, byId: parsed.byId, note: null };
}

async function fetchApp(m, { fetchImpl }) {
  if (m.platform === 'ios') {
    const r = await guardedFetch(lookupUrl(m.sourceId), { fetchImpl, retries: 1 });
    if (!r.ok) return { error: `${m.sourceId}: ${r.error} (${r.category})`, rateLimited: !!r.rateLimited };
    return parseItunesLookup(r.body, m.sourceId);
  }
  const r = await guardedFetch(playUrl(m.sourceId), { fetchImpl, retries: 1, expectJson: false, maxBytes: PLAY_MAX_BYTES, headers: PLAY_HEADERS });
  if (!r.ok) return { error: `${m.sourceId}: ${r.error} (${r.category})`, rateLimited: !!r.rateLimited };
  return parsePlayDetails(r.body);
}

function appObservations(app, { mapping, day, retrievedAt, chartRank }) {
  const base = {
    source: 'appstore', ticker: mapping.ticker, entity: mapping.sourceId, effectiveDate: day,
    sourceUrl: mapping.sourceUrl, publicAt: retrievedAt, basis: 'live',
    mappingId: mapping.mappingId, mappingVersion: mapping.version, retrievedAt,
  };
  const detail = { platform: mapping.platform, version: app.version, versionReleasedAt: app.versionReleasedAt || null, counterSemantics: 'cumulative store counter snapshot; no per-day history exists upstream' };
  const obs = [SCHEMA.makeObservation({ ...base, metric: 'ratingCount', value: app.ratingCount, unit: 'ratings', detail })];
  if (app.averageRating != null) obs.push(SCHEMA.makeObservation({ ...base, metric: 'averageRating', value: app.averageRating, unit: 'stars' }));
  if (chartRank != null) obs.push(SCHEMA.makeObservation({ ...base, metric: 'chartRank', value: chartRank, unit: 'rank:us-top-free' }));
  return obs;
}

async function collectAppstore({ mappings, now = new Date(), fetchImpl = null, budget = null } = {}) {
  const retrievedAt = now.toISOString();
  const day = retrievedAt.slice(0, 10);
  const overBudget = budget && Number.isFinite(budget.deadlineMs) && Date.now() - budget.t0 > budget.deadlineMs;
  const needsChart = !overBudget && mappings.some((m) => m.platform === 'ios');
  const chart = needsChart ? await fetchChart({ fetchImpl }) : { ok: null, byId: {}, note: overBudget ? 'skipped:budget' : 'no iOS mappings' };
  const results = await mapWithBudget(mappings, async (m) => {
    const r = await fetchApp(m, { fetchImpl });
    if (r.error) return { id: m.sourceId, error: r.error, rateLimited: !!r.rateLimited };
    const chartRank = m.platform === 'ios' && chart.byId[m.sourceId] !== undefined ? chart.byId[m.sourceId] : null;
    return {
      id: m.sourceId,
      observations: appObservations(r.app, { mapping: m, day, retrievedAt, chartRank }),
      snapshot: { ticker: m.ticker, platform: m.platform, mappingId: m.mappingId, ...r.app, chartRank, retrievedAt },
    };
  }, { budget });
  const observations = [];
  const errors = [];
  const snapshots = {};
  const perEntity = {};
  let rateLimited = false;
  for (const res of results) {
    if (res.skippedBudget) { errors.push(`${res.item.sourceId}: skipped:budget`); perEntity[res.item.sourceId] = { ok: false }; continue; }
    if (res.error) { rateLimited = rateLimited || !!res.rateLimited; errors.push(res.error); perEntity[res.id] = { ok: false }; continue; }
    observations.push(...res.observations);
    snapshots[res.id] = res.snapshot;
    perEntity[res.id] = { ok: true, ratingCount: res.snapshot.ratingCount };
  }
  return { ...adapterResult({ source: 'appstore', observations, errors, rateLimited, coverage: { day, perEntity, chartFeed: { ok: chart.ok, note: chart.note } } }), snapshots };
}

module.exports = { collectAppstore, parseItunesLookup, parsePlayDetails, parseChartFeed, lookupUrl, playUrl, CHART_URL, PLAY_MAX_BYTES };
