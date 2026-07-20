'use strict';
// NOVEL SIGNAL LAB — Engine 6: structured accounting-transition forensics (accounting-forensics-v1).
//
// Valuation/quality LEVELS are already everywhere in this app. What is not modelled is the
// CHANGE in the relationships between structured financial facts — the transitions that
// precede reported deterioration: receivables outrunning revenue, net income detaching from
// operating cash flow (accruals), cash conversion decaying, quiet share dilution. This engine
// uses the FREE SEC XBRL company-facts API — structured, point-in-time (every fact carries a
// `filed` date = public availability) — and compares each company primarily with ITS OWN prior
// accounting relationships.
//
// POINT-IN-TIME / VINTAGE SAFETY (acceptance criteria): a fact is admitted only if its `filed`
// date is ≤ asOf. Because XBRL restatements arrive as NEW facts with LATER `filed` dates for the
// same period `end`, the as-of filter naturally serves the ORIGINAL reported vintage the market
// saw — a restatement can never overwrite history. The pure core (assessAccountingFacts) takes an
// already-filtered series map so it is deterministic and testable; only fetchCompanyFacts touches
// the network.

const { fetchWithTimeout } = require('../http');
const { cikFor } = require('../edgar');
const { makeEnvelope, unavailable, STATUS, DIRECTION, clamp01 } = require('./registry');

