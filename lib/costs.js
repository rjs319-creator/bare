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

const COST_MODEL_VERSION = 'cost-v2';

// ── SHORT BORROW ────────────────────────────────────────────────────────────
// cost-v1 charged shorts exactly what it charged longs, which silently valued
// stock-loan fees at zero. That is the single most flattering assumption a
// short study can make: the app's own Trade Alerts fade result is profitable
// ONLY on its short leg, and only in illiquid social-darling names — precisely
// the population where borrow is expensive or unavailable. Reporting that leg
// net-of-spread-but-gross-of-borrow overstates it.
//
// HONESTY BOUNDARY: a real borrow rate is a per-name, per-day broker quote we
// do not have a feed for. These are TIER PRIORS, not quotes. Every consumer
// gets `borrowKnown:false` so a modeled number can never be mistaken for an
// observed one, and callers may fail closed instead of trusting the prior.
// Priors are deliberately conservative-but-not-punitive general-collateral
// estimates; genuinely hard-to-borrow names run far higher and are flagged,
// not silently averaged in.
const BORROW_APR_BPS = {
  liquid:  30,   // ~0.3%/yr general collateral
  small:   200,  // ~2%/yr
  micro:   1200, // ~12%/yr — frequently HTB, wide dispersion
  biotech: 800,  // ~8%/yr — event-driven names tighten hard
};
// Sessions → calendar days: borrow accrues every calendar day held, including
// weekends, but horizons are expressed in trading sessions.
const CALENDAR_PER_SESSION = 365 / 252;
const DAYS_PER_YEAR = 365;
// Above this prior, treat the tier as hard-to-borrow: the cost estimate is not
// merely uncertain, the position may not be enterable at all.
const HTB_APR_BPS = 1000;

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

// Borrow (stock-loan) cost in PERCENT for holding a SHORT `holdSessions` long.
// Longs are never charged borrow — they own the shares. Returns a labeled
// estimate, never a bare number, so no caller can quietly treat a tier prior as
// an observed quote.
//
//   { pct, aprBps, borrowKnown:false, hardToBorrow, basis }
//
// Unknown/absent side or a non-positive holding period ⇒ 0 with borrowKnown
// still false: absence of a charge is not evidence the borrow was free.
function borrowCost(tier, holdSessions, side) {
  const key = TIERS[tier] ? tier : 'liquid';
  const aprBps = BORROW_APR_BPS[key];
  const hardToBorrow = aprBps >= HTB_APR_BPS;
  const isShort = String(side || '').toLowerCase() === 'short';
  const sessions = Number.isFinite(holdSessions) && holdSessions > 0 ? holdSessions : 0;
  const pct = isShort && sessions
    ? +((aprBps / 100) * (sessions * CALENDAR_PER_SESSION) / DAYS_PER_YEAR).toFixed(3)
    : 0;
  return {
    pct, aprBps, hardToBorrow, borrowKnown: false, side: isShort ? 'short' : 'long',
    basis: isShort
      ? `tier prior ${(aprBps / 100).toFixed(2)}%/yr × ${sessions} sessions — ESTIMATE, not a broker quote`
      : 'long position — no borrow',
  };
}

// Full itemised round-trip cost for a position. This is the honest surface:
// it separates what we model well (spread/slippage) from what we are guessing
// (borrow), so a caller can decide to fail closed on the guess.
function costBreakdown(tier, opts = {}) {
  const { side = 'long', holdSessions = 0 } = opts;
  const spreadPct = roundTripCostPct(tier);
  const borrow = borrowCost(tier, holdSessions, side);
  return {
    version: COST_MODEL_VERSION,
    tier: TIERS[tier] ? tier : 'liquid',
    spreadPct, borrowPct: borrow.pct, totalPct: +(spreadPct + borrow.pct).toFixed(3),
    borrow,
  };
}

// Net of round-trip friction. grossPct is already direction-adjusted (shorts
// sign-flipped upstream), so the cost is always a positive drag either way.
// null in → null out.
//
// opts {side, holdSessions} additionally charges short borrow. Omitting them
// preserves the cost-v1 spread-only behaviour for every existing caller — but
// note that a SHORT priced without opts is being valued at zero borrow, which
// flatters it. Prefer costBreakdown() when the side is known.
function netReturn(grossPct, tier, opts = {}) {
  if (grossPct == null || !Number.isFinite(grossPct)) return null;
  const { side, holdSessions } = opts;
  const borrowPct = borrowCost(tier, holdSessions, side).pct;
  return +(grossPct - roundTripCostPct(tier) - borrowPct).toFixed(2);
}

// Net EXCESS vs a benchmark. Convention: the benchmark (SPY / sector ETF) is
// treated as a costless index baseline — we do NOT double-charge it — so this is
// "your net-of-costs return minus the market's return". Same drag, applied once.
function netExcess(grossExcessPct, tier, opts = {}) {
  return netReturn(grossExcessPct, tier, opts);
}

module.exports = {
  COST_MODEL_VERSION, TIERS, COMMISSION_BPS, BORROW_APR_BPS, HTB_APR_BPS,
  roundTripCostPct, tierForPick, netReturn, netExcess, borrowCost, costBreakdown,
};
