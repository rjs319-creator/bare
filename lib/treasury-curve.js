'use strict';
// U.S. TREASURY DAILY PAR YIELD CURVE — CSV adapter (treasury-curve-v1).
//
// URL (verified 2026-10-02 from this sandbox, 200 text/csv, newest row first):
//   https://home.treasury.gov/resource-center/data-chart-center/interest-rates/
//     daily-treasury-rates.csv/{YYYY}/all?type=daily_treasury_yield_curve
//     &field_tdr_date_value={YYYY}&page&_format=csv
// Header as published:
//   Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
// Treasury adds and removes tenors over time (the 1.5-month column is recent), so every
// column is matched by NAME and a missing tenor is null — never a number shifted from the
// neighbouring column. Values are percent; the 2s10s spread is reported in basis points.
//
// Why this exists next to lib/fred.js: FRED's DGS2/DGS10 are the same numbers one day
// late (and need a key). Treasury publishes at ~3:30pm ET the same day, keyless. Par
// yields are NOT revised after publication, so unlike FRED vintages a historical row is
// what was known on that date (backtestSafe: true).

const { memoFetchJSON } = require('./http-memo');
const { fetchWithTimeout } = require('./http');

const TREASURY_CURVE_VERSION = 'treasury-curve-v1';
const BASE = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/';
const MEMO_TTL_MS = 60 * 60 * 1000;      // Treasury posts once a day; an hour bounds the lag
const MEMO_TAG = 'treasury-curve';
const TIMEOUT_MS = 15_000;
const STALE_AFTER_DAYS = 7;               // a week without a new row = feed broken, not a holiday
const MIN_ROWS = 30;                      // early January: top up from the prior year's file
const TENOR_KEYS = Object.freeze({
  '1 Mo': 'm1', '1.5 Month': 'm1_5', '2 Mo': 'm2', '3 Mo': 'm3', '4 Mo': 'm4', '6 Mo': 'm6',
  '1 Yr': 'y1', '2 Yr': 'y2', '3 Yr': 'y3', '5 Yr': 'y5', '7 Yr': 'y7', '10 Yr': 'y10', '20 Yr': 'y20', '30 Yr': 'y30',
});

const unavailable = (reason) => ({ available: false, reason: String(reason) });
const round = (n, d = 2) => (Number.isFinite(n) ? +n.toFixed(d) : null);

