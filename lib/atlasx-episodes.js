'use strict';
// ATLAS-X — episode adapter. Reuses the EXISTING Swing Episode Supervisor engine
// (lib/swing-supervisor.js) rather than building a second lifecycle system. It maps
// ATLAS-X candidates into the supervisor's normalized swing-signal shape, then folds
// them with buildSupervisor over ATLAS-X's OWN prior episodes (atlasx/ namespace).
//
// This gives ATLAS-X, for free: immutable origins, the 5-axis lifecycle state
// machine, holiday-aware session aging, union monitoring (a published pick is
// re-evaluated even when no current candidate emits it), long/short slot isolation,
// and the append-only transition ledger — all identical to the live swing board,
// only namespaced and sourced from ATLAS-X.
//
// PURE: no fetch, no persistence. The engine/routes layer supplies prevEpisodes +
// priceBundle and persists the result.

const SUP = require('./swing-supervisor');
const { VERSIONS, HOLDING_WINDOW, MAX_CHASE_GAP } = require('./atlasx-config');

const num = v => (v == null || v === '' || typeof v === 'boolean' || !isFinite(+v) ? null : +v);

// Actions whose candidates carry a live plan worth monitoring as an episode. AVOID /
// NO_TRADE / DO_NOT_CHASE are NOT episodes — they are logged to capture (matched
// controls / rejected) so we can measure whether the removal was correct.
const EPISODE_ACTIONS = new Set(['ENTER_NEXT_OPEN', 'WAIT_BREAKOUT', 'WAIT_PULLBACK', 'WAIT_FIRST_HOUR', 'WAIT_CONFIRMATION']);

function isEpisodeCandidate(c) {
  return !!(c && c.entry && EPISODE_ACTIONS.has(c.entry.action));
}

// Map one ATLAS-X candidate → the supervisor's normalized swing signal. The selected
// EXPERT becomes the strategyFamily (so the router/board bucket ATLAS-X by expert),
// source is always 'atlasx' (shadow provenance).
function candidateToSignal(c) {
  const exp = c.router && c.router.selectedExpert ? c.router.selectedExpert : (c.expert || 'priceTrend');
  const dist = c.distribution || {};
  const entry = c.entry || {};
  const targets = c.targets && c.targets.length ? c.targets
    : (entry.target != null ? [entry.target] : (c.target != null ? [c.target] : []));
  const price = num(c.price);
  return {
    ticker: c.ticker, company: c.company || null, side: c.side === 'short' ? 'short' : 'long', horizon: 'swing',
    source: 'atlasx',
    sources: ['atlasx', ...(c.contributingExperts || [])].filter(Boolean),
    strategyFamily: exp,
    scoringVersion: VERSIONS.strategy,
    modelVersion: VERSIONS.ranking,
    score: num(c.score != null ? c.score : (c.utility && c.utility.expectedValue)),
    rank: num(c.rank),
    tier: c.tier || (c.expertStage || null),
    setup: c.setup || (c.transition && c.transition.dominantTransition) || null,
    price,
    entry: num(entry.entryPrice != null ? entry.entryPrice : entry.trigger),
    stop: num(entry.invalidation != null ? entry.invalidation : c.invalidation),
    target: targets.length ? num(targets[0]) : null,
    targets: targets.map(num).filter(v => v != null),
    maxEntry: num(entry.maxEntry != null ? entry.maxEntry : (price != null ? price * (1 + MAX_CHASE_GAP) : null)),
    maxGap: num(entry.maxGap != null ? entry.maxGap : MAX_CHASE_GAP),
    holdingWindow: num(c.holdingWindow) || HOLDING_WINDOW,
    rr: num(entry.remainingRR != null ? entry.remainingRR : c.remainingRR),
    note: c.thesis || (c.champion && c.champion.summary) || null,
    thesis: c.thesis || (c.champion && c.champion.summary) || null,
    risks: Array.isArray(c.risks) ? c.risks
      : (c.prosecutor && Array.isArray(c.prosecutor.failureModes) ? c.prosecutor.failureModes.map(f => f.mode) : []),
    sector: c.sector || null,
    sectorEtf: c.sectorEtf || null,
    sectorState: c.sectorState || null,
    features: compactFeatures(c),
    executionPolicyVersion: VERSIONS.execution,
    costModelVersion: 'costs-v1',
  };
}

function compactFeatures(c) {
  const t = c.transition && c.transition.features ? c.transition.features : {};
  const r = c.residual || {};
  return {
    residual10: r.byHorizon && r.byHorizon[10] ? r.byHorizon[10].residual : null,
    residualAccel: r.residualAccel != null ? r.residualAccel : null,
    dominantTransition: c.transition ? c.transition.dominantTransition : null,
    pathArchetype: c.path ? c.path.archetype : null,
    expertApplicability: c.expertApplicability != null ? c.expertApplicability : null,
    failureScore: c.prosecutor ? c.prosecutor.failureScore : null,
    volumeFade: t.volAccel != null ? t.volAccel < 0.9 : false,
  };
}

// Convert the ATLAS-X candidate list → supervisor signals (episode candidates only).
function candidatesToSignals(candidates = []) {
  return candidates.filter(isEpisodeCandidate).map(candidateToSignal);
}

/**
 * Fold ATLAS-X candidates into episodes via the shared supervisor engine.
 * @param {object} p {prevEpisodes, candidates, priceBundle, ctx}
 * @returns supervisor result { episodes, transitions, graded, sections, counts, ... }
 */
function buildAtlasEpisodes({ prevEpisodes = [], candidates = [], priceBundle = {}, ctx = {} }) {
  const signals = candidatesToSignals(candidates);
  return SUP.buildSupervisor({ prevEpisodes, signals, priceBundle, ctx });
}

module.exports = {
  candidatesToSignals, candidateToSignal, buildAtlasEpisodes, isEpisodeCandidate, EPISODE_ACTIONS,
};
