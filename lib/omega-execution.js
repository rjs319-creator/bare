'use strict';
// OMEGA-SWING EXECUTION — Phase 3. Turns OMEGA's entry-timing INTENT (BUY_NOW / breakout /
// pullback / wait) into an honest, executable plan against the canonical execution-policy
// (lib/execution-policy.js) and cost model (lib/costs.js). ONE shared entry model — OMEGA no
// longer credits the un-tradeable signal-day close.
//
// WHY THIS EXISTS: a signal computed from day-T's CLOSE cannot be filled at that close. The
// earliest tradeable price is day T+1's open (or a conditional trigger touched on T+1). This
// module makes that explicit: it separates the SIGNAL reference price (T close) from the
// ASSUMED FILL (T+1), models the opening gap, rejects fills that gap through the point of
// positive utility, and recomputes reward/risk AT THE FILL — not at the signal close.
//
// Live vs backfill: LIVE (op=omega) has no next-session bar yet, so this returns the PLAN
// (executable state + trigger + max acceptable price/gap) with fillStatus 'pending' — a plan,
// never a fabricated fill. BACKFILL/replay passes the full candle series, so planFill resolves
// the real T+1 fill (or an honest no-fill). Pure & deterministic — no network, no clock.

const EP = require('./execution-policy');
const { TIERS } = require('./costs');

const OMEGA_EXECUTION_VERSION = 'omega-exec-v1';

// Executable states shown to the trader (replace a bare "Buy now"). These describe WHAT the
// trader should do next session, not a claim that a fill happened.
const EXECUTABLE_STATES = Object.freeze({
  ELIGIBLE_NEXT_OPEN: 'ELIGIBLE_NEXT_OPEN',   // market entry at next open (within gap tolerance)
  BUY_ABOVE: 'BUY_ABOVE',                     // stop-entry: only if it trades above the trigger
  BUY_ON_PULLBACK: 'BUY_ON_PULLBACK',         // limit-entry: only on a pullback into the zone
  WAIT_CONFIRMATION: 'WAIT_CONFIRMATION',     // wait for a confirming close, then next open
  GAP_TOO_LARGE_SKIP: 'GAP_TOO_LARGE_SKIP',   // opening gap destroys the entry — skip
  NO_POSITIVE_UTILITY: 'NO_POSITIVE_UTILITY', // fill is past the point of positive utility
  FILLED: 'FILLED',                           // backfill: order filled
  NO_FILL: 'NO_FILL',                         // backfill: conditional trigger never met
  AVOID: 'AVOID',                             // not a candidate
});

// OMEGA entry classification → execution policy + which state it plans to.
const ENTRY_TO_POLICY = Object.freeze({
  BUY_NOW: { policy: EP.POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, planState: EXECUTABLE_STATES.ELIGIBLE_NEXT_OPEN },
  BUY_ON_BREAKOUT: { policy: EP.POLICIES.BREAKOUT_STOP, planState: EXECUTABLE_STATES.BUY_ABOVE },
  BUY_ON_FIRST_PULLBACK: { policy: EP.POLICIES.PULLBACK_LIMIT, planState: EXECUTABLE_STATES.BUY_ON_PULLBACK },
  WAIT_FOR_CLOSE_CONFIRMATION: { policy: EP.POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, planState: EXECUTABLE_STATES.WAIT_CONFIRMATION },
  WATCH: { policy: null, planState: EXECUTABLE_STATES.AVOID },
  SKIP: { policy: null, planState: EXECUTABLE_STATES.AVOID },
});

// Default maximum acceptable opening gap (fraction of the signal close). A larger gap means the
// edge the signal measured has already been given away overnight — chasing it destroys the R:R.
const DEFAULT_MAX_GAP_PCT = 0.04;
// Cap the max-acceptable ENTRY price above the signal close: beyond this the reward/risk the
// plan was built on no longer holds. ATR-scaled, floored/capped for sanity.
function maxAcceptableEntry(signalRef, atrPct, { maxGapPct = DEFAULT_MAX_GAP_PCT } = {}) {
  if (!(signalRef > 0)) return null;
  const gapRoom = Math.min(maxGapPct, Math.max(0.015, (atrPct || 0.03) * 1.0)); // ≤ maxGap, ≥1.5%
  return +(signalRef * (1 + gapRoom)).toFixed(2);
}

// The stop-entry / limit trigger for the conditional policies, from the swing levels.
//   breakout  → the pivot to reclaim (recent high just above); default: signalRef * 1.005
//   pullback  → the limit to buy into (support just below); default: signalRef * 0.985
function triggerFor(entryClass, signalRef, f, levels) {
  if (entryClass === 'BUY_ON_BREAKOUT') {
    const pivot = levels && levels.resistance > signalRef ? levels.resistance
      : (f && f.distFrom20High != null ? +(signalRef / (1 + f.distFrom20High)).toFixed(2) : null);
    return pivot && pivot > signalRef ? pivot : +(signalRef * 1.005).toFixed(2);
  }
  if (entryClass === 'BUY_ON_FIRST_PULLBACK') {
    const support = levels && levels.support > 0 && levels.support < signalRef ? levels.support : null;
    return support || +(signalRef * 0.985).toFixed(2);
  }
  return null;
}

const finite = (x) => Number.isFinite(x);

