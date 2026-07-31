'use strict';
// 🏛️ GOV-DEMAND — cadence expectation (deterministic, own-history baseline).
//
// The AI-Alpha-OS distinction this encodes: a POSITIVE OBSERVATION is not a
// POSITIVE SURPRISE. Big contractors win awards constantly — an award is only
// information if it departs from what the company's own award cadence made
// expectable. The expectation source here is the company's OWN obligation
// history as observed by our collector (expectationSource:'own-award-cadence').
//
// State shape: obligations are aggregated per fiscal-calendar quarter
// ({ '2026Q1': totalUSD }), which keeps collector state bounded no matter how
// many individual transactions a prime books.
//
// Honesty rules: with insufficient history the expectation is null and the
// surprise verdict is null (UNKNOWN) — never "unexpected by default". A single
// award is surprising when it alone rivals a typical QUARTER of total flow.

const MIN_HISTORY_QUARTERS = 2;      // below this the cadence is unknowable → null
const SURPRISE_MULTIPLE = 1.0;       // award ≥ 1.0× a typical quarter's total flow = unexpected
const MAX_QUARTERS_KEPT = 8;         // bounded per-ticker state

const quarterOf = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Immutably add one positive obligation to a per-ticker quarter-sum map,
// keeping only the most recent MAX_QUARTERS_KEPT quarters.
function addToQuarters(quarters, eventTime, amountUSD) {
  if (!eventTime || !Number.isFinite(amountUSD) || amountUSD <= 0) return quarters || {};
  const q = quarterOf(eventTime);
  const next = { ...(quarters || {}), [q]: ((quarters || {})[q] || 0) + amountUSD };
  const keys = Object.keys(next).sort();
  if (keys.length <= MAX_QUARTERS_KEPT) return next;
  const kept = keys.slice(-MAX_QUARTERS_KEPT);
  const out = {};
  for (const k of kept) out[k] = next[k];
  return out;
}

// Cadence baseline from a quarter-sum map as-of `asOf`. The CURRENT quarter is
// excluded (incomplete), and quarters strictly after asOf's quarter can never
// leak in (PIT rule) — the caller only feeds observations it has already seen.
function cadenceBaseline(quarters, asOf) {
  const currentQ = quarterOf(asOf);
  const completed = Object.keys(quarters || {}).filter(q => q < currentQ).sort();
  if (completed.length < MIN_HISTORY_QUARTERS) {
    return { expectedQuarterlyFlowUSD: null, historyQuarters: completed.length };
  }
  return {
    expectedQuarterlyFlowUSD: median(completed.map(q => quarters[q])),
    historyQuarters: completed.length,
  };
}

// Judge one award against the cadence baseline. Returns the canonical
// expectation record (prompt Phase-2 shape, nulls preserved).
function expectationSurprise({ amountUSD, ticker, asOf, quarters }) {
  const base = cadenceBaseline(quarters, asOf);
  const record = {
    ticker,
    variable: 'quarterly-obligation-flow',
    expectationSource: 'own-award-cadence',
    expectedQuarterlyFlowUSD: base.expectedQuarterlyFlowUSD,
    historyQuarters: base.historyQuarters,
    observedAwardUSD: Number.isFinite(amountUSD) ? amountUSD : null,
    asOf,
  };
  if (base.expectedQuarterlyFlowUSD == null || !Number.isFinite(amountUSD) || amountUSD <= 0) {
    // Unknowable ≠ unexpected: without a baseline (or a grounded amount) the
    // surprise verdict must stay null, and confidence reflects why.
    return { ...record, surpriseRatio: null, isUnexpected: null, confidence: 'insufficient-history' };
  }
  const surpriseRatio = amountUSD / base.expectedQuarterlyFlowUSD;
  return {
    ...record,
    surpriseRatio: +surpriseRatio.toFixed(4),
    isUnexpected: surpriseRatio >= SURPRISE_MULTIPLE,
    confidence: base.historyQuarters >= 4 ? 'normal' : 'short-history',
  };
}

module.exports = {
  addToQuarters, cadenceBaseline, expectationSurprise, quarterOf,
  MIN_HISTORY_QUARTERS, SURPRISE_MULTIPLE, MAX_QUARTERS_KEPT,
};
