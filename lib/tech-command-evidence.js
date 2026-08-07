'use strict';
// EVIDENCE ARCHITECTURE — tech-command-evidence-v1.
//
// Heterogeneous raw scores are never averaged. Evidence arrives as FAMILY records
// (the same fourteen families lib/lookup-contract already defines), each carrying
// its own normalized [-1, +1] direction-signed strength, an explicit quality, and
// its provenance. This module then:
//
//   • DISCOUNTS correlated families so Breakout + Ghost + momentum cannot be
//     counted as three independent confirmations (they collapse into one
//     'price-trend' contribution with a documented within-cluster discount);
//   • DEMOTES quality when data is missing — a missing family lowers evidence
//     quality, it never reads as neutral-good;
//   • ZEROES the weight of research overlays (options, social, patterns, shadow
//     engines) so they annotate but can never improve an actionable rank or size;
//   • BLOCKS probabilities. A number is only ever labeled a probability when the
//     outcome is precisely defined, the horizon is explicit, and a valid
//     out-of-sample calibration artifact for the exact model version exists. There
//     is no such artifact for anything on this page, so `probability` is null and
//     the honest label is "relative setup score (uncalibrated)".
//
// Pure: no network, no store, no clock.

const { EVIDENCE_FAMILIES, validCalibrationArtifact } = require('./lookup-contract');

const EVIDENCE_VERSION = 'tech-command-evidence-v1';

// Families that measure the SAME underlying thing. Within a cluster the strongest
// member counts fully and every additional member is discounted hard — agreement
// among correlated measurements is not independent evidence.
const CORRELATION_CLUSTERS = Object.freeze({
  trend: ['price-trend', 'relative-strength', 'pattern-structure'],
  flow: ['participation', 'options-positioning', 'social'],
  fundamental: ['fundamental-quality', 'valuation-expectations', 'analyst-revisions'],
  narrative: ['news-thesis', 'events-catalysts'],
});
const WITHIN_CLUSTER_DISCOUNT = 0.35;   // each additional member of a cluster counts at 35%

// Families that may NEVER contribute weight to an actionable decision. They are
// displayed, they can CONTRADICT (a contradiction is always allowed to speak), but
// their supporting contribution is zero until prospectively validated.
const RESEARCH_ONLY_FAMILIES = Object.freeze(new Set([
  'options-positioning', 'social', 'pattern-structure', 'analyst-revisions', 'insider',
]));

// Base weight per family for the actionable composite. Deliberately flat within a
// tier: this is a documented heuristic ordering, not a fitted model.
const BASE_WEIGHTS = Object.freeze({
  'price-trend': 1.0,
  'relative-strength': 1.0,
  participation: 0.8,
  'volatility-execution': 0.8,
  'fundamental-quality': 1.0,
  'valuation-expectations': 0.8,
  'analyst-revisions': 0.0,       // PIT_UNPROVEN — display only
  'events-catalysts': 0.6,
  'options-positioning': 0.0,     // research overlay — weight 0
  'news-thesis': 0.5,
  social: 0.0,                    // research overlay — weight 0
  'market-regime': 0.7,
  'pattern-structure': 0.0,       // shadow — weight 0
  insider: 0.0,                   // research overlay — weight 0
});

