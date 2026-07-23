'use strict';
// FORWARD-OUTCOME GRADING — leakage-safe triple-barrier labels from POST-DECISION bars only.
//
// Given a decision (price + timestamp + volatility scale) and the intraday bars that came
// AFTER it, compute which barrier was reached first, the max favorable/adverse excursion, the
// time-to-barrier, and slippage-aware returns. The one rule that matters: the label may use
// ONLY bars strictly after the decision timestamp — never the decision bar, never a daily
// close, never any later-known aggregate. That is what keeps the training label honest.
//
// Barriers are VOLATILITY-SCALED (ATR multiples), so a quiet large-cap and a jumpy small-cap
// are judged on their own scale rather than one fixed percentage. Pure: bars in → label out.

const DEFAULTS = Object.freeze({
  kUp: 0.5,          // success barrier: +0.50 ATR from the decision price
  kDown: 0.35,       // failure barrier: -0.35 ATR from the decision price
  slippageBps: 10,   // round-trip slippage/cost estimate applied to the realized return
});

// Keep only the bars strictly AFTER the decision timestamp — the leakage guard.
function forwardBarsAfter(sessionBars, decisionAt) {
  const dMs = Date.parse(decisionAt);
  return (sessionBars || []).filter(b => Date.parse(b.t) > dMs);
}

// Grade one decision. `forwardBars` MUST already be post-decision (use forwardBarsAfter).
// Returns null when there is no forward evidence yet (nothing to grade — do not invent one).
function gradeOutcome({ decisionPrice, decisionAt, atr, forwardBars, kUp = DEFAULTS.kUp, kDown = DEFAULTS.kDown, slippageBps = DEFAULTS.slippageBps } = {}) {
  if (!(decisionPrice > 0) || !(atr > 0) || !Array.isArray(forwardBars) || forwardBars.length === 0) return null;

  const upBarrier = decisionPrice + kUp * atr;
  const downBarrier = decisionPrice - kDown * atr;

  let maxHigh = -Infinity, minLow = Infinity;
  let barrier = 'TIMEOUT', barrierAt = null, barrierBar = null;
  for (const b of forwardBars) {
    if (b.h > maxHigh) maxHigh = b.h;
    if (b.l < minLow) minLow = b.l;
    if (barrier === 'TIMEOUT') {
      const hitUp = b.h >= upBarrier;
      const hitDown = b.l <= downBarrier;
      // A single bar can straddle both barriers; intrabar order is unknown, so resolve
      // CONSERVATIVELY to FAILURE (never optimistically claim the win came first).
      if (hitUp && hitDown) { barrier = 'FAILURE'; barrierAt = b.t; barrierBar = b; }
      else if (hitDown) { barrier = 'FAILURE'; barrierAt = b.t; barrierBar = b; }
      else if (hitUp) { barrier = 'SUCCESS'; barrierAt = b.t; barrierBar = b; }
    }
  }

  const lastClose = forwardBars[forwardBars.length - 1].c;
  const mfe = +((maxHigh - decisionPrice) / decisionPrice).toFixed(5);
  const mae = +((minLow - decisionPrice) / decisionPrice).toFixed(5);
  const closeReturn = +((lastClose - decisionPrice) / decisionPrice).toFixed(5);

  // Realized return of the triple-barrier trade: the barrier level if one was hit, else the
  // forward close (timeout). Then a slippage/cost haircut for an honest net figure.
  const grossReturn = barrier === 'SUCCESS' ? (kUp * atr) / decisionPrice
    : barrier === 'FAILURE' ? -(kDown * atr) / decisionPrice
      : closeReturn;
  const slipFrac = slippageBps / 1e4;
  const netReturn = +(grossReturn - slipFrac).toFixed(5);
  const timeToBarrierMin = barrierAt ? Math.round((Date.parse(barrierAt) - Date.parse(decisionAt)) / 60000) : null;

  return {
    barrier,                                  // 'SUCCESS' | 'FAILURE' | 'TIMEOUT'
    mfe, mae, closeReturn,
    grossReturn: +grossReturn.toFixed(5),
    netReturn,                                // slippage-aware
    timeToBarrierMin,
    barrierAt,
    upBarrier: +upBarrier.toFixed(4),
    downBarrier: +downBarrier.toFixed(4),
    barsAfter: forwardBars.length,
  };
}

module.exports = { DEFAULTS, forwardBarsAfter, gradeOutcome };
