'use strict';
// CFL — PIPELINE FUNNEL & STAGE-SEPARATED METRICS. Pure aggregation.
//
// Separates DISCOVERY (did any stage surface the opportunity — high recall) from
// SELECTION (did the ranked, displayed set contain it — high precision), so the
// bottleneck is a measurement instead of a guess. Consumes CFL day documents
// (episodes + missed attributions + replay summaries) — never raw provider data.

const CFG = require('./config');
const { MISS } = require('./taxonomy');

const STAGES = Object.freeze([
  'eligibleUniverse', 'generatedCandidates', 'topRanked', 'riskApproved',
  'alerted', 'displayed', 'actionableEntries', 'successfulOpportunities',
]);

// Stage a missed-winner attribution terminates at (for the leak-by-stage view).
const CATEGORY_STAGE = Object.freeze({
  [MISS.UNIVERSE_EXCLUSION]: 'eligibleUniverse',
  [MISS.DATA_UNAVAILABLE]: 'eligibleUniverse',
  [MISS.DATA_STALE_OR_FAILED]: 'eligibleUniverse',
  [MISS.CANDIDATE_GENERATION_FAILURE]: 'generatedCandidates',
  [MISS.RANKING_FAILURE]: 'topRanked',
  [MISS.LATE_DETECTION]: 'topRanked',
  [MISS.RISK_VETO]: 'riskApproved',
  [MISS.ALERT_FAILURE]: 'alerted',
  [MISS.PRESENTATION_FAILURE]: 'displayed',
  [MISS.LIQUIDITY_OR_EXECUTION_FAILURE]: 'actionableEntries',
  [MISS.INFORMATION_ARRIVED_AFTER_MOVE]: 'unforecastable',
  [MISS.OUT_OF_DISTRIBUTION]: 'unforecastable',
  [MISS.NO_PREMOVE_EVIDENCE]: 'unforecastable',
});

const rate = (num, den) => den > 0 ? +(num / den).toFixed(3) : null;

// Aggregate one horizon's day documents. days: [{decisionDate, scope, horizon,
// replaySummary, episodes[], opportunities, captured, missed[]}]
function computeFunnel(days = []) {
  const acc = {
    days: 0, cohort: 0, generated: 0, selected: 0, episodes: 0, matured: 0,
    opportunities: 0, captured: 0, missed: 0,
    missByCategory: {}, missByStage: {}, preventable: 0, unforecastable: 0,
    byRegime: {}, warningSessions: [], detectFracs: [],
  };
  for (const d of days) {
    if (!d || !d.replaySummary) continue;
    acc.days++;
    const c = d.replaySummary.counts || {};
    acc.cohort += c.cohort || 0;
    acc.generated += (c.selected || 0) + (c.nearMiss || 0);
    acc.selected += c.selected || 0;
    acc.episodes += (d.episodes || []).length;
    acc.matured += (d.episodes || []).filter(e => e.matured).length;
    acc.opportunities += d.opportunities || 0;
    acc.captured += d.captured || 0;
    acc.missed += (d.missed || []).length;
    const regime = d.replaySummary.regime
      ? (d.replaySummary.regime.bearish ? 'risk-off' : d.replaySummary.regime.riskOn ? 'risk-on' : 'neutral')
      : 'unknown';
    const rg = acc.byRegime[regime] || { opportunities: 0, captured: 0 };
    acc.byRegime[regime] = {
      opportunities: rg.opportunities + (d.opportunities || 0),
      captured: rg.captured + (d.captured || 0),
    };
    for (const m of d.missed || []) {
      const cat = m.attribution && m.attribution.primaryFailure;
      if (!cat) continue;
      acc.missByCategory[cat] = (acc.missByCategory[cat] || 0) + 1;
      const stage = CATEGORY_STAGE[cat] || 'unknown';
      acc.missByStage[stage] = (acc.missByStage[stage] || 0) + 1;
      if (m.attribution.preventable === true) acc.preventable++;
      if (m.attribution.preventable === false) acc.unforecastable++;
      if (m.trace) {
        if (Number.isFinite(m.trace.warningSessions)) acc.warningSessions.push(m.trace.warningSessions);
        if (Number.isFinite(m.trace.detectedBeforeMoveFrac)) acc.detectFracs.push(m.trace.detectedBeforeMoveFrac);
      }
    }
  }
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const detectedBefore = {};
  for (const f of CFG.DETECTION.moveFractions) {
    detectedBefore[`${Math.round(f * 100)}pct`] = rate(acc.detectFracs.filter(x => x <= f).length, acc.detectFracs.length);
  }
  return {
    version: CFG.CFL_VERSION,
    days: acc.days,
    stages: {
      eligibleUniverse: acc.cohort,
      generatedCandidates: acc.generated,
      topRanked: acc.selected,
      riskApproved: acc.selected,      // engine-level vetoes already removed; board gates not replayable (stated)
      alerted: 0,                      // this lane has no alert layer — a structural finding
      displayed: acc.selected,
      actionableEntries: acc.captured,
      successfulOpportunities: acc.captured,
    },
    conversion: {
      generationRate: rate(acc.generated, acc.cohort),
      selectionRate: rate(acc.selected, acc.generated),
    },
    discovery: {
      opportunityRecall: rate(acc.captured + countByStages(acc.missByStage, ['topRanked', 'riskApproved', 'alerted', 'displayed', 'actionableEntries']), acc.opportunities),
      note: 'recall of the DISCOVERY stage — opportunities the engine surfaced at all (selected, near-miss, or lost later in the funnel)',
    },
    selection: {
      opportunityCaptureRate: rate(acc.captured, acc.opportunities),
      note: 'end-to-end: opportunities that were actually selected at a checkpoint before maturing',
    },
    opportunities: acc.opportunities, captured: acc.captured, missedAttributed: acc.missed,
    missByCategory: acc.missByCategory,
    missByStage: acc.missByStage,
    preventableSplit: {
      preventable: acc.preventable, unforecastable: acc.unforecastable,
      preventableShare: rate(acc.preventable, acc.preventable + acc.unforecastable),
    },
    warningTime: { medianSessions: median(acc.warningSessions), n: acc.warningSessions.length },
    detectedBeforeMove: detectedBefore,
    byRegime: Object.fromEntries(Object.entries(acc.byRegime).map(([k, v]) => [k, { ...v, captureRate: rate(v.captured, v.opportunities) }])),
    episodes: acc.episodes, matured: acc.matured,
  };
}

function countByStages(missByStage, stages) {
  return stages.reduce((s, k) => s + (missByStage[k] || 0), 0);
}

// Recall@K over one day's replay + episode set: of the day's true opportunities,
// how many sat in the top-K by engine rank?
function recallAtK(day, k = 10) {
  if (!day || !Array.isArray(day.episodes)) return null;
  const opp = day.episodes.filter(e => e.bigMove || (e.crossSection && e.crossSection.topPercentile));
  if (!opp.length) return null;
  const missedSet = new Set((day.missed || []).map(m => m.episode.symbol));
  const capturedTop = opp.filter(e => !missedSet.has(e.symbol)).length;
  return { k, opportunities: opp.length, capturedTop, recall: rate(capturedTop, opp.length) };
}

module.exports = { STAGES, CATEGORY_STAGE, computeFunnel, recallAtK };