// Plan the OMEGA entry. Returns an explicit record separating signal price from fill.
//
//   candles     : oldest→newest daily candles (>= the signal bar; +1 more resolves a real fill)
//   signalDate  : ISO date of the signal bar (features from its close)
//   entryClass  : OMEGA entryTiming().classification
//   f           : OMEGA feature object (for atrPct)
//   levels      : { stop, resistance, support } swing levels (optional)
//   stop,target1,target2 : the published plan levels (for R:R-at-fill)
//   tier        : liquidity tier (costs.js) — 'liquid'|'small'|'micro'|'biotech'
//   maxGapPct   : override the max acceptable opening gap
function planOmegaEntry({ candles, signalDate, entryClass, f = {}, levels = null, stop = null, target1 = null, target2 = null, tier = 'liquid', side = 'long', maxGapPct = DEFAULT_MAX_GAP_PCT } = {}) {
  const map = ENTRY_TO_POLICY[entryClass] || ENTRY_TO_POLICY.WATCH;
  const sigIdx = EP.signalBarIndex(candles || [], signalDate);
  const signalRef = (sigIdx >= 0 && candles[sigIdx] && finite(candles[sigIdx].close)) ? +candles[sigIdx].close.toFixed(4) : null;
  const atrPct = f && finite(f.atrPct) ? f.atrPct / 100 : 0.03;
  const maxEntry = maxAcceptableEntry(signalRef, atrPct, { maxGapPct });
  const trigger = signalRef ? triggerFor(entryClass, signalRef, f, levels) : null;

  const base = {
    version: OMEGA_EXECUTION_VERSION,
    entryClass, side,
    executableState: map.planState,
    policy: map.policy,
    trigger,
    signalReferencePrice: signalRef,
    maxAcceptableEntryPrice: maxEntry,
    maxAcceptableGapPct: +maxGapPct.toFixed(3),
    // fill fields — null/pending in live, resolved in backfill
    fillStatus: 'pending', assumedFillPrice: null, assumedFillDate: null, noFillReason: null,
    openingGapPct: null, gapTooLarge: false, rrAtFill: null, exceededMaxEntry: false,
  };

  // Not a tradeable candidate.
  if (!map.policy || !signalRef) {
    return { ...base, executableState: EXECUTABLE_STATES.AVOID, fillStatus: 'unfilled', noFillReason: signalRef ? 'no-trade-state' : 'no-signal-bar' };
  }

  // Resolve a real fill only when the next session exists (backfill/replay). In LIVE the next
  // bar is absent → keep the PLAN with fillStatus 'pending' (honest: a plan, not a fill).
  const hasNext = Array.isArray(candles) && candles[sigIdx + 1];
  if (!hasNext) return base;

  const fill = EP.planFill(candles, signalDate, { policy: map.policy, side, tier, trigger });
  if (!fill.filled) {
    return { ...base, executableState: EXECUTABLE_STATES.NO_FILL, fillStatus: 'unfilled', noFillReason: fill.fillReason, assumedFillDate: fill.earliestFillDate || null };
  }

  const openingGapPct = +(((fill.referencePrice ?? fill.fillPrice) - signalRef) / signalRef).toFixed(4);
  const gapTooLarge = side === 'long' ? openingGapPct > maxGapPct : openingGapPct < -maxGapPct;
  const exceededMaxEntry = maxEntry != null && side === 'long' && fill.fillPrice > maxEntry;

  // Reward/risk recomputed AT THE FILL (not the signal close). A gap that eats the R:R is the
  // point of the exercise — a signal that looked 3R at the close can be 1R after a 3% gap up.
  let rrAtFill = null;
  if (finite(stop) && finite(target1) && stop < fill.fillPrice && target1 > fill.fillPrice) {
    rrAtFill = +((target1 - fill.fillPrice) / (fill.fillPrice - stop)).toFixed(2);
  }

  let state = EXECUTABLE_STATES.FILLED;
  if (gapTooLarge) state = EXECUTABLE_STATES.GAP_TOO_LARGE_SKIP;
  else if (exceededMaxEntry) state = EXECUTABLE_STATES.NO_POSITIVE_UTILITY;

  return {
    ...base,
    executableState: state,
    fillStatus: (gapTooLarge || exceededMaxEntry) ? 'unfilled' : 'filled',
    assumedFillPrice: fill.fillPrice,
    assumedFillDate: fill.earliestFillDate,
    noFillReason: gapTooLarge ? 'opening-gap-too-large' : exceededMaxEntry ? 'past-max-acceptable-entry' : null,
    openingGapPct, gapTooLarge, exceededMaxEntry, rrAtFill,
    slippagePct: fill.slippagePct, spreadPct: fill.spreadPct, fillReason: fill.fillReason,
  };
}

// Liquidity tier from a dollar-volume ADV (mirrors the cost model's buckets).
function tierForDollarVol(dollarVol) {
  if (!finite(dollarVol)) return 'liquid';
  if (dollarVol < 3e6) return 'micro';
  if (dollarVol < 2e7) return 'small';
  return 'liquid';
}

module.exports = {
  OMEGA_EXECUTION_VERSION, EXECUTABLE_STATES, ENTRY_TO_POLICY, DEFAULT_MAX_GAP_PCT,
  planOmegaEntry, maxAcceptableEntry, triggerFor, tierForDollarVol,
};