function curveUrl(year) {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new TypeError(`treasury-curve: bad year ${year}`);
  return `${BASE}${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
}

/** Split one CSV line on commas outside double quotes; strips the quotes. */
function splitCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function usDateToIso(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v == null ? '' : v).trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/** Parse the CSV. Rows ascend by date; tenors keyed by TENOR_KEYS (unknown columns kept raw). */
function parseCurveCsv(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty_body', rows: [], tenors: [] };
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0]);
  if (header[0] !== 'Date' || header.length < 3) return { ok: false, reason: 'bad_header', rows: [], tenors: [] };
  const keys = header.slice(1).map((h) => TENOR_KEYS[h] || h);
  const rows = [];
  let invalid = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const date = usDateToIso(cells[0]);
    if (!date || cells.length !== header.length) { invalid++; continue; }
    const tenors = {};
    keys.forEach((k, i) => { const n = Number(cells[i + 1]); tenors[k] = cells[i + 1] !== '' && Number.isFinite(n) ? n : null; });
    rows.push({ date, tenors });
  }
  if (!rows.length) return { ok: false, reason: 'no_rows', rows: [], tenors: keys, invalid };
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, reason: null, rows, tenors: keys, invalid };
}

/** 10y − 2y in basis points, or null when either tenor is missing. */
function twoTenSpreadBp(row) {
  const t = row && row.tenors;
  return t && Number.isFinite(t.y10) && Number.isFinite(t.y2) ? round((t.y10 - t.y2) * 100, 1) : null;
}

// memoFetchJSON stores JSON; wrap the CSV body as a JSON string so it rides the same cache.
const csvAsJson = (fetchImpl) => async (url, init) => {
  const r = await fetchImpl(url, init);
  const text = r.ok ? await r.text() : '';
  return { ok: r.ok, status: r.status, text: async () => JSON.stringify(text) };
};

async function fetchYear(year, { memo, fetchImpl }) {
  const r = await memo(curveUrl(year), { ttlMs: MEMO_TTL_MS, tag: MEMO_TAG, init: { timeoutMs: TIMEOUT_MS, headers: { Accept: 'text/csv' } }, fetchImpl: csvAsJson(fetchImpl) });
  if (!r.ok) return { ok: false, reason: `treasury HTTP ${r.status} for ${year}`, rows: [] };
  return parseCurveCsv(typeof r.body === 'string' ? r.body : '');
}

/**
 * Current-year curve (topped up from the prior year when the year is young). Never throws.
 * Returns { available, observations:[{date,y2,y10,spreadBp}], latest, ageDays, stale, ... }.
 */
async function fetchTreasuryCurve({ now = Date.now(), memo = memoFetchJSON, fetchImpl = fetchWithTimeout, minRows = MIN_ROWS } = {}) {
  const year = new Date(now).getUTCFullYear();
  try {
    const cur = await fetchYear(year, { memo, fetchImpl });
    if (!cur.ok && cur.reason !== 'no_rows') return { ...unavailable(cur.reason), source: 'treasury' };
    let rows = cur.rows;
    if (rows.length < minRows) {
      const prev = await fetchYear(year - 1, { memo, fetchImpl });
      if (prev.ok) rows = [...prev.rows, ...rows].sort((a, b) => a.date.localeCompare(b.date));
    }
    if (!rows.length) return { ...unavailable(`treasury returned no curve rows for ${year}`), source: 'treasury' };
    const observations = rows.map((r) => ({ date: r.date, y2: r.tenors.y2 ?? null, y10: r.tenors.y10 ?? null, spreadBp: twoTenSpreadBp(r), tenors: r.tenors }));
    const latest = observations[observations.length - 1];
    const ageDays = Math.floor((now - Date.parse(`${latest.date}T00:00:00Z`)) / 86_400_000);
    return {
      available: true, id: 'TREASURY_CURVE', source: 'treasury', observations, latest, ageDays,
      stale: ageDays > STALE_AFTER_DAYS, staleAfterDays: STALE_AFTER_DAYS,
      backtestSafe: true, vintageNote: 'Par yield curve rates are not revised after publication.',
      fetchedAt: new Date(now).toISOString(),
    };
  } catch (e) {
    return { ...unavailable(`treasury fetch failed: ${String((e && e.message) || e).slice(0, 120)}`), source: 'treasury' };
  }
}

// FRED-shaped series (what lib/fred.trendOf and lib/pulse2-macro consume) built from the curve.
function seriesFrom(curve, { id, label, pick, invert }) {
  if (!curve || !curve.available) return unavailable(curve ? curve.reason : 'no curve');
  const observations = curve.observations.filter((o) => Number.isFinite(pick(o))).map((o) => ({ date: o.date, value: pick(o) }));
  if (!observations.length) return unavailable(`${id}: no observations with the needed tenors`);
  const last = observations[observations.length - 1];
  return { available: true, id, label, leg: 'curve', frequency: 'daily', invert, observations, latest: last, ageDays: curve.ageDays, stale: curve.stale, staleAfterDays: STALE_AFTER_DAYS, backtestSafe: true, source: 'treasury', fetchedAt: curve.fetchedAt };
}
const tenYearSeries = (curve) => seriesFrom(curve, { id: 'TREASURY_10Y', label: '10-year Treasury par yield', pick: (o) => o.y10, invert: true });
const twoTenSeries = (curve) => seriesFrom(curve, { id: 'TREASURY_2S10S', label: '2s10s Treasury spread (bp)', pick: (o) => o.spreadBp, invert: false });

module.exports = {
  TREASURY_CURVE_VERSION, MEMO_TTL_MS, MEMO_TAG, STALE_AFTER_DAYS, MIN_ROWS, TENOR_KEYS,
  curveUrl, splitCsvLine, usDateToIso, parseCurveCsv, twoTenSpreadBp,
  fetchTreasuryCurve, tenYearSeries, twoTenSeries,
};
