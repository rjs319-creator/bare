'use strict';
// ARK DAILY HOLDINGS — fetch + parse + validate (GitHub-scan proposal #17, 2026-10-02).
//
// ARK Invest publishes every equity ETF's FULL holdings as a CSV after each close:
//   date,fund,company,ticker,cusip,shares,market value ($),weight (%)
// (measured 2026-10-02: all six files 200; dates are MM/DD/YYYY; shares/values are
// quoted with thousands separators and a `$`; weights carry a `%`; cash and warrant
// placeholders have a BLANK ticker; the last row is a one-cell quoted disclaimer; ARKX
// uses Bloomberg-style tickers such as "RKLB UQ"; ARKF/ARKX were republishing a stale
// 01/02/2026 as-of file). Reference for the schema + trade derivation: frefrik/ark-invest-api
// (MIT) — read only; nothing is vendored.
//
// BOUNDARY RULES. The CSV is external data, so this module validates it rather than
// trusting it: a missing required column is a NAMED schema error (never a sheet of silent
// zeros); a non-numeric cell drops the row and is COUNTED; a fund column that disagrees
// with the requested fund throws (URL/schema churn); zero parsed holdings throws (an empty
// snapshot would otherwise diff as "sold everything").
const { fetchWithTimeout } = require('./http');
const { mapLimit } = require('./map-limit');

const ARK_FUNDS = Object.freeze(['ARKK', 'ARKW', 'ARKG', 'ARKQ', 'ARKF', 'ARKX']);
const CSV_BASE = 'https://assets.ark-funds.com/fund-documents/funds-etf-csv/';
const CSV_FILES = Object.freeze({
  ARKK: 'ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv',
  ARKW: 'ARK_NEXT_GENERATION_INTERNET_ETF_ARKW_HOLDINGS.csv',
  ARKG: 'ARK_GENOMIC_REVOLUTION_ETF_ARKG_HOLDINGS.csv',
  ARKQ: 'ARK_AUTONOMOUS_TECH._&_ROBOTICS_ETF_ARKQ_HOLDINGS.csv',
  ARKF: 'ARK_FINTECH_INNOVATION_ETF_ARKF_HOLDINGS.csv',
  ARKX: 'ARK_SPACE_EXPLORATION_&_INNOVATION_ETF_ARKX_HOLDINGS.csv',
});
// `&` must be percent-encoded or the CDN answers 403 (measured).
const ARK_CSV_URLS = Object.freeze(Object.fromEntries(ARK_FUNDS.map((f) => [f, CSV_BASE + encodeURIComponent(CSV_FILES[f])])));

const REQUIRED_COLUMNS = Object.freeze(['date', 'fund', 'company', 'ticker', 'cusip', 'shares', 'market value ($)', 'weight (%)']);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_CONCURRENCY = 3;
const TICKER_RE = /^[A-Z][A-Z0-9-]{0,9}$/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

const fundFromUrl = (url) => { const m = /_(ARK[A-Z])_HOLDINGS\.csv$/.exec(String(url || '')); return m ? m[1] : null; };

// One RFC-4180 line → cells (quotes, doubled quotes, embedded commas). Pure.
function parseCsvLine(line) {
  const cells = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch !== '"') { cur += ch; continue; }
      if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// "2,087,330" / "$740,605,557.30" / "9.08%" → number; anything else → NaN (never 0).
