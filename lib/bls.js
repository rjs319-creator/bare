'use strict';
// BLS PUBLIC DATA API v2 — headline series only (bls-v1).
//
//   https://api.bls.gov/publicAPI/v2/timeseries/data/{seriesId}
//
// Keyless tier: 25 requests/day, ~3 years per request, no series lists. Verified
// 2026-10-02 from this sandbox (200):
//   { status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID, data: [{ year, period: "M08",
//     periodName, latest: "true", value: "334.980", footnotes: [...] }] }] } }
// Budget discipline: exactly two whitelisted headline series (CPI-U all items, U-3
// unemployment), memoized 24h via lib/http-memo so a day of page traffic costs at most
// two of the 25 calls. Output is the FRED series shape lib/fred.trendOf already consumes,
// so lib/pulse2-macro can use BLS as a keyless corroboration/fallback for its legs.
// BLS data are revised (seasonal factors, benchmark revisions) → backtestSafe: false.

const { memoFetchJSON } = require('./http-memo');

const BLS_VERSION = 'bls-v1';
const BASE = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const MEMO_TTL_MS = 24 * 60 * 60 * 1000;
const MEMO_TAG = 'bls';
const TIMEOUT_MS = 15_000;
const DAILY_KEYLESS_BUDGET = 25;

const SERIES = Object.freeze({
  CUUR0000SA0: { leg: 'inflation', label: 'CPI-U, all items, NSA (1982-84=100)', freq: 'monthly', staleAfterDays: 75, invert: false },
  LNS14000000: { leg: 'growth', label: 'Unemployment rate, U-3, SA', freq: 'monthly', staleAfterDays: 75, invert: true },
});

const unavailable = (reason) => ({ available: false, reason: String(reason) });

function seriesUrl(id) {
  if (!SERIES[id]) throw new TypeError(`bls: "${id}" is not a whitelisted headline series`);
  return `${BASE}${id}`;
}

/** BLS period → first-of-month ISO date; annual (M13) and non-monthly periods → null. */
function periodToDate(year, period) {
  const m = /^M(0[1-9]|1[0-2])$/.exec(String(period || ''));
  const y = Number(year);
  return m && Number.isInteger(y) && y >= 1900 && y <= 2100 ? `${y}-${m[1]}-01` : null;
}

/** Normalize a BLS body for `id` into ascending { date, value } observations, or null. */
function normalizeBls(body, id) {
  if (!body || body.status !== 'REQUEST_SUCCEEDED' || !body.Results || !Array.isArray(body.Results.series)) return null;
  const s = body.Results.series.find((x) => x && x.seriesID === id);
  if (!s || !Array.isArray(s.data)) return null;
  const obs = s.data
    .map((d) => ({ date: periodToDate(d && d.year, d && d.period), value: Number(d && d.value) }))
    .filter((o) => o.date && Number.isFinite(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  // Drop duplicate months (BLS can echo a revised row); keep the LAST, which is the revision.
  const byDate = new Map(obs.map((o) => [o.date, o]));
  return [...byDate.values()];
}

/**
 * Fetch one headline series. FRED-shaped result; never throws.
 * @returns {Promise<{available:boolean, id:string, observations?:{date:string,value:number}[], latest?:object, ageDays?:number, stale?:boolean, reason?:string}>}
 */
async function fetchBlsSeries(id, { memo = memoFetchJSON, fetchImpl, now = Date.now() } = {}) {
  const meta = SERIES[id];
  if (!meta) return { ...unavailable(`"${id}" is not a whitelisted BLS headline series (keyless budget is ${DAILY_KEYLESS_BUDGET}/day)`), id };
  try {
    const r = await memo(seriesUrl(id), { ttlMs: MEMO_TTL_MS, tag: MEMO_TAG, init: { timeoutMs: TIMEOUT_MS, headers: { Accept: 'application/json' } }, ...(fetchImpl ? { fetchImpl } : {}) });
    if (!r.ok) return { ...unavailable(`BLS returned HTTP ${r.status} for ${id}`), id };
    const obs = normalizeBls(r.body, id);
    if (!obs) {
      const msg = r.body && Array.isArray(r.body.message) && r.body.message.length ? r.body.message.join('; ').slice(0, 160) : (r.body && r.body.status) || 'unexpected envelope';
      return { ...unavailable(`BLS response for ${id} unusable: ${msg}`), id };
    }
    if (!obs.length) return { ...unavailable(`BLS returned no monthly observations for ${id}`), id };
    const last = obs[obs.length - 1];
    // A month's print covers the month; age it from the month END so a fresh release is not "old".
    const monthEnd = new Date(Date.UTC(Number(last.date.slice(0, 4)), Number(last.date.slice(5, 7)), 0));
    const ageDays = Math.floor((now - monthEnd.getTime()) / 86_400_000);
    const stale = ageDays > meta.staleAfterDays;
    return {
      available: true, id, leg: meta.leg, label: meta.label, frequency: meta.freq, invert: meta.invert,
      observations: obs, latest: last, ageDays, stale, staleAfterDays: meta.staleAfterDays,
      staleReason: stale ? `latest observation (${last.date}) is ${ageDays}d past its month end — release delayed or series discontinued` : null,
      backtestSafe: false, vintageNote: 'BLS serves current (revised) values; not point-in-time.',
      source: 'BLS', cached: r.cached, fetchedAt: new Date(now).toISOString(),
    };
  } catch (e) {
    return { ...unavailable(`BLS fetch failed for ${id}: ${String((e && e.message) || e).slice(0, 120)}`), id };
  }
}

module.exports = { BLS_VERSION, SERIES, MEMO_TTL_MS, MEMO_TAG, DAILY_KEYLESS_BUDGET, seriesUrl, periodToDate, normalizeBls, fetchBlsSeries };
