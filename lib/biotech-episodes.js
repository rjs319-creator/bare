'use strict';
// 🧬 BIOTECH EPISODES (Phase 8) — lifecycle persistence via the EXISTING Swing Episode
// Supervisor (lib/swing-supervisor.js), exactly as ATLAS-X reuses it. This gives biotech, for
// free: immutable origins (the first decision snapshot is frozen), the append-only transition
// ledger, holiday-aware session aging, and the UNION guarantee — a published biotech pick is
// re-evaluated against its origin even when no current candidate emits it, so it can only leave
// the board through a documented terminal state, never by silently vanishing. Benchmarked vs
// XBI (sectorEtf), so excess is measured against biotech beta, not SPY.
//
// PURE: no fetch, no persistence — the route supplies prevEpisodes + priceBundle and persists.

const SUP = require('./swing-supervisor');
const { VERSIONS, ARCHETYPE_META, BIOTECH_ETF } = require('./biotech-config');

const num = v => (v == null || v === '' || typeof v === 'boolean' || !isFinite(+v) ? null : +v);

// A candidate is an EPISODE (worth monitoring with a live plan) when its lane is actionable and
// a real plan exists. BINARY_WATCH / AVOID / NON-EXECUTABLE candidates are NOT episodes — they
// are logged to the daily ledger (counterfactual controls) so the removal itself is measurable.
function isEpisodeCandidate(c) {
  if (!c || !c.plan || c.plan.planStatus === 'no-plan') return false;
  const meta = ARCHETYPE_META[c.archetype];
  if (!meta || !meta.actionable) return false;
  return c.actionability === 'actionable' || c.actionability === 'waiting';
}

function candidateToSignal(c) {
  const plan = c.plan || {};
  const targets = [plan.target1, plan.target2].map(num).filter(v => v != null);
  const entry = plan.trigger != null ? plan.trigger : (plan.entryZone ? plan.entryZone[1] : c.last);
  return {
    ticker: c.ticker, company: c.company || null, side: 'long', horizon: 'swing',
    source: 'biotech', sources: ['biotech'],
    strategyFamily: c.archetype,
    scoringVersion: VERSIONS.scoring, modelVersion: VERSIONS.engine,
    score: num(c.overallResearchPriority != null ? c.overallResearchPriority : c.score), rank: num(c.rank),
    tier: c.tier || null,
    setup: (ARCHETYPE_META[c.archetype] && ARCHETYPE_META[c.archetype].label) || c.archetype,
    price: num(c.last),
    entry: num(entry), stop: num(plan.stop), target: targets[0] != null ? targets[0] : null, targets,
    maxEntry: num(plan.chaseCeiling), maxGap: null,
    holdingWindow: num(plan.expectedHoldingSessions) || 10,
    rr: num(plan.rewardRisk),
    note: c.thesis || (c.reasons && c.reasons[0]) || null,
    thesis: c.thesis || (c.reasons && c.reasons[0]) || null,
    risks: [c.actionCeiling, ...(c.severeLossReasons || [])].filter(Boolean),
    sector: c.sector || 'Health Care', sectorEtf: BIOTECH_ETF, sectorState: c.capitalState || null,
    features: {
      archetype: c.archetype, actionCeiling: c.actionCeiling, capitalState: c.capitalState,
      residual5: c.features ? c.features.residual5 : null,
      volumeFade: c.features && c.features.volDryUp != null ? c.features.volDryUp > 1.1 : false,
    },
    executionPolicyVersion: VERSIONS.engine, costModelVersion: 'cost-v2',
  };
}

function candidatesToSignals(candidates = []) {
  return candidates.filter(isEpisodeCandidate).map(candidateToSignal);
}

/**
 * Fold biotech candidates into episodes via the shared supervisor.
 * @param {object} p { prevEpisodes, candidates, priceBundle, ctx }
 */
function buildBiotechEpisodes({ prevEpisodes = [], candidates = [], priceBundle = {}, ctx = {} }) {
  const signals = candidatesToSignals(candidates);
  return SUP.buildSupervisor({ prevEpisodes, signals, priceBundle, ctx });
}

module.exports = { candidatesToSignals, candidateToSignal, buildBiotechEpisodes, isEpisodeCandidate };
