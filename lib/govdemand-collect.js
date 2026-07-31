'use strict';
// 🏛️ GOV-DEMAND — USAspending collector (deterministic, revision-preserving).
//
// Pulls contract TRANSACTIONS (award actions + modifications — the obligation
// granularity) for the verified public-contractor roster from the free
// USAspending API (no key). Endpoint shape verified live 2026-07:
//   POST /api/v2/search/spending_by_transaction/
//   filters: { recipient_search_text, time_period, award_type_codes }
//
// POINT-IN-TIME HONESTY (the whole reason this dataset is prospective-only):
// USAspending records `Action Date` (eventTime) but agencies REPORT actions
// with a lag (DoD historically up to ~90 days), and the API exposes no
// publication timestamp. So availability CANNOT be reconstructed historically.
// We therefore set observedAt = availableAt = the moment THIS collector saw
// the row, and the prereg commits to a prospective experiment. Action date is
// never substituted for publication time.
//
// Revision preservation: a transaction key seen again with a different amount
// does NOT overwrite the original observation — the change is appended as a
// revision with its own observedAt, so historical vintages survive.
//
// Serverless budget: one tick scans a cursor batch of the roster (like
// op=fundbuild), so a full roster cycle completes across a few daily ticks
// while the LOOKBACK window (45d) guarantees overlap — nothing is missed.

const { fetchWithTimeout } = require('./http');

const API_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_transaction/';
const CONTRACT_TYPE_CODES = Object.freeze(['A', 'B', 'C', 'D']); // definitive contracts + orders (obligations, not IDV ceilings)
const LOOKBACK_DAYS = 45;          // > roster cycle length × tick cadence, so scans overlap
const PAGE_LIMIT = 100;            // API max per page
const MAX_PAGES = 3;               // per recipient per tick — bounded fan-out
const FETCH_TIMEOUT_MS = 15000;
const FIELDS = Object.freeze([
  'Award ID', 'Mod', 'Recipient Name', 'Action Date', 'Transaction Amount',
  'Awarding Agency', 'Awarding Sub Agency', 'Transaction Description', 'Award Type',
]);

const addDays = (iso, d) => new Date(new Date(iso + 'T00:00:00Z').getTime() + d * 864e5).toISOString().slice(0, 10);

// Stable identity of one award action: award internal id + modification number.
function txnKey(row) {
  const award = row.generated_internal_id || row['Award ID'] || 'UNKNOWN_AWARD';
  const mod = row.Mod != null && row.Mod !== '' ? String(row.Mod) : '0';
  return `${award}|mod=${mod}`;
}

// One recipient query (single page). Injectable fetch for tests; returns
// { ok, rows, hasNext } and NEVER throws — a provider failure is reported,
// not fatal (safe-provider-failure rule).
async function fetchTransactionsPage({ query, startDate, endDate, page = 1, fetchImpl = fetchWithTimeout }) {
  const body = {
    filters: {
      recipient_search_text: [query],
      time_period: [{ start_date: startDate, end_date: endDate }],
      award_type_codes: [...CONTRACT_TYPE_CODES],
    },
    fields: [...FIELDS],
    sort: 'Action Date', order: 'desc', limit: PAGE_LIMIT, page,
  };
  try {
    const r = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!r.ok) return { ok: false, rows: [], hasNext: false, error: `usaspending http:${r.status}` };
    const j = await r.json();
    const rows = Array.isArray(j.results) ? j.results : [];
    const hasNext = !!(j.page_metadata && j.page_metadata.hasNext) || rows.length === PAGE_LIMIT;
    return { ok: true, rows, hasNext };
  } catch (e) {
    return { ok: false, rows: [], hasNext: false, error: String((e && e.message) || e) };
  }
}

// All pages (bounded) for one roster entry.
async function fetchRecipientTransactions({ query, startDate, endDate, fetchImpl }) {
  const rows = []; let error = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetchTransactionsPage({ query, startDate, endDate, page, fetchImpl });
    if (!r.ok) { error = r.error; break; }
    rows.push(...r.rows);
    if (!r.hasNext) break;
  }
  return { rows, error };
}

// Merge freshly fetched rows into the seen-observation state.
//
// state.seen : { [txnKey]: { firstObservedAt, amount, revisions: [{observedAt, amount, prevAmount}] } }
// Returns { fresh, revised } — fresh rows are NEW observations (never seen),
// revised rows changed amount since first observation. Pure + immutable: the
// caller receives a NEW seen map; the input state is not mutated.
function mergeObservations(seen, rows, rosterEntry, observedAt) {
  const nextSeen = { ...seen };
  const fresh = []; const revised = [];
  for (const row of rows) {
    const key = txnKey(row);
    const amount = Number(row['Transaction Amount']);
    const obs = {
      key,
      rosterTicker: rosterEntry.ticker,
      recipientName: row['Recipient Name'] || null,
      awardId: row['Award ID'] || null,
      generatedInternalId: row.generated_internal_id || null,
      mod: row.Mod != null && row.Mod !== '' ? String(row.Mod) : '0',
      // eventTime = the government action date; observedAt/availableAt = when WE saw it.
      eventTime: row['Action Date'] || null,
      observedAt,
      availableAt: observedAt,
      amountUSD: Number.isFinite(amount) ? amount : null,
      awardType: row['Award Type'] || null,
      agency: row['Awarding Agency'] || null,
      subAgency: row['Awarding Sub Agency'] || null,
      description: row['Transaction Description'] || null,
      primarySource: 'usaspending.gov',
      sourceIds: [`usaspending:${key}`],
    };
    const prior = nextSeen[key];
    if (!prior) {
      nextSeen[key] = { firstObservedAt: observedAt, amount: obs.amountUSD, revisions: [] };
      fresh.push(obs);
    } else if (prior.amount !== obs.amountUSD) {
      const revision = { observedAt, amount: obs.amountUSD, prevAmount: prior.amount };
      nextSeen[key] = { ...prior, amount: obs.amountUSD, revisions: [...prior.revisions, revision] };
      revised.push({ ...obs, revisionOf: key, prevAmountUSD: prior.amount });
    }
  }
  return { seen: nextSeen, fresh, revised };
}

