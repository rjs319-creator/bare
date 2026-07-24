'use strict';
// 📊 EVIDENCE CONSENSUS SCORE (redesign stage H).
//
// NOT bullish-headline-count / total-headline-count — that is exactly the metric the whole
// redesign exists to kill. Consensus here is an EVIDENCE-WEIGHTED, transparent 0-100 score
// with every subscore and penalty exposed, built from:
//
//   independent evidence breadth   — distinct evidence FAMILIES across CLUSTERS (not articles).
//                                     Reuses lib/decision.js independentEvidence + lib/redundancy
//                                     effectiveEvidence so correlated evidence earns diminishing
//                                     weight (measured from ledgers when a model is available).
//   source reliability             — best primary/tier-1 provenance in the cluster set.
//   novelty × magnitude            — how new + how big the change is (from the events).
//   market confirmation            — did price/volume actually validate the change (caller-supplied).
//   historical calibration         — how similar past signals scored (caller-supplied, optional).
//   − contradiction penalty        — opposing-direction clusters / explicit contradictions.
//   − duplication penalty          — lots of derivative reprints, little independent evidence.
//   − staleness penalty            — the freshest event is old.
//   − crowding penalty             — positioning already crowded (caller-supplied, optional).
//   − expectation-saturation       — the move already happened / already priced (caller-supplied).
//
// Pure module: all external facts are passed IN. Returns each component so the UI can show
// WHY the score is what it is, and an explicit `insufficientEvidence` state.

const { independentEvidence } = require('./decision');
let effectiveEvidence;
try { ({ effectiveEvidence } = require('./redundancy')); } catch { effectiveEvidence = null; }

// Subscore caps (the prompt's suggested component budget). Sum of positives = 105 headroom,
// normalized to 100; penalties subtract. Kept as named constants (no magic numbers).
const CAPS = Object.freeze({
  evidence: 30, revision: 20, marketConfirm: 15, catalyst: 10,
  regime: 10, source: 10, setup: 10,
  contradiction: -15, duplication: -10, staleness: -10, crowding: -10, saturation: -10,
});

// Below this many distinct evidence families across independent clusters we refuse to assert
// a consensus — the honest "insufficient evidence" state the prompt requires.
const MIN_FAMILIES_FOR_CONSENSUS = 1;
const STALE_DAYS = 10; // an event older than this contributes full staleness penalty

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v)) ? v : d;

// Convert the dominant direction across clusters into a sign, and detect contradiction.
function directionProfile(clusters) {
  let pos = 0, neg = 0, mixed = 0;
  for (const c of clusters) {
    const d = c.primary.direction;
    if (d === 'positive') pos++;
    else if (d === 'negative') neg++;
    else if (d === 'mixed') mixed++;
  }
  const dominant = pos === neg ? (mixed ? 'mixed' : 'neutral') : pos > neg ? 'positive' : 'negative';
  const conflicting = pos > 0 && neg > 0; // genuinely opposing events on the same name
  return { pos, neg, mixed, dominant, conflicting };
}

/**
 * Score consensus for ONE ticker from its clustered events + caller-supplied market facts.
 * @param {object} input
 *  - clusters: Array (from evidence-cluster.clusterEvents) — REQUIRED
 *  - redundancyModel: measured redundancy model (optional; enables measured diminishing weight)
 *  - marketConfirmation: -1..1 (price/vol confirms the dominant direction) or null
 *  - regimeFit: -1..1 (does the macro/sector regime support it) or null
 *  - historicalCalibration: 0..1 (how similar past signals scored; null = unknown)
 *  - crowding: 0..1 (positioning crowded; null = unknown)
 *  - expectationSaturation: 0..1 (move already priced in; null = unknown)
 *  - setupQuality: 0..1 (technical entry/valuation quality; null = unknown)
 *  - freshnessDays: age in days of the freshest event (null = unknown)
 */
