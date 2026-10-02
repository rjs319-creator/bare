'use strict';
// TIINGO SUPPORTED-TICKERS CROSS-CHECK CORE (tiingo-xcheck-v1) — pure.
//
// Tiingo publishes https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip
// (no key, ~0.8 MB): one CSV `ticker,exchange,assetType,priceCurrency,startDate,endDate`
// for every symbol it has ever carried, INCLUDING dead ones. `endDate` is the LAST bar
// Tiingo holds — a live name's endDate is simply the file's build date, so "dead" is a
// staleness rule relative to the file (never an empty field), mirroring the 10-day stale
// guard the research panel uses for its own price tails (research/lib/pit.js).
//
// This module parses the zip + CSV, classifies US listed names, and diffs the dead set
// against the research secmaster's delisted set so scripts/secmaster-tiingo-xcheck.js can
// report which dead names the FMP-derived master lacks. No network, no fs, no clock.

const zlib = require('zlib');

const TIINGO_XCHECK_VERSION = 'tiingo-xcheck-v1';
const SUPPORTED_TICKERS_URL = 'https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip';
const CSV_COLUMNS = Object.freeze(['ticker', 'exchange', 'assetType', 'priceCurrency', 'startDate', 'endDate']);
// Listed US venues as Tiingo spells them. OTC tiers (PINK, OTCMKTS, OTCGREY, OTCBB, OTCQB,
// OTCQX, OTCCE, EXPM, OTCD) are counted separately — the secmaster is an exchange-listed master.
const US_LISTED_EXCHANGES = Object.freeze(['NASDAQ', 'NYSE', 'NYSE MKT', 'AMEX', 'NYSE ARCA', 'BATS', 'NYSE NAT']);
const STALE_DAYS = 10;                     // endDate older than fileAsOf − 10d ⇒ dead
const DATE_TOLERANCE_DAYS = 45;            // Tiingo last bar vs secmaster delist date agreement window
const DAY_MS = 86400000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
// Common-stock-shaped tickers: 1–5 letters plus an optional one-letter share class (BRK-B).
// Preferreds (FRC-P-B), warrants/units/rights (-WS/-U/-R) and baby bonds ("AMG 5.15") are out.
const COMMON_TICKER_RE = /^[A-Z]{1,5}(-[A-Z])?$/;

const le16 = (buf, off) => buf.readUInt16LE(off);
const le32 = (buf, off) => buf.readUInt32LE(off);

// ── zip: single-entry archive → entry text ──────────────────────────────────
// Reads the CENTRAL DIRECTORY (authoritative sizes even when the local header deferred
// them to a data descriptor), then inflates the first entry whose name matches `pick`.
const SIG_EOCD = 0x06054b50, SIG_CDIR = 0x02014b50, SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22, CDIR_FIXED = 46, LOCAL_FIXED = 30;

function findEocd(buf) {
  for (let i = buf.length - EOCD_MIN; i >= 0; i--) if (le32(buf, i) === SIG_EOCD) return i;
  return -1;
}

function readCentralEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('zip: end-of-central-directory record not found');
  const count = le16(buf, eocd + 10), cdOffset = le32(buf, eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + CDIR_FIXED > buf.length || le32(buf, p) !== SIG_CDIR) throw new Error('zip: central directory entry corrupt');
    const nameLen = le16(buf, p + 28), extraLen = le16(buf, p + 30), commentLen = le16(buf, p + 32);
    entries.push({
      method: le16(buf, p + 10), compressedSize: le32(buf, p + 20), uncompressedSize: le32(buf, p + 24),
      name: buf.toString('utf8', p + CDIR_FIXED, p + CDIR_FIXED + nameLen), localOffset: le32(buf, p + 42),
    });
    p += CDIR_FIXED + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  const lh = entry.localOffset;
  if (lh + LOCAL_FIXED > buf.length || le32(buf, lh) !== SIG_LOCAL) throw new Error(`zip: local header missing for ${entry.name}`);
  const dataStart = lh + LOCAL_FIXED + le16(buf, lh + 26) + le16(buf, lh + 28);
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (raw.length !== entry.compressedSize) throw new Error(`zip: truncated data for ${entry.name}`);
  let out;
  if (entry.method === 0) out = raw;
  else if (entry.method === 8) out = zlib.inflateRawSync(raw);
  else throw new Error(`zip: unsupported compression method ${entry.method}`);
  if (out.length !== entry.uncompressedSize) throw new Error(`zip: size mismatch for ${entry.name} (${out.length} vs ${entry.uncompressedSize})`);
  return out;
}

// The supported_tickers CSV text out of the zip buffer (first .csv entry, else the only entry).
function readSupportedTickersZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN) throw new Error('zip: buffer too small');
  const entries = readCentralEntries(buf);
  if (!entries.length) throw new Error('zip: no entries');
  const entry = entries.find((e) => /\.csv$/i.test(e.name)) || entries[0];
  return extractEntry(buf, entry).toString('utf8');
}

