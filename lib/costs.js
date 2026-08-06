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

// SHORT-BORROW model (borrow-v1) — ADDITIVE to cost-v1, separately versioned
// because the round-trip haircut above is genuinely unchanged; this only ever
// touches SHORTS. WHY: shorting is not free. You borrow the shares and pay a
// stock-loan fee that accrues every day the position is open, and it is brutal
// exactly where the app's short sleeves live — the fade / gap-down / inverted-V
// families are small- and micro-caps that are frequently hard-to-borrow. Charging
// only the round-trip spread (as cost-v1 did) systematically FLATTERS every short
// track record, so the Scoreboard would over-credit the short sleeves. Longs pay
// zero borrow. Annualized, conservative retail/prime-broker estimates by liquidity
// tier, prorated over the holding period in trading sessions.
const BORROW_MODEL_VERSION = 'borrow-v1';
const BORROW_APR = {
  liquid:  0.005, // ~50 bps/yr — general-collateral, easy-to-borrow large caps
  small:   0.08,  // 8%/yr
  biotech: 0.20,  // 20%/yr — squeeze-prone, tight borrow
  micro:   0.30,  // 30%/yr — frequently hard-to-borrow / special
};
const SESSIONS_PER_YEAR = 252;

// Round-trip cost in PERCENT for a liquidity tier (unknown tier → liquid).
function roundTripCostPct(tier) {
  const t = TIERS[tier] || TIERS.liquid;
  return +(((2 * (t.halfSpreadBps + t.slippageBps)) + COMMISSION_BPS) / 100).toFixed(3);
}

// Borrow fee in PERCENT for holding a SHORT `holdSessions` trading days in a tier.
// Longs pay nothing — callers gate this behind their own `short` flag. A
// non-positive or non-finite hold charges nothing (fails safe to zero drag).
function borrowCostPct(tier, holdSessions) {
  const apr = BORROW_APR[tier] != null ? BORROW_APR[tier] : BORROW_APR.liquid;
  const h = Number(holdSessions);
  if (!Number.isFinite(h) || h <= 0) return 0;
  return +((apr * 100) * (h / SESSIONS_PER_YEAR)).toFixed(3);
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
// sign-flipped upstream), so the round-trip cost is always a positive drag either
// way. Optional `opts.short` + `opts.holdSessions` additionally charge the
// borrow-v1 stock-loan fee — only for shorts, prorated over the hold. Omitting
// opts reproduces the exact cost-v1 behaviour (backward compatible). null in →
// null out.
function netReturn(grossPct, tier, opts) {
  if (grossPct == null || !Number.isFinite(grossPct)) return null;
  const borrow = opts && opts.short ? borrowCostPct(tier, opts.holdSessions) : 0;
  return +(grossPct - roundTripCostPct(tier) - borrow).toFixed(2);
}

// Net EXCESS vs a benchmark. Convention: the benchmark (SPY / sector ETF) is
// treated as a costless index baseline — we do NOT double-charge it — so this is
// "your net-of-costs return minus the market's return". Same drag (round-trip +
// any short borrow), applied once. `opts` is forwarded to netReturn.
function netExcess(grossExcessPct, tier, opts) {
  return netReturn(grossExcessPct, tier, opts);
}

module.exports = {
  COST_MODEL_VERSION, BORROW_MODEL_VERSION, TIERS, COMMISSION_BPS, BORROW_APR,
  roundTripCostPct, borrowCostPct, tierForPick, netReturn, netExcess,
};
