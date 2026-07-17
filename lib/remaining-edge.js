// SIGNAL HALF-LIFE / REMAINING-EDGE MODEL (spec §3)
//
// THE DEFECT THIS FIXES: the board ranks by the signal's ORIGINAL composite. A name that
// was flagged at $10 with a $12 target and has since run to $11.80 still ranks as if the
// whole move were ahead of it — until it crosses the 1R "extended" line, at which point
// `lifecycleState` drops it entirely. That is a CLIFF (binary include-then-vanish), not a
// graded read of "how much edge is actually left at the current price". A late entrant to
// an 80%-consumed move is buying ~all the downside for ~none of the upside, yet the rank
// never said so.
//
// WHAT THIS ADDS: a multiplicative `mult` in [REMAIN_FLOOR, 1] that scales the composite by
// the fraction of the originally-advertised move still ahead, further trimmed for pullback
// risk on chased names (extension) and for staleness (decay past the expected hold). A
// fresh signal keeps mult 1 (byte-identical to before); a consumed one sinks smoothly BEFORE
// the extended cliff. Cost is NOT charged here — `decision-costs.js` already charges round-
// trip friction once in the composite; this factor is purely the consumption/extension/decay
// read, so the two never double-count. Regime is likewise left to the existing `regimeFit`
// factor; a `regimeNote` is surfaced for display only.
//
// IMMUTABILITY (spec §3 + validation rules): the "original" plan comes from an immutable
// origin snapshot (firstPrice/entry/stop/target captured at first detection, never rewritten)
// persisted by decision-routes.js. When no origin is supplied the signal is its OWN origin
// (firstPrice = current price ⇒ consumed 0 ⇒ mult 1), so a brand-new name and the feature-off
// path both score exactly as before — the safety guarantee mirrors redundancy/costPenalty.
//
// Pure: a signal + its origin in → a report out. No network, no clock, no state.

'use strict';

// Expected-hold bars per horizon. Lazily pulled from decision.js at call time (not at load)
// to avoid a require cycle — decision.js requires this module for rankSignals.
const holdBarsFor = (horizon) => {
  const { MAX_AGE_BARS } = require('./decision');
  return MAX_AGE_BARS[horizon] ?? 10;
};

const REMAINING_EDGE_VERSION = 'remaining-edge-v1';

