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

const LABEL_VERSION = 'intraday-labels-v1';
const HORIZONS_MIN = Object.freeze([30, 60, 120, 180]);
const UP_MULTS = Object.freeze([0.5, 1.0, 1.5, 2.0]);
const DOWN_MULTS = Object.freeze([0.35, 0.5]);
const COST_BPS = 10;   // conservative round-trip cost haircut

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
// remaining-fraction-of-move metric. Null when there is no forward evidence (do not invent).
function computeLabels({ decisionPrice, decisionAt, atr, sessionBars, prevClose = null, costBps = COST_BPS } = {}) {
  if (!(decisionPrice > 0) || !(atr > 0) || !decisionAt) return null;
  const fwd = forwardBarsAfter(sessionBars, decisionAt);
  if (!fwd.length) return null;

  const horizons = {};
  for (const h of HORIZONS_MIN) horizons[`h${h}`] = excursions(decisionPrice, decisionAt, fwd, h);

  // Barrier grid: each up-multiple raced against each down-multiple over the remaining
  // session. Same-bar straddles resolve to FAILURE inside gradeOutcome (conservative).
  const barriers = {};
  for (const ku of UP_MULTS) {
    for (const kd of DOWN_MULTS) {
      const g = gradeOutcome({ decisionPrice, decisionAt, atr, forwardBars: fwd, kUp: ku, kDown: kd, slippageBps: costBps });
      barriers[`u${ku}_d${kd}`] = g ? {
        outcome: g.barrier, timeToBarrierMin: g.timeToBarrierMin, netReturn: g.netReturn,
      } : null;
    }
  }
  const base = barriers[`u0.5_d0.35`];

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
    costBps,
    horizons,
    barriers,
    netReturn: base ? base.netReturn : null,
    timeToUpBarrierMin: base && base.outcome === 'SUCCESS' ? base.timeToBarrierMin : null,
    remainingMfe: all.mfe, remainingMae: all.mae,
    remainingFractionOfDayMove,
    forwardBars: fwd.length,
  };
}

module.exports = { LABEL_VERSION, HORIZONS_MIN, UP_MULTS, DOWN_MULTS, COST_BPS, computeLabels, excursions };
