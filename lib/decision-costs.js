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
const { EXECUTION_POLICY_VERSION, perSideSlippagePct } = require('./execution-policy');

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

// Worst-case costShare sentinel. `costShare` ∈ [0,1] on the known path: the fraction of
// the trade's own move eaten by the round trip, SATURATING at 1 whenever cost meets or
// exceeds the move — including a move fully consumed by the entry-slippage leg
// (grossMovePct clamps to 0). It is NEVER null when `known:true`: consumers
// (challenger-rank costEff, omega-ensemble cost view) treat a non-numeric costShare as
// MISSING and renormalize the factor away, which would rank the worst-cost trade on the
// board ABOVE a moderately costly one. null is reserved for known:false (no target).
const WORST_COST_SHARE = 1;

// Which cost tier a live signal trades in.
//
// UNKNOWN dollar-volume assumes the CONSERVATIVE middle tier ('small'), never the cheapest.
// The prior rule assumed 'liquid' — so a name with a MISSING liquidity feed paid the
// smallest modeled friction and out-ranked measured peers, which is exactly the "missing
// data becomes a favorable assumption" failure this codebase bans. 'small' is the
// documented conservative fallback: unknown names are demoted relative to measured-liquid
// ones without being buried under micro-cap costs they may not deserve. `assumed:true` is
// carried so the UI labels the estimate instead of implying it was measured — and the
// eligibility layer separately refuses to size an unknown-liquidity name.
function costTierFor(signal) {
  const sig = signal || {};
  const liq = sig.liquidity || {};
  if (sig.section === 'Biotech' || sig.bench === 'XBI') {
    return { tier: 'biotech', assumed: false, basis: 'biotech sleeve' };
  }
  const dv = Number.isFinite(liq.dollarVol) ? liq.dollarVol : null;
  if (dv == null) return { tier: 'small', assumed: true, basis: 'dollar-volume unknown — conservative tier assumed (never the cheapest)' };
  const row = TIER_BY_DOLLAR_VOL.find(r => dv >= r.min) || TIER_BY_DOLLAR_VOL[TIER_BY_DOLLAR_VOL.length - 1];
  return { tier: row.tier, assumed: false, basis: 'measured dollar-volume' };
}

// ── ENTRY BASIS (audit 2026-08-14) ──────────────────────────────────────────
// THE DEFECT THIS FIXES: this module priced the waterfall off the PUBLISHED entry — for
// the screener that is the signal-day close (Breakout) or a pivot stop-entry level
// (Early/Setup). But the strategy contract (lib/strategy-contracts.js: fillPolicy
// 'next-session-open') and the grading path (lib/apex-routes.js entryBasisForSection,
// basis entry-v2.2) grade the track record from NEXT-OPEN fills, and the canonical fill
// model (lib/execution-policy.js, exec-v1) says the achievable fill sits an adverse
// entry-side slippage leg beyond the reference print. So the decision-time net EV was
// computed on a basis the track record is never graded on — and the printed level is the
// FLATTERING side of that gap.
//
// THE FIX: charge the gross target move from the expected FILL, not the print. At
// decision time the next open is unknowable, so the printed level is the reference and
// the exec-v1 per-side slippage is the conservative displacement TOWARD the target
// (a long pays up, a short sells down — either way the remaining move shrinks). The
// correction can only SHRINK the expected net move, never flatter it. Slippage
// magnitudes are REUSED from exec-v1/lib/costs.js — no parallel friction numbers.
//
// The full roundTripPct stays charged on top, exactly mirroring how the graded record
// nets its next-open returns (apex-routes applies lib/costs netReturn post-hoc); the
// displacement here is the printed-level → achievable-fill basis gap, not a second
// friction charge.
//
// DAY TRADE IS PINNED TO LEGACY: apex-routes entryBasisForSection returns null for the
// daytrade section — its displayed record is contractually FROZEN on the logged entry
// (see test/today-golden.test.js DAY TRADE FROZEN guards) — so its decision basis must
// keep matching the basis it is actually graded on: the published level.
const ENTRY_BASIS_ADJUSTED = 'next-open+slippage';
const ENTRY_BASIS_PUBLISHED = 'published-level';
const LEGACY_BASIS_SECTIONS = new Set(['daytrade']);