function scoreConsensus(input = {}) {
  const clusters = (input.clusters || []).filter(c => c && c.primary);
  const familyOf = () => null; // clusters already carry families; no source→family lookup needed

  // 1. Independent evidence breadth — over CLUSTERS (each cluster = one real event), by family.
  const clusterFamilies = clusters.map(c => c.independentFamilies[0]).filter(Boolean);
  const ind = independentEvidence(clusterFamilies);
  // Measured diminishing weight when a redundancy model is available; else the family rule.
  let effScore = ind.score;
  let effMethod = 'family';
  if (effectiveEvidence && clusterFamilies.length) {
    const eff = effectiveEvidence(clusterFamilies, { model: input.redundancyModel || null, familyOf });
    effScore = eff.score; effMethod = eff.method;
  }
  const distinctFamilies = ind.familyCount;

  if (clusters.length === 0 || distinctFamilies < MIN_FAMILIES_FOR_CONSENSUS) {
    return {
      score: 0, state: 'insufficient_evidence',
      reason: 'no independent evidence families',
      distinctFamilies, clusterCount: clusters.length,
      subscores: {}, penalties: {}, direction: 'neutral',
    };
  }

  // 2. Magnitude / novelty / materiality — averaged over PRIMARY events of each cluster.
  const prim = clusters.map(c => c.primary);
  const avg = (sel) => prim.reduce((s, e) => s + num(sel(e), 0), 0) / prim.length;
  const novelty = avg(e => e.noveltyScore);
  const materiality = avg(e => e.materialityScore);
  const bestSource = Math.max(...prim.map(e => num(e.sourceQualityScore, 0.35)));
  const anyPrimary = clusters.some(c => c.hasPrimarySource);

  // 3. Revision/expectation quality — surprise magnitude when grounded, else materiality proxy.
  const surprises = prim.map(e => e.surpriseMagnitude).filter(v => v != null).map(Math.abs);
  const revisionSignal = surprises.length
    ? clamp(Math.max(...surprises) / 5, 0, 1)      // ~5σ / 5-unit surprise saturates
    : materiality * 0.5;                            // no grounded surprise → half credit

  const dir = directionProfile(clusters);

  // ── Positive subscores (each within its cap) ──────────────────────────────
  const sub = {};
  // Evidence quality scales with independent-family breadth (discounted score), 2 families ~ full.
  sub.evidence = +clamp((effScore / 2) * CAPS.evidence, 0, CAPS.evidence).toFixed(2);
  sub.revision = +clamp(revisionSignal * CAPS.revision, 0, CAPS.revision).toFixed(2);
  sub.marketConfirm = input.marketConfirmation == null ? 0
    : +clamp(((num(input.marketConfirmation) + 1) / 2) * CAPS.marketConfirm, 0, CAPS.marketConfirm).toFixed(2);
  sub.catalyst = +clamp(novelty * CAPS.catalyst, 0, CAPS.catalyst).toFixed(2);
  sub.regime = input.regimeFit == null ? CAPS.regime * 0.5
    : +clamp(((num(input.regimeFit) + 1) / 2) * CAPS.regime, 0, CAPS.regime).toFixed(2);
  sub.source = +clamp(bestSource * CAPS.source, 0, CAPS.source).toFixed(2);
  sub.setup = input.setupQuality == null ? 0
    : +clamp(num(input.setupQuality) * CAPS.setup, 0, CAPS.setup).toFixed(2);

  // ── Penalties (each ≤ 0) ───────────────────────────────────────────────────
  const pen = {};
  // Contradiction: opposing-direction clusters OR explicit contradiction notes.
  const contradictionNotes = clusters.reduce((s, c) => s + (c.primary.contradictions?.length || 0), 0);
  pen.contradiction = +(CAPS.contradiction * clamp((dir.conflicting ? 0.7 : 0) + Math.min(contradictionNotes, 3) * 0.1, 0, 1)).toFixed(2);
  // Duplication: many derivative reprints relative to independent clusters = headline inflation.
  const totalCoverage = clusters.reduce((s, c) => s + c.coverageCount, 0);
  const derivRatio = totalCoverage > 0 ? clusters.reduce((s, c) => s + c.derivativeCount, 0) / totalCoverage : 0;
  pen.duplication = +(CAPS.duplication * clamp(derivRatio, 0, 1)).toFixed(2);
  // Staleness: freshest event age.
  pen.staleness = input.freshnessDays == null ? 0
    : +(CAPS.staleness * clamp(num(input.freshnessDays) / STALE_DAYS, 0, 1)).toFixed(2);
  // Crowding & expectation-saturation (caller-supplied positioning / already-priced).
  pen.crowding = input.crowding == null ? 0 : +(CAPS.crowding * clamp(num(input.crowding), 0, 1)).toFixed(2);
  pen.saturation = input.expectationSaturation == null ? 0
    : +(CAPS.saturation * clamp(num(input.expectationSaturation), 0, 1)).toFixed(2);

  const positive = Object.values(sub).reduce((s, v) => s + v, 0);
  const penalty = Object.values(pen).reduce((s, v) => s + v, 0);
  // Normalize the positive budget (max 105) to 0-100, then apply penalties, clamp ≥0.
  const raw = clamp((positive / 105) * 100 + penalty, 0, 100);

  return {
    score: +raw.toFixed(1),
    state: 'scored',
    direction: dir.dominant,
    conflicting: dir.conflicting,
    distinctFamilies,
    clusterCount: clusters.length,
    coverageCount: totalCoverage,
    hasPrimarySource: anyPrimary,
    evidenceMethod: effMethod,          // 'measured' | 'prior'/'family' — is the discount data-earned?
    subscores: sub,
    penalties: pen,
    caps: CAPS,
    historicalCalibration: input.historicalCalibration == null ? null : +num(input.historicalCalibration).toFixed(2),
  };
}

module.exports = { scoreConsensus, directionProfile, CAPS, MIN_FAMILIES_FOR_CONSENSUS, STALE_DAYS };
