'use strict';
// CATALYST–FLOW — REFERENCE-DATA INGESTION (sector, security type, sector benchmarks).
//
// The offline price cache carries bars and nothing else, so three inputs the experiment
// genuinely needs are not in it:
//
//   1. SECURITY TYPE — to exclude ETFs, funds, units, warrants and preferreds. Without it
//      the "operating common shares" rule is an assumption, not a screen.
//   2. SECTOR — the target is SECTOR-relative. There is no SPY fallback: a sector-labelled
//      statistic that quietly became a market statistic is a defect this repo has shipped
//      once already (commit 1d26675) and will not ship again here.
//   3. SECTOR BENCHMARK BARS — the eleven SPDR sector ETFs.
//
// Sources are free (Yahoo, via the app's own auth handshake). Results are cached to disk
// so a re-run is deterministic and does not re-hit the network.
//
// HONEST LIMITATION, RECORDED IN THE CACHE ITSELF. `assetProfile` returns TODAY's
// classification, not the classification as of a past date. Sector membership is
// slow-moving but not immutable, so every row is stamped `pitVerified: false` and the
// downstream manifest reports `sectorPitVerified: false`. It is an approximation that is
// declared, not one that is hidden.

const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'catalyst-flow');
const PROFILE_PATH = path.join(OUT_DIR, 'profiles.json');
const REFERENCE_VERSION = 'catalyst-reference-v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// Yahoo's sector vocabulary → the app's own SECTOR_ETF keys (lib/omega-backfill.js), so
// there is ONE sector→ETF map in the repo rather than a second private one.
const SECTOR_ETF = require('../../lib/omega-backfill').SECTOR_ETF;
const SECTOR_ETFS = [...new Set(Object.values(SECTOR_ETF))];

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 0)); };

const loadProfiles = () => readJson(PROFILE_PATH, { version: REFERENCE_VERSION, sectorPitVerified: false, profiles: {} });

// One symbol's profile: sector, industry and the security TYPE. A symbol we cannot
// classify is stored as `{ ok:false }` — recorded as a known failure so the next run does
// not silently retry forever, and so eligibility can reject it explicitly.
async function fetchProfile(auth, symbol) {
  const modules = 'assetProfile,quoteType';
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: auth.cookie } });
      if (!r.ok) continue;
      const j = await r.json();
      const res = j?.quoteSummary?.result?.[0];
      if (!res) continue;
      const ap = res.assetProfile || {}, qt = res.quoteType || {};
      return {
        ok: true,
        symbol,
        sector: ap.sector || null,
        industry: ap.industry || null,
        quoteType: qt.quoteType || null,
        exchange: qt.exchange || null,
        fetchedAt: new Date().toISOString(),
        pitVerified: false,
      };
    } catch { /* try the next host */ }
  }
  return { ok: false, symbol, reason: 'profile-unavailable', fetchedAt: new Date().toISOString() };
}

// Ingest profiles for `symbols`, skipping any already cached. Concurrency is modest and
// the cache is flushed periodically so a long run is resumable after an interrupt.
async function ingestProfiles(symbols, { concurrency = 6, flushEvery = 100, onProgress = null } = {}) {
  const { yahooAuth } = require('../../lib/options-baseline');
  const auth = await yahooAuth();
  if (!auth) throw new Error('Yahoo auth handshake failed — cannot ingest reference data');

  const doc = loadProfiles();
  const todo = symbols.filter((s) => !doc.profiles[s]);
  let i = 0, done = 0;

  const worker = async () => {
    while (i < todo.length) {
      const sym = todo[i++];
      doc.profiles[sym] = await fetchProfile(auth, sym);
      done++;
      if (done % flushEvery === 0) { writeJson(PROFILE_PATH, doc); if (onProgress) onProgress(done, todo.length); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, todo.length)) }, worker));
  doc.updatedAt = new Date().toISOString();
  writeJson(PROFILE_PATH, doc);
  return { fetched: todo.length, cached: symbols.length - todo.length, total: Object.keys(doc.profiles).length };
}

// Sector benchmark bars, cached into the SAME price cache the rest of the rig reads, so
// the benchmark and the stock are loaded by one loader with one set of conventions.
async function ingestSectorBenchmarks({ range = '5y', cacheDir = null } = {}) {
  const { fetchDailyHistory } = require('../../lib/screener');
  const dir = cacheDir || path.join(__dirname, '..', 'data', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  const report = {};
  for (const etf of [...SECTOR_ETFS, 'SPY']) {
    const file = path.join(dir, `${etf}.json`);
    const existing = readJson(file, null);
    // SPY is already cached by the rest of the rig; only fill genuine gaps.
    if (existing && Array.isArray(existing.price) && existing.price.length > 200) { report[etf] = { status: 'cached', bars: existing.price.length }; continue; }
    const d = await fetchDailyHistory(etf, range).catch(() => null);
    if (!d || !d.candles || d.candles.length < 200) { report[etf] = { status: 'FAILED', bars: d && d.candles ? d.candles.length : 0 }; continue; }
    // The rig's loader stores newest-first under `.price` and reverses on read.
    writeJson(file, { sym: etf, price: [...d.candles].reverse(), fetchedAt: new Date().toISOString(), source: 'yahoo-chart' });
    report[etf] = { status: 'fetched', bars: d.candles.length };
  }
  return report;
}

// Resolve symbol → { sector, benchmark } using the cached profiles. Returns null when the
// symbol has no usable sector — the caller must DROP the event rather than benchmark it
// against the market.
function sectorOf(profiles, symbol) {
  const p = profiles && profiles.profiles ? profiles.profiles[symbol] : null;
  if (!p || !p.ok || !p.sector) return null;
  const etf = SECTOR_ETF[p.sector];
  if (!etf) return null;
  return { sector: p.sector, industry: p.industry || null, benchmark: etf, quoteType: p.quoteType || null, pitVerified: false };
}

module.exports = {
  REFERENCE_VERSION, OUT_DIR, PROFILE_PATH, SECTOR_ETF, SECTOR_ETFS,
  loadProfiles, fetchProfile, ingestProfiles, ingestSectorBenchmarks, sectorOf,
};
