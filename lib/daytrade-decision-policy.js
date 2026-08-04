'use strict';
// CANONICAL DAY-TRADE DECISION POLICY (daytrade-policy-v1) — the ONE versioned contract
// shared by live decisions, replay/backtests, label creation, shadow grading and the UI.
//
// WHY THIS EXISTS. Before this module, three disconnected policy fragments coexisted: the
// live plan (1.5×ATR stop / 2R target / 120-min expiry in daytrade-config), the label
// barrier grid (±0.5/0.35 ATR, no time stop), and the training target (+1.0/−0.5 ATR) —
// so the model was trained on a trade nobody executes, at the unfillable signal price.
// Every consumer now derives its numbers from THIS object, and every artifact stamps
// `policyVersion` so a change is a visible migration, not silent drift.
//
// Pure constants + pure helpers. No storage, no clock, no network.

const CFG = require('./daytrade-config');
const { COST_MODEL_VERSION } = require('./intraday-costs');

const POLICY_VERSION = 'daytrade-policy-v1';

const DECISION_POLICY = Object.freeze({
  version: POLICY_VERSION,
  // Evidence + timing contract.
  evidence: Object.freeze({
    completedBarsOnly: true,              // confirmations use completed 5-min bars only
    barIntervalMin: 5,
    quoteMaxAgeMs: CFG.FRESHNESS.QUOTE_MAX_AGE_MS,
  }),
  // Trigger + entry contract.
  entry: Object.freeze({
    trigger: 'opening-range-high (30-min, completed bars)',
    orderType: 'stop-breakout',           // buy-stop through the trigger — enters INTO momentum
    // The earliest EXECUTABLE entry for replay/labels: the first forward bar's open strictly
    // after the decision instant. The signal price at detection is NOT assumed fillable.
    fillRule: 'next-bar-open',
    // Gap/skip rule: if the first executable price gaps more than this many ATRs past the
    // intended entry, the replayed trade is SKIPPED (chasing a gap is a different trade).
    maxEntryGapAtr: 0.75,
    noFillBehavior: 'skip-episode',       // never fabricate a fill that was not achievable
  }),
  // Exit contract (must match CFG.LIVE_PLAN — asserted by tests).
  exits: Object.freeze({
    stopAtrMult: CFG.LIVE_PLAN.STOP_ATR_MULT,      // stop = entry − 1.5×ATR (floored under OR low live)
    targetRR: CFG.LIVE_PLAN.TARGET_RR,             // target = entry + 2×risk
    timeStopMin: CFG.LIVE_PLAN.EXPIRES_MIN,        // 120-minute time stop
    sessionClose: true,                            // everything closes by the session end
  }),
  // Sizing + capacity contract (documentation-level unit for cost/impact math; there is no
  // live order routing in this system).
  sizing: Object.freeze({
    notionalUsd: require('./intraday-costs').DEFAULT_NOTIONAL_USD,
    maxConcurrentPositions: 5,
    onePositionPerTickerPerDay: true,             // one statistical episode per setup/ticker/day
  }),
  // Costs contract.
  costs: Object.freeze({ model: COST_MODEL_VERSION, promotionScenario: 'adverse' }),
});

// Policy-consistent barrier parameters for replay/labels, in gradeOutcome terms:
// risk = stopAtrMult×ATR; target = targetRR×risk ⇒ kDown = stopAtrMult, kUp = targetRR×stopAtrMult.
function policyBarriers() {
  const kDown = DECISION_POLICY.exits.stopAtrMult;
  return { kUp: +(DECISION_POLICY.exits.targetRR * kDown).toFixed(4), kDown, horizonMin: DECISION_POLICY.exits.timeStopMin };
}

// The first EXECUTABLE entry for a decision, per the fill rule. Returns
// { price, at, gapAtr, filled, reason } — `filled:false` (with a reason) when no forward bar
// exists or the entry gapped beyond the policy bound. Never fabricates a fill.
function executableEntry({ decisionPrice, decisionAt, atr, forwardBars }) {
  const first = (forwardBars || [])[0];
  if (!first || !(first.o > 0)) return { filled: false, reason: 'no-forward-bar', price: null, at: null, gapAtr: null };
  const gapAtr = (Number.isFinite(decisionPrice) && atr > 0) ? +((first.o - decisionPrice) / atr).toFixed(3) : null;
  if (gapAtr != null && gapAtr > DECISION_POLICY.entry.maxEntryGapAtr) {
    return { filled: false, reason: 'gap-beyond-policy', price: +first.o.toFixed(4), at: first.t, gapAtr };
  }
  return { filled: true, reason: null, price: +first.o.toFixed(4), at: first.t, gapAtr };
}

module.exports = { POLICY_VERSION, DECISION_POLICY, policyBarriers, executableEntry };
