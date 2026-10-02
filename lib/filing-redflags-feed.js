'use strict';
// FILING RED FLAGS — the nightly feed (network side; every fetch dependency-injected).
//
// For a tick date the feed reads EDGAR's daily form index for the date and the day before
// (evening filers land after the 22:00 UTC cron), keeps the 8-K / NT 10-K / NT 10-Q rows
// whose CIK has a ticker in SEC's own company_tickers map, and classifies:
//   NT rows      → NT_FIRST via the first-in-252 state (no document fetch)
//   8-K rows     → Items from the filer's submissions JSON (memoized, ≤10 req/s) → 4.02 /
//                  4.01-stand-alone / 3.01; a 5.02 candidate fetches the PRIMARY DOCUMENT
//                  only (bounded count + bytes) and the text classifier decides CEO/CFO
//   FTS          → "substantial doubt" "going concern" in 10-K/10-Q filed on the dates →
//                  GOING_CONCERN_FIRST via the state
// Stages run cheapest-first and each is time-budgeted: a tick that runs out of budget
// persists what it has (routes mark the shard partial and count the truncation).
//
// SEC etiquette: descriptive User-Agent, ≤10 requests/sec (THROTTLE_MS), and the archive's
// missing-key answer is an S3-style 403 AccessDenied — never a 404 (measured 2026-09-09).

const { fetchWithTimeout } = require('./http');
const EDGAR = require('./edgar');
const RF = require('./filing-redflags');
const { dailyIndexUrl, addDays } = require('./insider-cluster-feed');

