'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — point-in-time research labels. PURE composition of EXISTING graders
// (no new label semantics invented here):
//   • residual forward returns / MFE / MAE / hit-times → omega-swing
//     residualForward (strictly-after-decision bars via evolve-labels
//     sliceForward; missing benchmark ⇒ residual null, never 0)
//   • cost-aware executable outcome → lib/research/execution executableOutcome
//     (exec-engine-v1: next-session-open entry, commission, size-aware
//     slippage, participation cap)
// An episode window that has not elapsed is PENDING — and an episode that is
// still active at the end of available history is RIGHT_CENSORED, never a
// success or failure. Same-bar highs/lows are never used for fills (the
// delegated engines enforce next-open semantics).
// ═══════════════════════════════════════════════════════════════════════════

const { residualForward } = require('../omega-swing');
const { executableOutcome } = require('../research/execution');
const { VERSIONS } = require('./config');

const LABEL_WINDOWS = Object.freeze([5, 21, 63]);

function barIndexOf(bars, date) {
  for (let i = 0; i < bars.length; i++) if (String(bars[i].date) === String(date)) return i;
  return -1;
}

// exec-engine-v1 consumes panel-shape bars ({ms, open, close}); screener
// candles carry ISO dates. Normalize without mutating the input.
function execBars(candles) {
  return (candles || []).map((b) => ({
    ...b,
    ms: Number.isFinite(b.ms) ? b.ms : Date.parse(`${b.date}T00:00:00Z`),
    open: b.open ?? b.o ?? null,
    close: b.close ?? b.c ?? null,
  }));
}

/**
 * Label one decision (episode start) at the standard windows.
 * candles/spyCandles/sectorCandles: screener-shape daily candles.
 * decisionDate: the signal close date; entry economics assume the NEXT
 * eligible session (exec-engine-v1).
 */
function labelDecision({ candles, spyCandles, sectorCandles = null, decisionDate, adv = null, windows = LABEL_WINDOWS }) {
  const bars = candles || [];
  const decisionIdx = barIndexOf(bars, decisionDate);
  const entry = decisionIdx >= 0 ? bars[decisionIdx].close ?? bars[decisionIdx].c : null;
  const out = { labelVersion: VERSIONS.labels, decisionDate, windows: {}, rightCensored: false };
  if (decisionIdx < 0 || !(entry > 0)) {
    return { ...out, available: false, reason: 'decision-bar-not-found' };
  }
  for (const w of windows) {
    const residual = residualForward({
      candles: bars, predDate: decisionDate, entry, window: w,
      spyCandles: spyCandles || [], sectorCandles: sectorCandles || [],
    });
    const exec = executableOutcome({
      bars: execBars(bars), decisionIdx, horizonSessions: w,
      adv: adv ?? null,
    });
    out.windows[`h${w}`] = { residual, exec };
  }
  const longest = Math.max(...windows);
  const lastResolved = out.windows[`h${longest}`]?.residual;
  out.rightCensored = !!(lastResolved && lastResolved.pending);
  return { ...out, available: true };
}

module.exports = { labelDecision, LABEL_WINDOWS };
