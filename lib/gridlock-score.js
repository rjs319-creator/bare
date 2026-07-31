'use strict';
// ⚡ GRIDLOCK — decomposed opportunity score + action gate (pure).
//
// GridlockOpportunityScore (gridlock-score-v1): 8 weighted components, each
// 0–100 or null (missing), weights renormalized over available components,
// explicit penalty list subtracted AFTER the weighted sum. Every component and
// every penalty is returned — nothing is hidden inside the total, and NO
// probability of success is ever output (nothing here is calibrated).
//
// Separation of concerns: the CAUSAL side (this file + gridlock-causal) never
// computes momentum/RS/volume features itself — priceVolumeConfirm and timing
// inputs arrive from the tape read + OMEGA-SWING's evaluateCandidate, so the
// ensemble cannot double-count technical momentum as independent physical
// evidence.

const SCORE_VERSION = 'gridlock-score-v1';

// Research weights — hypotheses, not validated alpha. Stored with every candidate.
const WEIGHTS = Object.freeze({
  eventMagnitude: 0.15,
  constraintPressure: 0.15,
  exposure: 0.20,
  durability: 0.10,
  freshness: 0.10,
  priceVolumeConfirm: 0.15,
  notYetRepriced: 0.10,
  liquidity: 0.05,
});

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// MW → 0–100 on a log scale (100 MW ≈ 33, 1 GW ≈ 67, 10 GW = 100).
function magnitudeScore(mw) {
  if (mw == null || !(mw > 0)) return null;
  return Math.round(clamp((Math.log10(mw) - 1) / 3, 0, 1) * 100);
}

function exposureScore(relationship, named) {
  if (!relationship) return null;
  const base = clamp(relationship.estimatedExposureStrength || 0, 0, 1) * 100;
  const verifiedMult = relationship.verifiedOrInferred === 'verified' ? 1 : 0.5;
  const matMult = relationship.estimatedMateriality === 'high' ? 1 : relationship.estimatedMateriality === 'medium' ? 0.75 : 0.4;
  return Math.round(clamp(base * verifiedMult * matMult + (named ? 10 : 0), 0, 100));
}

function durabilityScore(event) {
  const months = event.contractDuration || event.durationMonths || null;
  const certaintyPts = { CONTRACTED: 60, PERMITTED: 70, FINANCED: 80, UNDER_CONSTRUCTION: 90, OPERATING: 100, ANNOUNCED: 30, RUMORED: 0, CANCELLED: 0 }[event.certainty];
  if (months == null && certaintyPts == null) return null;
  const durPts = months == null ? null : Math.round(clamp(months / 240, 0, 1) * 100);
  if (durPts == null) return certaintyPts;
  if (certaintyPts == null) return durPts;
  return Math.round(0.6 * durPts + 0.4 * certaintyPts);
}

function freshnessScore(announcedAt, asOf) {
  if (!announcedAt || !asOf) return null;
  const days = (Date.parse(asOf) - Date.parse(String(announcedAt).slice(0, 10))) / 864e5;
  if (!Number.isFinite(days) || days < 0) return null;
  if (days <= 2) return 100;
  if (days >= 30) return 0;
  return Math.round((1 - (days - 2) / 28) * 100);
}

// tape = { excessMovePct, relVol } (deterministic, from gridlock-readthrough).
function priceVolumeConfirmScore(tape, direction) {
  if (!tape || tape.excessMovePct == null) return null;
  const signed = direction >= 0 ? tape.excessMovePct : -tape.excessMovePct;
  // Confirmation = mild move in thesis direction (0–8% maps 40→100); a move
  // AGAINST the thesis scores low. Volume adds confirmation.
  const movePts = signed <= -2 ? 0 : signed < 0 ? 30 : clamp(40 + (signed / 8) * 60, 40, 100);
  const volPts = tape.relVol == null ? null : clamp((tape.relVol - 0.8) / 1.2, 0, 1) * 100;
  return Math.round(volPts == null ? movePts : 0.7 * movePts + 0.3 * volPts);
}

function liquidityScore(dollarVol) {
  if (dollarVol == null || !(dollarVol >= 0)) return null;
  if (dollarVol >= 50e6) return 100;
  if (dollarVol >= 20e6) return 75;
  if (dollarVol >= 3e6) return 40;
  return 10;
}