// Tunables — deliberately a single exported object so the formula is CONFIGURABLE and
// validated by test rather than hard-coded in the arithmetic (spec §3: "the exact formula
// should be configurable and validated").
const CONFIG = {
  // Floor on the multiplier. A fully-consumed name keeps this fraction of its rank weight —
  // a decisive demotion in a multiplicative score without annihilating the row (it may still
  // clear a thin board). 0.15 ≈ "worth ~1/6 of a fresh peer".
  REMAIN_FLOOR: 0.15,
  // Extension (pullback-risk) haircut. Runway up to EXT_FREE_R past entry is free; beyond it
  // each additional R of chase multiplies the factor down by EXT_K per R, floored at EXT_FLOOR.
  EXT_FREE_R: 0.5,
  EXT_K: 0.35,
  EXT_FLOOR: 0.6,
  // Staleness (decay) haircut. Once a setup ages past its horizon's expected hold, each extra
  // bar trims reliability by DECAY_PER_BAR, floored at DECAY_FLOOR.
  DECAY_PER_BAR: 0.03,
  DECAY_FLOOR: 0.6,
  // Consumption-class thresholds (fraction of the advertised move already realized).
  FRESH_MAX: 0.15,
  ACTIONABLE_MAX: 0.5,
  PARTIAL_MAX: 0.85,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Resolve the immutable original plan for a signal. With an origin, use its captured
// firstPrice/entry/stop/target (never the possibly-drifted live levels). Without one, the
// signal is its own origin (firstPrice = current price ⇒ nothing consumed yet).
function planFrom(sig, origin) {
  if (origin) {
    return {
      firstPrice: num(origin.firstPrice),
      entry: num(origin.entry), stop: num(origin.stop), target: num(origin.target),
      ageBars: Number.isFinite(origin.bars) ? origin.bars : 0,
      hasOrigin: true,
    };
  }
  return {
    firstPrice: num(sig.price),
    entry: num(sig.entry), stop: num(sig.stop), target: num(sig.target),
    ageBars: Number.isFinite(sig.ageBars) ? sig.ageBars : 0,
    hasOrigin: false,
  };
}
const num = (v) => (Number.isFinite(+v) ? +v : null);

// The core computation. Returns a full report + the binding `mult`. Direction-aware.
function computeRemainingEdge(sig = {}, origin = null, cfg = CONFIG) {
  const plan = planFrom(sig, origin);
  const side = sig.side === 'short' ? 'short' : 'long';
  const long = side !== 'short';
  const price = num(sig.price);
  const { firstPrice, entry, stop, target, ageBars, hasOrigin } = plan;

  const base = {
    version: REMAINING_EDGE_VERSION, hasOrigin, side, ageBars,
    firstPrice, rated: false, mult: 1, freshness: hasOrigin ? 'fresh' : 'new',
    originalEdgePct: null, realizedMovePct: null, consumedPct: null,
    remainingToTargetPct: null, netRemainingPct: null, extensionR: null,
    regimeNote: sig.regimeDeteriorated ? 'regime deteriorated since signal' : null,
  };

  // Invalidated by the lifecycle takes precedence — a stopped-out name has no edge to rank.
  if (sig.state === 'failed') return { ...base, freshness: 'invalidated', mult: cfg.REMAIN_FLOOR };

  // No usable geometry (no target, or unpriced) ⇒ UNRATED, neutral. We never manufacture a
  // consumption number we can't ground — mult stays 1 so a lead-only signal is not penalized.
  if (price == null || price <= 0 || firstPrice == null || firstPrice <= 0 || target == null || target <= 0) {
    return { ...base, rated: false, freshness: 'unrated', mult: 1 };
  }

  // Original advertised move (detection → target) and what's been realized since.
  const originalMove = long ? (target - firstPrice) / firstPrice : (firstPrice - target) / firstPrice;
  const realizedMove = long ? (price - firstPrice) / firstPrice : (firstPrice - price) / firstPrice;
  const remainingToTarget = long ? (target - price) / price : (price - target) / price;

  // A degenerate/backwards plan (target the wrong side of detection) can't be rated.
  if (!(originalMove > 0)) return { ...base, rated: false, freshness: 'unrated', mult: 1 };

  const consumed = clamp(realizedMove / originalMove, 0, 1.5);
  const fracLeft = clamp(1 - consumed, 0, 1); // fraction of the advertised move still ahead

  // Extension (pullback) risk: how far price is beyond the planned entry, in R.
  const risk = entry != null && stop != null ? Math.abs(entry - stop) : null;
  const beyondR = (risk && risk > 0 && entry != null)
    ? Math.max(0, (long ? price - entry : entry - price) / risk) : 0;
  const extFactor = clamp(1 - cfg.EXT_K * Math.max(0, beyondR - cfg.EXT_FREE_R), cfg.EXT_FLOOR, 1);

  // Staleness: bars past the horizon's expected hold.
  const holdBars = holdBarsFor(sig.horizon);
  const over = Math.max(0, ageBars - holdBars);
  const decayFactor = clamp(1 - cfg.DECAY_PER_BAR * over, cfg.DECAY_FLOOR, 1);

  // Net further upside if you ENTER NOW, after round-trip cost (display honesty). Cost is a
  // fraction here; `sig.costPct` is the round-trip percent already modelled upstream.
  const costFrac = Number.isFinite(sig.costPct) ? sig.costPct / 100 : 0;
  const netRemaining = remainingToTarget - costFrac;

  // The binding multiplier — consumption × extension × decay, floored. Fresh & un-chased &
  // un-aged ⇒ exactly 1.
  let mult = clamp(fracLeft * extFactor * decayFactor, cfg.REMAIN_FLOOR, 1);
  if (netRemaining <= 0) mult = cfg.REMAIN_FLOOR; // no net edge left to enter on

  const freshness = classify(consumed, netRemaining, cfg);
  return {
    ...base, rated: true, freshness,
    originalEdgePct: +(originalMove * 100).toFixed(2),
    realizedMovePct: +(realizedMove * 100).toFixed(2),
    consumedPct: +(consumed * 100).toFixed(1),
    remainingToTargetPct: +(remainingToTarget * 100).toFixed(2),
    netRemainingPct: +(netRemaining * 100).toFixed(2),
    extensionR: +beyondR.toFixed(2),
    extFactor: +extFactor.toFixed(3), decayFactor: +decayFactor.toFixed(3),
    mult: +mult.toFixed(3),
  };
}

// Consumption class. `late`/`expired` are graded honestly from remaining net edge, so a name
// can be "late" well before the lifecycle's 1R "extended" cliff.
function classify(consumed, netRemaining, cfg) {
  if (netRemaining <= 0) return 'expired';        // no net edge from here
  if (consumed < cfg.FRESH_MAX) return 'fresh';
  if (consumed < cfg.ACTIONABLE_MAX) return 'actionable';
  if (consumed < cfg.PARTIAL_MAX) return 'partially-consumed';
  return 'late';
}

module.exports = { REMAINING_EDGE_VERSION, CONFIG, computeRemainingEdge, classify };
