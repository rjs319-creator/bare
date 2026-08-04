'use strict';
// VERSIONED SAME-DAY TARGETS — the label side of the point-in-time training dataset.
//
// Every target uses bars STRICTLY AFTER the decision timestamp (delegated to
// lib/outcome-grade's forwardBarsAfter / gradeOutcome, which already enforce the
// strictly-after rule and resolve same-bar barrier straddles CONSERVATIVELY to FAILURE).
// This module widens that primitive into the full same-day target set:
//   • MFE / MAE over 30/60/120/180-minute horizons
//   • barrier outcomes for +0.5/+1.0/+1.5/+2.0 ATR before −0.35/−0.5 ATR
//   • time to the upside barrier
//   • net return after conservative costs (base barrier pair)
//   • REMAINING move from detection — and, when prevClose is supplied, the fraction of the
//     day's total move that was still ahead at the decision (the lead-time honesty metric)
//
// These are intentionally NOT the 3-session pcarry target: pcarry remains a separately
// labeled multi-session fade context and is never the intraday training label.
//
// Pure: decision + forward bars in → labels out. No storage, no clock, no fabrication —
// insufficient forward data yields null labels, never invented ones.

const { gradeOutcome, forwardBarsAfter } = require('./outcome-grade');

// v2 (2026-08-03): EXECUTION-AWARE, POLICY-CONSISTENT, TIER-COSTED.
//   • Entry realism: barrier labels grade from the first EXECUTABLE price (next forward bar
//     open per daytrade-policy-v1's fill rule), never the unfillable signal price. The old
//     signal-price grade is kept as a labeled diagnostic (`signalBasis`).
//   • Competing-risk horizons: the +0.75 ATR multiple joins the grid, and each up-multiple
//     is additionally raced with a REAL 30/60/120-minute bar-close timeout (gradeOutcome's
//     horizonMin), not just the session-end timeout.
//   • Costs: the flat 10 bp haircut is replaced by the tiered lib/intraday-costs model
//     (liquidity/price/volatility/time-of-day aware, modeled-vs-observed labeled, with
//     base/adverse/severe scenarios). Missing inputs assume the CONSERVATIVE tier.
//   • `policyLabel` grades the ACTUAL live policy trade (stop 1.5×ATR, target 2R, 120-min
//     time stop — daytrade-policy-v1), so training/evaluation and the live plan finally
//     describe the same trade.
// Old v1 rows are versioned out by the fail-closed label-version join in training.
const LABEL_VERSION = 'intraday-labels-v2';
const HORIZONS_MIN = Object.freeze([30, 60, 120, 180]);
const UP_MULTS = Object.freeze([0.5, 0.75, 1.0, 1.5, 2.0]);
const DOWN_MULTS = Object.freeze([0.35, 0.5]);
const TIMEOUT_HORIZONS_MIN = Object.freeze([30, 60, 120]);   // competing-risk bar-close timeouts
const COST_BPS = 10;   // legacy flat haircut — kept ONLY as the last-resort fallback

// MFE/MAE (fractions vs decision price) within a horizon, strictly-after bars only.
function excursions(decisionPrice, decisionAt, bars, horizonMin) {
  const cutoff = Date.parse(decisionAt) + horizonMin * 60000;
  const w = bars.filter(b => Date.parse(b.t) <= cutoff);
  if (!w.length || !(decisionPrice > 0)) return { mfe: null, mae: null, bars: 0 };
  let hi = -Infinity, lo = Infinity;
  for (const b of w) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
  return {
    mfe: +((hi - decisionPrice) / decisionPrice).toFixed(5),
    mae: +((lo - decisionPrice) / decisionPrice).toFixed(5),
    bars: w.length,
  };
}