function parseNumber(raw) {
  const s = String(raw == null ? '' : raw).replace(/[$,%\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

function parseUsDate(raw) {
  const m = US_DATE_RE.exec(String(raw || '').trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso + 'T00:00:00Z')) ? null : iso;
}

// "RKLB UQ" → RKLB (Bloomberg exchange suffix), "BF.B" → BF-B (app convention); blank → null.
function normalizeTicker(raw) {
  const t = String(raw || '').trim().split(/\s+/)[0].toUpperCase().replace(/\./g, '-');
  return TICKER_RE.test(t) ? t : null;
}

function headerIndex(headerLine, fund) {
  const cols = parseCsvLine(headerLine).map((c) => c.trim().toLowerCase());
  const idx = {};
  for (const name of REQUIRED_COLUMNS) {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`ARK ${fund}: CSV schema changed — missing column "${name}" (have: ${cols.join(' | ')})`);
    idx[name] = i;
  }
  return { idx, width: cols.length };
}

// One data row → { holding } | { skip: reason }. Pure.
function parseRow(cells, idx, fund) {
  const rowFund = String(cells[idx.fund] || '').trim().toUpperCase();
  if (rowFund !== fund) throw new Error(`ARK CSV fund mismatch: requested ${fund}, file says ${rowFund || '(blank)'}`);
  const ticker = normalizeTicker(cells[idx.ticker]);
  if (!ticker) return { skip: 'noTicker' };
  const date = parseUsDate(cells[idx.date]);
  if (!date) return { skip: 'malformed' };
  const shares = parseNumber(cells[idx.shares]);
  const marketValue = parseNumber(cells[idx['market value ($)']]);
  const weight = parseNumber(cells[idx['weight (%)']]);
  if (![shares, marketValue, weight].every(Number.isFinite)) return { skip: 'badNumber' };
  return { date, holding: { ticker, cusip: String(cells[idx.cusip] || '').trim(), company: String(cells[idx.company] || '').trim(), shares, marketValue, weight } };
}

/**
 * Parse one fund's holdings CSV. Pure.
 * → { fund, asOf (ISO, the latest row date), asOfDates, holdings[], skipped: {noTicker, malformed, badNumber}, rows }
 * Throws on: empty body, missing required column, fund mismatch, zero holdings.
 */
function parseArkCsv(text, { fund } = {}) {
  const F = String(fund || '').toUpperCase();
  if (!ARK_FUNDS.includes(F)) throw new Error(`ARK: unknown fund ${fund}`);
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error(`ARK ${F}: empty CSV (no header)`);
  const { idx, width } = headerIndex(lines[0], F);
  const skipped = { noTicker: 0, malformed: 0, badNumber: 0 };
  const holdings = [];
  const dates = new Set();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells.length !== width) { skipped.malformed++; continue; }   // the trailing disclaimer row
    const r = parseRow(cells, idx, F);
    if (r.skip) { skipped[r.skip]++; continue; }
    dates.add(r.date);
    holdings.push(r.holding);
  }
  if (!holdings.length) throw new Error(`ARK ${F}: no holdings parsed (${lines.length - 1} rows, skipped ${JSON.stringify(skipped)})`);
  const asOfDates = [...dates].sort();
  return { fund: F, asOf: asOfDates[asOfDates.length - 1], asOfDates, holdings, skipped, rows: lines.length - 1 };
}

async function fetchArkHoldings(fund, { fetchImpl = fetchWithTimeout, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = ARK_CSV_URLS[fund];
  if (!url) throw new Error(`ARK: unknown fund ${fund}`);
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' }, timeoutMs, retries: 1 });
  if (!r.ok) throw new Error(`ARK ${fund}: HTTP ${r.status}`);
  return parseArkCsv(await r.text(), { fund });
}

// Every fund independently: one bad file never hides the other five. → { funds, errors }
async function fetchAllArkHoldings({ fetchImpl, funds = ARK_FUNDS, concurrency = FETCH_CONCURRENCY } = {}) {
  const results = await mapLimit([...funds], concurrency, async (fund) => {
    try { return { fund, parsed: await fetchArkHoldings(fund, { fetchImpl }) }; } catch (e) { return { fund, error: String((e && e.message) || e) }; }
  });
  const out = { funds: {}, errors: {} };
  for (const r of results) { if (r.parsed) out.funds[r.fund] = r.parsed; else out.errors[r.fund] = r.error; }
  return out;
}

module.exports = {
  ARK_FUNDS, ARK_CSV_URLS, REQUIRED_COLUMNS, FETCH_TIMEOUT_MS,
  fundFromUrl, parseCsvLine, parseNumber, parseUsDate, normalizeTicker, parseArkCsv,
  fetchArkHoldings, fetchAllArkHoldings,
};
