'use strict';
// POINT-IN-TIME SECURITY MASTER (research-side, survivorship-complete). `pit-secmaster-v1`.
//
// WHY this exists separately from the app's lib/security-master.js: that one is a clean PIT
// interface, but it is populated only from ~55 Wikipedia-scraped S&P removals, so it declares
// `survivorshipSafe = false` by construction. THIS builds the real thing from the research rig's
// survivorship-COMPLETE FMP cache (research/data/cache/*.json — ~10k US symbols INCLUDING delisted
// names like SIVB / FRC, whose daily price + quarterly income FMP retains to their last trading day).
//
// For each symbol it derives a point-in-time LISTING RECORD (first/last traded bar → delisted?).
// `universeAt(asOf)` then returns the cross-section that was actually tradeable THEN — a name is
// included from its first bar up to the day it stopped trading, and excluded after — which is
// exactly what removes survivorship bias from a cross-sectional backtest. Membership optionally
// applies the same PIT cap-band + liquidity filter as the panel (research/03), computed as-of the
// date (close × report-lagged shares, trailing-20d ADV) so it never peeks.
//
// The pure core (buildRecord / memberAsOf / universeFrom / candlesFor) is unit-tested; the
// disk-backed layer reads the cache and writes research/data/secmaster.json.

const fs = require('fs');
const path = require('path');
const pit = require('./pit');

const DATA = path.join(__dirname, '..', 'data');
const CACHE = pit.CACHE;
const SECMASTER_PATH = path.join(DATA, 'secmaster.json');
const VERSION = 'pit-secmaster-v1';

// A name whose LAST bar predates this is treated as DELISTED (it stopped trading); otherwise a stale
// tail just means the free feed lags. Same cutoff as research/04 so the two agree.
const ACTIVE_CUTOFF_MS = Date.UTC(2026, 3, 1);   // 2026-04-01
const DAY = pit.DAY;
const DEFAULT_BAND = Object.freeze({ capLo: pit.CAP_LO, capHi: pit.CAP_HI, advFloor: pit.ADV_FLOOR });

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// PURE. From one cached record { sym, price[], income[], sector? } derive the listing record.
// Returns null when there is no usable price history (cannot place the name in time).
function buildRecord(rec, { activeCutoffMs = ACTIVE_CUTOFF_MS } = {}) {
  if (!rec || !rec.sym) return null;
  const ps = pit.priceSeries(rec.price || []);
  if (!ps.length) return null;
  const first = ps[0].ms, last = ps[ps.length - 1].ms;
  const delisted = last < activeCutoffMs;
  return {
    sym: rec.sym,
    firstDate: iso(first),
    lastDate: iso(last),
    delisted,
    delistDate: delisted ? iso(last) : null,   // last traded day ≈ delisting date (free feed has no reason code)
    nBars: ps.length,
    hasIncome: !!(rec.income && rec.income.length),
    sector: rec.sector || null,
  };
}

// PURE. Was `rec` tradeable AND in-band as of dateMs, from its own cached series? Uses PIT cap
// (close × report-lagged shares) + trailing-20d ADV, exactly like the panel (research/03). Returns
// a membership row, or null when the name is not a member then (unlisted yet / already delisted /
// out of band / no data). `band = null` skips the cap/liquidity filter (listing-window membership only).
function memberAsOf(rec, dateMs, band = DEFAULT_BAND) {
  const ps = pit.priceSeries(rec.price || []);
  if (!ps.length) return null;
  // Outside the listing window: not yet listed, or delisted more than a few days ago.
  if (dateMs < ps[0].ms || dateMs > ps[ps.length - 1].ms + 5 * DAY) return null;
  const pa = pit.asOfPriceAdv(ps, dateMs);
  if (!pa || pa.stale) return null;   // stale ⇒ the name has effectively stopped trading by dateMs
  if (!band) return { sym: rec.sym, close: pa.close, adv: Math.round(pa.adv), cap: null };
  const sh = pit.asOfShares(pit.sharesSeries(rec.income || []), dateMs);
  if (!sh) return null;
  const cap = pa.close * sh;
  if (cap < band.capLo || cap > band.capHi || pa.adv < band.advFloor) return null;
  return { sym: rec.sym, cap: Math.round(cap), adv: Math.round(pa.adv), close: pa.close };
}