const QUALITY_FACTOR = Object.freeze({ high: 1.0, medium: 0.7, low: 0.4, unknown: 0.2 });
const QUALITIES = Object.freeze(['high', 'medium', 'low', 'unknown']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Build one normalized evidence item.
 * @param {{family: string, label: string, value?: number|null, strength: number,
 *          quality?: string, direction?: 'supporting'|'contradicting'|'neutral',
 *          source: string, asOf?: string|null, detail?: string|null}} input
 */
function makeEvidence(input = {}) {
  const family = EVIDENCE_FAMILIES.includes(input.family) ? input.family : null;
  const strength = Number.isFinite(input.strength) ? clamp(input.strength, -1, 1) : 0;
  const quality = QUALITIES.includes(input.quality) ? input.quality : 'unknown';
  const direction = input.direction || (strength > 0 ? 'supporting' : strength < 0 ? 'contradicting' : 'neutral');
  return Object.freeze({
    family,
    label: String(input.label || family || 'evidence'),
    value: Number.isFinite(input.value) ? input.value : null,
    strength,
    quality,
    direction,
    researchOnly: family ? RESEARCH_ONLY_FAMILIES.has(family) : true,
    source: String(input.source || 'unknown'),
    asOf: input.asOf || null,
    detail: input.detail || null,
  });
}

function clusterOf(family) {
  for (const [name, members] of Object.entries(CORRELATION_CLUSTERS)) {
    if (members.includes(family)) return name;
  }
  return null;
}

/**
 * Compose evidence items into a decomposed, uncalibrated relative setup score.
 *
 * Returns the score in [-100, +100] together with the FULL decomposition, the
 * discount actually applied to each item, an evidence-quality grade that falls
 * when families are missing, and the separated supporting/contradicting lists.
 *
 * @param {Array} items
 * @param {{expectedFamilies?: string[]}} [opts]
 */
function composeEvidence(items, { expectedFamilies = [] } = {}) {
  const list = (items || []).filter(x => x && x.family);
  // Rank within cluster by |strength| × quality so the strongest member leads.
  const effective = list.map(it => ({
    it,
    baseWeight: BASE_WEIGHTS[it.family] ?? 0,
    qualityFactor: QUALITY_FACTOR[it.quality] ?? QUALITY_FACTOR.unknown,
  }));
  const byCluster = new Map();
  for (const e of effective) {
    const c = clusterOf(e.it.family) || `solo:${e.it.family}`;
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c).push(e);
  }

  const contributions = [];
  let num = 0, den = 0;
  for (const [cluster, group] of byCluster) {
    const ordered = [...group].sort((a, b) =>
      (Math.abs(b.it.strength) * b.qualityFactor * b.baseWeight) - (Math.abs(a.it.strength) * a.qualityFactor * a.baseWeight));
    ordered.forEach((e, idx) => {
      const discount = idx === 0 ? 1 : WITHIN_CLUSTER_DISCOUNT;
      const weight = e.baseWeight * e.qualityFactor * discount;
      const contribution = weight * e.it.strength;
      contributions.push({
        family: e.it.family, label: e.it.label, cluster: cluster.startsWith('solo:') ? null : cluster,
        strength: e.it.strength, quality: e.it.quality, baseWeight: e.baseWeight,
        qualityFactor: +e.qualityFactor.toFixed(2), correlationDiscount: discount,
        effectiveWeight: +weight.toFixed(3), contribution: +contribution.toFixed(3),
        researchOnly: e.it.researchOnly, source: e.it.source, asOf: e.it.asOf,
      });
      num += contribution;
      den += weight;
    });
  }

  const score = den > 0 ? clamp((num / den) * 100, -100, 100) : null;

  // Coverage / quality. A missing expected family is a real deduction.
  const present = new Set(list.map(i => i.family));
  const expected = expectedFamilies.length ? expectedFamilies : Object.keys(BASE_WEIGHTS).filter(f => (BASE_WEIGHTS[f] ?? 0) > 0);
  const missingFamilies = expected.filter(f => !present.has(f));
  const coverage = expected.length ? (expected.length - missingFamilies.length) / expected.length : 0;
  const avgQuality = list.length
    ? list.reduce((s, i) => s + (QUALITY_FACTOR[i.quality] ?? 0.2), 0) / list.length
    : 0;
  const qualityScore = coverage * avgQuality;
  const evidenceQuality = qualityScore >= 0.7 ? 'high' : qualityScore >= 0.45 ? 'medium' : qualityScore >= 0.2 ? 'low' : 'insufficient';

  return Object.freeze({
    schema: EVIDENCE_VERSION,
    // Deliberately NOT called a probability, a win rate, or an expected return.
    scoreLabel: 'relative setup score (uncalibrated, 0 = neutral)',
    score: score == null ? null : +score.toFixed(1),
    evidenceQuality,
    coveragePct: +(coverage * 100).toFixed(0),
    missingFamilies: Object.freeze(missingFamilies),
    familiesUsed: Object.freeze([...present]),
    contributions: Object.freeze(contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))),
    supporting: Object.freeze(list.filter(i => i.direction === 'supporting')),
    contradicting: Object.freeze(list.filter(i => i.direction === 'contradicting')),
    researchOnlyAnnotations: Object.freeze(list.filter(i => i.researchOnly)),
    correlationNote: `Correlated families are collapsed: within ${Object.keys(CORRELATION_CLUSTERS).length} clusters only the strongest member counts fully, each additional one at ${Math.round(WITHIN_CLUSTER_DISCOUNT * 100)}%.`,
  });
}

/**
 * The probability gate. Returns a display record that is ONLY ever a probability
 * when every condition holds. There is currently no calibration artifact for any
 * Tech Command Center model, so this returns the honest refusal in production.
 *
 * @param {{outcome?: string, horizon?: string, modelVersion?: string,
 *          artifact?: object, value?: number}} req
 */
function probabilityDisplay(req = {}) {
  const reasons = [];
  if (!req.outcome) reasons.push('outcome is not precisely defined');
  if (!req.horizon) reasons.push('horizon is not explicit');
  if (!req.modelVersion) reasons.push('no model version supplied');
  if (!validCalibrationArtifact(req.artifact)) reasons.push('no valid out-of-sample calibration artifact for this exact model version');
  else if (req.artifact.modelVersion && req.modelVersion && req.artifact.modelVersion !== req.modelVersion) {
    reasons.push('calibration artifact belongs to a different model version');
  }
  if (!Number.isFinite(req.value)) reasons.push('no value supplied');
  if (reasons.length) {
    return Object.freeze({
      probability: null,
      label: 'Probability unavailable',
      blocked: true,
      reasons: Object.freeze(reasons),
      display: 'No calibrated probability exists for this model. The score shown is a relative setup score, not odds.',
    });
  }
  return Object.freeze({
    probability: clamp(req.value, 0, 1),
    blocked: false,
    reasons: Object.freeze([]),
    // A calibrated probability must state the exact outcome and horizon.
    label: `Estimated probability of ${req.outcome} within ${req.horizon}`,
    artifactVersion: req.artifact.version,
    sampleSize: req.artifact.sampleSize,
    display: null,
  });
}

/**
 * Percentile rank of a score inside its own cross-section — the honest
 * alternative to a probability when no calibration exists.
 */
function percentileWithin(score, population) {
  const pop = (population || []).filter(Number.isFinite);
  if (!Number.isFinite(score) || pop.length < 5) return null;
  const below = pop.filter(v => v <= score).length;
  return Math.round((below / pop.length) * 100);
}

module.exports = {
  EVIDENCE_VERSION, CORRELATION_CLUSTERS, WITHIN_CLUSTER_DISCOUNT, RESEARCH_ONLY_FAMILIES,
  BASE_WEIGHTS, QUALITY_FACTOR,
  makeEvidence, clusterOf, composeEvidence, probabilityDisplay, percentileWithin,
};
