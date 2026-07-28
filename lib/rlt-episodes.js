'use strict';
// RLT — episode adapter. Reuses the EXISTING Swing Episode Supervisor engine
// (lib/swing-supervisor.js) rather than building a second lifecycle system,
// exactly like lib/atlasx-episodes.js — only namespaced rlt/* and sourced from
// the RLT inventory. A published RLT candidate therefore NEVER silently
// disappears: union monitoring keeps evaluating it (VALID_BUT_DISPLACED /
// SOURCE_DROPPED) until a terminal state resolves it.
//
// PURE: no fetch, no persistence. Routes supply prevEpisodes + priceBundle.

const SUP = require('./swing-supervisor');
const { VERSIONS } = require('./rlt-config');
const { STATES } = require('./rlt-states');
const { TARGET_ATR, STOP_ATR } = require('./rlt-features');

const num = v => (v == null || v === '' || typeof v === 'boolean' || !isFinite(+v) ? null : +v);

const HOLDING_WINDOW = 10;
const MAX_CHASE_GAP = 0.05;

// Only candidates with a live, structured plan become episodes. DISCOVERED /
// EMERGING_LEADER are inventory-only (watch); they are captured, not episodic.
const EPISODE_STATES = new Set([STATES.PRIMED, STATES.ARMED, STATES.TRIGGERED, STATES.ACCEPTED]);

function isEpisodeCandidate(e) {
  return !!(e && EPISODE_STATES.has(e.state)
    && e.features && e.features.setup && e.features.setup.pivot != null
    && num(e.price) != null);
}

// Map one RLT inventory entry → the supervisor's normalized swing signal.
// The TRIGGER FAMILY becomes strategyFamily so the router/board bucket RLT
// episodes by setup family (breakout-acceptance, first-pullback, …).
function candidateToSignal(e) {
  const setup = e.features.setup;
  const price = num(e.price);
  const atr = num(setup.atr);
  const entry = num(setup.pivot);
  const stop = (entry != null && atr != null) ? entry - STOP_ATR * atr : null;
  const target = (entry != null && atr != null) ? entry + TARGET_ATR * atr : null;
  return {
    ticker: e.ticker, company: e.company || null, side: 'long', horizon: 'swing',
    source: 'rlt',
    sources: ['rlt'],
    strategyFamily: e.triggerFamily || 'breakout-acceptance',
    scoringVersion: VERSIONS.scoring,
    modelVersion: VERSIONS.stageA,
    score: num(e.transitionRank != null ? e.transitionRank * 100 : null),
    rank: null,
    tier: e.state,
    setup: e.triggerFamily || null,
    price,
    entry,
    stop,
    target,
    targets: target != null ? [target] : [],
    maxEntry: entry != null ? entry * (1 + MAX_CHASE_GAP) : null,
    maxGap: MAX_CHASE_GAP,
    holdingWindow: HOLDING_WINDOW,
    rr: num(setup.remainingRR),
    note: rltThesis(e),
    thesis: rltThesis(e),
    risks: Array.isArray(e.cautions) ? e.cautions : [],
    sector: e.sector || null,
    sectorEtf: e.sectorEtf || null,
    sectorState: e.sectorState || null,
    features: compactFeatures(e),
    executionPolicyVersion: 'exec-v1',
    costModelVersion: 'cost-v2',
  };
}

function rltThesis(e) {
  const pct = e.residualRank != null ? Math.round(e.residualRank * 100) : null;
  const vel = e.rankVel5 != null ? Math.round(e.rankVel5 * 100) : null;
  const parts = [];
  parts.push(`${e.state}: sector-relative leadership ${pct != null ? `at the ${pct}th peer percentile` : 'rank unavailable'}`);
  if (vel != null && vel !== 0) parts.push(`rank ${vel > 0 ? 'rose' : 'fell'} ${Math.abs(vel)} points over 5 sessions`);
  if (e.sectorState) parts.push(`sector ${e.sectorState}`);
  return parts.join('; ');
}

function compactFeatures(e) {
  const l = e.leadership || {};
  const s = e.features && e.features.setup ? e.features.setup : {};
  return {
    withinSectorPercentile: l.pctile ?? null,
    rankVel5: l.rankVel5 ?? null,
    rankAccel: l.rankAccel ?? null,
    residual10: l.byHorizon && l.byHorizon[10] ? l.byHorizon[10].sectorResidual : null,
    peerGroupSize: l.peerGroupSize ?? null,
    groupingLevel: l.groupingLevel ?? null,
    distanceToPivotAtr: s.distanceToPivotAtr ?? null,
    extensionState: s.extensionState ?? null,
    transitionRank: e.transitionRank ?? null,
  };
}

function candidatesToSignals(inventory = []) {
  return inventory.filter(isEpisodeCandidate).map(candidateToSignal);
}

/**
 * Fold RLT inventory entries into episodes via the shared supervisor engine.
 * @returns supervisor result { episodes, transitions, graded, sections, counts, … }
 */
function buildRltEpisodes({ prevEpisodes = [], inventory = [], priceBundle = {}, ctx = {} }) {
  const signals = candidatesToSignals(inventory);
  return SUP.buildSupervisor({ prevEpisodes, signals, priceBundle, ctx });
}

module.exports = {
  candidatesToSignals, candidateToSignal, buildRltEpisodes, isEpisodeCandidate,
  EPISODE_STATES, HOLDING_WINDOW, MAX_CHASE_GAP,
};
