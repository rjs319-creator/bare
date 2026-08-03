'use strict';
// Step 55 — RESUMABLE HISTORICAL-DATA EXPANSION (target: 2010-01-01 → cutoff).
//
//   node --env-file=research/.env research/55-history-expand.js \
//        [--from=2010-01-01] [--to=2021-12-31] [--symbols=AAPL,MSFT | --limit=N]
//        [--probe] [--corpactions]
//
// WHY: the 48-month panel is too short for reliable 63/126-session inference.
// This collector extends RAW history in content-addressed, per-(symbol, year)
// partitions so a longer panel can be built once historical listing membership
// exists (see the BLOCKED artifact this script writes: prices alone do NOT
// make a survivorship-defensible panel).
//
// Guarantees:
//   * explicit from/to on every request (FMP stable historical-price-eod/full);
//   * partitions research/data/history/<SYM>/<year>.json carry a content hash;
//   * a VALID existing partition is NEVER overwritten silently (skipped and
//     counted; --force is deliberately not implemented);
//   * resumable: an index (history/index.json) records per-symbol progress;
//     rerunning continues where the last run stopped;
//   * raw OHLCV preserved verbatim; nothing fabricated for missing years;
//   * splits+dividends collected for the same period with --corpactions;
//   * a monthly coverage report (history-coverage.json) is produced/refreshed
//     every run — experiments must consult it BEFORE using expanded data;
//   * symbols/years the provider cannot serve are recorded as blocked, not
//     invented.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fmp = require('./lib/fmp');

const DATA = path.join(__dirname, 'data');
const HIST = path.join(DATA, 'history');
const INDEX_PATH = path.join(HIST, 'index.json');
const COVERAGE_PATH = path.join(DATA, 'history-coverage.json');
const BLOCKED_PATH = path.join(DATA, 'history-expansion.BLOCKED.json');
const DEFAULT_FROM = '2010-01-01';
const DEFAULT_TO = '2021-12-31';       // the existing cache already covers 2021-06→present

const arg = (name, dflt = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? true : dflt;
};

const sha256 = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return { schema: 'HistoryExpansionIndex', version: 'history-expansion-v1', symbols: {}, blocked: {} }; }
}
const saveIndex = (idx) => { fs.mkdirSync(HIST, { recursive: true }); fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2)); };

function partitionPath(sym, year) { return path.join(HIST, sym, `${year}.json`); }

function validPartition(p) {
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    return !!(doc && doc.contentHash && doc.contentHash === sha256(doc.bars || []));
  } catch { return false; }
}

