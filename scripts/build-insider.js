#!/usr/bin/env node
// EDGAR insider-history builder — runs on a box WITHOUT a function time limit
// (e.g. your ~/trade-alert-ranker machine). Pulls each ticker's open-market
// Form 4 transactions from SEC EDGAR and POSTs them to the app's ingest endpoint
// (op=insideringest), which caches them to Blob for the walk-forward harness.
//
// USAGE (from the project root, needs Node 18+ for global fetch):
//   node scripts/build-insider.js --limit=50 --years=2 \
//        --host=market-news-app-chi.vercel.app --token=YOUR_TOKEN
//
// Flags:
//   --limit=N      pilot universe = first N of the LARGE list (default 50)
//   --years=Y      history depth in years (default 2 — matches the harness window)
//   --host=HOST    app host to POST to (default market-news-app-chi.vercel.app)
//   --token=TOK    INSIDER_INGEST_TOKEN (omit if not set server-side)
//   --batch=B      POST every B tickers (default 999 = one POST at the end, which
//                  avoids any read-modify-write race on the shared store)
//   --maxFilings=M Form 4 filings scanned per ticker (default 80)
//   --reset        wipe the stored insider history before the first batch
//   --scope=S      universe: large | small | micro (default large) — must match
//                  the harness scope you'll validate on
//   --tickers=A,B  explicit ticker list (overrides --limit/--scope)
const path = require('path');
const { fetchInsiderTransactions } = require(path.join(__dirname, '..', 'lib', 'edgar'));
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require(path.join(__dirname, '..', 'lib', 'universe'));

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const LIMIT = parseInt(args.limit, 10) || 50;
const YEARS = parseFloat(args.years) || 2;
const HOST = args.host || 'market-news-app-chi.vercel.app';
const TOKEN = args.token || process.env.INSIDER_INGEST_TOKEN || '';
const BATCH = parseInt(args.batch, 10) || 999;  // default: single POST at the end
const MAX_FILINGS = parseInt(args.maxFilings, 10) || 80;
const fromDate = new Date(Date.now() - YEARS * 365 * 864e5).toISOString().slice(0, 10);

const SCOPE = (args.scope || 'large').toLowerCase();
const SCOPE_LIST = SCOPE === 'small' ? SMALL_CAPS : SCOPE === 'micro' ? MICRO_CAPS : LARGE;
const universe = args.tickers
  ? String(args.tickers).toUpperCase().split(',').map(s => s.trim()).filter(Boolean)
  : [...new Set(SCOPE_LIST)].slice(0, LIMIT);

async function ingest(tickers, reset) {
  const url = `https://${HOST}/api/tracker?op=insideringest${reset ? '&reset=1' : ''}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-ingest-token': TOKEN } : {}) },
    body: JSON.stringify({ tickers }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('ingest failed: ' + r.status + ' ' + JSON.stringify(j));
  return j;
}

(async () => {
  console.log(`EDGAR insider builder [${SCOPE}] → ${universe.length} tickers, history since ${fromDate}, POST → ${HOST}`);
  let batch = {}, inBatch = 0, done = 0, totalTx = 0, firstPost = true;
  for (const t of universe) {
    try {
      const { txs, cik } = await fetchInsiderTransactions(t, { fromDate, maxFilings: MAX_FILINGS, throttleMs: 130 });
      batch[t] = txs;
      totalTx += txs.length;
      const buys = txs.filter(x => x.code === 'P').length, sells = txs.filter(x => x.code === 'S').length;
      console.log(`  ${t} (CIK ${cik || '—'}): ${txs.length} open-market tx [${buys} buys / ${sells} sells]`);
    } catch (e) {
      batch[t] = [];
      console.log(`  ${t}: ERROR ${e.message}`);
    }
    inBatch++; done++;
    if (inBatch >= BATCH || done === universe.length) {
      try {
        const res = await ingest(batch, firstPost && args.reset);
        console.log(`  ↳ posted ${inBatch} tickers (server now holds ${res.totalTickers}) [${done}/${universe.length}]`);
      } catch (e) { console.error('  ↳ POST error:', e.message); }
      batch = {}; inBatch = 0; firstPost = false;
    }
  }
  console.log(`Done. ${universe.length} tickers, ${totalTx} open-market transactions ingested.`);
})();
