'use strict';
// FINRA REG SHO DAILY SHORT SALE VOLUME — feature adapter (finra-shortvol-v1).
//
// SOURCE. https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt — one
// pipe-delimited file per trading day (~550 KB, ~12k symbols) consolidating the NMS
// short-sale volume FINRA publishes for its TRFs/ADF:
//   Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
// Verified 2026-10-02 from this sandbox: HTTP 200 text/plain, 12,343 rows. ShortVolume
// and TotalVolume carry FRACTIONAL share counts (e.g. 482143.150276 — odd-lot
// allocations), and a day with no file (weekend/holiday) answers HTTP 403, not 404.
//
// TERMS. FINRA's data terms permit personal, non-commercial use and prohibit automated
// scraping tools. This module performs ONE bounded daily download of the published file
// for a personal research site and redistributes nothing. If the site's use ever becomes
// commercial, this feed must be licensed or removed.
//
// DATASET DISCIPLINE. Daily short-sale VOLUME is NOT short interest. It is the share of
// a day's reported volume that was sold short — dominated by market-maker and dealer
// hedging flow — and the literature finds little return predictability in it. It is
// treated here as a FEATURE (liquidity/positioning context for Ignition + CERN) and as
// the subject of ONE preregistered weight-0 hypothesis (hypothesis-registry id
// `short-volume-ratio-top-decile`). It is never a score input. lib/research/finra-si.js
// rejects rows of this shape for the same reason, from the other side.
//
// Pure: parsing, validation, feature math and document assembly take data in and return
// new objects. Networking + Blob I/O live in lib/finra-shortvol-routes.js.

const crypto = require('node:crypto');

const FINRA_SHORTVOL_VERSION = 'finra-shortvol-v1';
const CDN_BASE = 'https://cdn.finra.org/equity/regsho/daily/CNMSshvol';
const EXPECTED_HEADER = 'Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market';
const SOURCE = 'finra:regsho-daily-short-volume';

const SHARD_PREFIX = 'shortvol/';
const ROLLING_PATH = 'shortvol/rolling-30d.json';
const ROLLING_DAYS = 30;          // compact per-universe history kept in one doc
const Z_WINDOW = 20;              // trailing sessions behind the z-score
const Z_MIN_OBS = 10;             // fewer trailing observations → z is null, not 0
const EXEMPT_SPIKE_MULT = 3;      // exempt share ≥ 3× its trailing median …
const EXEMPT_SPIKE_MIN_RATIO = 0.01; // … and ≥ 1% of the day's volume
const DECILE_MIN_TOTAL_VOLUME = 100_000; // shares — below this a ratio is noise
const DECILES = 10;
const TOP_DECILE = 10;
const PLACEBO_DECILE = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024; // the real file is ~0.55 MB; 8× is a corrupted feed
const DAY_MS = 86_400_000;
const SHARD_COLUMNS = Object.freeze(['symbol', 'shortVolume', 'shortExemptVolume', 'totalVolume', 'market']);

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const compactDate = (iso) => iso.replace(/-/g, '');
const isoFromCompact = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
const round = (n, d = 4) => (Number.isFinite(n) ? +n.toFixed(d) : null);

function urlFor(iso) {
  if (!isIsoDate(iso)) throw new TypeError(`finra-shortvol: urlFor needs an ISO date, got ${iso}`);
  return `${CDN_BASE}${compactDate(iso)}.txt`;
}

const shardPath = (iso) => `${SHARD_PREFIX}${iso}.json`;

function sourceHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function normalizeSymbol(raw) {
  const t = String(raw == null ? '' : raw).toUpperCase().trim();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) ? t : null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────
