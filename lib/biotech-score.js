'use strict';
// 🧬 BIOTECH SCORE (Phase 6/10) — SEPARATED score fields, not one blended number that can hide
// risk. Each dimension is scored 0–100 on its own axis; the headline value is a RESEARCH
// PRIORITY (attention ordering), explicitly NOT a probability — probabilities stay withheld
// until a frozen, prospectively-calibrated model clears the validation gate. The action ceiling
// (from the gates) CAPS the priority, so an AVOID/LATE/NON-EXECUTABLE name can never out-rank a
// clean, verified, liquid setup no matter how strong one component looks. Transparent weighted
// rules only — no ML — and the data contract carries the fields a future model would predict.

const { ACTION, ACTION_RANK, CAPITAL_STATES: S, DATA_QUALITY } = require('./biotech-config');
const { tierFor } = require('./biotech');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Mechanical setup quality (momentum earliness + relative strength + volume + structure + base).
function setupScore(f, ctx = {}) {
  if (!f) return 0;
  let pts = 0;
  // Earliness/momentum (0–35): a real multi-day move that isn't yet blown off.
  const ret5 = f.ret5 || 0;
  pts += clamp(ret5 * 1.2, 0, 24);
  if (f.extAtr != null && f.extAtr >= 4) pts -= (f.extAtr - 4) * 4;      // blow-off penalty
  if (f.higherHigh) pts += 4; if (f.higherLow) pts += 3;
  // Relative strength vs XBI (0–15).
  if (f.residual5 != null) pts += clamp(7.5 + f.residual5 * 0.5, 0, 15);
  else pts += 5;                                                          // unknown benchmark → modest
  // Structure (0–20).
  pts += (f.aboveSma20 ? 5 : 0) + (f.aboveSma50 ? 5 : 0) + (f.aboveSma200 ? 4 : 0);
  if (f.event && f.event.aboveAnchoredVwap) pts += 6;
  // Base / contraction quality (0–10).
  if (f.volContraction != null && f.volContraction < 1) pts += clamp((1 - f.volContraction) * 20, 0, 6);
  if (f.volDryUp != null && f.volDryUp < 1) pts += clamp((1 - f.volDryUp) * 8, 0, 4);
  if (ctx.regime === 'risk-off') pts *= 0.7;                             // biotech regime gate
  return Math.round(clamp(pts, 0, 100));
}

// Catalyst evidence strength (verification level × independent origins × AI evidence grade).
function catalystEvidenceScore(event, aiEvidence) {
  let base = 20;
  if (event) {
    const byVerif = { PRIMARY: 80, CORROBORATED: 95, SECONDARY: 45, UNVERIFIED: 15, CONFLICTED: 25 };
    base = byVerif[event.verification] != null ? byVerif[event.verification] : 20;
    if (event.independentOriginCount >= 2 && event.verification === 'PRIMARY') base += 8;
  } else if (aiEvidence) {
    base = aiEvidence === 'Verified' ? 55 : aiEvidence === 'Inferred' ? 30 : 12;
  }
  return Math.round(clamp(base, 0, 100));
}

// Scientific quality (endpoint rigor / phase). Unknown → low-mid, flagged elsewhere as data gap.
function scientificQualityScore(event) {
  if (!event) return 30;
  const q = { high: 85, medium: 55, low: 30 }[String(event.scientificQuality || '').toLowerCase()];
  if (q != null) return q;
  const byType = { FDA_DECISION: 75, PDUFA: 75, TRIAL_READOUT: 65, MA: 70, PARTNERSHIP: 50, FINANCING: 25, ANALYST: 25, CONFERENCE: 45, OTHER: 35 };
  return byType[event.eventType] != null ? byType[event.eventType] : 35;
}

// Capital-structure health (higher = cleaner; dilution danger = low).
function capitalStructureScore(capital) {
  if (!capital) return 40;
  const map = {
    [S.FUNDED_THROUGH_CATALYST]: 90, [S.ADEQUATE_RUNWAY]: 75, [S.COMPLETED_FINANCING_RELIEF]: 70,
    [S.UNKNOWN]: 40, [S.FINANCING_LIKELY]: 30, [S.ACTIVE_ATM]: 20, [S.PENDING_OFFERING]: 12, [S.SEVERE_DILUTION_RISK]: 5,
  };
  return map[capital.state] != null ? map[capital.state] : 40;
}

// Execution/liquidity quality (dollar volume tier minus cost drag).
function executionScore(liquidity, costEstimatePct) {
  const adv = liquidity && liquidity.avgDollarVol;
  let s = adv == null ? 30 : adv >= 5e7 ? 90 : adv >= 2e7 ? 75 : adv >= 5e6 ? 55 : adv >= 2e6 ? 35 : 15;
  if (costEstimatePct != null) s -= clamp(costEstimatePct * 8, 0, 20);   // 1% cost → −8
  return Math.round(clamp(s, 0, 100));
}

// Ceiling → attention multiplier: an unactionable ceiling can't earn high priority.
const CEILING_FACTOR = {
  [ACTION.PRIMARY_CONFIRMED]: 1.0, [ACTION.ACTIONABLE]: 0.95, [ACTION.WAIT_FOR_TRIGGER]: 0.8,
  [ACTION.WAIT_FOR_FINANCING]: 0.5, [ACTION.NEEDS_REVIEW]: 0.55, [ACTION.WATCH_ONLY]: 0.45,
  [ACTION.BINARY_WATCH_ONLY]: 0.4, [ACTION.LATE]: 0.4, [ACTION.NON_EXECUTABLE]: 0.25, [ACTION.AVOID]: 0.12,
};

/**
 * Assemble the separated score fields + the capped Research Priority.
 * @param {object} ctx { archetype, features, event, capital, liquidity, gates, aiEvidence, costEstimate, dataQuality, regime }
 */
function scoreCandidate(ctx = {}) {
  const setup = setupScore(ctx.features, { regime: ctx.regime });
  const catalystEvidence = catalystEvidenceScore(ctx.event, ctx.aiEvidence);
  const scientific = scientificQualityScore(ctx.event);
  const capital = capitalStructureScore(ctx.capital);
  const execution = executionScore(ctx.liquidity, ctx.costEstimate);

  // Transparent weighted blend (attention, not probability).
  const raw = setup * 0.30 + catalystEvidence * 0.25 + scientific * 0.15 + capital * 0.15 + execution * 0.15;

  const ceiling = (ctx.gates && ctx.gates.actionCeiling) || ACTION.WATCH_ONLY;
  let factor = CEILING_FACTOR[ceiling] != null ? CEILING_FACTOR[ceiling] : 0.4;
  if (ctx.gates && ctx.gates.severeLossRisk === 'High') factor *= 0.8;
  if (ctx.dataQuality === DATA_QUALITY.MISSING) factor *= 0.7;           // missing data never defaults positive

  const researchPriority = Math.round(clamp(raw * factor, 0, 100));
  return {
    setupScore: setup,
    catalystEvidenceScore: catalystEvidence,
    scientificQualityScore: scientific,
    capitalStructureScore: capital,
    executionScore: execution,
    severeLossRisk: (ctx.gates && ctx.gates.severeLossRisk) || 'Low',
    overallResearchPriority: researchPriority,
    // Back-compat surface for downstream decision-normalizers / apex / calibration.
    score: researchPriority,
    tier: tierFor(researchPriority),
  };
}

module.exports = {
  scoreCandidate, setupScore, catalystEvidenceScore, scientificQualityScore,
  capitalStructureScore, executionScore, CEILING_FACTOR,
};