// Full same-day label set for one decision. `sessionBars` may include the decision bar —
// forwardBarsAfter drops everything at/before decisionAt. `prevClose` (optional) enables the
// remaining-fraction-of-move metric. `costContext` supplies the tiered-cost inputs
// ({ avgDollarVol, price, atrPct, sessionBucket }); absent inputs fall to the CONSERVATIVE
// tier inside the cost model. Null when there is no forward evidence (do not invent).
function computeLabels({ decisionPrice, decisionAt, atr, sessionBars, prevClose = null, costBps = null, costContext = null } = {}) {
  if (!(decisionPrice > 0) || !(atr > 0) || !decisionAt) return null;
  const fwd = forwardBarsAfter(sessionBars, decisionAt);
  if (!fwd.length) return null;

  // Tiered round-trip cost (bps). An explicit costBps override (tests/legacy) wins;
  // otherwise the versioned model prices this row's own liquidity/volatility/time-of-day.
  const { estimateIntradayCost } = require('./intraday-costs');
  const cost = estimateIntradayCost({
    avgDollarVol: costContext ? costContext.avgDollarVol : null,
    price: decisionPrice,
    atrPct: decisionPrice > 0 ? atr / decisionPrice : null,
    sessionBucket: costContext ? costContext.sessionBucket : null,
  });
  const effCostBps = Number.isFinite(costBps) ? costBps : cost.roundTripBps;

  // EXECUTION-AWARE ENTRY (daytrade-policy-v1 fill rule): the first forward bar's open is
  // the earliest realistically executable price. `filled:false` (gap beyond policy, or no
  // bar) yields a SKIPPED policy trade — never a fabricated fill.
  const { executableEntry, policyBarriers, POLICY_VERSION } = require('./daytrade-decision-policy');
  const exec = executableEntry({ decisionPrice, decisionAt, atr, forwardBars: fwd });

  const horizons = {};
  for (const h of HORIZONS_MIN) horizons[`h${h}`] = excursions(decisionPrice, decisionAt, fwd, h);

  // Barrier grid — EXECUTABLE-entry basis. Each up-multiple raced against each down-multiple
  // over the remaining session, plus REAL 30/60/120-minute bar-close timeouts against the
  // primary −0.5 ATR stop (the competing-risk grid). Same-bar straddles resolve to FAILURE
  // inside gradeOutcome (conservative). Null cells when the entry was not fillable.
  const entryPrice = exec.filled ? exec.price : null;
  const entryAt = exec.filled ? exec.at : null;
  const gradeCell = g => g ? { outcome: g.barrier, timeToBarrierMin: g.timeToBarrierMin, netReturn: g.netReturn } : null;
  const barriers = {};
  for (const ku of UP_MULTS) {
    for (const kd of DOWN_MULTS) {
      barriers[`u${ku}_d${kd}`] = entryPrice
        ? gradeCell(gradeOutcome({ decisionPrice: entryPrice, decisionAt: entryAt, atr, forwardBars: fwd, kUp: ku, kDown: kd, slippageBps: effCostBps }))
        : null;
    }
    for (const h of TIMEOUT_HORIZONS_MIN) {
      barriers[`u${ku}_d0.5_h${h}`] = entryPrice
        ? gradeCell(gradeOutcome({ decisionPrice: entryPrice, decisionAt: entryAt, atr, forwardBars: fwd, kUp: ku, kDown: 0.5, slippageBps: effCostBps, horizonMin: h }))
        : null;
    }
  }
  const base = barriers[`u0.5_d0.35`];

  // Diagnostic ONLY: the old signal-price grade of the base pair, so v1-era comparisons
  // remain possible. Never the training target.
  const signalBasis = gradeCell(gradeOutcome({ decisionPrice, decisionAt, atr, forwardBars: fwd, kUp: 0.5, kDown: 0.35, slippageBps: effCostBps }));

  // POLICY LABEL — the trade the live system actually holds out (daytrade-policy-v1: stop
  // 1.5×ATR, target 2R ⇒ kUp = 3.0×ATR, 120-minute time stop), from the executable entry,
  // costed under base AND adverse scenarios. This is what policy-level evaluation and the
  // promotion gate consume.
  const pb = policyBarriers();
  const policyGrade = entryPrice
    ? gradeOutcome({ decisionPrice: entryPrice, decisionAt: entryAt, atr, forwardBars: fwd, kUp: pb.kUp, kDown: pb.kDown, slippageBps: effCostBps, horizonMin: pb.horizonMin })
    : null;
  const policyGradeAdverse = entryPrice
    ? gradeOutcome({ decisionPrice: entryPrice, decisionAt: entryAt, atr, forwardBars: fwd, kUp: pb.kUp, kDown: pb.kDown, slippageBps: cost.scenarios.adverse, horizonMin: pb.horizonMin })
    : null;
  const policyLabel = {
    policyVersion: POLICY_VERSION,
    filled: exec.filled, unfillableReason: exec.filled ? null : exec.reason, entryGapAtr: exec.gapAtr,
    entryPrice, entryAt,
    outcome: policyGrade ? policyGrade.barrier : null,
    netReturn: policyGrade ? policyGrade.netReturn : null,
    netReturnAdverse: policyGradeAdverse ? policyGradeAdverse.netReturn : null,
    timeToBarrierMin: policyGrade ? policyGrade.timeToBarrierMin : null,
  };

  // Remaining move from detection (full remaining session), and the fraction of the day's
  // TOTAL move still ahead at decision time. A detector that fires after 80% of the move is
  // complete scores near 0 here no matter how "right" the direction was.
  const all = excursions(decisionPrice, decisionAt, fwd, 24 * 60);
  let remainingFractionOfDayMove = null;
  if (prevClose > 0 && all.mfe != null) {
    let dayHigh = -Infinity;
    for (const b of sessionBars || []) if (b.h > dayHigh) dayHigh = b.h;
    const totalMove = dayHigh - prevClose;
    if (totalMove > 0) remainingFractionOfDayMove = +(Math.max(0, Math.min(1, (decisionPrice * (1 + all.mfe) - decisionPrice) / totalMove))).toFixed(3);
  }

  return {
    labelVersion: LABEL_VERSION,
    decisionAt, decisionPrice: +decisionPrice.toFixed(4), atr: +atr.toFixed(4),
    // Cost provenance: the tiered model's verdict for this row (+ scenarios), and the
    // effective bps actually applied to the grades.
    costBps: effCostBps,
    costModel: { version: cost.version, tier: cost.tier, basis: cost.basis, roundTripBps: cost.roundTripBps, scenarios: cost.scenarios },
    horizons,
    barriers,
    signalBasis,
    policyLabel,
    netReturn: base ? base.netReturn : null,
    timeToUpBarrierMin: base && base.outcome === 'SUCCESS' ? base.timeToBarrierMin : null,
    remainingMfe: all.mfe, remainingMae: all.mae,
    remainingFractionOfDayMove,
    forwardBars: fwd.length,
  };
}

module.exports = { LABEL_VERSION, HORIZONS_MIN, UP_MULTS, DOWN_MULTS, TIMEOUT_HORIZONS_MIN, COST_BPS, computeLabels, excursions };
