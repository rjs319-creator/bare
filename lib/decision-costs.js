// TRANSACTION COSTS THAT BIND THE RANK (spec §7: "trading costs must alter rankings,
// not merely appear as warnings").
//
// THE DEFECT THIS FIXES: `lib/costs.js` has modelled round-trip friction since cost-v1,
// but it was required by exactly ONE consumer — `apex-routes.js` — which applies it
// post-hoc to the RESOLVED ledger (the track record). The live board never saw it:
// `decision.js compositeScore` was confidence × regimeFit × execution × tilt ×
// evidenceMult, with no cost term anywhere. So a micro-cap chasing a 3% target and a
// mega-cap chasing 3% ranked identically, even though ~half the micro-cap's move is
// eaten by the spread. This is the same defect class as the redundancy model before
// PR #110: measured honestly, reported honestly, and then never allowed to change a
// decision.
//
// WHAT BINDS: cost is charged against the trade's OWN target move, because that ratio —
// not the absolute cost — is what decides whether a setup can pay for itself. A 0.16%
// round trip is noise against a +15% swing target and is fatal against a +1% scalp.
//
// COST IS CHARGED EXACTLY ONCE. `expectancyTilt` deliberately keeps reading GROSS
// realized excess: it measures a section:tier's REALIZED group track record, which is a
// different quantity from this setup's cost geometry, and charging both would put the
// same friction into the product twice. The net figures below are additive/for display;
// the single binding channel is `penalty`.
//
// Pure: a signal in → a cost object out. No network, no state.

const { roundTripCostPct, TIERS, COST_MODEL_VERSION } = require('./costs');

// `costs.js` keys its tiers by the LEDGER's scope label (large/small/micro), which the
// live decision table does not carry. It does carry real dollar-volume — which is what
// the scope label was proxying for all along, and is strictly better evidence than it.
// Thresholds mirror `decision.js LIQ` so the two liquidity reads cannot contradict.
const TIER_BY_DOLLAR_VOL = [
  { min: 2e7, tier: 'liquid' }, // LIQ.goodDollarVol
  { min: 2e6, tier: 'small' },  // LIQ.minDollarVol
  { min: 0, tier: 'micro' },
];

// The penalty floor. A setup whose round trip exceeds its entire target move is not a
// trade — but this is a RANKING multiplier, not a veto, and halving the composite is
// already a decisive demotion in a multiplicative score. We demote it; we let the rest
// of the evidence decide whether it still clears the board.
const MAX_COST_DRAG_FLOOR = 0.5;

// Which cost tier a live signal trades in.
//
// UNKNOWN dollar-volume assumes the CHEAPEST tier, never the worst. A name must never be
// buried for a missing feed — that is the same principle `executionQuality` follows when
// it treats an absent dollar-volume as neutral rather than thin. `assumed:true` is
// carried so the UI can label the estimate instead of implying it was measured.
function costTierFor(signal) {
  const sig = signal || {};
  const liq = sig.liquidity || {};
  if (sig.section === 'Biotech' || sig.bench === 'XBI') {
    return { tier: 'biotech', assumed: false, basis: 'biotech sleeve' };
  }
  const dv = Number.isFinite(liq.dollarVol) ? liq.dollarVol : null;
  if (dv == null) return { tier: 'liquid', assumed: true, basis: 'dollar-volume unknown — cheapest tier assumed' };
  const row = TIER_BY_DOLLAR_VOL.find(r => dv >= r.min) || TIER_BY_DOLLAR_VOL[TIER_BY_DOLLAR_VOL.length - 1];
  return { tier: row.tier, assumed: false, basis: 'measured dollar-volume' };
}

// The trade's own gross target move, in percent. Direction-agnostic: a short targeting
// 90 from 100 is the same 10% move as a long targeting 110, and pays the same round trip.
function grossMoveOf(signal) {
  const sig = signal || {};
  const entry = Number.isFinite(sig.entry) ? sig.entry : (Number.isFinite(sig.price) ? sig.price : null);
  const target = Number.isFinite(sig.target) ? sig.target : null;
  if (entry == null || target == null || entry <= 0) return null;
  const move = Math.abs(target - entry) / entry * 100;
  return move > 0 ? +move.toFixed(2) : null;
}

// The gross → cost → net waterfall for one signal, plus the binding `penalty`.
//
// Returns `known:false, penalty:1` whenever the trade has no target to charge against
// (the AI screeners and Biotech emit leads, not levels). Unknown ⇒ neutral: we do not
// invent a move in order to manufacture a penalty.
function costModel(signal) {
  const { tier, assumed, basis } = costTierFor(signal);
  const roundTripPct = roundTripCostPct(tier);
  const grossMovePct = grossMoveOf(signal);
  const base = {
    modelVersion: COST_MODEL_VERSION,
    tier,
    tierLabel: (TIERS[tier] || TIERS.liquid).label,
    tierAssumed: assumed,
    tierBasis: basis,
    roundTripPct,
  };
  if (grossMovePct == null) {
    return { ...base, known: false, grossMovePct: null, netMovePct: null, costShare: null, penalty: 1 };
  }
  const costShare = +(roundTripPct / grossMovePct).toFixed(3);
  const netMovePct = +(grossMovePct - roundTripPct).toFixed(2);
  const penalty = +Math.max(MAX_COST_DRAG_FLOOR, Math.min(1, 1 - costShare)).toFixed(3);
  return { ...base, known: true, grossMovePct, netMovePct, costShare, penalty };
}

module.exports = {
  MAX_COST_DRAG_FLOOR, TIER_BY_DOLLAR_VOL,
  costTierFor, grossMoveOf, costModel,
};
