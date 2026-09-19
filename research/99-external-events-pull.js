'use strict';
// Step 99 — EXTERNAL-EVENT PULLS (no outcomes computed here).
//   node --env-file=research/.env research/99-external-events-pull.js --efts     # EDGAR full-text hits (13D, buyback 8-K)
//   node --env-file=research/.env research/99-external-events-pull.js --grades   # FMP analyst grades per cached-universe symbol
//
// Frozen by research/PREREGISTRATION-EXTERNAL-EVENTS-2026-09.md (sealed b43f45a). Resumable:
// every month/symbol lands in its own file under research/data/external-events/ and is
// skipped when present. Rate limits: EDGAR ≤ 10 req/s with a declared UA; FMP throttled by
// research/lib/fmp.js.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');

const OUT = path.join(K.DATA_DIR, 'external-events');
const EFTS = 'https://efts.sec.gov/LATEST/search-index';
const UA = process.env.SEC_USER_AGENT || 'market-news-app research rjs319@gmail.com';
const PULL_FROM = '2021-07-01';
const PULL_TO = '2026-03-31';           // the sealed holdout ends 2026-03-31
const PAGE = 100;
const EFTS_SLEEP_MS = 130;              // < 10 req/s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The two frozen queries (§2 of the preregistration).
const QUERIES = Object.freeze({
  '13d': { q: '"13D"', forms: 'SC 13D' },
  // The SEC renamed the form type to "SCHEDULE 13D" for structured (XML) filings from
  // December 2024; the legacy name returns ZERO hits after that. Discovered on the r1 run
  // (holdout had no events) — same filing, same phrase, new label. Pulled separately so r1's
  // files stay untouched.
  '13d-schedule': { q: '"13D"', forms: 'SCHEDULE 13D' },
  'buyback': { q: '"share repurchase program" OR "stock repurchase program"', forms: '8-K' },
});

function months(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let end = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    if (end > to) end = to;
    out.push({ start, end });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function eftsPage(q, forms, start, end, from) {
  const u = new URL(EFTS);
  u.searchParams.set('q', q);
  u.searchParams.set('forms', forms);
  u.searchParams.set('dateRange', 'custom');
  u.searchParams.set('startdt', start);
  u.searchParams.set('enddt', end);
  u.searchParams.set('from', String(from));
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`efts ${res.status} ${u.search.slice(0, 120)}`);
    return res.json();
  }
  throw new Error('efts: retries exhausted');
}

// One file per (query, month): { total, hits:[{adsh, form, file_date, display_names, ciks, items, file_type}] }.
async function pullEfts() {
  for (const [key, spec] of Object.entries(QUERIES)) {
    const dir = path.join(OUT, `efts-${key}`);
    fs.mkdirSync(dir, { recursive: true });
    let done = 0, skipped = 0;
    for (const { start, end } of months(PULL_FROM, PULL_TO)) {
      const file = path.join(dir, `${start.slice(0, 7)}.json`);
      if (fs.existsSync(file)) { skipped++; continue; }
      const hits = [];
      let total = null;
      for (let from = 0; from < 10000; from += PAGE) {
        const page = await eftsPage(spec.q, spec.forms, start, end, from);
        const h = page.hits || {};
        if (total == null) total = (h.total && h.total.value) || 0;
        for (const x of h.hits || []) {
          const s = x._source || {};
          hits.push({ adsh: s.adsh, form: s.form, file_date: s.file_date, display_names: s.display_names, ciks: s.ciks, items: s.items || [], file_type: s.file_type, root_forms: s.root_forms });
        }
        await sleep(EFTS_SLEEP_MS);
        if (!(h.hits || []).length || from + PAGE >= total) break;
      }
      fs.writeFileSync(file, JSON.stringify({ query: spec, start, end, total, capped: total > 10000, hits, pulledAt: new Date().toISOString() }));
      done++;
      console.log(`${key} ${start.slice(0, 7)}: ${hits.length}/${total} hits`);
    }
    console.log(`${key}: pulled ${done} months, ${skipped} cached`);
  }
}

// One file per symbol: the full FMP grades history (upgrades/downgrades/maintains).
async function pullGrades() {
  const fmp = require('./lib/fmp');
  const dir = path.join(OUT, 'grades');
  fs.mkdirSync(dir, { recursive: true });
  const { dataset } = K.loadUniverse({ minAdv: 2e6, maxNames: 12000 });
  const syms = [...dataset.keys()].sort();
  let done = 0, skipped = 0, failed = 0;
  for (const sym of syms) {
    const file = path.join(dir, `${sym}.json`);
    if (fs.existsSync(file)) { skipped++; continue; }
    try {
      const rows = await fmp.get('grades', { symbol: sym, limit: 1000 });
      fs.writeFileSync(file, JSON.stringify({ sym, rows: Array.isArray(rows) ? rows : [], pulledAt: new Date().toISOString() }));
      done++;
      if (done % 100 === 0) console.log(`grades: ${done} pulled (${skipped} cached, ${failed} failed) — last ${sym}: ${Array.isArray(rows) ? rows.length : 0} rows`);
    } catch (e) {
      failed++;
      fs.writeFileSync(file, JSON.stringify({ sym, rows: [], error: String(e.message).slice(0, 120), pulledAt: new Date().toISOString() }));
    }
  }
  console.log(`grades: ${done} pulled, ${skipped} cached, ${failed} failed, universe ${syms.length}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--efts')) await pullEfts();
  if (args.has('--grades')) await pullGrades();
  if (!args.has('--efts') && !args.has('--grades')) console.log('usage: --efts | --grades');
}

if (require.main === module) main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
module.exports = { QUERIES, months, PULL_FROM, PULL_TO, OUT };
