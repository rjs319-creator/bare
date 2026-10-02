'use strict';
// NASDAQ CALENDARS — earnings / splits / dividends (nasdaq-calendar-v1).
//
//   https://api.nasdaq.com/api/calendar/{earnings|splits|dividends}?date=YYYY-MM-DD
//
// Unofficial (tier C): the endpoint needs a browser User-Agent plus
// `Accept: application/json`, and datacenter IPs occasionally get 403 — so FMP's
// /stable calendars stay wired as the fallback, and the response says which source
// answered. Shapes verified 2026-10-02 (fixtures in test/fixtures/datapack/):
//   earnings  → data.rows[]          symbol, name, time, epsForecast ("($0.31)" | ""),
//                                    noOfEsts, lastYearEPS, lastYearRptDt, fiscalQuarterEnding, marketCap
//   splits    → data.rows[]          symbol, name, ratio ("3 : 1"), executionDate (MM/DD/YYYY)
//   dividends → data.calendar.rows[] symbol, companyName, dividend_Ex_Date, record_Date, payment_Date,
//                                    dividend_Rate, indicated_Annual_Dividend, announcement_Date
// Every row is validated and normalized at this boundary; malformed rows are dropped
// and counted, never passed through. Memoized via lib/http-memo (6h — a day's calendar
// changes rarely and the page polls once a minute).

const { memoFetchJSON } = require('./http-memo');
const { fmpRequest } = require('./fmp-client');

