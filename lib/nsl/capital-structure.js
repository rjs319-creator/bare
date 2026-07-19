'use strict';
// NOVEL SIGNAL LAB — Engine 5: capital-structure divergence (capital-structure-v1).
//
// When a firm's credit (bond spreads, CDS, loan pricing, rating actions) and its equity tell
// different stories, credit often leads — refinancing stress can hide behind headline earnings.
// Detecting this requires issuer-level fixed-income pricing (TRACE/ICE bonds, Markit CDS) and
// ratings feeds, all of which are LICENSED and NOT held here. So this engine is a clean provider
// interface that emits UNAVAILABLE. A stale bond print must never be treated as a current
// observation, so the pure core below also carries a staleness gate for the day a feed is added.

const { unavailable, makeEnvelope, STATUS, DIRECTION, clamp01, signalMeta } = require('./registry');
const { resolveSignal } = require('./providers');

const MAX_CREDIT_STALE_DAYS = 5; // a bond/CDS print older than this is NOT a current observation

// PURE. `credit` = { spreadBps, spreadChgBps, lastTradeTs }, `equity` = { ret63, vol }.
// Detects credit-equity divergence when a credit feed exists. Returns null if credit is stale.
function assessDivergence(credit, equity, asOf) {
  if (!credit || !Number.isFinite(credit.spreadChgBps) || !equity) return null;
  const daysBetween = (x, y) => Math.round((Date.parse(x) - Date.parse(y)) / 86400000);
  if (credit.lastTradeTs && daysBetween(asOf, credit.lastTradeTs) > MAX_CREDIT_STALE_DAYS) {
    return { stale: true, ageDays: daysBetween(asOf, credit.lastTradeTs) };
  }
  // Divergence: equity up while credit risk rises (spread widening) = bearish lead, and vice-versa.
  const equityUp = Number.isFinite(equity.ret63) ? Math.tanh(equity.ret63 * 5) : 0;
  const creditWorse = Math.tanh(credit.spreadChgBps / 50); // positive = spreads widening (worse)
  const divergence = -0.5 * (equityUp * creditWorse < 0 ? 0 : (equityUp + creditWorse)); // signed conflict
  return { stale: false, divergence: Math.max(-1, Math.min(1, divergence)), lastTradeTs: credit.lastTradeTs };
}

function computeCapitalStructure(ticker, { asOf, securityId = null, credit = null, equity = null } = {}) {
  const { anyAvailable } = resolveSignal(signalMeta(5));
  if (!anyAvailable || !credit) {
    return unavailable('capital_structure', { engine: 5, ticker, securityId, asOf,
      reason: 'issuer-level credit (bond/CDS spreads, ratings) requires a fixed-income data licence; none configured',
      provider: 'bond_spread', restrictions: 'licensed credit data — not held by this deployment' });
  }
  const a = assessDivergence(credit, equity, asOf);
  if (!a) return unavailable('capital_structure', { engine: 5, ticker, securityId, asOf, reason: 'insufficient credit data', provider: 'bond_spread' });
  if (a.stale) return unavailable('capital_structure', { engine: 5, ticker, securityId, asOf, reason: `stale credit print (${a.ageDays}d) — not a current observation`, provider: 'bond_spread' });
  return makeEnvelope({
    engine: 5, signal: 'capital_structure', signalVersion: 'capital-structure-v1', ticker, securityId, asOf,
    status: STATUS.EXPERIMENTAL,
    score: +a.divergence.toFixed(4),
    direction: a.divergence > 0.1 ? DIRECTION.LONG : (a.divergence < -0.1 ? DIRECTION.SHORT : DIRECTION.NEUTRAL),
    confidence: clamp01(0.35), coverage: 1,
    staleness: a.lastTradeTs ? { ageDays: Math.round((Date.parse(asOf) - Date.parse(a.lastTradeTs)) / 86400000), publishedTs: a.lastTradeTs } : null,
    expectedDecay: { halfLifeDays: 20, reversal: false },
    warnings: ['experimental — credit-leads-equity effect unverified in this app'],
  });
}

module.exports = { assessDivergence, computeCapitalStructure, MAX_CREDIT_STALE_DAYS };
