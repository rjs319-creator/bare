#!/usr/bin/env node
'use strict';
// SECMASTER × TIINGO CROSS-CHECK — which dead US names does the FMP-derived master lack?
//
//   node scripts/secmaster-tiingo-xcheck.js                 # download the zip, diff, write the summary
//   node scripts/secmaster-tiingo-xcheck.js --zip <file>    # reuse a downloaded supported_tickers.zip
//   node scripts/secmaster-tiingo-xcheck.js --secmaster <research/data/secmaster.json|secmaster-v3.json>
//
// Writes research/data-derived/secmaster-tiingo-xcheck.json (small, committable): Tiingo-side
// counts (listed-US common stocks dead by year/exchange) plus the diff against the secmaster's
// delisted set when a master file is present. research/data/ is gitignored and may be absent
// on this machine — then the diff section is written as `available:false` with the reason,
// never fabricated. The FULL missing-name list goes to research/data/ (ignored); the committed
// summary carries a capped sample.
//
// Tiingo's list has no license statement and no key; this is metadata only. Prices for the
// extra dead names would need Tiingo EOD (paid tier) — a user decision, not this script's.

const fs = require('fs');
const path = require('path');
const T = require('../research/lib/tiingo-tickers');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'research', 'data');
const DERIVED = path.join(ROOT, 'research', 'data-derived');
const OUT_PATH = path.join(DERIVED, 'secmaster-tiingo-xcheck.json');
const FULL_LIST_PATH = path.join(DATA, 'secmaster-tiingo-missing.csv');
const MASTER_CANDIDATES = [path.join(DATA, 'secmaster.json'), path.join(DATA, 'secmaster-v3.json')];
const SAMPLE_CAP = 300;
const FETCH_TIMEOUT_MS = 60_000;

const argValue = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };

async function loadZip() {
  const local = argValue('zip');
  if (local) return { buf: fs.readFileSync(local), source: `file:${local}` };
  const res = await fetch(T.SUPPORTED_TICKERS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`tiingo download failed: HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), source: T.SUPPORTED_TICKERS_URL };
}

function loadSecmaster() {
  const explicit = argValue('secmaster');
  const candidates = explicit ? [explicit] : MASTER_CANDIDATES;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const delisted = T.delistedFromSecmasterDoc(doc);
    if (delisted.size) return { path: p.startsWith(ROOT) ? path.relative(ROOT, p) : path.basename(p), version: doc.v || doc.version || null, delisted };
  }
  return { path: null, delisted: null, reason: `no secmaster with delistings at ${candidates.map((p) => path.relative(ROOT, p)).join(' | ')} (research/data is gitignored and absent on this host)` };
}

const sampleRow = (r) => `${r.ticker}|${r.exchange}|${r.startDate}|${r.endDate}`;

function tiingoSummary(rows, malformed, cls) {
  const byYear = T.countBy(cls.dead, (r) => r.endDate.slice(0, 4));
  return {
    rows: rows.length, malformed, fileAsOf: cls.asOf, deadBefore: cls.deadBefore, staleDays: T.STALE_DAYS,
    usdStockRows: rows.filter((r) => r.assetType === 'Stock' && r.priceCurrency === 'USD').length,
    listedUsCommon: { total: cls.dead.length + cls.active.length, dead: cls.dead.length, active: cls.active.length },
    deadByExchange: T.countBy(cls.dead, (r) => r.exchange),
    deadByYear: Object.fromEntries(Object.entries(byYear).sort()),
    exchanges: T.US_LISTED_EXCHANGES,
    commonTickerRule: String(T.COMMON_TICKER_RE),
  };
}

function diffSummary(cls, master) {
  if (!master.delisted) return { available: false, reason: master.reason };
  const d = T.diffDeadVsSecmaster(cls.dead, master.delisted, { activeRows: cls.active });
  return {
    available: true, secmaster: master.path, secmasterVersion: master.version, secmasterDelisted: master.delisted.size,
    inBoth: d.inBoth.length, tiingoDeadNotInSecmaster: d.missing.length, secmasterDelistedNotInTiingo: d.masterOnly.length,
    secmasterDelistedButTiingoActive: d.masterOnlyActiveInTiingo.length, secmasterDelistedButTiingoActiveSample: d.masterOnlyActiveInTiingo.slice(0, SAMPLE_CAP),
    dateDisagreements: d.dateDisagreements.length, dateToleranceDays: T.DATE_TOLERANCE_DAYS,
    missingByYear: Object.fromEntries(Object.entries(T.countBy(d.missing, (r) => r.endDate.slice(0, 4))).sort()),
    missingSample: d.missing.slice(0, SAMPLE_CAP).map(sampleRow),
    masterOnlySample: d.masterOnly.slice(0, SAMPLE_CAP),
    fullMissingList: path.relative(ROOT, FULL_LIST_PATH),
    _missing: d.missing,
  };
}

async function main() {
  const { buf, source } = await loadZip();
  const { rows, malformed } = T.parseSupportedTickersCsv(T.readSupportedTickersZip(buf));
  const cls = T.classifyListedUs(rows);
  const master = loadSecmaster();
  const { _missing, ...diff } = diffSummary(cls, master);
  const out = {
    version: T.TIINGO_XCHECK_VERSION, generatedAt: new Date().toISOString(), source, zipBytes: buf.length,
    tiingo: tiingoSummary(rows, malformed, cls), diff,
    note: 'Tiingo endDate = last bar held (live names carry the file date), so dead = endDate older than fileAsOf − staleDays. Common-shaped tickers only; OTC tiers excluded. Prices for missing names are NOT included (Tiingo EOD is a paid decision).',
  };
  fs.mkdirSync(DERIVED, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1) + '\n');
  if (_missing) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FULL_LIST_PATH, ['ticker,exchange,startDate,endDate', ..._missing.map((r) => `${r.ticker},${r.exchange},${r.startDate},${r.endDate}`)].join('\n') + '\n');
  }
  const t = out.tiingo;
  process.stdout.write(`tiingo ${t.rows} rows (as of ${t.fileAsOf}) → listed-US common ${t.listedUsCommon.total}: dead ${t.listedUsCommon.dead}, active ${t.listedUsCommon.active}\n`);
  process.stdout.write(diff.available
    ? `secmaster ${diff.secmaster}: ${diff.secmasterDelisted} delisted · in both ${diff.inBoth} · Tiingo-dead missing from master ${diff.tiingoDeadNotInSecmaster} · master-only ${diff.secmasterDelistedNotInTiingo}\n`
    : `secmaster diff BLOCKED: ${diff.reason}\n`);
  process.stdout.write(`saved → ${path.relative(ROOT, OUT_PATH)}\n`);
}

main().catch((e) => { process.stderr.write(`secmaster-tiingo-xcheck failed: ${String((e && e.message) || e)}\n`); process.exit(1); });