const NASDAQ_CALENDAR_VERSION = 'nasdaq-calendar-v1';
const BASE = 'https://api.nasdaq.com/api/calendar/';
const KINDS = Object.freeze(['earnings', 'splits', 'dividends']);
const MEMO_TTL_MS = 6 * 60 * 60 * 1000;
const MEMO_TAG = 'nasdaq-calendar';
const TIMEOUT_MS = 12_000;
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const HEADERS = Object.freeze({ 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' });
const FMP_PATH = Object.freeze({ earnings: '/earnings-calendar', splits: '/splits-calendar', dividends: '/dividends-calendar' });

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const symbolOf = (raw) => { const t = String(raw == null ? '' : raw).toUpperCase().trim(); return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) ? t : null; };
const str = (v) => (v == null ? null : String(v).trim() || null);

function calendarUrl(kind, iso) {
  if (!KINDS.includes(kind)) throw new TypeError(`nasdaq-calendar: unknown kind "${kind}"`);
  if (!isIsoDate(iso)) throw new TypeError(`nasdaq-calendar: date must be YYYY-MM-DD, got ${iso}`);
  return `${BASE}${kind}?date=${iso}`;
}

/** "10/09/2026" | "9/08/2026" → "2026-10-09"; "N/A"/"" → null. */
function usDateToIso(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

/** "($0.31)" → -0.31, "$43,807,184" → 43807184, "" | "N/A" → null. */
function parseAccountingNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s || /^n\/?a$/i.test(s)) return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = Number(s.replace(/[()$,\s-]/g, ''));
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/** "3 : 1" → { numerator: 3, denominator: 1, factor: 3 } (factor < 1 = reverse split). */
function parseSplitRatio(v) {
  const m = /^\s*([\d.]+)\s*[:/-]\s*([\d.]+)\s*$/.exec(String(v == null ? '' : v));
  if (!m) return null;
  const numerator = Number(m[1]), denominator = Number(m[2]);
  if (!(numerator > 0) || !(denominator > 0)) return null;
  return { numerator, denominator, factor: +(numerator / denominator).toFixed(6) };
}

// ── Nasdaq row normalizers ──────────────────────────────────────────────────
const NASDAQ_ROWS = {
  earnings: (data) => data && Array.isArray(data.rows) ? data.rows : null,
  splits: (data) => data && Array.isArray(data.rows) ? data.rows : null,
  dividends: (data) => data && data.calendar && Array.isArray(data.calendar.rows) ? data.calendar.rows : null,
};

const NASDAQ_ROW = {
  earnings: (r, date) => {
    const symbol = symbolOf(r.symbol);
    return symbol ? { symbol, name: str(r.name), date, time: str(r.time), epsForecast: parseAccountingNumber(r.epsForecast), noOfEsts: parseAccountingNumber(r.noOfEsts), lastYearEps: parseAccountingNumber(r.lastYearEPS), fiscalQuarterEnding: str(r.fiscalQuarterEnding), marketCap: parseAccountingNumber(r.marketCap) } : null;
  },
  splits: (r) => {
    const symbol = symbolOf(r.symbol);
    const ratio = parseSplitRatio(r.ratio);
    const executionDate = usDateToIso(r.executionDate);
    return symbol && ratio && executionDate ? { symbol, name: str(r.name), ratio: str(r.ratio), factor: ratio.factor, reverse: ratio.factor < 1, executionDate } : null;
  },
  dividends: (r) => {
    const symbol = symbolOf(r.symbol);
    const exDate = usDateToIso(r.dividend_Ex_Date);
    return symbol && exDate ? { symbol, name: str(r.companyName), exDate, recordDate: usDateToIso(r.record_Date), payDate: usDateToIso(r.payment_Date), announcementDate: usDateToIso(r.announcement_Date), rate: parseAccountingNumber(r.dividend_Rate), indicatedAnnual: parseAccountingNumber(r.indicated_Annual_Dividend) } : null;
  },
};

/** Normalize a Nasdaq body. Returns { rows, dropped } or null when the envelope is wrong. */
function normalizeNasdaq(kind, body, date) {
  if (!body || !body.status || body.status.rCode !== 200) return null;
  const raw = NASDAQ_ROWS[kind](body.data);
  if (!raw) return null;
  const rows = raw.map((r) => (r && typeof r === 'object' ? NASDAQ_ROW[kind](r, date) : null)).filter(Boolean);
  return { rows, dropped: raw.length - rows.length };
}

// ── FMP fallback normalizers (same output shape) ────────────────────────────
const FMP_ROW = {
  earnings: (r) => { const symbol = symbolOf(r.symbol); return symbol && isIsoDate(r.date) ? { symbol, name: null, date: r.date, time: str(r.time), epsForecast: parseAccountingNumber(r.epsEstimated), noOfEsts: null, lastYearEps: null, fiscalQuarterEnding: str(r.fiscalDateEnding), marketCap: null } : null; },
  splits: (r) => {
    const symbol = symbolOf(r.symbol);
    const num = Number(r.numerator), den = Number(r.denominator);
    return symbol && isIsoDate(r.date) && num > 0 && den > 0 ? { symbol, name: null, ratio: `${num} : ${den}`, factor: +(num / den).toFixed(6), reverse: num / den < 1, executionDate: r.date } : null;
  },
  dividends: (r) => { const symbol = symbolOf(r.symbol); return symbol && isIsoDate(r.date) ? { symbol, name: null, exDate: r.date, recordDate: isIsoDate(r.recordDate) ? r.recordDate : null, payDate: isIsoDate(r.paymentDate) ? r.paymentDate : null, announcementDate: isIsoDate(r.declarationDate) ? r.declarationDate : null, rate: parseAccountingNumber(r.dividend), indicatedAnnual: null } : null; },
};

function normalizeFmp(kind, body) {
  if (!Array.isArray(body)) return null;
  const rows = body.map((r) => (r && typeof r === 'object' ? FMP_ROW[kind](r) : null)).filter(Boolean);
  return { rows, dropped: body.length - rows.length };
}

/**
 * One calendar day. Nasdaq first; FMP when Nasdaq is unreachable, gated, or malformed.
 * Never throws; `ok:false` carries both reasons.
 * @returns {Promise<{ok:boolean, kind:string, date:string, source:'nasdaq'|'fmp'|null, rows:object[], dropped:number, reason:string|null, cached:any}>}
 */
async function fetchNasdaqCalendar(kind, iso, { memo = memoFetchJSON, fmp = fmpRequest, fetchImpl } = {}) {
  const url = calendarUrl(kind, iso);
  let nasdaqReason = null;
  let cached = false;
  try {
    const r = await memo(url, { ttlMs: MEMO_TTL_MS, tag: MEMO_TAG, init: { headers: { ...HEADERS }, timeoutMs: TIMEOUT_MS }, ...(fetchImpl ? { fetchImpl } : {}) });
    cached = r.cached;
    const norm = r.ok ? normalizeNasdaq(kind, r.body, iso) : null;
    if (norm) return { ok: true, kind, date: iso, source: 'nasdaq', rows: norm.rows, dropped: norm.dropped, reason: null, cached };
    nasdaqReason = r.ok ? (r.invalidJson ? 'nasdaq: unparseable body' : 'nasdaq: unexpected envelope') : `nasdaq: HTTP ${r.status}`;
  } catch (e) {
    nasdaqReason = `nasdaq: ${String((e && e.message) || e).slice(0, 100)}`;
  }
  const f = await fmp(FMP_PATH[kind], { from: iso, to: iso }, { memoTtlMs: MEMO_TTL_MS });
  const norm = f.ok ? normalizeFmp(kind, f.body) : null;
  if (norm) return { ok: true, kind, date: iso, source: 'fmp', rows: norm.rows, dropped: norm.dropped, reason: `${nasdaqReason} → FMP fallback`, cached: f.cached || false };
  return { ok: false, kind, date: iso, source: null, rows: [], dropped: 0, reason: `${nasdaqReason}; fmp: ${f.error || f.category || 'unexpected body'}`, cached };
}

/** The tickers reporting on `iso` (any session time). Never throws. */
async function earningsTickersOn(iso, opts = {}) {
  const r = await fetchNasdaqCalendar('earnings', iso, opts);
  const byTicker = Object.fromEntries(r.rows.map((row) => [row.symbol, { time: row.time, epsForecast: row.epsForecast }]));
  return { ok: r.ok, date: iso, source: r.source, reason: r.reason, tickers: Object.keys(byTicker).sort(), byTicker };
}

module.exports = {
  NASDAQ_CALENDAR_VERSION, KINDS, MEMO_TTL_MS, MEMO_TAG, BROWSER_UA, HEADERS, FMP_PATH,
  calendarUrl, usDateToIso, parseAccountingNumber, parseSplitRatio,
  normalizeNasdaq, normalizeFmp, fetchNasdaqCalendar, earningsTickersOn,
};
