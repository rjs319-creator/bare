'use strict';
// SWING EPISODE IDENTITY — durable, side-aware, source-stable identity for a published pick.
//
// Fixes the decision-engine identity defect (lib/decision.js:370): the old signal id was
// `${source}:${horizon}:${TICKER}` — source-dependent (a merged row's base source flips → new
// id → the pick reads as "vanished + a new one appeared"), side-less (a long bounce and a short
// fade on the same ticker collided), and re-usable (a genuinely new setup after a terminal one
// reused the old id and its stale levels).
//
// Two distinct notions, deliberately separated:
//
//   slotKey({ticker, side, horizon})      the STABLE lookup key. op=today already merges every
//                                         source for a (ticker, side, horizon) into ONE canonical
//                                         signal, so this is the natural unit. It is invariant to
//                                         which source is the merge base, so carrying an episode
//                                         forward never breaks when the base source changes
//                                         (test: "changing merged-source base does not create a
//                                         new episode"). Side is part of the key, so long/short
//                                         never collide (test: "long and short cannot share an ID").
//
//   episodeId(originAttrs)                the DURABLE immutable identity, frozen at inception. It
//                                         embeds every dimension the spec requires — ticker, side,
//                                         horizon, originating strategy family, strategy version,
//                                         first decision date, and a setup-generation counter — so
//                                         two setups on the same slot at different times are
//                                         distinct records for grading, and a reused symbol can
//                                         never merge two episodes.
//
//   predictionIdFor(episodeId, source)    source-specific prediction identity. A cross-source
//                                         merged episode keeps ONE episodeId but a distinct
//                                         predictionId per contributing source, so each source's
//                                         forward record can be graded independently.
//
// Pure: no clock, no store. `firstDecisionDate` and `setupGeneration` are supplied by the caller
// (the supervisor), never invented here.

const SIDES = new Set(['long', 'short']);

function normSide(side) { return side === 'short' ? 'short' : 'long'; }
function normTicker(t) { return String(t || '').toUpperCase().trim(); }
function normFamily(f) { return String(f || 'priceTrend').trim() || 'priceTrend'; }

// The stable per-day lookup key. Invariant to source/family flips; distinguishes side.
function slotKey({ ticker, side, horizon }) {
  return `${normTicker(ticker)}|${normSide(side)}|${String(horizon || 'swing')}`;
}

// The durable immutable episode identity. `setupGeneration` (1-based) distinguishes a re-opened
// setup on the same slot from the original. `firstDecisionDate` anchors it to a session.
function episodeId({ ticker, side, horizon, strategyFamily, strategyVersion, firstDecisionDate, setupGeneration }) {
  const g = Number.isFinite(+setupGeneration) && +setupGeneration >= 1 ? Math.floor(+setupGeneration) : 1;
  return [
    'swing',
    normTicker(ticker),
    normSide(side),
    String(horizon || 'swing'),
    normFamily(strategyFamily),
    String(strategyVersion || 'v1'),
    String(firstDecisionDate || 'unknown'),
    `g${g}`,
  ].join(':');
}

// A source-specific prediction id under a canonical episode. Used to grade each contributing
// source's forward record separately while keeping one canonical episode.
function predictionIdFor(id, source) {
  return `${id}::${String(source || 'base').toLowerCase()}`;
}

// RE-ENTRY POLICY — the guard that prevents the origin-store reuse bug.
//
// Given the prior episode for a slot (or null) and today's context, decide whether today's
// signal continues that episode or opens a NEW one (incrementing setupGeneration). A new episode
// may open ONLY when the prior is terminal AND either a documented cooldown has elapsed OR a
// genuinely new setup generation is detected. Within the cooldown with no new setup, we do NOT
// reopen — the terminal episode stays terminal and today's signal is suppressed as a re-entry.
//
//   prior:  { setupGeneration, terminal:boolean, terminalDate:'YYYY-MM-DD', setupSignature }
//   ctx:    { sessionsSincePriorTerminal, cooldownSessions, newSetupDetected, currentSetupSignature }
//
// Returns { action, setupGeneration, reason }:
//   action 'open-first'   — no prior; open generation 1
//   action 'continue'     — prior is non-terminal; keep the same episode + generation
//   action 'open-new'     — prior terminal + (cooldown elapsed OR new setup); open next generation
//   action 'suppress'     — prior terminal, still cooling down, no new setup; do not reopen
function reentryDecision(prior, ctx = {}) {
  if (!prior) return { action: 'open-first', setupGeneration: 1, reason: 'NEW_SLOT' };
  const priorGen = Number.isFinite(+prior.setupGeneration) && +prior.setupGeneration >= 1
    ? Math.floor(+prior.setupGeneration) : 1;
  if (!prior.terminal) return { action: 'continue', setupGeneration: priorGen, reason: 'OPEN_EPISODE' };

  const cooldown = Number.isFinite(+ctx.cooldownSessions) ? +ctx.cooldownSessions : 3;
  const elapsed = Number.isFinite(+ctx.sessionsSincePriorTerminal) ? +ctx.sessionsSincePriorTerminal : 0;
  const signatureChanged = ctx.currentSetupSignature != null && prior.setupSignature != null
    && ctx.currentSetupSignature !== prior.setupSignature;
  const newSetup = !!ctx.newSetupDetected || signatureChanged;

  if (elapsed >= cooldown || newSetup) {
    return { action: 'open-new', setupGeneration: priorGen + 1, reason: newSetup ? 'NEW_SETUP_GENERATION' : 'COOLDOWN_ELAPSED' };
  }
  return { action: 'suppress', setupGeneration: priorGen, reason: 'REENTRY_COOLDOWN' };
}

// A coarse, deterministic setup signature so a genuinely different setup on the same slot can be
// detected (drives newSetupDetected in reentryDecision). Built from the discretized entry level
// and setup label — a new breakout at a materially different price is a new setup, not the old one.
function setupSignature({ setup, entry, stop }) {
  const bucket = (v) => (Number.isFinite(+v) ? Math.round(+v * 100) / 100 : 'na');
  return `${String(setup || 'na')}|${bucket(entry)}|${bucket(stop)}`;
}

module.exports = {
  SIDES, normSide, normTicker, normFamily,
  slotKey, episodeId, predictionIdFor, reentryDecision, setupSignature,
};