const SEC_UA = process.env.SEC_USER_AGENT || 'market-news-app (contact: rjs319@gmail.com)';
const H = { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip, deflate', 'Accept': 'application/json' };

// The us-gaap concepts we read. First present alias wins (taxonomies drift over time).
const CONCEPTS = Object.freeze({
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  receivables: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'],
  inventory: ['InventoryNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  cfo: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  assets: ['Assets'],
  shares: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic', 'CommonStockSharesOutstanding'],
});

const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b - 1 : null);

// From a concept's PIT-filtered point list (each { end, val, form }), return the last two
// distinct-period annual values (prefer 10-K; fall back to trailing points). Used for YoY.
function lastTwoAnnual(points) {
  if (!Array.isArray(points) || !points.length) return null;
  // Deduplicate by period-end, keeping the EARLIEST-filed value (original vintage).
  const byEnd = new Map();
  for (const p of points) if (!byEnd.has(p.end)) byEnd.set(p.end, p);
  const annual = [...byEnd.values()].filter(p => p.form === '10-K' || p.form === '20-F');
  const series = (annual.length >= 2 ? annual : [...byEnd.values()]).sort((a, b) => (a.end < b.end ? -1 : 1));
  if (series.length < 2) return null;
  return { latest: series.at(-1), prior: series.at(-2), n: series.length };
}

// PURE. `seriesMap` = { revenue:[{end,val,form}], receivables:[...], ... } already filtered to
// filed ≤ asOf. Computes the transition signals. Returns null if too little data.
function assessAccountingFacts(seriesMap, asOf) {
  const g = {}; // per-concept last-two-annual
  let present = 0, needed = 0;
  for (const k of Object.keys(CONCEPTS)) { needed++; const t = lastTwoAnnual(seriesMap[k]); if (t) { g[k] = t; present++; } }
  if (present < 3) return { insufficient: true, coverage: present / needed };

  const val = (k, w) => (g[k] ? g[k][w].val : null);
  const yoy = (k) => (g[k] ? pct(g[k].latest.val, g[k].prior.val) : null);

  // Revenue quality: receivables growing FASTER than revenue = softening revenue recognition.
  const revGrowth = yoy('revenue'), recvGrowth = yoy('receivables');
  const revenueQualityChange = (revGrowth != null && recvGrowth != null) ? -(recvGrowth - revGrowth) : null; // negative = deteriorating

  // Accruals / cash conversion: NI detaching from CFO. Accrual = (NI - CFO)/Assets; a RISE is bad.
  const accrualNow = (val('netIncome', 'latest') != null && val('cfo', 'latest') != null && val('assets', 'latest'))
    ? (val('netIncome', 'latest') - val('cfo', 'latest')) / val('assets', 'latest') : null;
  const accrualPrior = (val('netIncome', 'prior') != null && val('cfo', 'prior') != null && val('assets', 'prior'))
    ? (val('netIncome', 'prior') - val('cfo', 'prior')) / val('assets', 'prior') : null;
  const accrualTransition = (accrualNow != null && accrualPrior != null) ? -(accrualNow - accrualPrior) : null; // negative = worsening accruals

  const cfoNiNow = (val('cfo', 'latest') != null && val('netIncome', 'latest')) ? val('cfo', 'latest') / val('netIncome', 'latest') : null;
  const cfoNiPrior = (val('cfo', 'prior') != null && val('netIncome', 'prior')) ? val('cfo', 'prior') / val('netIncome', 'prior') : null;
  const cashConversionChange = (cfoNiNow != null && cfoNiPrior != null) ? clip(cfoNiNow - cfoNiPrior, -2, 2) : null; // positive = improving

  // Working capital stress: receivables + inventory growing faster than revenue.
  const invGrowth = yoy('inventory');
  const wcStress = (revGrowth != null && (recvGrowth != null || invGrowth != null))
    ? -(avgDefined([recvGrowth, invGrowth]) - revGrowth) : null; // negative = WC consuming cash faster than sales

  // Share dilution pressure: growth in diluted share count (positive = dilution).
  const shareDilution = yoy('shares');

  const parts = [scale(revenueQualityChange, 0.15), scale(accrualTransition, 0.05), scale(cashConversionChange, 0.5), scale(wcStress, 0.15), scale(-shareDilution, 0.05)]
    .filter(x => x != null);
  const composite = parts.length ? clip(parts.reduce((a, b) => a + b, 0) / parts.length, -1, 1) : null;

  return {
    insufficient: false, coverage: present / needed,
    revenueQualityChange, accrualTransition, cashConversionChange, workingCapitalStress: wcStress,
    shareDilution, composite,
    latestPeriod: g.revenue ? g.revenue.latest.end : (g.netIncome ? g.netIncome.latest.end : null),
    latestFiled: latestFiledAcross(seriesMap, asOf),
  };
}

const clip = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
const scale = (v, denom) => (v == null ? null : clip(v / denom, -1, 1));
const avgDefined = (a) => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
function latestFiledAcross(seriesMap, asOf) {
  let latest = null;
  for (const k of Object.keys(seriesMap || {})) for (const p of seriesMap[k] || []) if (p.filed && p.filed <= asOf && (!latest || p.filed > latest)) latest = p.filed;
  return latest;
}

function toEnvelope(a, { ticker, securityId, asOf } = {}) {
  if (!a) return unavailable('accounting_forensics', { engine: 6, ticker, securityId, asOf, reason: 'no XBRL facts', provider: 'sec_xbrl' });
  if (a.insufficient) {
    return makeEnvelope({ engine: 6, signal: 'accounting_forensics', signalVersion: 'accounting-forensics-v1', ticker, securityId, asOf,
      status: STATUS.UNAVAILABLE, coverage: +a.coverage.toFixed(2),
      warnings: ['insufficient structured facts for a transition (need ≥3 concepts, ≥2 periods)'] });
  }
  const daysBetween = (x, y) => Math.round((Date.parse(x) - Date.parse(y)) / 86400000);
  const ageDays = a.latestFiled ? daysBetween(asOf, a.latestFiled) : null;
  return makeEnvelope({
    engine: 6, signal: 'accounting_forensics', signalVersion: 'accounting-forensics-v1', ticker, securityId, asOf,
    status: STATUS.USABLE,
    score: a.composite != null ? +a.composite.toFixed(4) : null,
    direction: a.composite == null ? DIRECTION.NEUTRAL : (a.composite > 0.1 ? DIRECTION.LONG : (a.composite < -0.1 ? DIRECTION.SHORT : DIRECTION.NEUTRAL)),
    confidence: +(clamp01(0.3 + 0.4 * a.coverage)).toFixed(3),
    coverage: +a.coverage.toFixed(3),
    staleness: ageDays != null ? { ageDays, publishedTs: a.latestFiled } : null,
    expectedDecay: { halfLifeDays: 120, reversal: false }, // accounting drift is a slow, quarters-scale effect
    historicalSupport: { n: null, note: 'company-vs-own-history transition (annual)' },
    warnings: ageDays != null && ageDays > 200 ? ['freshest annual filing is stale (>200d)'] : [],
    inputs: {
      accrual_transition: fx(a.accrualTransition), working_capital_stress: fx(a.workingCapitalStress),
      revenue_quality_change: fx(a.revenueQualityChange), cash_conversion_change: fx(a.cashConversionChange),
      share_dilution_pressure: fx(a.shareDilution), structured_reporting_anomaly: null, // XBRL tag-change forensics: not built
      latestPeriod: a.latestPeriod,
    },
    sourceTimestamps: { latest_filing: a.latestFiled, period_end: a.latestPeriod },
  });
}
const fx = (v) => (v == null ? null : +v.toFixed(4));

// Reduce a raw company-facts payload to the PIT-filtered series map the pure core consumes.
function extractSeries(facts, asOf) {
  const gaap = (facts && facts.facts && facts.facts['us-gaap']) || {};
  const out = {};
  for (const key of Object.keys(CONCEPTS)) {
    let points = null;
    for (const alias of CONCEPTS[key]) {
      const concept = gaap[alias];
      if (!concept || !concept.units) continue;
      const unit = concept.units.USD || concept.units.shares || concept.units[Object.keys(concept.units)[0]];
      if (!Array.isArray(unit)) continue;
      points = unit.filter(p => p.filed && p.filed <= asOf && p.val != null && p.form)
        .map(p => ({ end: p.end, val: Number(p.val), form: p.form, filed: p.filed }));
      if (points.length) break;
    }
    out[key] = points || [];
  }
  return out;
}

async function fetchCompanyFacts(cik) {
  const r = await fetchWithTimeout(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: H });
  if (!r.ok) return null;
  return r.json();
}

