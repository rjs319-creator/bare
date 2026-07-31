'use strict';
// RUNNER / DUD RESEARCH SCORES — two INDEPENDENT deterministic evidence scores for a
// current-session Day Trade candidate:
//   • runnerScore (0–100): continuation evidence — is the rise supported (trigger, VWAP,
//     participation, residual strength, structure, remaining reward:risk)?
//   • dudScore (0–100): failure evidence — is the setup deteriorating (VWAP losses, failed
//     breakout, fading volume, lower highs, stop breach, extension, stale data)?
//
// HONESTY CONTRACT. These are DETERMINISTIC RESEARCH SCORES for ordering and explanation —
// NOT calibrated probabilities. The app's own research found no confirmed tradeable intraday
// edge after overfitting controls, so no output here may use probability language until a
// learned model passes the pre-registered promotion gate (lib/promotion-gate + op=survival
// walk-forward on accrued graded episodes). The learned-model path already exists:
// lib/survival-model (L2 logistic) + lib/walk-forward + lib/survival-metrics train/evaluate
// on the SAME graded episodes these scores are captured into — a promoted model would slot
// in via `activeModel()` below without changing callers.
//
// Pure: feature fields in → scores + reason-coded drivers out. Missing evidence contributes
// NOTHING (never treated as favorable); a candidate with no intraday features gets null
// scores, not fabricated ones.

// v2: momAccel and volAccel now actually REACH the scorer (they were computed upstream but
// dropped before scoring in v1 — the schema-drift defect). Rules otherwise unchanged.
const VERSION = 'runner-dud-deterministic-v2';
const SCORE_BASIS = 'deterministic research score (uncalibrated — not a probability)';

// Grading horizons (minutes) for the triple-barrier outcomes these scores are judged
// against. Kept here so capture, grading and any future model share one definition.
const HORIZONS_MIN = [30, 60, 120];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Continuation evidence. `c` is the canonical card / ev-metric surface (all fields optional).
function runnerScore(c) {
  if (c == null || (c.currentVwap == null && c.mom15 == null && c.triggerConfirmed == null)) return null;   // no intraday evidence at all
  let s = 30;   // neutral prior — evidence moves it, absence doesn't
  const why = [];
  const add = (pts, label) => { s += pts; why.push({ pts, label }); };
  if (c.triggerConfirmed === true) add(15, 'trigger confirmed above the opening range');
  if (c.aboveVwap === true) add(10, 'holding above VWAP');
  if (c.mom15 != null && c.mom15 > 0) add(clamp(Math.round(c.mom15 * 400), 2, 10), '15-min momentum positive');
  if (c.momAccel != null && c.momAccel > 0) add(8, 'momentum accelerating');
  if (c.residualVsSpy != null && c.residualVsSpy > 0) add(clamp(Math.round(c.residualVsSpy * 6), 2, 12), `outpacing SPY (+${c.residualVsSpy}%)`);
  if (c.timeOfDayRelVol != null && c.timeOfDayRelVol >= 3) add(18, `${c.timeOfDayRelVol}× time-of-day volume`);
  else if (c.timeOfDayRelVol != null && c.timeOfDayRelVol >= 1.5) add(12, `${c.timeOfDayRelVol}× time-of-day volume`);
  if (c.volAccel != null && c.volAccel >= 1.5) add(6, `volume accelerating (${c.volAccel}×)`);
  if (c.barsSinceHigh != null && c.barsSinceHigh <= 2) add(8, 'pressing the high of day');
  if (c.remainingRR != null && c.remainingRR >= 1.5) add(10, `remaining R:R ${c.remainingRR}`);
  if (c.extensionAtr != null && c.extensionAtr > 2) add(-15, `${c.extensionAtr} ATR extended above VWAP (chase risk)`);
  if (c.lowerHighs != null && c.lowerHighs >= 1) add(-8 * c.lowerHighs, 'printing lower highs');
  if (c.volumeFading === true) add(-8, 'volume fading');
  return { score: clamp(Math.round(s), 0, 100), drivers: why };
}

// Failure evidence — measured INDEPENDENTLY (not 100 − runner): a name can score high on
// both (strong move deteriorating) or low on both (nothing happening).
function dudScore(c) {
  if (c == null || (c.currentVwap == null && c.mom15 == null && c.stopBreached == null)) return null;
  let s = 10;
  const why = [];
  const add = (pts, label) => { s += pts; why.push({ pts, label }); };
  if (c.stopBreached === true) add(30, 'stop breached');
  if (c.breakoutFailed === true) add(30, 'broke out then failed back below the range midpoint');
  const vlosses = c.closesBelowVwap ?? c.closesBelowVwapStreak ?? 0;
  if (vlosses >= 1) add(15 * Math.min(vlosses, 3), `${vlosses} close(s) below VWAP`);
  if (c.mom15 != null && c.mom15 < 0) add(10, '15-min momentum negative');
  if (c.momAccel != null && c.momAccel < 0) add(6, 'momentum decelerating');
  if (c.residualVsSpy != null && c.residualVsSpy < 0) add(10, `trailing SPY (${c.residualVsSpy}%)`);
  if (c.volumeFading === true) add(10, 'volume fading');
  if (c.lowerHighs != null && c.lowerHighs >= 1) add(8 * Math.min(c.lowerHighs, 3), 'lower highs');
  if (c.barsSinceHigh != null && c.barsSinceHigh > 6) add(10, `${c.barsSinceHigh} bars since the high`);
  if (c.extensionAtr != null && c.extensionAtr > 2.5) add(10, 'blow-off extension');
  if (c.remainingRR != null && c.remainingRR < 1) add(10, `remaining R:R only ${c.remainingRR}`);
  if (c.currentSessionFresh === false) add(20, 'live evidence stale or contradictory');
  return { score: clamp(Math.round(s), 0, 100), drivers: why };
}

// Score a canonical card. Returns the fields buildCanonicalCard spreads onto the card.
function scoreCard(c) {
  const r = runnerScore(c);
  const d = dudScore(c);
  return {
    runnerScore: r ? r.score : null,
    dudScore: d ? d.score : null,
    runnerDrivers: r ? r.drivers : null,
    dudDrivers: d ? d.drivers : null,
    scoreBasis: (r || d) ? SCORE_BASIS : null,
    scoreVersion: (r || d) ? VERSION : null,
  };
}

// The active scoring model. Deterministic baseline until a learned challenger passes the
// pre-registered promotion gate (lib/promotion-gate) on out-of-sample graded episodes.
function activeModel() {
  return { version: VERSION, kind: 'deterministic-baseline', calibrated: false, promotionGate: 'not-passed' };
}

module.exports = { runnerScore, dudScore, scoreCard, activeModel, VERSION, SCORE_BASIS, HORIZONS_MIN };