// Which entry basis a signal's decision math uses, and the slippage (as a FRACTION of
// price, exec-v1 convention) its expected fill is displaced by.
function entryAdjustmentFor(signal) {
  const sig = signal || {};
  if (LEGACY_BASIS_SECTIONS.has(sig.section) || LEGACY_BASIS_SECTIONS.has(sig.source)) {
    return {
      adjusted: false, slippagePct: 0,
      entryBasis: ENTRY_BASIS_PUBLISHED, execModel: null,
      basis: 'published-level (daytrade grading basis is pinned to legacy — record FROZEN)',
    };
  }
  const { tier } = costTierFor(sig);
  return {
    adjusted: true, slippagePct: perSideSlippagePct(tier),
    entryBasis: ENTRY_BASIS_ADJUSTED, execModel: EXECUTION_POLICY_VERSION,
    basis: `${ENTRY_BASIS_ADJUSTED} (${EXECUTION_POLICY_VERSION})`,
  };
}

// The published entry/target pair, or null when the signal is a lead without levels.
function publishedLevelsOf(signal) {
  const sig = signal || {};
  const entry = Number.isFinite(sig.entry) ? sig.entry : (Number.isFinite(sig.price) ? sig.price : null);
  const target = Number.isFinite(sig.target) ? sig.target : null;
  if (entry == null || target == null || entry <= 0) return null;
  const printedMovePct = Math.abs(target - entry) / entry * 100;
  return printedMovePct > 0 ? { entry, target, printedMovePct } : null;
}

// The trade's own gross target move, in percent, FROM THE EXPECTED FILL. Direction-
// agnostic: a short targeting 90 from 100 is the same move class as a long targeting 110,
// and pays the same round trip — but each enters at its own adverse fill.
//
// Returns 0 (not null) when the entry-side displacement eats the entire printed move:
// null would degrade to known:false ⇒ penalty 1, turning a fully-eaten move into a
// favorable assumption — exactly the failure class this codebase bans.
function grossMoveOf(signal) {
  const lv = publishedLevelsOf(signal);
  if (!lv) return null;
  const adj = entryAdjustmentFor(signal);
  if (!adj.adjusted || adj.slippagePct <= 0) return +lv.printedMovePct.toFixed(2);
  const dir = lv.target >= lv.entry ? 1 : -1;          // toward the target = against the trader
  const fill = lv.entry * (1 + dir * adj.slippagePct); // expected achievable fill, exec-v1
  const remaining = (lv.target - fill) * dir;          // signed distance still ahead of the fill
  return +(Math.max(0, remaining / fill) * 100).toFixed(2);
}

// The gross → cost → net waterfall for one signal, plus the binding `penalty`.
//
// Returns `known:false, penalty:1` whenever the trade has no target to charge against
// (the AI screeners and Biotech emit leads, not levels). Unknown ⇒ neutral: we do not
// invent a move in order to manufacture a penalty.
function costModel(signal) {
  const { tier, assumed, basis } = costTierFor(signal);
  const roundTripPct = roundTripCostPct(tier);
  const adj = entryAdjustmentFor(signal);
  const lv = publishedLevelsOf(signal);
  const grossMovePct = grossMoveOf(signal);
  const base = {
    modelVersion: COST_MODEL_VERSION,
    tier,
    tierLabel: (TIERS[tier] || TIERS.liquid).label,
    tierAssumed: assumed,
    tierBasis: basis,
    roundTripPct,
    // Basis stamp (audit 2026-08-14): WHICH entry basis this decision's math used, so the
    // payload is self-describing and a future audit never has to reverse-engineer it.
    // entrySlippagePct is in PERCENT (matching roundTripPct), not the exec-v1 fraction.
    entryBasis: adj.entryBasis,
    execModel: adj.execModel,
    basis: adj.basis,
    entrySlippagePct: +(adj.slippagePct * 100).toFixed(3),
    grossMovePrintedPct: lv ? +lv.printedMovePct.toFixed(2) : null,
  };
  if (grossMovePct == null) {
    return { ...base, known: false, grossMovePct: null, netMovePct: null, costShare: null, penalty: 1 };
  }
  const netMovePct = +(grossMovePct - roundTripPct).toFixed(2);
  // A move fully eaten by the entry leg has no gross to share the cost against — that is
  // the WORST case, not a missing one: it takes the sentinel (100% of the move eaten)
  // rather than dividing by zero, and any nonzero move saturates at the same cap so
  // costShare stays a [0,1] fraction (see WORST_COST_SHARE).
  const costShare = grossMovePct > 0
    ? +Math.min(WORST_COST_SHARE, roundTripPct / grossMovePct).toFixed(3)
    : WORST_COST_SHARE;
  const penalty = +Math.max(MAX_COST_DRAG_FLOOR, Math.min(1, 1 - costShare)).toFixed(3);
  return { ...base, known: true, grossMovePct, netMovePct, costShare, penalty };
}

module.exports = {
  MAX_COST_DRAG_FLOOR, TIER_BY_DOLLAR_VOL, LEGACY_BASIS_SECTIONS,
  costTierFor, grossMoveOf, costModel, entryAdjustmentFor,
};
