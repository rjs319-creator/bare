'use strict';
// 🧬 BIOTECH ENGINE (pipeline seam) — assembles ONE candidate through the full Biotech Swing
// Engine given its candles and any pre-fetched evidence (event ledger entry, deterministic
// capital state, bounded-AI interpretation). Pure and synchronous: the route does the async
// retrieval/AI and passes the results in, so the whole pipeline is unit-testable without network.
//
//   features → archetype → plan → gates → score
//
// The output is a single flat candidate object carrying the SEPARATED score fields, the action
// ceiling + reasons, the executable plan, the archetype, the capital state, and the back-compat
// surface (tier / score / classification / last / relVol / catalyst_timing / sector) that the
// downstream decision-normalizers, apex scoreboard, and calibration read unchanged.

const { computeFeatures } = require('./biotech-features');
const { classifyArchetype } = require('./biotech-archetypes');
const { buildPlan } = require('./biotech-plan');
const { applyGates } = require('./biotech-gates');
const { scoreCandidate } = require('./biotech-score');
const { classifyTiming, daysToNextBinary } = require('./biotech-events');
const { DATA_QUALITY, ARCHETYPE_META } = require('./biotech-config');

// Data-quality: missing candles = MISSING; no catalyst + unknown capital + no AI = THIN; a
// partial evidence set = DEGRADED; full = OK. Missing/thin must NOT earn positive defaults.
function assessDataQuality({ features, event, capital, ai }) {
  if (!features) return DATA_QUALITY.MISSING;
  const haveCatalyst = !!(event && event.verified) || !!(ai && ai.evidence && ai.evidence !== 'None');
  const haveCapital = !!(capital && capital.dataQuality && capital.dataQuality !== 'MISSING');
  if (!haveCatalyst && !haveCapital && !ai) return DATA_QUALITY.THIN;
  if (!haveCatalyst || !haveCapital) return DATA_QUALITY.DEGRADED;
  return DATA_QUALITY.OK;
}

/**
 * @param {object} input { ticker, company, last, relVol, avgDollarVol, candles, xbi, regime,
 *                         eventIdx, event, capital, ai, asOf, sector }
 * @returns {object} the assembled candidate (or a minimal WATCH-ONLY stub if features fail)
 */
function assembleCandidate(input = {}) {
  const asOf = input.asOf || (input.candles && input.candles.length ? input.candles[input.candles.length - 1].date : null);
  const features = computeFeatures(input.candles || [], { eventIdx: input.eventIdx, xbi: input.xbi });
  const ai = input.ai || null;
  const event = input.event || null;
  const capital = input.capital || null;
  const aiClass = ai ? ai.classification : null;
  const aiEvidence = ai ? ai.evidence : null;
  const timing = event ? classifyTiming(event, asOf) : (ai ? ai.catalyst_timing : 'NA');
  const daysToBinary = event ? daysToNextBinary(event, asOf) : null;
  const dataQuality = assessDataQuality({ features, event, capital, ai });
  const liquidity = { avgDollarVol: input.avgDollarVol != null ? input.avgDollarVol : (features ? features.avgDollarVol : null), price: input.last };

  const { archetype, reasons } = classifyArchetype({ features, event, capital, aiClass, timing, daysToBinary, asOf });
  const plan = buildPlan({ archetype, price: input.last, features, event, candles: input.candles, side: 'long' });
  const gates = applyGates({
    archetype, event, capital, features, liquidity, plan, aiClass, timing,
    hasExitBefore: !!(plan && plan.exitBeforeDate), dataQuality,
  });
  const score = scoreCandidate({
    archetype, features, event, capital, liquidity, gates,
    aiEvidence, costEstimate: plan.costEstimate, dataQuality, regime: input.regime,
  });

  return {
    ticker: input.ticker, company: input.company || null,
    // Archetype + honest action surface.
    archetype, archetypeLabel: (ARCHETYPE_META[archetype] || {}).label || archetype, reasons,
    actionCeiling: gates.actionCeiling, actionCeilingReasons: gates.actionCeilingReasons,
    actionability: gates.actionability, severeLossRisk: gates.severeLossRisk, severeLossReasons: gates.severeLossReasons,
    // Separated scores + capped Research Priority.
    setupScore: score.setupScore, catalystEvidenceScore: score.catalystEvidenceScore,
    scientificQualityScore: score.scientificQualityScore, capitalStructureScore: score.capitalStructureScore,
    executionScore: score.executionScore, overallResearchPriority: score.overallResearchPriority,
    // Plan.
    plan,
    // Evidence.
    event: event ? { eventType: event.eventType, verification: event.verification, verified: event.verified, expectedDate: event.expectedDate, actualDate: event.actualDate, independentOriginCount: event.independentOriginCount, nextUnresolvedBinaryDate: event.nextUnresolvedBinaryDate, sources: event.sources } : null,
    capitalState: capital ? capital.state : null, capitalEvidence: capital ? capital.evidence : null,
    dilutionRisk: capital ? capital.dilutionRisk : (ai ? ai.dilution_interpretation : null),
    timing, daysToBinary, dataQuality,
    subsector: ai ? ai.subsector : null,
    thesis: ai ? ai.thesis : null, bear_case: ai ? ai.bear_case : null, caution: ai ? ai.caution : null,
    citations: ai ? ai.citations : null, groundedPrimary: ai ? ai.groundedPrimary : null,
    confidence: ai ? ai.confidence : 2,
    features,
    // ── Back-compat surface (downstream decision-normalizers / apex / calibration) ──
    tier: score.tier, score: score.score,
    classification: aiClass || (archetype === 'BINARY_WATCH' ? 'NOISE' : 'STEALTH'),
    evidence: aiEvidence || 'None',
    catalyst_timing: timing,
    last: input.last, relVol: input.relVol, sector: input.sector || 'Health Care',
    pct5d: features ? features.ret5 : null, runAge: null, adrDaysConsumed: null,
    flags: {
      dilutionHigh: !!(capital && (capital.dilutionRisk === 'High')),
      binaryAhead: timing === 'Ahead',
      lowLiquidity: liquidity.avgDollarVol != null && liquidity.avgDollarVol < 5e6,
      overextended: !!(features && features.extAtr != null && features.extAtr >= 4),
    },
  };
}

module.exports = { assembleCandidate, assessDataQuality };