// ── Assemble the decomposed score ───────────────────────────────────────────
function opportunityScore({ event, relationship, classification, cps, tape, notYetRepriced, dollarVol, asOf }) {
  const components = {
    eventMagnitude: magnitudeScore(event.demandDeltaMW || event.generationDeltaMW || event.transmissionDeltaMW || event.storageDeltaMW),
    constraintPressure: cps && cps.total != null ? cps.total : null,
    exposure: exposureScore(relationship, classification.named),
    durability: durabilityScore(event),
    freshness: freshnessScore(event.announcedAt, asOf),
    priceVolumeConfirm: priceVolumeConfirmScore(tape, classification.direction),
    notYetRepriced: notYetRepriced && notYetRepriced.score != null ? notYetRepriced.score : null,
    liquidity: liquidityScore(dollarVol),
  };
  const available = Object.keys(components).filter(k => components[k] != null);
  const missing = Object.keys(components).filter(k => components[k] == null);

  // Penalties: causal-side uncertainty + data-state penalties. Explicit list.
  const penalties = [...(classification.uncertaintyPenalties || [])];
  if (cps && cps.dataQuality === 'poor') penalties.push({ kind: 'stale-region-data', note: 'regional data coverage poor', points: 15 });
  if (!(event.sourceEvidence || []).some(s => s.primaryOrSecondary === 'primary')) {
    penalties.push({ kind: 'no-primary-source', note: 'no primary source in evidence set', points: 15 });
  }
  if (missing.length >= 4) penalties.push({ kind: 'sparse-inputs', note: `${missing.length}/8 components missing`, points: 10 });
  const penaltyPoints = penalties.reduce((s, p) => s + (p.points || 0), 0);

  let weighted = null;
  if (available.length) {
    const wSum = available.reduce((s, k) => s + WEIGHTS[k], 0);
    weighted = available.reduce((s, k) => s + components[k] * (WEIGHTS[k] / wSum), 0);
  }
  const total = weighted == null ? null : Math.round(clamp(weighted - penaltyPoints, 0, 100));

  return {
    version: SCORE_VERSION, ticker: classification.ticker, asOf,
    total, weightedBeforePenalties: weighted == null ? null : Math.round(weighted),
    components, weights: WEIGHTS, available, missing,
    penalties, penaltyPoints,
    probability: null,   // NEVER a probability — nothing is calibrated
    dataQualityGrade: missing.length === 0 && penaltyPoints < 20 ? 'A' : missing.length <= 2 ? 'B' : missing.length <= 4 ? 'C' : 'D',
  };
}

// ── ACTIONABLE_RESEARCH gate (ordered cascade, first failure explains itself) ─
const STATUS = Object.freeze({
  RECORDED_ONLY: 'RECORDED_ONLY',                    // classified too weak to research further
  DATA_INSUFFICIENT: 'DATA_INSUFFICIENT',
  NOT_SWING_RELEVANT: 'NOT_SWING_RELEVANT',
  REGIME_BLOCKED: 'REGIME_BLOCKED',
  NO_TIMING_CONFIRM: 'NO_TIMING_CONFIRM',
  OVEREXTENDED: 'OVEREXTENDED',
  ILLIQUID: 'ILLIQUID',
  ACTIONABLE_RESEARCH: 'ACTIONABLE_RESEARCH',        // still SHADOW — never a live pick
});

// timing = OMEGA evaluateCandidate output (or null). All timing knowledge
// comes from OMEGA — GRIDLOCK adds none of its own.
function actionGate({ classification, score, cps, timing, regime, dollarVol }) {
  const gate = (status, reason) => ({ status, reason, shadow: true });
  const beneficial = ['DIRECT_BENEFICIARY', 'SECOND_ORDER_BENEFICIARY', 'EQUIPMENT_OR_CAPACITY_BENEFICIARY'].includes(classification.classification);
  if (!beneficial) return gate(STATUS.RECORDED_ONLY, `classification ${classification.classification} — recorded, not researched further`);
  if (!classification.swingRelevant) return gate(STATUS.NOT_SWING_RELEVANT, `mechanism horizon ~${classification.horizonDays}d exceeds the 5–10d swing window`);
  if (!cps || cps.total == null || cps.dataQuality === 'poor') return gate(STATUS.DATA_INSUFFICIENT, 'regional constraint data missing or stale');
  if (score.total == null || score.missing.includes('priceVolumeConfirm')) return gate(STATUS.DATA_INSUFFICIENT, 'price confirmation unavailable');
  if (regime && regime.riskOff) return gate(STATUS.REGIME_BLOCKED, 'macro risk-off — long setups blocked (regime gate)');
  if (dollarVol != null && dollarVol < 3e6) return gate(STATUS.ILLIQUID, 'dollar volume below execution floor');
  if (!timing) return gate(STATUS.NO_TIMING_CONFIRM, 'OMEGA-SWING timing evaluation unavailable');
  const entryClass = timing.entry && (timing.entry.classification || timing.entry.class);
  if (timing.stage === 'EXTENDED' || timing.stage === 'EXHAUSTED') {
    return gate(STATUS.OVEREXTENDED, `OMEGA stage ${timing.stage} — already run, chasing risk`);
  }
  if (entryClass === 'SKIP') return gate(STATUS.NO_TIMING_CONFIRM, `OMEGA entry SKIP${timing.entry.reason ? ` — ${timing.entry.reason}` : ''}`);
  const hasLevels = timing.risk && timing.risk.invalidation != null && timing.risk.target1 != null;
  if (!hasLevels) return gate(STATUS.NO_TIMING_CONFIRM, 'entry/stop/target not defined by OMEGA');
  if (score.components.priceVolumeConfirm != null && score.components.priceVolumeConfirm < 40) {
    return gate(STATUS.NO_TIMING_CONFIRM, 'price action does not confirm the thesis');
  }
  return gate(STATUS.ACTIONABLE_RESEARCH, null);
}

module.exports = {
  SCORE_VERSION, WEIGHTS, STATUS,
  magnitudeScore, exposureScore, durabilityScore, freshnessScore,
  priceVolumeConfirmScore, liquidityScore, opportunityScore, actionGate,
};
