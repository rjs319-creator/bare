'use strict';
// Step 97 — build the five-year open-market insider BUY table from the SEC bulk
// Form 3/4/5 datasets (one zip per quarter), replacing per-ticker EDGAR crawling.
//
//   node research/97-form345-build.js            # download missing quarters, parse, write
//   node research/97-form345-build.js --no-fetch # parse only what is on disk
//
// Output (gitignored):
//   research/data/form345/<q>_form345.zip          raw quarterly zips (resumable download)
//   research/data/form345-buys/<TICKER>.json       { ticker, source, quarters, txs }
//   research/data/form345-buys/index.json          build metadata, exclusions, consistency check
//
// PIT note: `filingDate` is the SEC filing date (the disclosure clock the cluster study
// keys on); `date` is the transaction date. Never anchor an event on `date`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const F = require('./lib/form345');

const DATA = path.join(__dirname, 'data');
const ZIP_DIR = path.join(DATA, 'form345');
const OUT_DIR = path.join(DATA, 'form345-buys');
const INDEX_URL = 'https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets';
const FALLBACK_BASE = 'https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/';
const UA = process.env.SEC_USER_AGENT || 'market-news-app research rjs319@gmail.com';
const FROM_Q = '2021q2';           // price cache starts 2021-06
const TO_Q = '2026q2';
const PAUSE_MS = 1100;             // SEC: ≤10 req/s; we go far slower
const MAX_BUFFER = 512 * 1024 * 1024;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function quarterList(from, to) {
  const [fy, fq] = [parseInt(from.slice(0, 4), 10), parseInt(from.slice(5), 10)];
  const [ty, tq] = [parseInt(to.slice(0, 4), 10), parseInt(to.slice(5), 10)];
  const out = [];
  for (let y = fy, q = fq; y < ty || (y === ty && q <= tq); ) {
    out.push(`${y}q${q}`);
    q++; if (q > 4) { q = 1; y++; }
  }
  return out;
}

async function scrapeHrefs() {
  const r = await fetch(INDEX_URL, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!r.ok) throw new Error(`index page ${r.status}`);
  const html = await r.text();
  const map = {};
  for (const m of html.matchAll(/href="([^"]*?(\d{4}q[1-4])_form345\.zip)"/g)) map[m[2]] = new URL(m[1], 'https://www.sec.gov').href;
  return map;
}

async function download(q, hrefs) {
  const f = path.join(ZIP_DIR, `${q}_form345.zip`);
  if (fs.existsSync(f) && fs.statSync(f).size > 100000) return { q, skipped: true };
  const url = hrefs[q] || `${FALLBACK_BASE}${q}_form345.zip`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return { q, error: `http ${r.status}`, url };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100000 || buf.slice(0, 2).toString() !== 'PK') return { q, error: `not a zip (${buf.length} bytes)`, url };
  fs.writeFileSync(f, buf);
  return { q, bytes: buf.length, url };
}

function readTable(zip, name) {
  return execFileSync('unzip', ['-p', zip, name], { maxBuffer: MAX_BUFFER, encoding: 'utf8' });
}

async function cikToTickerMap() {
  try {
    const { loadCikMap } = require('../lib/edgar');
    const t2c = await loadCikMap();
    const inv = {};
    for (const [tk, cik] of Object.entries(t2c)) if (!inv[cik]) inv[cik] = tk;   // first ticker per CIK
    return inv;
  } catch (e) {
    console.warn('cik map unavailable:', e.message);
    return null;
  }
}

function parseQuarter(q, cikToTicker) {
  const zip = path.join(ZIP_DIR, `${q}_form345.zip`);
  const submissions = F.parseTsv(readTable(zip, 'SUBMISSION.tsv'));
  const trans = F.parseTsv(readTable(zip, 'NONDERIV_TRANS.tsv'));
  const owners = F.parseTsv(readTable(zip, 'REPORTINGOWNER.tsv'));
  const res = F.extractBuys({ submissions, trans, owners }, { cikToTicker });
  return { ...res, meta: { rows: trans.length, filings: submissions.length, buys: res.counts.buyRows, tickers: res.counts.tickers } };
}

function loadEdgarCrawl(sym) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'insider-edgar', `${sym}.json`), 'utf8')); } catch { return null; }
}

function perYear(txs, years) {
  const out = {};
  for (const y of years) out[y] = { n: 0, usd: 0 };
  for (const t of txs || []) {
    if (t.code !== 'P') continue;
    const y = String(t.filingDate || t.date || '').slice(0, 4);
    if (out[y]) { out[y].n++; out[y].usd += t.value || Math.round(t.shares * t.price); }
  }
  return out;
}