const SEC_UA = process.env.SEC_USER_AGENT || 'market-news-app (contact: rjs319@gmail.com)';
const H = Object.freeze({ 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' });
const FTS = 'https://efts.sec.gov/LATEST/search-index';
const FTS_QUERY = '"substantial doubt" "going concern"';
const FTS_FORMS = '10-K,10-Q';
const FTS_PAGE = 100;
const FTS_MAX_FROM = 10_000;

const THROTTLE_MS = 130;                 // ≤ 10 req/s
const INDEX_TIMEOUT_MS = 20_000;
const DOC_TIMEOUT_MS = 15_000;
const DOC_MAX_CHARS = 600_000;           // an 8-K primary doc is ~50-400KB; cap the regex input
const TEXT_FETCH_CAP = 25;               // 5.02 primary documents per tick
const MISSING_INDEX_RE = /<Code>(AccessDenied|NoSuchKey)<\/Code>/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Daily index ─────────────────────────────────────────────────────────────
async function fetchDailyIndex(iso, { fetchImpl = fetchWithTimeout } = {}) {
  const r = await fetchImpl(dailyIndexUrl(iso), { headers: H, timeoutMs: INDEX_TIMEOUT_MS, retries: 1 });
  if (r.status === 404) return { date: iso, missing: true, rows: [] };
  if (r.status === 403) {
    const body = await r.text().catch(() => '');
    if (MISSING_INDEX_RE.test(body)) return { date: iso, missing: true, rows: [] };
    throw new Error(`EDGAR daily index ${iso}: 403 (not a missing-key response — blocked?)`);
  }
  if (!r.ok) throw new Error(`EDGAR daily index ${iso}: ${r.status}`);
  return { date: iso, missing: false, rows: RF.parseDailyIndex(await r.text()) };
}

// CIK → ticker for every issuer SEC lists (ticker → CIK map inverted). Pure given the map.
function cikToTickerMap(cikByTicker) {
  const out = new Map();
  for (const [t, c] of Object.entries(cikByTicker || {})) {
    const cik = String(c).padStart(10, '0');
    // A CIK with several share classes keeps the shortest ticker (the primary line).
    const cur = out.get(cik);
    if (!cur || t.length < cur.length) out.set(cik, t);
  }
  return out;
}

// Index rows → rows with a ticker, minus accessions already stored. Pure.
function selectRows(rows, cikToTicker, knownAccessions = new Set()) {
  const out = [];
  for (const r of rows || []) {
    const ticker = cikToTicker.get(r.cik);
    if (!ticker || knownAccessions.has(r.accession)) continue;
    out.push({ ...r, ticker });
  }
  return out;
}

// ── Stage 1: NT first-in-window (pure) ──────────────────────────────────────
// One event per ticker per batch: isFirstIn treats an equal date as the SAME event (so a
// re-tick is idempotent), so a second same-day filing is deduped here, not there.
function ntEvents(rows, state) {
  const events = [];
  const batch = new Set();
  let next = state;
  for (const r of rows || []) {
    if (!RF.ntKind(r.form) || batch.has(r.ticker)) continue;
    if (!RF.isFirstIn(next, r.ticker, 'NT', r.dateFiled)) continue;
    batch.add(r.ticker);
    events.push({ ticker: r.ticker, cik: r.cik, flag: 'NT_FIRST', form: r.form, accession: r.accession, filingDate: r.dateFiled, detail: null });
    next = RF.advanceState(next, r.ticker, 'NT', r.dateFiled);
  }
  return { events, state: next };
}

// ── Stage 2: 8-K items via submissions JSON ─────────────────────────────────
// The daily index carries form types but NOT item numbers; the filer's submissions index
// does (lib/edgar.js reads `filings.recent.items`). One memoized fetch per filer per burst.
async function itemsForFiling(row, { fetchSubmissions = EDGAR.fetchSubmissionsRecent } = {}) {
  const rec = await fetchSubmissions(row.cik);
  if (!rec || !Array.isArray(rec.accessionNumber)) return null;
  const i = rec.accessionNumber.indexOf(row.accession);
  if (i < 0) return null;
  return { items: RF.parseItems(rec.items ? rec.items[i] : ''), primaryDoc: rec.primaryDocument ? rec.primaryDocument[i] : null };
}

async function classify8kRows(rows, { fetchSubmissions, budgetMs, throttleMs = THROTTLE_MS, now = Date.now } = {}) {
  const t0 = now();
  const events = [];
  const textCandidates = [];
  const stats = { eightK: 0, looked: 0, noItems: 0, errors: 0, truncated: 0 };
  const eightK = (rows || []).filter((r) => r.form === '8-K');
  stats.eightK = eightK.length;
  for (let k = 0; k < eightK.length; k++) {
    if (now() - t0 > budgetMs) { stats.truncated = eightK.length - k; break; }
    const r = eightK[k];
    try {
      const found = await itemsForFiling(r, { fetchSubmissions });
      stats.looked++;
      if (!found) { stats.noItems++; continue; }
      const c = RF.classify8kItems(found.items);
      for (const flag of c.flags) events.push({ ticker: r.ticker, cik: r.cik, flag, form: '8-K', accession: r.accession, filingDate: r.dateFiled, detail: { items: found.items } });
      if (c.needsText) textCandidates.push({ ...r, items: found.items, primaryDoc: found.primaryDoc });
    } catch { stats.errors++; }
    if (throttleMs) await sleep(throttleMs);
  }
  return { events, textCandidates, stats };
}

// ── Stage 3: 5.02 primary documents (bounded) ───────────────────────────────
function primaryDocUrl(cik, accession, primaryDoc) {
  const numCik = String(parseInt(cik, 10));
  return `https://www.sec.gov/Archives/edgar/data/${numCik}/${accession.replace(/-/g, '')}/${primaryDoc}`;
}

async function fetchPrimaryDocText(row, { fetchImpl = fetchWithTimeout } = {}) {
  if (!row.primaryDoc) return null;
  const r = await fetchImpl(primaryDocUrl(row.cik, row.accession, row.primaryDoc), { headers: { ...H, Accept: 'text/html,text/plain' }, timeoutMs: DOC_TIMEOUT_MS });
  if (!r.ok) return null;
  return (await r.text()).slice(0, DOC_MAX_CHARS);
}

async function classify502Rows(candidates, { fetchDoc = fetchPrimaryDocText, budgetMs, throttleMs = THROTTLE_MS, now = Date.now, cap = TEXT_FETCH_CAP } = {}) {
  const t0 = now();
  const events = [];
  const stats = { candidates: (candidates || []).length, fetched: 0, noDoc: 0, errors: 0, truncated: 0, overCap: Math.max(0, (candidates || []).length - cap) };
  const list = (candidates || []).slice(0, cap);
  for (let k = 0; k < list.length; k++) {
    if (now() - t0 > budgetMs) { stats.truncated = list.length - k; break; }
    const r = list[k];
    try {
      const text = await fetchDoc(r);
      if (!text) { stats.noDoc++; continue; }
      stats.fetched++;
      const c = RF.classify502Text(text);
      if (c.cxoDeparture) events.push({ ticker: r.ticker, cik: r.cik, flag: 'ITEM_5_02_CXO', form: '8-K', accession: r.accession, filingDate: r.dateFiled, detail: { items: r.items, roles: c.roles } });
    } catch { stats.errors++; }
    if (throttleMs) await sleep(throttleMs);
  }
  return { events, stats };
}

// ── Stage 4: going-concern full-text search ─────────────────────────────────
// One EDGAR FTS hit → {ticker, cik, fileDate, adsh, form} or null (display_names carries
// "Name  (TICKER)  (CIK 0000…)"; dots become dashes to match the app's symbols).
function parseFtsHit(hit) {
  const s = (hit && hit._source) || {};
  if (!s.file_date || !s.adsh) return null;
  const m = /\(([A-Z][A-Z.\-]{0,7})\)\s*\(CIK/.exec((s.display_names || [])[0] || '');
  if (!m) return null;
  return { ticker: m[1].replace(/\./g, '-'), cik: String((s.ciks || [])[0] || '').padStart(10, '0') || null, fileDate: s.file_date, adsh: s.adsh, form: s.form || null };
}

async function fetchGoingConcernHits({ startdt, enddt, fetchImpl = fetchWithTimeout, throttleMs = THROTTLE_MS } = {}) {
  const out = [];
  for (let from = 0; from < FTS_MAX_FROM; from += FTS_PAGE) {
    const url = `${FTS}?q=${encodeURIComponent(FTS_QUERY)}&forms=${encodeURIComponent(FTS_FORMS)}&dateRange=custom&startdt=${startdt}&enddt=${enddt}&from=${from}&size=${FTS_PAGE}`;
    const r = await fetchImpl(url, { headers: { ...H, Accept: 'application/json' }, timeoutMs: INDEX_TIMEOUT_MS, retries: 2 });
    if (!r.ok) throw new Error(`EDGAR FTS ${startdt}..${enddt}: ${r.status}`);
    const j = await r.json();
    const hits = (j && j.hits && j.hits.hits) || [];
    for (const h of hits) { const p = parseFtsHit(h); if (p) out.push(p); }
    if (hits.length < FTS_PAGE) break;
    if (throttleMs) await sleep(throttleMs);
  }
  return out;
}

// FTS hits → GOING_CONCERN_FIRST events via the state (pure). Hits are restricted to the
// tick's dates by the caller's query; one event per ticker per date.
function goingConcernEvents(hits, state, knownAccessions = new Set()) {
  const events = [];
  const batch = new Set();
  let next = state;
  const sorted = [...(hits || [])].sort((a, b) => (a.fileDate < b.fileDate ? -1 : a.fileDate > b.fileDate ? 1 : 0));
  for (const h of sorted) {
    if (!h.ticker || knownAccessions.has(h.adsh) || batch.has(h.ticker)) continue;
    if (!RF.isFirstIn(next, h.ticker, 'GC', h.fileDate)) { next = RF.advanceState(next, h.ticker, 'GC', h.fileDate); continue; }
    batch.add(h.ticker);
    events.push({ ticker: h.ticker, cik: h.cik, flag: 'GOING_CONCERN_FIRST', form: h.form || '10-K/10-Q', accession: h.adsh, filingDate: h.fileDate, detail: { query: FTS_QUERY } });
    next = RF.advanceState(next, h.ticker, 'GC', h.fileDate);
  }
  return { events, state: next };
}

module.exports = {
  THROTTLE_MS, TEXT_FETCH_CAP, FTS_QUERY, FTS_FORMS, MISSING_INDEX_RE,
  fetchDailyIndex, cikToTickerMap, selectRows, ntEvents,
  itemsForFiling, classify8kRows, primaryDocUrl, fetchPrimaryDocText, classify502Rows,
  parseFtsHit, fetchGoingConcernHits, goingConcernEvents, addDays,
};
