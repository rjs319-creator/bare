'use strict';
// 🏛️ GOV-DEMAND — action classification + deterministic financial materiality.
//
// The AI-Alpha-OS rule this module enforces: AI may propose hypotheses, but
// RETURNS/PROBABILITIES/MATERIALITY are calculated by deterministic code. No
// LLM touches anything here. Every estimate carries its formula, inputs,
// assumptions and failure reasons; when an input can't be grounded the result
// is null — never zero, never a guess (missing ≠ 0).
//
// Guards encoded (the classic govcon traps):
//   • contract CEILING ≠ obligated value — only obligation transactions count
//     (IDV award types are excluded upstream; classify flags them anyway)
//   • negative modifications = de-obligations (bearish direction, not bullish)
//   • zero-dollar admin mods are noise, not demand
//   • option exercises were already in expectations more often than new awards
//   • recompete language ("bridge", "follow-on", "recompete") caps surprise
//   • trailing revenue is MODELED from Finnhub per-share sales × shares
//     outstanding — labeled modeled, never presented as a measured figure.

const { fetchWithTimeout } = require('./http');

const ACTIONS = Object.freeze({
  NEW_AWARD: 'NEW_AWARD',
  OPTION_EXERCISE: 'OPTION_EXERCISE',
  MODIFICATION: 'MODIFICATION',
  DE_OBLIGATION: 'DE_OBLIGATION',
  ADMIN_ZERO: 'ADMIN_ZERO',
  IDV_CEILING: 'IDV_CEILING',
  UNKNOWN: 'UNKNOWN',
});

const OPTION_RE = /\b(EXERCISE[SD]?\s+(OF\s+)?OPTION|OPTION\s+(YEAR|PERIOD|CLIN)|OPTION\s+EXERCISE)\b/i;
const RECOMPETE_RE = /\b(RECOMPETE|RE-COMPETE|FOLLOW[- ]ON|BRIDGE\s+CONTRACT|CONTINUATION\s+OF\s+(SERVICES|EFFORT))\b/i;
const IDV_TYPE_RE = /\b(IDV|INDEFINITE\s+DELIVERY|BLANKET\s+PURCHASE|GWAC|BASIC\s+ORDERING)\b/i;

// Classify one observation (from govdemand-collect). Deterministic keyword +
// sign + mod-number rules; anything ambiguous stays UNKNOWN rather than guessed.
function classifyAction(obs) {
  const amount = obs.amountUSD;
  const mod = String(obs.mod == null ? '' : obs.mod);
  const desc = String(obs.description || '');
  const type = String(obs.awardType || '');
  const isBaseAction = mod === '0' || mod === '';

  if (IDV_TYPE_RE.test(type)) return ACTIONS.IDV_CEILING;          // ceiling vehicle, not obligated revenue
  if (amount == null) return ACTIONS.UNKNOWN;                       // unusable without a grounded amount
  if (amount < 0) return ACTIONS.DE_OBLIGATION;
  if (amount === 0) return ACTIONS.ADMIN_ZERO;
  if (OPTION_RE.test(desc)) return ACTIONS.OPTION_EXERCISE;
  if (isBaseAction) return ACTIONS.NEW_AWARD;
  return ACTIONS.MODIFICATION;
}

// True when the description reads like routine continuation rather than new demand.
function looksRoutine(obs) {
  return RECOMPETE_RE.test(String(obs.description || ''));
}

// ── Trailing revenue (modeled) ────────────────────────────────────────────────
// Finnhub stock/metric: revenuePerShareTTM × shareOutstanding (both from the
// `metric` block; shareOutstanding is in MILLIONS). Modeled — split/buyback
// timing between the two figures introduces error, which is why the output is
// labeled measuredOrModeled:'modeled' with explicit assumptions.
const SHARES_MILLIONS = 1e6;
async function fetchTrailingRevenueUSD(ticker, { fetchImpl = fetchWithTimeout } = {}) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return { revenueUSD: null, failureReasons: ['FINNHUB_API_KEY missing'] };
  try {
    const r = await fetchImpl(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${key}`);
    if (!r.ok) return { revenueUSD: null, failureReasons: [`finnhub http:${r.status}`] };
    const m = ((await r.json()) || {}).metric || {};
    const rps = Number(m.revenuePerShareTTM);
    const shares = Number(m.shareOutstanding);
    if (!Number.isFinite(rps) || !Number.isFinite(shares) || rps <= 0 || shares <= 0) {
      return { revenueUSD: null, failureReasons: ['revenuePerShareTTM or shareOutstanding unavailable'] };
    }
    return {
      revenueUSD: rps * shares * SHARES_MILLIONS,
      inputs: { revenuePerShareTTM: rps, sharesOutstandingM: shares },
      failureReasons: [],
    };
  } catch (e) {
    return { revenueUSD: null, failureReasons: [String((e && e.message) || e)] };
  }
}

// ── Materiality arithmetic (pure) ────────────────────────────────────────────
// materiality = obligated dollars / point-in-time trailing 12-month revenue.
// Returns the full provenance object the prereg requires; null value whenever
// an input is missing or non-positive.
function computeMateriality({ obligatedUSD, trailingRevenueUSD, revenueInputs = null, revenueFailures = [] }) {
  const base = {
    unit: 'fraction-of-ttm-revenue',
    formula: 'obligatedUSD / trailingRevenueTTMUSD',
    inputs: { obligatedUSD: obligatedUSD == null ? null : obligatedUSD, trailingRevenueUSD: trailingRevenueUSD == null ? null : trailingRevenueUSD, revenue: revenueInputs },
    measuredOrModeled: 'modeled',
    assumptions: [
      'trailing revenue modeled as revenuePerShareTTM × sharesOutstanding (Finnhub)',
      'obligation recognized as revenue over the period of performance, not immediately',
      'no adjustment for multi-company award vehicles or subcontracting',
    ],
    failureReasons: [...revenueFailures],
  };
  if (!Number.isFinite(obligatedUSD)) {
    return { ...base, value: null, failureReasons: [...base.failureReasons, 'obligated amount not grounded'] };
  }
  if (!Number.isFinite(trailingRevenueUSD) || trailingRevenueUSD <= 0) {
    return { ...base, value: null, failureReasons: [...base.failureReasons, 'trailing revenue unavailable'] };
  }
  return { ...base, value: obligatedUSD / trailingRevenueUSD };
}

module.exports = {
  ACTIONS, classifyAction, looksRoutine,
  fetchTrailingRevenueUSD, computeMateriality,
};
