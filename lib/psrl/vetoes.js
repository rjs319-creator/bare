'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL addendum — independent failure vetoes + per-horizon opportunity value.
// PURE, deterministic, reason-coded.
//
// Stage-3 rule (explicit, addendum §8): a high continuation score must NOT
// erase a high independent failure signal. Any veto ≥ VETO_GATE caps the
// entry state (never better than WATCH) and haircuts the rank score by
// (1 − 0.5·maxVeto). Veto scores are 0..1 evidence intensities, not
// probabilities; every economic quantity is BASELINE_UNCALIBRATED.
// ═══════════════════════════════════════════════════════════════════════════

const VETO_VERSION = 'psrl-vetoes-v1';
const VETO_GATE = 0.7;

const isNum = (x) => Number.isFinite(x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function veto(score, reasons) {
  return { score: clamp01(score), reasons, triggered: clamp01(score) >= VETO_GATE };
}

/** Stagnation: no highs, fading pace, narrow dead range — vs constructive pause. */
function stagnationVeto(card) {
  const reasons = [];
  let s = 0;
  const path = card.absPath || {};
  const post = path.post || {};
  if (path.state === 'JUMP_PLATEAU') { s += 0.45; reasons.push('JUMP_PLATEAU_STATE'); }
  if (isNum(post.daysSinceHigh) && post.daysSinceHigh > 15) { s += 0.2; reasons.push('NO_RECENT_HIGH'); }
  if (isNum(card.residual?.residualAccel) && card.residual.residualAccel < -0.0015) { s += 0.2; reasons.push('RESIDUAL_SLOPE_DECAY'); }
  if (isNum(card.participation) && card.participation < 0.3) { s += 0.15; reasons.push('WEAKENING_VOLUME'); }
  const hl = post.higherLowPct;
  if (isNum(hl) && hl >= 0.55) { s -= 0.25; reasons.push('CONSTRUCTIVE_HIGHER_LOWS_OFFSET'); }
  if (isNum(post.rangeContraction) && post.rangeContraction > 0.15 && isNum(hl) && hl >= 0.55) {
    s -= 0.1; reasons.push('ORDERLY_RANGE_CONTRACTION');
  }
  return veto(s, reasons);
}

/** Breakdown / momentum-reversal: extension + gap dependence + market stress. */
function breakdownVeto(card, { marketState = null } = {}) {
  const reasons = [];
  let s = 0;
  if (card.absPath?.state === 'TREND_BROKEN') { s += 0.8; reasons.push('TREND_ALREADY_BROKEN'); }
  if (isNum(card.extensionAtr) && card.extensionAtr > 4) { s += 0.25; reasons.push('WINNER_EXTENSION'); }
  const gd = card.continuity?.w63?.gaps?.gapDependence;
  if (isNum(gd) && gd > 0.55) { s += 0.15; reasons.push('GAP_DEPENDENT_PATH'); }
  if (isNum(card.residual?.beta) && card.residual.beta > 1.8) { s += 0.15; reasons.push('HIGH_BETA_EXPOSURE'); }
  const dd = card.trend?.byHorizon?.[63]?.maxDrawdown;
  if (isNum(dd) && dd < -0.2) { s += 0.2; reasons.push('DEEP_RECENT_DRAWDOWN'); }
  if (marketState === 'PANIC_REVERSAL_RISK' || marketState === 'BEAR') { s += 0.25; reasons.push(`MARKET_${marketState}`); }
  if (card.eventRisk) { s += 0.15; reasons.push('BINARY_EVENT_EXPOSURE'); }
  return veto(s, reasons);
}

/** Data / forecastability failure: stale, low support, unstable beta. */
function dataVeto(card) {
  const reasons = [];
  let s = 0;
  if (card.support?.abstain) { s += 1; reasons.push('SUPPORT_ABSTAIN'); }
  if (card.support?.grade === 'LOW') { s += 0.5; reasons.push('LOW_BETA_SUPPORT'); }
  if (card.support?.grade === 'REDUCED') { s += 0.2; reasons.push('REDUCED_SUPPORT'); }
  if ((card.eligibility?.staleSessions ?? 0) > 1) { s += 0.3; reasons.push('DATA_LAG'); }
  return veto(s, reasons);
}

/**
 * All vetoes for a card (+ optional changepoint context). Returns the veto
 * set plus the explicit combination rule outputs.
 */
function vetoesFor(card, { changepoint = null, marketState = null } = {}) {
  const stagnation = stagnationVeto(card);
  const breakdown = breakdownVeto(card, { marketState });
  const data = dataVeto(card);
  const plateau = veto(
    (card.absPath?.state === 'JUMP_PLATEAU' ? 0.8 : 0) +
    (isNum(card.continuity?.w63?.concentration?.top1Share) && card.continuity.w63.concentration.top1Share > 0.5 ? 0.2 : 0),
    card.absPath?.state === 'JUMP_PLATEAU' ? ['JUMP_PLATEAU_STATE'] : [],
  );
  const cpWarn = changepoint?.recentChange &&
    ['STEADY_TO_DECLINING', 'HIGH_VOLATILITY_BREAK', 'STEADY_TO_PLATEAU'].includes(changepoint.likelyTransition);
  if (cpWarn) {
    breakdown.reasons.push(`CHANGEPOINT_${changepoint.likelyTransition}`);
    breakdown.score = clamp01(breakdown.score + 0.2);
    breakdown.triggered = breakdown.score >= VETO_GATE;
  }
  const all = { stagnation, plateau, breakdown, data };
  const maxVeto = Math.max(...Object.values(all).map((v) => v.score));
  return {
    version: VETO_VERSION,
    ...all,
    maxVeto,
    gate: VETO_GATE,
    vetoed: maxVeto >= VETO_GATE,
    rankHaircut: 1 - 0.5 * maxVeto,   // explicit rule: continuation cannot erase a veto
    rule: 'any veto ≥ gate caps entry at WATCH and haircuts rankScore by (1 − 0.5·maxVeto)',
  };
}

/**
 * OpportunityValue(h) — addendum §14. Uses evidence tilts and veto
 * intensities as UNCALIBRATED stand-ins for the eventual trained
 * probabilities; per-horizon values are exposed separately with an explicit
 * disagreement flag — never averaged into one number.
 */
function opportunityValue({ card, vetoes, horizons = [5, 21, 63] }) {
  const combined = card.scores?.combinedAfterPenalties;
  const atrPct = card.atrPct;
  if (!isNum(combined) || !isNum(atrPct)) return { available: false, basis: 'BASELINE_UNCALIBRATED' };
  const tilt = clamp01((combined - 30) / 55);            // 0..1 evidence tilt
  const accel = card.trend?.byHorizon?.[21]?.accel;
  const accelTilt = isNum(accel) ? clamp01(accel / 0.002) : 0;
  const cost = (card.liquidity?.dollarVol ?? 0) >= 10e6 ? 0.0025 : 0.006;
  const extPen = isNum(card.extensionAtr) ? clamp01((card.extensionAtr - 3) / 2) * 0.01 : 0;
  const uncPen = card.support?.grade === 'FULL' ? 0 : 0.005;

  const byHorizon = {};
  for (const h of horizons) {
    const envelope = atrPct * Math.sqrt(h) * 1.6;
    const value =
      tilt * envelope
      + 0.3 * accelTilt * envelope
      - vetoes.plateau.score * 0.3 * envelope
      - vetoes.stagnation.score * 0.3 * envelope
      - vetoes.breakdown.score * 0.6 * envelope
      - cost - extPen - uncPen;
    byHorizon[`h${h}`] = {
      value, envelope,
      basis: 'BASELINE_UNCALIBRATED', calibrationStatus: 'uncalibrated',
    };
  }
  const vals = horizons.map((h) => byHorizon[`h${h}`].value);
  const signs = new Set(vals.map((v) => Math.sign(v)));
  return {
    available: true,
    basis: 'BASELINE_UNCALIBRATED',
    byHorizon,
    horizonsDisagree: signs.size > 1,
    disagreement: signs.size > 1 ? 'horizons conflict — shown separately, never averaged' : null,
  };
}

module.exports = { VETO_VERSION, VETO_GATE, vetoesFor, opportunityValue, stagnationVeto, breakdownVeto, dataVeto };