function consistencyCheck(byTicker) {
  const dir = path.join(DATA, 'insider-edgar');
  if (!fs.existsSync(dir)) return { note: 'no per-ticker EDGAR crawl on disk' };
  const ranked = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const d = loadEdgarCrawl(f.replace(/\.json$/, ''));
    return { sym: f.replace(/\.json$/, ''), buys: (d && d.txs ? d.txs.filter(t => t.code === 'P').length : 0) };
  }).sort((a, b) => b.buys - a.buys).slice(0, 10);
  const years = ['2022', '2023', '2024', '2025'];
  const rows = ranked.map(({ sym }) => {
    const crawl = perYear((loadEdgarCrawl(sym) || {}).txs, years);
    const bulk = perYear(byTicker[sym] || [], years);
    return { sym, years: Object.fromEntries(years.map(y => [y, { crawlN: crawl[y].n, bulkN: bulk[y].n, crawlUsd: Math.round(crawl[y].usd), bulkUsd: Math.round(bulk[y].usd) }])) };
  });
  return {
    basis: 'P-buy rows per FILING year, one row per reporting owner in both sources; crawl = research/data/insider-edgar (≤150 filings/name from 2021-01-01, parsed from XML), bulk = SEC Form 345 datasets',
    rows,
  };
}

async function main() {
  const t0 = Date.now();
  const noFetch = process.argv.includes('--no-fetch');
  fs.mkdirSync(ZIP_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const quarters = quarterList(FROM_Q, TO_Q);

  const fetched = [];
  if (!noFetch) {
    let hrefs = {};
    try { hrefs = await scrapeHrefs(); } catch (e) { console.warn('index scrape failed, using fallback paths:', e.message); }
    for (const q of quarters) {
      const r = await download(q, hrefs);
      fetched.push(r);
      console.log(`download ${q}: ${r.skipped ? 'on disk' : r.error ? 'ERROR ' + r.error : (r.bytes / 1e6).toFixed(1) + ' MB'}`);
      if (!r.skipped) await sleep(PAUSE_MS);
    }
  }

  const cikToTicker = await cikToTickerMap();
  const all = {};                 // ticker → txs
  const quartersMeta = {};
  const exclusions = {};
  const qDone = [];
  for (const q of quarters) {
    const zip = path.join(ZIP_DIR, `${q}_form345.zip`);
    if (!fs.existsSync(zip)) { quartersMeta[q] = { missing: true }; continue; }
    const t1 = Date.now();
    const res = parseQuarter(q, cikToTicker);
    for (const [tk, txs] of Object.entries(res.byTicker)) (all[tk] = all[tk] || []).push(...txs);
    for (const [k, v] of Object.entries(res.exclusions)) exclusions[k] = (exclusions[k] || 0) + v;
    quartersMeta[q] = { ...res.meta, resolvedByCik: res.counts.resolvedByCik, amendedRows: res.counts.amendedRows, ms: Date.now() - t1 };
    qDone.push(q);
    console.log(`parse ${q}: ${res.meta.rows} trans rows → ${res.meta.buys} buy rows across ${res.meta.tickers} tickers (${Date.now() - t1} ms)`);
  }

  // Write per-ticker docs (sorted by transaction date for deterministic output).
  for (const f of fs.readdirSync(OUT_DIR)) if (f.endsWith('.json')) fs.unlinkSync(path.join(OUT_DIR, f));
  let totalBuys = 0;
  for (const [tk, txs] of Object.entries(all)) {
    const sorted = txs.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.filingDate < b.filingDate ? -1 : 1)));
    fs.writeFileSync(path.join(OUT_DIR, `${tk}.json`), JSON.stringify({ ticker: tk, source: 'sec-form345-bulk', quarters: qDone, txs: sorted }));
    totalBuys += sorted.length;
  }
  const sampleTk = Object.keys(all).sort((a, b) => all[b].length - all[a].length)[0];
  const consistency = consistencyCheck(all);
  const index = {
    builtAt: new Date().toISOString(), source: INDEX_URL, quarters: quartersMeta, quartersParsed: qDone,
    tickers: Object.keys(all).length, buyRows: totalBuys, exclusions,
    sample: sampleTk ? { ticker: sampleTk, n: all[sampleTk].length, first: all[sampleTk][0] } : null,
    consistency, fetched, runMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`\nDONE: ${qDone.length}/${quarters.length} quarters, ${totalBuys} buy rows, ${index.tickers} tickers, ${(index.runMs / 1000).toFixed(0)}s`);
  console.log('exclusions:', JSON.stringify(exclusions));
  console.log('\nconsistency (crawl vs bulk, P-buy rows per filing year):');
  for (const r of consistency.rows || []) {
    console.log(`  ${r.sym.padEnd(6)} ` + Object.entries(r.years).map(([y, v]) => `${y}: ${v.crawlN}/${v.bulkN}`).join('  '));
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { quarterList, perYear };