// Write one immutable partition. Refuses to replace a valid one.
function writePartition({ sym, year, from, to, bars, source }) {
  const p = partitionPath(sym, year);
  if (fs.existsSync(p)) {
    if (validPartition(p)) return { written: false, reason: 'valid-partition-exists-never-overwritten' };
    // corrupt partition → keep the evidence, write beside it
    fs.renameSync(p, `${p}.corrupt-${Date.now()}`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const doc = {
    schema: 'HistoricalPricePartition', version: 'history-expansion-v1',
    symbol: sym, year, from, to, source,
    barCount: bars.length,
    retrievedAt: new Date().toISOString(),
    contentHash: sha256(bars),
    bars,                                            // RAW vendor OHLCV, untouched
  };
  fs.writeFileSync(p, JSON.stringify(doc));
  return { written: true };
}

async function collectSymbol(sym, from, to, idx, { corpactions = false } = {}) {
  const st = (idx.symbols[sym] ||= { status: 'pending', years: {}, lastError: null });
  try {
    const rows = await fmp.get('historical-price-eod/full', { symbol: sym, from, to });
    const bars = Array.isArray(rows) ? rows : (rows && rows.historical) || [];
    if (!bars.length) {
      st.status = 'no-data';
      (idx.blocked[sym] ||= []).push({ from, to, reason: 'provider returned no bars for the requested range', at: new Date().toISOString() });
      return { sym, bars: 0 };
    }
    const byYear = new Map();
    for (const b of bars) {
      const y = String(b.date || '').slice(0, 4);
      if (!/^\d{4}$/.test(y)) continue;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(b);
    }
    for (const [year, yb] of byYear) {
      const r = writePartition({ sym, year, from, to, bars: yb, source: 'fmp-stable:historical-price-eod/full' });
      st.years[year] = { bars: yb.length, ...(r.written ? {} : { skipped: r.reason }) };
    }
    if (corpactions) {
      const [splits, dividends] = [
        await fmp.get('splits', { symbol: sym }).catch(() => null),
        await fmp.get('dividends', { symbol: sym }).catch(() => null),
      ];
      if (Array.isArray(splits) || Array.isArray(dividends)) {
        const doc = { symbol: sym, from, to, splits: splits || [], dividends: dividends || [], retrievedAt: new Date().toISOString() };
        doc.contentHash = sha256({ splits: doc.splits, dividends: doc.dividends });
        fs.mkdirSync(path.join(HIST, sym), { recursive: true });
        fs.writeFileSync(path.join(HIST, sym, 'corpactions.json'), JSON.stringify(doc));
      }
    }
    const years = [...byYear.keys()].sort();
    st.status = 'collected';
    st.range = { firstBar: bars[bars.length - 1] && bars[bars.length - 1].date, lastBar: bars[0] && bars[0].date };
    st.lastError = null;
    return { sym, bars: bars.length, years: `${years[0]}..${years[years.length - 1]}` };
  } catch (e) {
    st.status = 'error';
    st.lastError = String(e.message).slice(0, 160);
    (idx.blocked[sym] ||= []).push({ from, to, reason: st.lastError, at: new Date().toISOString() });
    return { sym, error: st.lastError };
  }
}

// Monthly coverage over collected partitions: how many symbols have ≥15 bars
// in each month. Experiments must consult this BEFORE using expanded history.
function coverageReport() {
  const monthly = {};
  let symbols = 0;
  if (fs.existsSync(HIST)) {
    for (const sym of fs.readdirSync(HIST)) {
      const d = path.join(HIST, sym);
      if (!fs.statSync(d).isDirectory()) continue;
      symbols++;
      for (const f of fs.readdirSync(d)) {
        if (!/^\d{4}\.json$/.test(f)) continue;
        let doc; try { doc = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
        const perMonth = {};
        for (const b of doc.bars || []) {
          const ym = String(b.date || '').slice(0, 7);
          perMonth[ym] = (perMonth[ym] || 0) + 1;
        }
        for (const [ym, n] of Object.entries(perMonth)) {
          if (n >= 15) (monthly[ym] ||= 0), monthly[ym]++;
        }
      }
    }
  }
  return { schema: 'HistoryCoverageReport', generatedAt: new Date().toISOString(), symbolsCollected: symbols, monthlySymbolCounts: monthly };
}

// The honest boundary: prices alone are NOT a survivorship-defensible panel.
function writeBlockedArtifact(idx) {
  const blocked = {
    schema: 'HistoricalExpansionBlocked',
    status: 'BLOCKED',
    checkedAt: new Date().toISOString(),
    whatWorks: [
      'FMP stable historical-price-eod/full serves explicit from/to ranges back beyond 2010 for symbols it knows (verified by probe; see probeResults in history/index.json).',
      'Resumable content-addressed price partitions + splits/dividends collection are implemented (research/55-history-expand.js).',
    ],
    missingDataset: {
      name: 'authoritative monthly historical listing universe, 2010→present',
      requirements: [
        'complete point-in-time listing membership per month (every US-listed common stock that EXISTED that month, not the present-day list)',
        'delisting dates AND categorized reasons (bankruptcy vs acquisition vs move) for the whole era',
        'symbol-change/rename chains for the whole era (vendor /symbol-change is ~3 months deep)',
        'instrument typing (common stock vs ETF/ADR/unit/preferred) as of each month',
      ],
      whyBlocking: 'Without historical membership, a 2010-era panel can only start from today\'s survivors plus partially-enumerated delistings — the existing pit-security-master reconstruction measured a ~25% listing hole at 2022, growing with distance. Every conclusion drawn from such a panel would carry unbounded survivorship bias, and survivorshipStatus could never leave `survivorship-reduced`.',
      knownCandidateSources: [
        'CRSP monthly stock file (academic license)',
        'Nasdaq/NYSE daily list archives (nasdaqtrader.com symbol directory archives)',
        'commercial security-master vendors (e.g. Sharadar/Norgate) with delisting coverage',
      ],
      providerFindings: 'FMP delisted-companies enumeration is present-plan-gated and incomplete for the pre-2020 era; it cannot certify monthly membership. No purchase or integration performed automatically — human decision required.',
    },
    consequence: 'Panel extension to 2010 is NOT built. Price collection may proceed for cached-universe symbols, but any experiment on the expanded era must carry survivorshipStatus=survivorship-reduced and is barred from promotion eligibility.',
    blockedSymbols: Object.keys(idx.blocked || {}).length,
  };
  fs.writeFileSync(BLOCKED_PATH, JSON.stringify(blocked, null, 2));
  return blocked;
}

async function main() {
  const from = arg('from', DEFAULT_FROM);
  const to = arg('to', DEFAULT_TO);
  const probe = arg('probe', false) === true;
  const corpactions = arg('corpactions', false) === true;
  const symbolsArg = arg('symbols', null);
  const limit = Number(arg('limit', 0)) || 0;

  const idx = loadIndex();

  let symbols;
  if (symbolsArg) symbols = symbolsArg.split(',').map((s) => s.trim()).filter(Boolean);
  else {
    const doc = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8'));
    symbols = Object.keys(doc.symbols).sort()
      .filter((s) => !idx.symbols[s] || idx.symbols[s].status === 'pending' || idx.symbols[s].status === 'error');
    if (limit) symbols = symbols.slice(0, limit);
  }

  if (probe) {
    // Small, explicit availability probe — recorded, never extrapolated.
    const probeSyms = symbols.slice(0, 3);
    console.log(`PROBE: ${probeSyms.join(', ')} for ${from}..${to}`);
    for (const sym of probeSyms) {
      const r = await collectSymbol(sym, from, to, idx, { corpactions });
      console.log(' ', sym, JSON.stringify(r));
    }
    idx.probeResults = { at: new Date().toISOString(), from, to, symbols: probeSyms.map((s) => ({ s, ...idx.symbols[s] && { status: idx.symbols[s].status, range: idx.symbols[s].range } })) };
    saveIndex(idx);
    fs.writeFileSync(COVERAGE_PATH, JSON.stringify(coverageReport(), null, 2));
    writeBlockedArtifact(idx);
    console.log(`BLOCKED artifact refreshed → ${path.relative(process.cwd(), BLOCKED_PATH)} (historical listing membership is the missing dataset)`);
    return;
  }

  console.log(`collecting ${symbols.length} symbols, ${from}..${to} (resumable; valid partitions never overwritten)`);
  let done = 0, errors = 0;
  for (const sym of symbols) {
    const r = await collectSymbol(sym, from, to, idx, { corpactions });
    if (r.error) errors++;
    done++;
    if (done % 25 === 0 || done === symbols.length) {
      saveIndex(idx);
      console.log(`  ${done}/${symbols.length} (${errors} errors)`);
    }
  }
  saveIndex(idx);
  fs.writeFileSync(COVERAGE_PATH, JSON.stringify(coverageReport(), null, 2));
  writeBlockedArtifact(idx);
  console.log(`coverage report → ${path.relative(process.cwd(), COVERAGE_PATH)}; BLOCKED artifact → ${path.relative(process.cwd(), BLOCKED_PATH)}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
