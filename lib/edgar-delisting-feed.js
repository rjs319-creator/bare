'use strict';
// EDGAR DELISTING-EVENT FEED — "delisting pending" AVOID flag (SHADOW, weight 0).
//
// Daily, after the close: read EDGAR's daily form index for the tick day and the day before
// (evening filers), keep the delisting notices — Form 25 / 25-NSE (exchange removal under
// Rule 12d2-2, effective 10 days after filing) and Form 15-12G / 15-15D (deregistration /
// suspension of reporting, effective on filing) — join the issuer CIK to a ticker through
// SEC's own company_tickers table, and persist point-in-time events as `delist/<filingDate>.json`
// shards (union-monotonic, CAS via store.updateJSON). This is the method BlackFalconData sells;
// the daily index is free and already read by the insider-cluster feed.
//
// HONESTY. (1) The CIK→ticker join is LOSSY: company_tickers.json lists CURRENT registrants, a
// multi-class issuer maps to several tickers, and a name whose listing is already gone may have
// no row — every event carries `confidence` (high | medium | none) and the public set counts the
// unresolved ones instead of hiding them. (2) A Form 25 is ALSO filed on a voluntary exchange
// TRANSFER (NYSE → Nasdaq): the flag reads "delisting notice filed", never "going to zero"; the
// the offline EDGAR helper (research side) caveat applies. (3) Weight 0 everywhere: badge + session-board chip +
// ledger; nothing ranks, sizes, gates or alerts on it until the registry row's gates are met.
//
// Pure functions are exported for tests; the network lives in `fetchDailyDelistings` (daily
// index text via lib/insider-cluster-feed.fetchDailyIndexText, which owns the 403-vs-missing
// rule) and the CIK map comes from lib/edgar.loadCikMap — both dependency-injected by callers.

const FEED = require('./insider-cluster-feed');

const DAY_MS = 86_400_000;
const FORM25_EFFECTIVE_CALENDAR_DAYS = 10;   // Rule 12d2-2(d)(1); validated on ATVI 2023-10-13 → 2023-10-23

const FROZEN = Object.freeze({
  version: 'delisting-flag-v1',
  experimentId: 'delisting-pending-avoid-2026-10',
  // Form → event kind + effective-date rule. Calendar days, as the SEC rule reads and as the
  // offline research helper (FORM25_EFFECTIVE_DAYS on the research side) validated against real cases.
  forms: Object.freeze({
    '25': Object.freeze({ kind: 'exchange-delisting', effectiveDays: FORM25_EFFECTIVE_CALENDAR_DAYS, rule: 'Form 25 effective 10 calendar days after filing (Rule 12d2-2(d))' }),
    '25-NSE': Object.freeze({ kind: 'exchange-delisting', effectiveDays: FORM25_EFFECTIVE_CALENDAR_DAYS, rule: 'Form 25-NSE effective 10 calendar days after filing (Rule 12d2-2(d))' }),
    '15-12G': Object.freeze({ kind: 'deregistration', effectiveDays: 0, rule: 'Form 15-12G: 12(g) registration termination; reporting suspended on filing' }),
    '15-15D': Object.freeze({ kind: 'reporting-suspension', effectiveDays: 0, rule: 'Form 15-15D: suspension of 15(d) reporting on filing' }),
  }),
  // A name stays flagged from the filing through the effective date plus a grace window in
  // which it typically migrates to OTC / stops trading. Frozen; never tuned against the ledger.
  flagWindowDays: 45,
  prospectiveGate: { minEvents: 200, minDecisionDates: 60, note: 'then a date-clustered eval with the −126-session same-name placebo; the flag stays shadow until the registry row is changed by hand' },
});

const AMENDMENT_SUFFIX = '/A';
const BASE_FORMS = Object.freeze(Object.keys(FROZEN.forms));
const ALL_FORMS = Object.freeze([...BASE_FORMS, ...BASE_FORMS.map((f) => f + AMENDMENT_SUFFIX)]);
const FORM_SET = new Set(ALL_FORMS);

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => isoDate(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS);
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ── daily index → delisting rows ─────────────────────────────────────────────
// Rows: `<form> <company…> <cik> <yyyymmdd> edgar/data/<cik>/<accession>.txt`. Only the
// delisting forms (and their amendments, flagged so a revision never double-counts). Pure.
const ROW_RE = /^(\S+)\s+(.*?)\s+(\d+)\s+(\d{8})\s+(edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt)\s*$/;
function parseDailyIndex(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = ROW_RE.exec(line);
    if (!m || !FORM_SET.has(m[1])) continue;
    const amended = m[1].endsWith(AMENDMENT_SUFFIX);
    const d = m[4];
    out.push({
      form: m[1], baseForm: amended ? m[1].slice(0, -AMENDMENT_SUFFIX.length) : m[1], amended,
      company: m[2].trim(), cik: m[3].padStart(10, '0'),
      dateFiled: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, fileName: m[5], accession: m[6],
    });
  }
  return out;
}

// ── effective-date math ──────────────────────────────────────────────────────
// Returns the ISO effective date for a base form, or null for a form this feed does not model.
function effectiveDateFor(baseForm, filedAt) {
  const spec = FROZEN.forms[baseForm];
  if (!spec || !isIso(filedAt)) return null;
  return addDays(filedAt, spec.effectiveDays);
}