// ── CSV ─────────────────────────────────────────────────────────────────────
// Validated at the boundary: header must match, each row needs 6 fields and ISO dates
// (or an empty endDate). Malformed rows are counted, never silently dropped.
function parseSupportedTickersCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = (lines[0] || '').trim();
  if (header !== CSV_COLUMNS.join(',')) throw new Error(`tiingo csv: unexpected header "${header.slice(0, 80)}"`);
  const rows = [];
  let malformed = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = line.split(',');
    const okDates = ISO_RE.test(f[4] || '') && (f[5] === '' || ISO_RE.test(f[5] || ''));
    if (f.length !== CSV_COLUMNS.length || !f[0] || !okDates) { malformed++; continue; }
    rows.push({ ticker: f[0].trim().toUpperCase(), exchange: f[1].trim(), assetType: f[2].trim(), priceCurrency: f[3].trim(), startDate: f[4], endDate: f[5] || null });
  }
  return { rows, malformed };
}

// ── classification ──────────────────────────────────────────────────────────
const isoDaysBefore = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') - days * DAY_MS).toISOString().slice(0, 10);

// The file's own as-of: the newest endDate present (Tiingo stamps live names with it).
function fileAsOf(rows) {
  let max = null;
  for (const r of rows) if (r.endDate && (!max || r.endDate > max)) max = r.endDate;
  return max;
}

// US listed common-shaped stocks split into dead / active by the staleness rule.
function classifyListedUs(rows, { asOf = fileAsOf(rows), staleDays = STALE_DAYS, exchanges = US_LISTED_EXCHANGES, commonOnly = true } = {}) {
  if (!asOf) throw new Error('tiingo: cannot derive the file as-of date (no endDate anywhere)');
  const deadBefore = isoDaysBefore(asOf, staleDays);
  const ex = new Set(exchanges);
  const dead = [], active = [];
  for (const r of rows) {
    if (r.assetType !== 'Stock' || r.priceCurrency !== 'USD' || !ex.has(r.exchange)) continue;
    if (commonOnly && !COMMON_TICKER_RE.test(r.ticker)) continue;
    if (r.endDate && r.endDate < deadBefore) dead.push(r); else active.push(r);
  }
  return { asOf, deadBefore, dead, active };
}

const countBy = (rows, key) => rows.reduce((acc, r) => ({ ...acc, [key(r)]: (acc[key(r)] || 0) + 1 }), {});

// ── secmaster join ──────────────────────────────────────────────────────────
// Delisted set from either master shape: v1 (records[sym].delisted/delistDate) or v3
// (records[sym].delisting.date). Returns Map<SYM, delistDate|null>.
function delistedFromSecmasterDoc(doc) {
  const out = new Map();
  const records = (doc && doc.records) || {};
  for (const [sym, rec] of Object.entries(records)) {
    if (!rec) continue;
    if (rec.delisted === true) out.set(sym.toUpperCase(), rec.delistDate || null);
    else if (rec.delisting && rec.delisting.date) out.set(sym.toUpperCase(), rec.delisting.date);
  }
  return out;
}

const normalizeSymbol = (s) => String(s || '').toUpperCase().replace(/\./g, '-');

// Dead Tiingo names vs the secmaster's delisted set. `missing` = dead in Tiingo, absent from
// the master's delisted set (the names FMP lacks); `dateDisagreements` = present in both but
// the last-bar dates differ by more than the tolerance; `masterOnly` = master delistings
// Tiingo never carried under that symbol (renames / recycled tickers show up here);
// `masterOnlyActiveInTiingo` = the subset Tiingo still shows TRADING — suspected false
// delistings from a stale FMP price tail (the v1 master infers delisting from the last bar).
function diffDeadVsSecmaster(deadRows, delistedMap, { tolDays = DATE_TOLERANCE_DAYS, activeRows = [] } = {}) {
  const deadBySym = new Map(deadRows.map((r) => [normalizeSymbol(r.ticker), r]));
  const activeSyms = new Set(activeRows.map((r) => normalizeSymbol(r.ticker)));
  const missing = [], inBoth = [], dateDisagreements = [];
  for (const [sym, r] of deadBySym) {
    const masterDate = delistedMap.get(sym);
    if (masterDate === undefined) { missing.push(r); continue; }
    inBoth.push(sym);
    if (masterDate && r.endDate && Math.abs(Date.parse(masterDate) - Date.parse(r.endDate)) / DAY_MS > tolDays) {
      dateDisagreements.push({ ticker: sym, tiingoEnd: r.endDate, secmasterDelist: masterDate });
    }
  }
  const masterOnly = [...delistedMap.keys()].filter((s) => !deadBySym.has(s)).sort();
  const masterOnlyActiveInTiingo = masterOnly.filter((s) => activeSyms.has(s));
  missing.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
  return { missing, inBoth: inBoth.sort(), dateDisagreements, masterOnly, masterOnlyActiveInTiingo };
}

module.exports = {
  TIINGO_XCHECK_VERSION, SUPPORTED_TICKERS_URL, CSV_COLUMNS, US_LISTED_EXCHANGES, STALE_DAYS, DATE_TOLERANCE_DAYS, COMMON_TICKER_RE,
  readSupportedTickersZip, readCentralEntries, parseSupportedTickersCsv,
  fileAsOf, classifyListedUs, countBy, delistedFromSecmasterDoc, normalizeSymbol, diffDeadVsSecmaster,
};