// Resolve a ticker to its raw companyfacts payload (CIK lookup + fetch). Returns null on any
// failure so callers can treat the name as UNAVAILABLE. Exposed for research harnesses that pull
// the full payload ONCE and then compute the PIT signal at many as-of dates locally (via
// extractSeries + assessAccountingFacts) — avoiding one SEC round-trip per (ticker, date).
async function fetchCompanyFactsForTicker(ticker) {
  let cik; try { cik = await cikFor(ticker); } catch { cik = null; }
  if (!cik) return null;
  try { return await fetchCompanyFacts(cik); } catch { return null; }
}

async function computeAccountingForensics(ticker, { asOf, securityId = null } = {}) {
  if (!asOf) throw new Error('computeAccountingForensics requires asOf');
  let cik; try { cik = await cikFor(ticker); } catch { cik = null; }
  if (!cik) return unavailable('accounting_forensics', { engine: 6, ticker, securityId, asOf, reason: 'no CIK', provider: 'sec_xbrl' });
  let facts; try { facts = await fetchCompanyFacts(cik); } catch (e) { return unavailable('accounting_forensics', { engine: 6, ticker, securityId, asOf, reason: `xbrl fetch failed: ${e.message}`, provider: 'sec_xbrl' }); }
  if (!facts) return unavailable('accounting_forensics', { engine: 6, ticker, securityId, asOf, reason: 'no company facts', provider: 'sec_xbrl' });
  const series = extractSeries(facts, asOf);
  return toEnvelope(assessAccountingFacts(series, asOf), { ticker, securityId, asOf });
}

module.exports = { CONCEPTS, lastTwoAnnual, assessAccountingFacts, extractSeries, toEnvelope, computeAccountingForensics, fetchCompanyFacts, fetchCompanyFactsForTicker };