function parseLine(line) {
  const parts = line.split('|');
  if (parts.length !== 6) return { error: 'bad_column_count' };
  const date = isoFromCompact(parts[0].trim());
  if (!date) return { error: 'bad_date' };
  const symbol = normalizeSymbol(parts[1]);
  if (!symbol) return { error: 'bad_symbol' };
  const shortVolume = Number(parts[2]);
  const shortExemptVolume = Number(parts[3]);
  const totalVolume = Number(parts[4]);
  if (!Number.isFinite(shortVolume) || shortVolume < 0) return { error: 'bad_short_volume' };
  if (!Number.isFinite(shortExemptVolume) || shortExemptVolume < 0) return { error: 'bad_exempt_volume' };
  if (!Number.isFinite(totalVolume) || totalVolume <= 0) return { error: 'bad_total_volume' };
  // Allow a hair of rounding slack: the fractional allocations can put short a few
  // hundredths above total on micro rows; a material excess is a corrupted row.
  if (shortVolume > totalVolume * 1.001) return { error: 'short_gt_total' };
  return { row: { date, symbol, shortVolume, shortExemptVolume, totalVolume, market: parts[5].trim() } };
}

/**
 * Parse one CNMSshvol file. Fail-fast on the header or a date mismatch (a wrong-day
 * file must never be filed under the requested date); per-row problems are counted
 * and skipped, never coerced.
 */
function parseShortVolumeFile(text, { expectedDate = null } = {}) {
  const health = { lines: 0, kept: 0, invalid: 0, invalidReasons: {}, bytes: typeof text === 'string' ? text.length : 0 };
  if (typeof text !== 'string' || !text.length) return { ok: false, reason: 'empty_body', date: null, rows: [], health };
  if (text.length > MAX_FILE_BYTES) return { ok: false, reason: 'oversized_body', date: null, rows: [], health };
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== EXPECTED_HEADER) return { ok: false, reason: 'bad_header', date: null, rows: [], health };
  const rows = [];
  let date = null;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    health.lines++;
    const p = parseLine(line);
    if (p.error) { health.invalid++; health.invalidReasons[p.error] = (health.invalidReasons[p.error] || 0) + 1; continue; }
    date = date || p.row.date;
    if (p.row.date !== date) { health.invalid++; health.invalidReasons.mixed_dates = (health.invalidReasons.mixed_dates || 0) + 1; continue; }
    rows.push(p.row);
    health.kept++;
  }
  if (!rows.length) return { ok: false, reason: 'no_rows', date, rows: [], health };
  if (expectedDate && date !== expectedDate) return { ok: false, reason: 'date_mismatch', date, rows: [], health };
  return { ok: true, reason: null, date, rows, health };
}

// ── Feature math ─────────────────────────────────────────────────────────────
const shortVolRatio = (row) => (row && row.totalVolume > 0 ? row.shortVolume / row.totalVolume : null);
const exemptRatio = (row) => (row && row.totalVolume > 0 ? row.shortExemptVolume / row.totalVolume : null);