// One collection tick: scan the next `batchSize` roster entries from
// state.cursor, respecting a wall-clock deadline. Returns new state + the
// fresh/revised observations. Injectable clock + fetch for tests.
async function collectBatch({
  roster, state, todayIso, batchSize = 12,
  fetchImpl = fetchWithTimeout, nowMs = () => Date.now(), deadlineMs = 40000,
}) {
  const t0 = nowMs();
  const startDate = addDays(todayIso, -LOOKBACK_DAYS);
  const seen0 = (state && state.seen) || {};
  const cursor0 = (state && Number.isInteger(state.cursor)) ? state.cursor : 0;

  let seen = seen0; let cursor = cursor0;
  const fresh = []; const revised = []; const errors = []; let scanned = 0;

  for (let n = 0; n < Math.min(batchSize, roster.length); n++) {
    if (nowMs() - t0 > deadlineMs) break;
    const entry = roster[cursor % roster.length];
    cursor++;
    const { rows, error } = await fetchRecipientTransactions({
      query: entry.query, startDate, endDate: todayIso, fetchImpl,
    });
    scanned++;
    if (error) { errors.push({ ticker: entry.ticker, error }); continue; }
    const merged = mergeObservations(seen, rows, entry, todayIso);
    seen = merged.seen;
    fresh.push(...merged.fresh);
    revised.push(...merged.revised);
  }

  return {
    state: { ...state, cursor: cursor % roster.length, seen, lastRunAt: todayIso },
    fresh, revised, scanned, errors,
    window: { startDate, endDate: todayIso, lookbackDays: LOOKBACK_DAYS },
  };
}

// ── Cadence seeding: authoritative quarterly obligation flow ────────────────
// POST /api/v2/search/spending_over_time/ (verified live 2026-07) aggregates a
// recipient's contract obligations per FISCAL quarter in ONE call — this seeds
// the cadence baseline at first sight of a ticker instead of waiting two
// calendar quarters of prospective collection. Federal FY starts Oct 1, so
// FY-q1 = Oct–Dec of (FY−1); we convert to calendar-quarter keys to match
// govdemand-expect's current-quarter exclusion.
const OVER_TIME_URL = 'https://api.usaspending.gov/api/v2/search/spending_over_time/';
const CADENCE_LOOKBACK_MONTHS = 27;   // ~9 fiscal quarters
function fiscalToCalendarQuarter(fiscalYear, quarter) {
  const fy = Number(fiscalYear), q = Number(quarter);
  if (!Number.isInteger(fy) || !Number.isInteger(q) || q < 1 || q > 4) return null;
  return q === 1 ? `${fy - 1}Q4` : `${fy}Q${q - 1}`;
}
async function fetchQuarterlyObligations({ query, todayIso, fetchImpl = fetchWithTimeout }) {
  const startDate = addDays(todayIso, -Math.round(CADENCE_LOOKBACK_MONTHS * 30.4));
  const body = {
    group: 'quarter',
    filters: {
      recipient_search_text: [query],
      time_period: [{ start_date: startDate, end_date: todayIso }],
      award_type_codes: [...CONTRACT_TYPE_CODES],
    },
  };
  try {
    const r = await fetchImpl(OVER_TIME_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!r.ok) return { ok: false, quarters: null, error: `usaspending http:${r.status}` };
    const j = await r.json();
    const quarters = {};
    for (const row of (Array.isArray(j.results) ? j.results : [])) {
      const tp = row.time_period || {};
      const key = fiscalToCalendarQuarter(tp.fiscal_year, tp.quarter);
      const amt = Number(row.aggregated_amount);
      if (key && Number.isFinite(amt)) quarters[key] = amt;
    }
    return { ok: true, quarters };
  } catch (e) {
    return { ok: false, quarters: null, error: String((e && e.message) || e) };
  }
}

// Drop seen-keys first observed more than `maxAgeDays` ago so state.json can't
// grow without bound. Safe because the scan window is only LOOKBACK_DAYS wide:
// a pruned key can never re-enter the window and be double-counted as fresh.
const SEEN_MAX_AGE_DAYS = 180;
function pruneSeen(seen, todayIso, maxAgeDays = SEEN_MAX_AGE_DAYS) {
  const cutoff = addDays(todayIso, -maxAgeDays);
  const out = {};
  for (const [key, rec] of Object.entries(seen || {})) {
    if (rec && rec.firstObservedAt && rec.firstObservedAt >= cutoff) out[key] = rec;
  }
  return out;
}

module.exports = {
  fetchTransactionsPage, fetchRecipientTransactions, mergeObservations, collectBatch,
  fetchQuarterlyObligations, fiscalToCalendarQuarter,
  pruneSeen, txnKey, LOOKBACK_DAYS, CONTRACT_TYPE_CODES, API_URL, SEEN_MAX_AGE_DAYS,
};