// ── CIK → ticker join ────────────────────────────────────────────────────────
// `cikByTicker` is lib/edgar.loadCikMap()'s shape ({ TICKER: '0000320193' }). Inverted to
// cik → sorted tickers. Pure.
function buildCikTickerIndex(cikByTicker = {}) {
  const idx = new Map();
  for (const [ticker, cik] of Object.entries(cikByTicker)) {
    if (!ticker || !cik) continue;
    const k = String(cik).padStart(10, '0');
    idx.set(k, [...(idx.get(k) || []), String(ticker).toUpperCase()].sort());
  }
  return idx;
}

// Confidence: high = exactly one ticker for the CIK; medium = several (multi-class issuer —
// the shortest symbol is the usual common class, alternates carried); none = no row (the
// registrant is already out of SEC's current table, or never had a listed ticker).
function joinTicker(cik, index) {
  const tickers = index.get(String(cik).padStart(10, '0')) || [];
  if (tickers.length === 0) return { ticker: null, confidence: 'none', alternates: [] };
  if (tickers.length === 1) return { ticker: tickers[0], confidence: 'high', alternates: [] };
  const byLength = [...tickers].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return { ticker: byLength[0], confidence: 'medium', alternates: byLength.slice(1) };
}

// One index row → one PIT event. Pure.
function toEvent(row, index) {
  const spec = FROZEN.forms[row.baseForm];
  const join = joinTicker(row.cik, index);
  return {
    accession: row.accession, cik: row.cik, company: row.company,
    ticker: join.ticker, confidence: join.confidence, alternates: join.alternates,
    form: row.form, baseForm: row.baseForm, kind: spec.kind, amended: row.amended,
    filedAt: row.dateFiled, effectiveAt: effectiveDateFor(row.baseForm, row.dateFiled), effectiveRule: spec.rule,
  };
}

// ── shard merge (the updateJSON mutator) ─────────────────────────────────────
// Union by accession, ascending; a re-tick or a concurrent writer can only ADD. Returns a
// NEW document; neither input is mutated.
function mergeShard(prior, events, { date, now }) {
  const byAcc = new Map((prior && Array.isArray(prior.events) ? prior.events : []).map((e) => [e.accession, e]));
  for (const e of events || []) if (e && e.accession && !byAcc.has(e.accession)) byAcc.set(e.accession, e);
  const merged = [...byAcc.values()].sort((a, b) => (a.accession < b.accession ? -1 : a.accession > b.accession ? 1 : 0));
  return { version: FROZEN.version, date, events: merged, count: merged.length, updatedAt: now };
}

// ── pending set ──────────────────────────────────────────────────────────────
// Events → per-ticker flag map at `asOf`. A ticker is flagged while 0 ≤ asOf − filedAt ≤
// flagWindowDays; the latest filing per ticker wins; amendments do not open a new window on
// their own (they only count when they are the sole notice). Unresolved tickers are COUNTED.
function buildPendingSet(events, asOf, { windowDays = FROZEN.flagWindowDays } = {}) {
  const asOfMs = Date.parse(asOf + 'T00:00:00Z');
  const symbols = {};
  let unresolvedTicker = 0, inWindow = 0;
  for (const e of events || []) {
    if (!e || !isIso(e.filedAt)) continue;
    const ageDays = Math.floor((asOfMs - Date.parse(e.filedAt + 'T00:00:00Z')) / DAY_MS);
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > windowDays) continue;
    inWindow++;
    if (!e.ticker) { unresolvedTicker++; continue; }
    const cur = symbols[e.ticker];
    const row = {
      form: e.form, kind: e.kind, filedAt: e.filedAt, effectiveAt: e.effectiveAt, ageDays,
      status: e.effectiveAt && asOf < e.effectiveAt ? 'pending' : 'effective',
      confidence: e.confidence, amended: !!e.amended, accession: e.accession, filings: (cur ? cur.filings : 0) + 1,
    };
    if (!cur || e.filedAt > cur.filedAt || (e.filedAt === cur.filedAt && cur.amended && !e.amended)) symbols[e.ticker] = row;
    else symbols[e.ticker] = { ...cur, filings: cur.filings + 1 };
  }
  const list = Object.values(symbols);
  return {
    version: FROZEN.version, asOf, windowDays, symbols,
    counts: {
      flagged: list.length, pending: list.filter((s) => s.status === 'pending').length, effective: list.filter((s) => s.status === 'effective').length,
      exchangeDelisting: list.filter((s) => s.kind === 'exchange-delisting').length, deregistration: list.filter((s) => s.kind !== 'exchange-delisting').length,
      eventsInWindow: inWindow, unresolvedTicker,
    },
  };
}

// ── network ──────────────────────────────────────────────────────────────────
async function fetchDailyDelistings(iso, { fetchImpl } = {}) {
  const { date, missing, text } = await FEED.fetchDailyIndexText(iso, fetchImpl ? { fetchImpl } : {});
  return { date, missing, rows: missing ? [] : parseDailyIndex(text) };
}

module.exports = {
  FROZEN, BASE_FORMS, ALL_FORMS, FORM25_EFFECTIVE_CALENDAR_DAYS,
  parseDailyIndex, effectiveDateFor, buildCikTickerIndex, joinTicker, toEvent, mergeShard, buildPendingSet,
  fetchDailyDelistings, addDays,
};