function meanSd(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { mean: null, sd: null, n: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { mean, sd, n: v.length };
}

/** z of `value` against a TRAILING history (exclusive of the value itself). */
function zScore(value, history, { minObs = Z_MIN_OBS } = {}) {
  const { mean, sd, n } = meanSd(history || []);
  if (!Number.isFinite(value) || n < minObs) return { z: null, n, mean: round(mean), sd: round(sd) };
  // A near-zero sd would turn float jitter into a confident z; report null instead.
  if (!(sd > 1e-6)) return { z: null, n, mean: round(mean), sd: round(sd), flat: true };
  return { z: round((value - mean) / sd, 2), n, mean: round(mean), sd: round(sd) };
}

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Exempt-volume spike: bona-fide market-making exempt share far above its own norm. */
function exemptSpike(todayExemptRatio, history, { minObs = Z_MIN_OBS } = {}) {
  const hist = (history || []).filter((x) => Number.isFinite(x));
  if (!Number.isFinite(todayExemptRatio) || hist.length < minObs) return { spike: null, median: round(median(hist)) };
  const med = median(hist);
  const spike = todayExemptRatio >= EXEMPT_SPIKE_MIN_RATIO && todayExemptRatio >= EXEMPT_SPIKE_MULT * Math.max(med, 1e-4);
  return { spike, median: round(med) };
}

/**
 * Cross-sectional deciles of the short-volume ratio (10 = highest) among rows with
 * enough volume to make the ratio meaningful. Returns Map(symbol → decile).
 */
function decileOf(rows, { minTotalVolume = DECILE_MIN_TOTAL_VOLUME } = {}) {
  const eligible = (rows || []).filter((r) => r && r.totalVolume >= minTotalVolume && shortVolRatio(r) != null)
    .map((r) => ({ symbol: r.symbol, ratio: shortVolRatio(r) }))
    .sort((a, b) => a.ratio - b.ratio || a.symbol.localeCompare(b.symbol));
  const out = new Map();
  const n = eligible.length;
  eligible.forEach((e, i) => out.set(e.symbol, Math.min(DECILES, Math.floor((i * DECILES) / n) + 1)));
  return out;
}

// ── Documents ────────────────────────────────────────────────────────────────
/**
 * The per-day shard: the whole market as compact row arrays (replayable), plus the
 * hypothesis cohorts for the app universe — top decile (the hypothesis) and the middle
 * decile (the same-date cross-sectional placebo), both computed WITHIN the universe so
 * the Scoreboard can grade them against the same SPY-excess contract.
 */
function buildDayShard({ date, rows, fetchedAt, sourceHash: hash, universe = [] }) {
  const uni = new Set(universe);
  const uniRows = rows.filter((r) => uni.has(r.symbol));
  const deciles = decileOf(uniRows);
  const cohort = (d) => uniRows.filter((r) => deciles.get(r.symbol) === d).map((r) => r.symbol).sort();
  return {
    version: FINRA_SHORTVOL_VERSION, source: SOURCE, date, fetchedAt: fetchedAt || null, sourceHash: hash || null,
    counts: { rows: rows.length, universe: uniRows.length, decileEligible: deciles.size },
    columns: [...SHARD_COLUMNS],
    rows: rows.map((r) => [r.symbol, r.shortVolume, r.shortExemptVolume, r.totalVolume, r.market]),
    hypothesis: {
      id: 'short-volume-ratio-top-decile', weight: 0,
      topDecile: cohort(TOP_DECILE), placeboDecile: cohort(PLACEBO_DECILE),
      minTotalVolume: DECILE_MIN_TOTAL_VOLUME,
    },
  };
}

const emptyRolling = () => ({ version: FINRA_SHORTVOL_VERSION, source: SOURCE, asOf: null, dates: [], bySymbol: {}, hypothesisByDate: {} });

/**
 * Append (or replace) one day in the compact rolling doc. Returns a NEW doc: dates are
 * the sorted union capped to the newest `maxDays`; every symbol series is re-aligned to
 * that date axis with null gaps, so the doc stays consistent no matter the arrival order
 * (a back-filled day lands in place rather than at the end).
 */
function appendRollingDay(doc, { date, rows, universe = [], hypothesis = null, maxDays = ROLLING_DAYS }) {
  const base = doc && Array.isArray(doc.dates) ? doc : emptyRolling();
  const dates = [...new Set([...base.dates, date])].sort().slice(-maxDays);
  const idxOf = new Map(dates.map((d, i) => [d, i]));
  const uni = new Set(universe);
  const byDate = new Map(); // date → Map(symbol → [r, e])
  for (const [sym, series] of Object.entries(base.bySymbol || {})) {
    base.dates.forEach((d, i) => {
      if (!idxOf.has(d) || d === date) return;
      const r = series.r && series.r[i];
      if (r == null) return;
      if (!byDate.has(d)) byDate.set(d, new Map());
      byDate.get(d).set(sym, [r, series.e ? series.e[i] : null]);
    });
  }
  const today = new Map();
  for (const row of rows || []) if (uni.has(row.symbol)) today.set(row.symbol, [round(shortVolRatio(row)), round(exemptRatio(row))]);
  byDate.set(date, today);
  const symbols = new Set();
  for (const m of byDate.values()) for (const s of m.keys()) symbols.add(s);
  const bySymbol = {};
  for (const sym of [...symbols].sort()) {
    const r = dates.map((d) => { const m = byDate.get(d); return m && m.has(sym) ? m.get(sym)[0] : null; });
    const e = dates.map((d) => { const m = byDate.get(d); return m && m.has(sym) ? m.get(sym)[1] : null; });
    bySymbol[sym] = { r, e };
  }
  const hypothesisByDate = Object.fromEntries(Object.entries({ ...(base.hypothesisByDate || {}), ...(hypothesis ? { [date]: { topDecile: hypothesis.topDecile, placeboDecile: hypothesis.placeboDecile } } : {}) })
    .filter(([d]) => idxOf.has(d)));
  return { version: FINRA_SHORTVOL_VERSION, source: SOURCE, asOf: dates[dates.length - 1] || null, dates, bySymbol, hypothesisByDate, updatedAt: null };
}

/** Read-side features for one symbol from the rolling doc. Null when unknown. */
function featuresFor(doc, symbol, { window = Z_WINDOW } = {}) {
  const sym = normalizeSymbol(symbol);
  if (!doc || !sym || !doc.bySymbol || !doc.bySymbol[sym] || !Array.isArray(doc.dates)) return null;
  const { r = [], e = [] } = doc.bySymbol[sym];
  let last = -1;
  for (let i = r.length - 1; i >= 0; i--) if (r[i] != null) { last = i; break; }
  if (last < 0) return null;
  const trailingR = r.slice(Math.max(0, last - window), last);
  const trailingE = e.slice(Math.max(0, last - window), last);
  const z = zScore(r[last], trailingR);
  const ex = exemptSpike(e[last], trailingE);
  const date = doc.dates[last];
  return {
    symbol: sym, date, asOf: doc.asOf, stale: date !== doc.asOf,
    shortVolRatio: r[last], exemptRatio: e[last],
    z20: z.z, zWindow: window, n: z.n, mean20: z.mean,
    exemptSpike: ex.spike, exemptMedian: ex.median,
    source: SOURCE, feature: true, scoreInput: false,
  };
}

function summaryOf(doc) {
  if (!doc || !Array.isArray(doc.dates)) return { asOf: null, days: 0, symbols: 0, latest: null };
  const latest = doc.asOf && doc.hypothesisByDate ? doc.hypothesisByDate[doc.asOf] || null : null;
  return { asOf: doc.asOf || null, days: doc.dates.length, symbols: Object.keys(doc.bySymbol || {}).length, latest: latest ? { date: doc.asOf, ...latest } : null };
}

// ── Calendar helpers (UTC weekdays; holidays surface as a 403 and are skipped) ──
function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function previousWeekday(iso) {
  let ms = Date.parse(`${iso}T00:00:00Z`) - DAY_MS;
  while ([0, 6].includes(new Date(ms).getUTCDay())) ms -= DAY_MS;
  return isoDay(ms);
}
/** The newest `n` weekdays on or before `iso`, newest first. */
function recentWeekdays(iso, n) {
  const out = [];
  let d = iso;
  while (out.length < n) {
    if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) out.push(d);
    d = isoDay(Date.parse(`${d}T00:00:00Z`) - DAY_MS);
  }
  return out;
}
const missingDates = (doc, candidates) => {
  const have = new Set((doc && doc.dates) || []);
  return candidates.filter((d) => !have.has(d));
};

module.exports = {
  FINRA_SHORTVOL_VERSION, CDN_BASE, EXPECTED_HEADER, SOURCE, SHARD_PREFIX, ROLLING_PATH, ROLLING_DAYS,
  Z_WINDOW, Z_MIN_OBS, EXEMPT_SPIKE_MULT, EXEMPT_SPIKE_MIN_RATIO, DECILE_MIN_TOTAL_VOLUME, TOP_DECILE, PLACEBO_DECILE, MAX_FILE_BYTES,
  urlFor, shardPath, sourceHash, normalizeSymbol, isIsoDate,
  parseShortVolumeFile, shortVolRatio, exemptRatio, meanSd, zScore, median, exemptSpike, decileOf,
  buildDayShard, emptyRolling, appendRollingDay, featuresFor, summaryOf,
  previousWeekday, recentWeekdays, missingDates,
};
