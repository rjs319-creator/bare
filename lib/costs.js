// TRANSACTION-COST model — turns GROSS Scoreboard forward returns into NET.
//
// WHY: every number the Scoreboard reports (avg, avgExcess, winRate, expectancy)
// is a raw close-to-close forward return with ZERO friction. On edges this thin
// (the app's own research: momentum rank-IC ~0.10, breakout PF < 1) round-trip
// spread + slippage is not a rounding error — it decides which sleeves are real.
// This module estimates a realistic round-trip haircut and subtracts it once per
// pick, so the board can show a net track record alongside the gross one.
//
// It is ADDITIVE and VERSIONED: gross fields are never overwritten, so no stored
// history has to be recomputed (the Scoreboard recomputes returns live from
// candles on every call anyway — nothing about costs is persisted).
//
// Pure: (grossReturnPct, tier) in → net in. No network, no state.

const COST_MODEL_VERSION = 'cost-v1';

// Round-trip cost is charged on BOTH sides (entry + exit):
//   roundTripPct = 2 × (halfSpreadBps + slippageBps) + commissionBps  (then bps→%)
// Tiers are liquidity buckets because a small/micro/biotech spread dwarfs a
// large-cap one — a flat number would flatter the illiquid sleeves where the
// app actually trades. Conservative but defensible retail estimates.
const TIERS = {
  liquid:  { halfSpreadBps: 3,  slippageBps: 5,  label: 'large / liquid' },
  small:   { halfSpreadBps: 15, slippageBps: 15, label: 'small-cap' },
  micro:   { halfSpreadBps: 40, slippageBps: 35, label: 'micro-cap' },
  biotech: { halfSpreadBps: 25, slippageBps: 25, label: 'biotech' },
};
const COMMISSION_BPS = 0; // modern zero-commission retail brokers

// Round-trip cost in PERCENT for a liquidity tier (unknown tier → liquid).
function roundTripCostPct(tier) {
  const t = TIERS[tier] || TIERS.liquid;
  return +(((2 * (t.halfSpreadBps + t.slippageBps)) + COMMISSION_BPS) / 100).toFixed(3);
}

// Classify a Scoreboard pick into a liquidity tier from the metadata the ledgers
// already carry (scope small/micro, or the biotech sleeve). Defaults to liquid.
function tierForPick(p) {
  if (!p || typeof p !== 'object') return 'liquid';
  if (p.section === 'Biotech' || p.bench === 'XBI') return 'biotech';
  const s = String(p.scope || '').toLowerCase();
  if (s === 'micro') return 'micro';
  if (s === 'small') return 'small';
  return 'liquid';
}

// Net of round-trip friction. grossPct is already direction-adjusted (shorts
// sign-flipped upstream), so the cost is always a positive drag either way.
// null in → null out.
function netReturn(grossPct, tier) {
  if (grossPct == null || !Number.isFinite(grossPct)) return null;
  return +(grossPct - roundTripCostPct(tier)).toFixed(2);
}

// Net EXCESS vs a benchmark. Convention: the benchmark (SPY / sector ETF) is
// treated as a costless index baseline — we do NOT double-charge it — so this is
// "your net-of-costs return minus the market's return". Same drag, applied once.
function netExcess(grossExcessPct, tier) {
  return netReturn(grossExcessPct, tier);
}

module.exports = {
  COST_MODEL_VERSION, TIERS, COMMISSION_BPS,
  roundTripCostPct, tierForPick, netReturn, netExcess,
};