// PURE. The survivorship-free cross-section as of dateMs, over an in-memory { sym: cachedRec } map.
// Delisted names ARE included up to the day they stopped trading — that is the whole point.
function universeFrom(recordsMap, dateMs, band = DEFAULT_BAND) {
  const out = [];
  for (const sym of Object.keys(recordsMap || {})) {
    const m = memberAsOf(recordsMap[sym], dateMs, band);
    if (m) out.push(m);
  }
  return out.sort((a, b) => (a.sym < b.sym ? -1 : 1));
}

// PURE. Adapt an FMP price array (newest-first) to the ascending OHLCV candle shape the NSL
// harnesses consume ({ date, open, high, low, close, volume }). Missing OHLC fields fall back to close.
function candlesFor(rec) {
  const rows = (rec && rec.price || [])
    .filter(r => r && r.date && r.close > 0)
    .map(r => ({ date: r.date, open: r.open ?? r.close, high: r.high ?? r.close, low: r.low ?? r.close, close: r.close, volume: r.volume ?? 0 }));
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

// ── disk-backed layer ────────────────────────────────────────────────────────

function cachedSyms() {
  try { return fs.readdirSync(CACHE).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
  catch { return []; }
}

function loadCached(sym) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE, `${sym}.json`), 'utf8')); }
  catch { return null; }
}

// Load { sym: cachedRec } for a symbol list, overlaying sector from symbols.json when present.
function loadRecordsForSyms(syms, { sectorOf = {} } = {}) {
  const map = {};
  for (const sym of syms) {
    const rec = loadCached(sym);
    if (!rec) continue;
    if (!rec.sector && sectorOf[sym]) rec.sector = sectorOf[sym];
    map[sym] = rec;
  }
  return map;
}

// Build the master over the whole cache and persist listing metadata (no price arrays).
function buildMaster({ activeCutoffMs = ACTIVE_CUTOFF_MS, write = true } = {}) {
  const sectorOf = readSurvivorSectors();
  const records = {};
  let survivors = 0, delisted = 0, skipped = 0;
  for (const sym of cachedSyms()) {
    const rec = loadCached(sym);
    if (rec && !rec.sector && sectorOf[sym]) rec.sector = sectorOf[sym];
    const r = buildRecord(rec, { activeCutoffMs });
    if (!r) { skipped++; continue; }
    records[sym] = r;
    if (r.delisted) delisted++; else survivors++;
  }
  const doc = { v: VERSION, builtAt: new Date().toISOString(), activeCutoff: iso(activeCutoffMs), count: Object.keys(records).length, survivors, delisted, skipped, records };
  if (write) fs.writeFileSync(SECMASTER_PATH, JSON.stringify(doc));
  return doc;
}

function loadMaster() {
  try { return JSON.parse(fs.readFileSync(SECMASTER_PATH, 'utf8')); }
  catch { return null; }
}

// Sector overlay from the survivor superset (research/02 symbols.json), when it exists.
function readSurvivorSectors() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols || {};
    const out = {}; for (const sym of Object.keys(s)) if (s[sym] && s[sym].sector) out[sym] = s[sym].sector;
    return out;
  } catch { return {}; }
}

// Disk convenience: universe as-of a YYYY-MM-DD over the WHOLE cache. Scans every cached series, so
// prefer loadRecordsForSyms + universeFrom when querying many dates for a fixed candidate set.
function universeAt(asOfDate, band = DEFAULT_BAND) {
  const dateMs = Date.parse(asOfDate + 'T00:00:00Z');
  const map = {};
  for (const sym of cachedSyms()) { const rec = loadCached(sym); if (rec) map[sym] = rec; }
  return universeFrom(map, dateMs, band);
}

module.exports = {
  VERSION, ACTIVE_CUTOFF_MS, DEFAULT_BAND, SECMASTER_PATH,
  buildRecord, memberAsOf, universeFrom, candlesFor,          // pure
  cachedSyms, loadCached, loadRecordsForSyms, buildMaster, loadMaster, universeAt, readSurvivorSectors,  // disk
};
