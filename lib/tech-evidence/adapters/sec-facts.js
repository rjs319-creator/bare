'use strict';
// SEC Company Facts (XBRL) + 8-K item scan — official data.sec.gov interfaces.
// Deterministic only: every observation is a tagged fact with its unit, period, form,
// accession and filed date preserved. Nothing is derived here — comparable-period
// selection and change math live in signals.js so they stay point-in-time correct
// (facts filed after a cutoff are invisible to that cutoff's signal).
//
// Amendment policy: the same (tag, period) filed again with a different value becomes a
// NEW observation (a revision) with its own filed/publicAt — never an overwrite.

const { guardedFetch, adapterResult, SEC_UA, LARGE_MAX_BYTES } = require('./common');
const SCHEMA = require('../schema');

const FACTS_URL = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

// Tags with defensible, comparable-period semantics. `span`: 'duration' | 'instant'.
const TAGS = Object.freeze([
  { ns: 'us-gaap', tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', measure: 'revenue', span: 'duration' },
  { ns: 'us-gaap', tag: 'Revenues', measure: 'revenue', span: 'duration' },
  { ns: 'us-gaap', tag: 'AccountsReceivableNetCurrent', measure: 'accountsReceivable', span: 'instant' },
  { ns: 'us-gaap', tag: 'InventoryNet', measure: 'inventory', span: 'instant' },
  { ns: 'us-gaap', tag: 'ContractWithCustomerLiabilityCurrent', measure: 'deferredRevenueCurrent', span: 'instant' },
  { ns: 'us-gaap', tag: 'ResearchAndDevelopmentExpense', measure: 'rdExpense', span: 'duration' },
  { ns: 'us-gaap', tag: 'ShareBasedCompensation', measure: 'stockComp', span: 'duration' },
  { ns: 'us-gaap', tag: 'NetCashProvidedByUsedInOperatingActivities', measure: 'operatingCashFlow', span: 'duration' },
  { ns: 'us-gaap', tag: 'PaymentsToAcquirePropertyPlantAndEquipment', measure: 'capex', span: 'duration' },
  { ns: 'dei', tag: 'EntityCommonStockSharesOutstanding', measure: 'sharesOutstanding', span: 'instant', unit: 'shares' },
]);

const QUARTER_MIN_DAYS = 75;
const QUARTER_MAX_DAYS = 105;
const ACCEPTED_FORMS = new Set(['10-Q', '10-K', '10-Q/A', '10-K/A', '8-K', '20-F', '20-F/A']);

const daySpan = (start, end) => Math.round((new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z')) / 86400000);
const isQuarterly = (f) => f.start && f.end && daySpan(f.start, f.end) >= QUARTER_MIN_DAYS && daySpan(f.start, f.end) <= QUARTER_MAX_DAYS;

// Extract clean fact rows for one tag spec from a companyfacts payload.
// Returns rows sorted by (end, filed); duplicates (same period+value) collapsed to
// the EARLIEST filing (first public availability); restatements kept as extra rows.
function extractFacts(payload, spec) {
  const node = payload && payload.facts && payload.facts[spec.ns] && payload.facts[spec.ns][spec.tag];
  if (!node || !node.units) return [];
  const unitKey = spec.unit || 'USD';
  const rows = Array.isArray(node.units[unitKey]) ? node.units[unitKey] : [];
  const out = [];
  const seen = new Map(); // periodKey|value → earliest filed row index
  for (const f of rows) {
    if (!f || !f.end || !Number.isFinite(Number(f.val))) continue;
    if (f.form && !ACCEPTED_FORMS.has(f.form)) continue;
    if (spec.span === 'duration' && !isQuarterly(f)) continue;   // only directly-tagged quarters — no Q4 arithmetic
    if (spec.span === 'instant' && f.start) continue;
    const row = {
      measure: spec.measure, tag: `${spec.ns}:${spec.tag}`, unit: unitKey,
      start: f.start || null, end: f.end, val: Number(f.val),
      fy: f.fy ?? null, fp: f.fp || null, form: f.form || null,
      accn: f.accn || null, filed: f.filed || null,
    };
    const key = `${row.start || ''}|${row.end}|${row.val}`;
    const prior = seen.get(key);
    if (prior != null) {
      if (row.filed && (!out[prior].filed || row.filed < out[prior].filed)) out[prior] = row;
      continue;
    }
    seen.set(key, out.length);
    out.push(row);
  }
  out.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : (a.filed || '') < (b.filed || '') ? -1 : 1));
  return out;
}

// Pick ONE revenue tag per company: the one with more quarterly rows (consistency > coverage ties).
function pickRevenueRows(payload) {
  const a = extractFacts(payload, TAGS[0]);
  const b = extractFacts(payload, TAGS[1]);
  return a.length >= b.length ? a : b;
}

function factsToObservations(payload, { mapping, retrievedAt, basis, sinceFiled = null }) {
  const observations = [];
  const push = (row) => {
    if (sinceFiled && (!row.filed || row.filed < sinceFiled)) return;
    observations.push(SCHEMA.makeObservation({
      source: 'sec', ticker: mapping.ticker, entity: mapping.cik, metric: row.measure,
      effectiveDate: row.end, value: row.val, unit: row.unit,
      sourceUrl: row.accn
        ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${mapping.cik}&type=${encodeURIComponent(row.form || '')}&dateb=&owner=include&count=10`
        : null,
      publicAt: row.filed ? row.filed + 'T00:00:00Z' : null,
      basis, mappingId: null, mappingVersion: null,
      detail: { tag: row.tag, start: row.start, end: row.end, fy: row.fy, fp: row.fp, form: row.form, accn: row.accn, filed: row.filed },
      retrievedAt,
    }));
  };
  pickRevenueRows(payload).forEach(push);
  for (const spec of TAGS.slice(2)) extractFacts(payload, spec).forEach(push);
  return observations;
}

// 8-K Item 1.05 (material cybersecurity incident) via the submissions feed — the exact
// item designation IS the supporting text location; no fabricated narrative.
function cyber8kObservations(filings, { mapping, retrievedAt, basis }) {
  const observations = [];
  for (const f of filings || []) {
    const items = String(f.items || '');
    if (!items.split(',').map((s) => s.trim()).includes('1.05')) continue;
    observations.push(SCHEMA.makeObservation({
      source: 'sec', ticker: mapping.ticker, entity: mapping.cik, metric: 'cyber8k105',
      effectiveDate: f.filingDate, value: 1, unit: 'filing',
      sourceUrl: f.url || null,
      publicAt: f.filingDate ? f.filingDate + 'T00:00:00Z' : null,
      basis, detail: { form: f.form, accession: f.accession, items },
      retrievedAt,
    }));
  }
  return observations;
}

async function collectSec({ companies, now = new Date(), fetchImpl = null, basis = 'live',
  sinceFiled = null, fetchRecentFilingsImpl = null, throttleMs = 150, budget = null } = {}) {
  const retrievedAt = now.toISOString();
  const edgar = require('../../edgar');
  const fetchRecent = fetchRecentFilingsImpl || edgar.fetchRecentFilings;
  const observations = [];
  const errors = [];
  let rateLimited = false;
  const perEntity = {};
  const FACT_BEARING = new Set(['10-Q', '10-K', '10-Q/A', '10-K/A', '20-F', '20-F/A']);
  for (const c of companies) {
    // SEC stays sequential (≤10 req/s etiquette) — but never starts a new company past budget.
    if (budget && Number.isFinite(budget.deadlineMs) && Date.now() - budget.t0 > budget.deadlineMs) {
      errors.push(`${c.ticker}: skipped:budget`);
      perEntity[c.ticker] = { ok: false, error: 'skipped:budget' };
      continue;
    }
    // Lightweight submissions feed FIRST: it carries the 8-K item scan AND — on live
    // ticks (sinceFiled set) — gates the heavy companyfacts fetch. On a typical night
    // with no new filings this skips downloading+parsing a multi-MB payload per CIK.
    let skipFacts = false;
    try {
      const recent = await fetchRecent(c.cik, { forms: null, fromDate: sinceFiled, maxFilings: 40 });
      observations.push(...cyber8kObservations((recent || []).filter((f) => f.form === '8-K'), { mapping: c, retrievedAt, basis }));
      if (sinceFiled) {
        skipFacts = !(recent || []).some((f) => FACT_BEARING.has(f.form) && f.filingDate && f.filingDate >= sinceFiled);
      }
    } catch (e) {
      errors.push(`${c.ticker} submissions scan: ${String((e && e.message) || e).slice(0, 120)}`);
      // Submissions feed unavailable → fall through to the full fetch rather than go blind.
    }
    if (skipFacts) {
      perEntity[c.ticker] = { ok: true, facts: 0, skipped: 'no fact-bearing filing since ' + sinceFiled };
    } else {
      const r = await guardedFetch(FACTS_URL(c.cik), {
        fetchImpl, timeoutMs: 15000, retries: 1, maxBytes: LARGE_MAX_BYTES,
        headers: { 'User-Agent': SEC_UA },
      });
      if (!r.ok) {
        rateLimited = rateLimited || !!r.rateLimited;
        errors.push(`${c.ticker} companyfacts: ${r.error} (${r.category})`);
        perEntity[c.ticker] = { ok: false };
      } else {
        const obs = factsToObservations(r.body, { mapping: c, retrievedAt, basis, sinceFiled });
        observations.push(...obs);
        perEntity[c.ticker] = { ok: true, facts: obs.length };
      }
    }
    if (throttleMs) await new Promise((res) => setTimeout(res, throttleMs)); // SEC ≤10 req/s etiquette
  }
  return adapterResult({ source: 'sec', observations, errors, rateLimited, coverage: { perEntity, sinceFiled } });
}

module.exports = {
  collectSec, extractFacts, pickRevenueRows, factsToObservations, cyber8kObservations,
  TAGS, isQuarterly, QUARTER_MIN_DAYS, QUARTER_MAX_DAYS, FACTS_URL,
};
