'use strict';
// INSIDER CLUSTER BUYS — prospective feed (shadow, weight-0).
//
// Daily, after the close: read EDGAR's daily form index for the tick day and the day
// before (evening filers land after the 22:00 UTC cron), keep the Form 4s whose issuer
// CIK is in the app's universe, fetch each ownership XML (≤10 req/s, time-boxed), keep
// open-market buys, and run the FROZEN cluster constructor over the trailing 14 days of
// stored buys. A cluster whose latest filing is on one of the tick's dates becomes a
// ledger row dated the TICK day — the day the app KNEW — with entry at the next open.
// That is one session later than the retrospective study for evening filers: stated,
// conservative, real.
//
// Pure functions are exported for tests; the network lives in `fetchDailyForm4` and
// `fetchBuysForFilings`, both dependency-injected.

const { fetchWithTimeout } = require('./http');
const EDGAR = require('./edgar');
const IC = require('./insider-cluster');
const U = require('./universe');

const SEC_UA = process.env.SEC_USER_AGENT || 'market-news-app (contact: rjs319@gmail.com)';
const H = { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate' };
const THROTTLE_MS = 130;                 // ≤ 10 req/s, SEC fair-access
const FETCH_BUDGET_MS = 120_000;         // inside the 240s chain wall with room for history + writes
const DAY = 86_400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoDate(new Date(Date.parse(iso) + n * DAY));

// The ledger's universe: the app's static lists (large + small + micro + biotech). Stated
// on every row; the retrospective study ran on the full ~10k-name cache, so the
// prospective sample is a SUBSET — expect fewer events per session than the study's rate.
function universeTickers() {
  return [...new Set([...U.LARGE, ...U.SMALL_CAPS, ...U.MICRO_CAPS, ...U.BIOTECH].map((t) => String(t).toUpperCase()))];
}

function dailyIndexUrl(iso) {
  const [y, m] = iso.split('-').map(Number);
  const qtr = Math.floor((m - 1) / 3) + 1;
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${qtr}/form.${iso.replace(/-/g, '')}.idx`;
}

// Parse the fixed-width daily form index. Rows: `<form> <company…> <cik> <yyyymmdd> <path>`.
// Only Form 4 and 4/A. Pure.
function parseDailyIndex(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(4|4\/A)\s+(.*?)\s+(\d+)\s+(\d{8})\s+(edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt)\s*$/.exec(line);
    if (!m) continue;
    const d = m[4];
    out.push({ form: m[1], amended: m[1] === '4/A', company: m[2].trim(), cik: m[3].padStart(10, '0'), dateFiled: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, fileName: m[5], accession: m[6] });
  }
  return out;
}

// Weekends/holidays have no index. EDGAR's archive answers a missing key with an S3-style
// 403 AccessDenied (measured 2026-09-09: Sat/Sun/Labor Day → 403 <Code>AccessDenied</Code>,
// the next session → 200) — never a 404. Only THAT body is a legitimate "no index"; any
// other 403 (the rate-limit block page) or non-2xx is an error and the tick fails closed.
const MISSING_INDEX_RE = /<Code>(AccessDenied|NoSuchKey)<\/Code>/i;
async function fetchDailyForm4(iso, { fetchImpl = fetchWithTimeout } = {}) {
  const r = await fetchImpl(dailyIndexUrl(iso), { headers: H, timeoutMs: 20_000, retries: 1 });
  if (r.status === 404) return { date: iso, missing: true, filings: [] };
  if (r.status === 403) {
    const body = await r.text().catch(() => '');
    if (MISSING_INDEX_RE.test(body)) return { date: iso, missing: true, filings: [] };
    throw new Error(`EDGAR daily index ${iso}: 403 (not a missing-key response — blocked?)`);
  }
  if (!r.ok) throw new Error(`EDGAR daily index ${iso}: ${r.status}`);
  return { date: iso, missing: false, filings: parseDailyIndex(await r.text()) };
}

// CIK → ticker for the universe, built from SEC's own map (ticker → CIK). Pure given the map.
function universeCikMap(cikByTicker, tickers = universeTickers()) {
  const out = new Map();
  for (const t of tickers) { const c = cikByTicker[t]; if (c) out.set(String(c).padStart(10, '0'), t); }
  return out;
}

// Keep the universe's filings; drop accessions already stored. Pure.
function selectUniverseFilings(filings, cikToTicker, knownAccessions = new Set()) {
  const out = [];
  for (const f of filings || []) {
    const ticker = cikToTicker.get(f.cik);
    if (!ticker || knownAccessions.has(f.accession)) continue;
    out.push({ ...f, ticker });
  }
  return out;
}

// Ownership XML → open-market buys in the study's row shape (one row per filing — a joint
// filing is one decision; `jointOwners` records how many reporting persons signed).
function buysFromXml(xml, filing) {
  const p = EDGAR.parseForm4(xml);
  if (!p) return [];
  return p.txs
    .filter((t) => t.code === 'P' && t.ad !== 'D' && t.shares > 0 && t.price > 0)
    .map((t) => ({
      date: t.date, code: 'P', shares: t.shares, price: t.price, value: t.value, ad: 'A',
      owner: p.owner, isDirector: p.isDirector, isOfficer: p.isOfficer, isTenPct: p.isTenPct,
      filingDate: filing.dateFiled, accession: filing.accession, amended: !!filing.amended,
      tenB51: p.tenB51 === true, jointOwners: p.ownerCount || 1, ticker: filing.ticker, cik: filing.cik,
    }));
}

// Fetch + parse the selected filings, throttled and time-boxed; every miss is counted.
async function fetchBuysForFilings(filings, { fetchXml = EDGAR.fetchForm4Xml, budgetMs = FETCH_BUDGET_MS, throttleMs = THROTTLE_MS, now = Date.now } = {}) {
  const t0 = now();
  const buys = [];
  const stats = { filings: filings.length, fetched: 0, noXml: 0, errors: 0, truncated: 0, buys: 0 };
  for (let k = 0; k < filings.length; k++) {
    if (now() - t0 > budgetMs) { stats.truncated = filings.length - k; break; }
    const f = filings[k];
    try {
      const xml = await fetchXml(f.cik, f.accession, null);
      if (!xml) { stats.noXml++; continue; }
      stats.fetched++;
      buys.push(...buysFromXml(xml, f));
    } catch { stats.errors++; }
    if (throttleMs) await sleep(throttleMs);
  }
  stats.buys = buys.length;
  return { buys, stats };
}

// Cluster emission for a tick. `shards` = trailing tx shards (each {date, buys}), `eventDates`
// = the dates a cluster's latest filing may carry to count as NEW on this tick, `recent` =
// ledger rows of the last cooldown window ({ticker, date}). Pure.
function emitClusters(shards, { eventDates, recentRows = [], tickDate }) {
  const byTicker = new Map();
  for (const s of shards || []) for (const b of s.buys || []) (byTicker.get(b.ticker) || byTicker.set(b.ticker, []).get(b.ticker)).push(b);
  const cooled = new Set((recentRows || []).filter((r) => r && r.ticker && r.date && Date.parse(tickDate) - Date.parse(r.date) < IC.LEDGER.cooldownCalendarDays * DAY).map((r) => r.ticker));
  const want = new Set(eventDates);
  const out = [];
  for (const [ticker, txs] of byTicker) {
    const clusters = IC.clusterEvents(IC.dedupeJointFilings(txs));
    for (const c of clusters) {
      if (!want.has(c.eventDate)) continue;
      if (cooled.has(ticker)) { out.push({ ticker, eventDate: c.eventDate, cooled: true }); continue; }
      out.push({ ticker, eventDate: c.eventDate, owners: c.owners, combinedValue: c.combinedValue, txDates: c.txDates,
        accessions: [...new Set(c.members.map((m) => m.accession))],
        officerDirectorOnly: c.members.every((m) => (m.isOfficer || m.isDirector) && !m.isTenPct),
        tenB51: c.members.some((m) => m.tenB51 === true), members: c.members });
    }
  }
  return out.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
}

// Decision-bar facts from daily history: last close + trailing 60-session mean $ volume.
function decisionFacts(candles) {
  const c = (candles || []).filter((b) => b && b.close > 0);
  if (!c.length) return null;
  const last = c[c.length - 1];
  const win = c.slice(-IC.LEDGER.advLookback);
  const adv = win.reduce((s, b) => s + (b.close || 0) * (b.volume || 0), 0) / win.length;
  return { close: last.close, adv60: Math.round(adv), asOf: last.date, bars: c.length };
}

// Ledger row for one emitted cluster. Pure.
function ledgerRow(cluster, facts, tickDate) {
  const elig = facts ? IC.classifyEligibility({ adv: facts.adv60, close: facts.close, members: cluster.members }) : { tier: IC.LEDGER.excludedTier, liqTier: null, reasons: ['no-history'] };
  return {
    ticker: cluster.ticker, tier: elig.tier, liqTier: elig.liqTier, reasons: elig.reasons,
    // Scope = the measured as-of ADV tier, so the Scoreboard's cost model (lib/costs
    // tierForPick) and the scoped evidence key charge and group the row by what it WAS,
    // not by a section default. Absent history ⇒ no scope ⇒ the conservative default.
    scope: elig.liqTier === 'liquid' ? 'large' : (elig.liqTier || null),
    date: tickDate, eventDate: cluster.eventDate, txDates: cluster.txDates,
    owners: cluster.owners, combinedValue: cluster.combinedValue, accessions: cluster.accessions,
    officerDirectorOnly: cluster.officerDirectorOnly, tenB51: cluster.tenB51,
    close: facts ? facts.close : null, adv60: facts ? facts.adv60 : null, priceAsOf: facts ? facts.asOf : null,
    entry: null, fillPolicy: 'next-session-open', side: 'long',
  };
}

module.exports = {
  THROTTLE_MS, FETCH_BUDGET_MS, universeTickers, dailyIndexUrl, parseDailyIndex, fetchDailyForm4,
  universeCikMap, selectUniverseFilings, buysFromXml, fetchBuysForFilings, emitClusters, decisionFacts, ledgerRow, addDays,
};
