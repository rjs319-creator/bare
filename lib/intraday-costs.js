'use strict';
// INTRADAY EXECUTION-COST MODEL (intraday-cost-v1) — the versioned, tiered replacement for
// the flat 10-basis-point assumption that used to price every label and every EV identically
// on a mega-cap and a micro-cap.
//
// HONESTY CONTRACT. Bid/ask is not observed on the current feeds, so costs are MODELED from
// point-in-time inputs (liquidity tier, price level, volatility, time of day, intended
// notional, order type) and labeled `basis: 'modeled-tier'`. When a microstructure provider
// ever supplies an observed spread, it replaces the tier prior and the basis flips to
// 'observed-spread'. Unknown inputs assume the CONSERVATIVE tier — never the cheapest.
// Every estimate carries base / adverse / severe scenarios so a strategy that only survives
// the base assumption is visibly fragile.
//
// Pure: inputs in → estimate out. No network, no clock.

const COST_MODEL_VERSION = 'intraday-cost-v1';

// One-way priors (bps) by measured average daily dollar volume. Deliberately conservative:
// these are crossing-the-spread + short-horizon slippage priors for a momentum entry, not
// midpoint-fill fantasies.
const TIERS = Object.freeze([
  { name: 'mega', minAdv: 1e9, halfSpreadBps: 1, slippageBps: 2 },
  { name: 'liquid', minAdv: 1e8, halfSpreadBps: 2, slippageBps: 4 },
  { name: 'mid', minAdv: 2e7, halfSpreadBps: 5, slippageBps: 8 },
  { name: 'small', minAdv: 5e6, halfSpreadBps: 10, slippageBps: 15 },
  { name: 'micro', minAdv: 0, halfSpreadBps: 20, slippageBps: 30 },
]);

// Regulatory/venue fees (SEC §31 + TAF, sell side), retail commission-free assumed.
const FEES_BPS = 0.2;

// Scenario multipliers — pre-registered, not fitted. Adverse ≈ a fast tape; severe ≈ a
// halt-reopen / news-spike tape. Promotion gates evaluate net utility under ADVERSE.
const SCENARIOS = Object.freeze({ base: 1, adverse: 2, severe: 4 });

const DEFAULT_NOTIONAL_USD = 10_000;   // documentation-level position unit for impact math

function tierFor(avgDollarVol) {
  if (!Number.isFinite(avgDollarVol) || avgDollarVol <= 0) return TIERS[TIERS.length - 1];   // unknown → most conservative
  return TIERS.find(t => avgDollarVol >= t.minAdv) || TIERS[TIERS.length - 1];
}

// Estimate the ROUND-TRIP cost (bps) of the intraday policy trade.
//   avgDollarVol      — measured 20-day average daily dollar volume (null → conservative tier)
//   price             — current price (low-priced names carry proportionally wider spreads)
//   atrPct            — daily ATR as a FRACTION of price (volatility adjustment)
//   sessionBucket     — 'open5'|'open30'|'midday'|'power'|'premarket'|... (time-of-day adj)
//   notionalUsd       — intended order notional (impact/participation penalty)
//   orderType         — 'stop-breakout' (default: momentum entry crossing) | 'limit' | 'market'
//   observedSpreadBps — quoted spread from a real provider, when available
function estimateIntradayCost({
  avgDollarVol = null, price = null, atrPct = null, sessionBucket = null,
  notionalUsd = DEFAULT_NOTIONAL_USD, orderType = 'stop-breakout', observedSpreadBps = null,
} = {}) {
  const tier = tierFor(avgDollarVol);
  const observed = Number.isFinite(observedSpreadBps) && observedSpreadBps >= 0;
  let halfSpread = observed ? observedSpreadBps / 2 : tier.halfSpreadBps;
  let slippage = tier.slippageBps;

  // Price-level adjustment: sub-$5 names have structurally wider proportional spreads.
  const priceMult = Number.isFinite(price) && price > 0 ? (price < 2 ? 2 : price < 5 ? 1.5 : 1) : 1.5;
  // Volatility adjustment: crossing a fast tape costs more.
  const volMult = Number.isFinite(atrPct) && atrPct > 0 ? (atrPct > 0.10 ? 2 : atrPct > 0.06 ? 1.5 : 1) : 1.25;
  // Time-of-day adjustment: the open and premarket are the expensive windows.
  const todMult = sessionBucket === 'premarket' ? 2
    : sessionBucket === 'open5' ? 1.6
      : sessionBucket === 'open30' ? 1.4
        : sessionBucket === 'power' ? 1.1 : 1;
  // Order type: a breakout stop-order enters INTO momentum (worse than a resting limit).
  const orderMult = orderType === 'limit' ? 0.6 : orderType === 'stop-breakout' ? 1.25 : 1;

  if (!observed) halfSpread = halfSpread * priceMult;
  slippage = slippage * priceMult * volMult * todMult * orderMult;

  // Impact/participation penalty: square-root impact once the order exceeds a small share
  // of average daily dollar volume. Unknown ADV already landed in the micro tier.
  let impact = 0;
  if (Number.isFinite(avgDollarVol) && avgDollarVol > 0 && Number.isFinite(notionalUsd) && notionalUsd > 0) {
    const participation = notionalUsd / avgDollarVol;
    if (participation > 0.0005) impact = Math.min(50, 10 * Math.sqrt(participation / 0.0005) - 10);
  }

  const oneWayBps = +(halfSpread + slippage + impact / 2 + FEES_BPS / 2).toFixed(2);
  const roundTripBps = +(2 * (halfSpread + slippage) + impact + FEES_BPS).toFixed(2);
  const scenarios = Object.fromEntries(
    Object.entries(SCENARIOS).map(([k, m]) => [k, +(roundTripBps * m).toFixed(2)]),
  );
  return {
    version: COST_MODEL_VERSION,
    tier: tier.name,
    basis: observed ? 'observed-spread' : 'modeled-tier',
    oneWayBps,
    roundTripBps,
    components: {
      halfSpreadBps: +halfSpread.toFixed(2), slippageBps: +slippage.toFixed(2),
      impactBps: +impact.toFixed(2), feesBps: FEES_BPS,
    },
    scenarios,
    inputs: {
      avgDollarVol: Number.isFinite(avgDollarVol) ? avgDollarVol : null,
      price: Number.isFinite(price) ? price : null,
      atrPct: Number.isFinite(atrPct) ? +atrPct.toFixed(4) : null,
      sessionBucket: sessionBucket || null,
      notionalUsd, orderType,
      observedSpreadBps: observed ? observedSpreadBps : null,
    },
  };
}

module.exports = { COST_MODEL_VERSION, TIERS, SCENARIOS, FEES_BPS, DEFAULT_NOTIONAL_USD, tierFor, estimateIntradayCost };
