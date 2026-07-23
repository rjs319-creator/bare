'use strict';
// SWING EPISODE SUPERVISOR (pure core) — the union engine.
//
// THE product requirement lives here: the daily evaluation universe is
//
//     current swing candidates  ∪  all previously-published non-terminal swing episodes
//
// so a published pick is re-evaluated against its immutable origin EVEN WHEN no current source
// emits it, it falls below a display cutoff, a different source now emits it, or the regime
// changed. A pick can only leave the board through a documented terminal state — never by
// vanishing. This module is pure: the route layer fetches candles and persists; here we only fold.
//
// Given prior episodes (from the store), today's normalized swing candidates, and a price bundle,
// buildSupervisor returns: the next episode records to persist, the transitions to append, the
// terminal episodes to grade, and the server-authoritative sectioned board the client renders.

const ID = require('./swing-identity');
const EP = require('./swing-episode');
const EV = require('./swing-evaluate');
const LC = require('./swing-lifecycle');
const { explain } = require('./swing-explain');
const { latestSessionDate, calendarSessionsBetween } = require('./swing-sessions');

const STRATEGY_VERSION = 'swing-supervisor-v1';
const ARCHIVE_AFTER_DAYS = 30;   // No-Longer-Actionable stays visible this long, then archives
const STALE_TOLERANCE_SESSIONS = 2; // bars older than this vs the pass date ⇒ DATA_STALE

function num(v) { return (v === null || v === undefined || v === "" || typeof v === "boolean") ? null : (Number.isFinite(+v) ? +v : null); }

// Map a normalized op=today swing signal → the fields an origin needs at inception.
function signalToOriginInput(sig, ctx) {
  const side = sig.side === 'short' ? 'short' : 'long';
  const family = sig.strategyFamily || 'priceTrend';
  const targets = Array.isArray(sig.targets) ? sig.targets : (sig.target != null ? [sig.target] : []);
  return {
    ticker: sig.ticker, company: sig.company || null, side, horizon: sig.horizon || 'swing',
    sourceStrategy: sig.source || (sig.sources && sig.sources[0]) || 'unknown',
    sourceStrategies: sig.sources && sig.sources.length ? sig.sources : (sig.source ? [sig.source] : []),
    strategyFamily: family, strategyVersion: sig.scoringVersion || STRATEGY_VERSION,
    modelVersion: sig.modelVersion || null,
    firstSuggestedAt: ctx.generatedAt, firstDecisionDate: ctx.date, decisionBarAsOf: ctx.date,
    firstSuggestedPrice: num(sig.price),
    originalEntry: num(sig.entry), originalStop: num(sig.stop), originalTargets: targets,
    originalMaxEntry: num(sig.maxEntry), originalMaxGap: num(sig.maxGap),
    originalHoldingWindow: num(sig.holdingWindow) || 10,
    originalScore: num(sig.score), originalRank: num(sig.rank),
    originalTier: sig.tier || null, originalSetup: sig.setup || sig.tier || null,
    originalThesis: sig.thesis || sig.note || null,
    originalRisks: Array.isArray(sig.risks) ? sig.risks : (sig.event ? [`event: ${sig.event.type || sig.event.kind}`] : []),
    originalFeatures: sig.features || {},
    originalRegime: ctx.regime || null, originalSectorState: sig.sectorState || (sig.sector ? `${sig.sector}` : null),
    setupSignature: ID.setupSignature({ setup: sig.setup, entry: sig.entry, stop: sig.stop }),
    dataProvenance: 'prospective_live',
    executionPolicyVersion: sig.executionPolicyVersion || null,
    costModelVersion: sig.costModelVersion || null,
  };
}

// Decide the origin to use for this slot given prior episode + today's signal + re-entry policy.
// Returns { origin, isNew, priorEpisode, suppressed }.
function resolveOrigin(prior, sig, ctx) {
  const priorTerminal = prior ? prior.terminal : false;
  let sessionsSincePriorTerminal = 0;
  if (prior && priorTerminal) {
    const termDate = terminalDateOf(prior);
    sessionsSincePriorTerminal = termDate ? calendarSessionsBetween(termDate, ctx.date, ctx.isHoliday) : 999;
  }
  const decision = ID.reentryDecision(
    prior ? { setupGeneration: prior.origin.setupGeneration, terminal: priorTerminal, setupSignature: prior.origin.setupSignature } : null,
    {
      sessionsSincePriorTerminal, cooldownSessions: ctx.cooldownSessions,
      currentSetupSignature: sig ? ID.setupSignature({ setup: sig.setup, entry: sig.entry, stop: sig.stop }) : null,
    }
  );

  if (decision.action === 'continue') return { origin: prior.origin, isNew: false, priorEpisode: prior, suppressed: false };
  if (decision.action === 'suppress') return { origin: prior.origin, isNew: false, priorEpisode: prior, suppressed: true };
  // open-first or open-new — build a fresh immutable origin from today's signal.
  if (!sig) return { origin: prior ? prior.origin : null, isNew: false, priorEpisode: prior, suppressed: false };
  const originInput = signalToOriginInput(sig, ctx);
  originInput.setupGeneration = decision.setupGeneration;
  const eid = ID.episodeId({ ...originInput });
  originInput.episodeId = eid;
  originInput.predictionId = ID.predictionIdFor(eid, originInput.sourceStrategy);
  return { origin: EP.makeOrigin(originInput), isNew: true, priorEpisode: decision.action === 'open-new' ? null : prior, suppressed: false };
}

function terminalDateOf(episode) {
  const ts = episode.transitions || [];
  for (let i = ts.length - 1; i >= 0; i--) if (LC.isTerminal(ts[i].newLifecycle)) return ts[i].session;
  return episode.assessment ? episode.assessment.latestCompletedBarAsOf : null;
}

// Evaluate one slot and produce { episode, transition|null, graded }.
function evaluateSlot(origin, sig, prior, priceBundle, ctx) {
  const candles = (priceBundle.map && priceBundle.map[origin.ticker]) || [];
  const spy = priceBundle.bench && priceBundle.bench.SPY ? priceBundle.bench.SPY : [];
  const sector = pickSectorBench(priceBundle.bench, sig, origin);
  const latestBar = latestSessionDate(candles);
  const dataStale = !latestBar || (calendarSessionsBetween(latestBar, ctx.date, ctx.isHoliday) > STALE_TOLERANCE_SESSIONS);

  const m = EV.evaluate(origin, { candles, spy, sector, asOf: ctx.date, costBps: ctx.costBps });

  const priorLifecycle = prior && prior.assessment ? prior.assessment.lifecycleState : null;
  const isNew = !prior;
  const cls = LC.classify(origin, m, {
    side: origin.side,
    sourceStillSelects: sig ? true : false,
    currentRank: sig ? num(sig.rank) : null,
    originalRank: origin.originalRank,
    currentScore: sig ? num(sig.score) : null,
    originalScore: origin.originalScore,
    regimeRiskOff: ctx.regimeRiskOff === true,
    dataStale, sourceUnavailable: dataStale && !sig,
    fillDeadline: origin.originalHoldingWindow,
    volumeFade: sig && sig.features ? sig.features.volumeFade === true : false,
    sectorRollover: ctx.sectorRollover === true,
    isNew,
    priorExecution: prior && prior.assessment ? prior.assessment.executionState : null,
  });

  const scoreDelta = sig && num(sig.score) != null && num(origin.originalScore) != null ? num(sig.score) - num(origin.originalScore) : null;
  const rankDelta = sig && num(sig.rank) != null && num(origin.originalRank) != null ? num(sig.rank) - num(origin.originalRank) : null;
  const explanation = explain(cls, { ...m, currentScore: sig ? num(sig.score) : null, currentRank: sig ? num(sig.rank) : null }, origin);
  const dataFreshness = dataStale ? 'stale' : 'fresh';

  const assessment = EP.makeAssessment({
    lastEvaluatedAt: ctx.generatedAt, latestCompletedBarAsOf: latestBar,
    dataAge: latestBar ? calendarSessionsBetween(latestBar, ctx.date, ctx.isHoliday) : null,
    sessionsSinceSuggestion: m.sessionsSinceSuggestion, sessionsSinceEntry: m.sessionsSinceEntry,
    sessionsRemaining: num(origin.originalHoldingWindow) != null && m.sessionsSinceSuggestion != null
      ? Math.max(0, origin.originalHoldingWindow - m.sessionsSinceSuggestion) : null,
    sourceStillSelects: sig ? true : false,
    currentSources: sig ? (sig.sources && sig.sources.length ? sig.sources : [sig.source].filter(Boolean)) : [],
    currentPrice: m.currentPrice, currentScore: sig ? num(sig.score) : null, scoreDelta,
    currentRank: sig ? num(sig.rank) : null, rankDelta,
    currentTier: sig ? (sig.tier || null) : null, currentSetup: sig ? (sig.setup || null) : origin.originalSetup,
    currentFeatures: sig && sig.features ? sig.features : {},
    currentRegime: ctx.regime || null, currentSectorState: sig ? (sig.sectorState || null) : origin.originalSectorState,
    returnSinceSuggestion: m.returnSinceSuggestion, returnSinceFill: m.returnSinceFill,
    excessVsSpy: m.excessVsSpy, excessVsSector: m.excessVsSector,
    mfeSinceSuggestion: m.mfeSinceSuggestion, maeSinceSuggestion: m.maeSinceSuggestion,
    mfeSinceFill: m.mfeSinceFill, maeSinceFill: m.maeSinceFill,
    remainingToOriginalTarget: m.remainingToOriginalTarget, remainingRewardRisk: m.remainingRewardRisk, consumedPct: m.consumedPct,
    managementStop: m.managementStop, managementNote: m.managementStop != null ? 'Advisory: stop to breakeven after >1R (does not change grading)' : null,
    lifecycleState: cls.lifecycle, thesisState: cls.thesis, actionState: cls.action,
    executionState: cls.execution, outcomeState: cls.outcome,
    reasonCodes: cls.reasonCodes, explanation, dataFreshness, calibrationStatus: 'uncalibrated',
  });

  // Transition only when the lifecycle axis actually changes (idempotent per session — re-running
  // with the same prior state appends nothing new).
  let transition = null;
  if (priorLifecycle !== cls.lifecycle) {
    transition = EP.makeTransition({
      at: ctx.generatedAt, session: ctx.date,
      prevLifecycle: priorLifecycle, newLifecycle: cls.lifecycle,
      prevThesis: prior && prior.assessment ? prior.assessment.thesisState : null, newThesis: cls.thesis,
      prevAction: prior && prior.assessment ? prior.assessment.actionState : null, newAction: cls.action,
      prevExecution: prior && prior.assessment ? prior.assessment.executionState : null, newExecution: cls.execution,
      prevOutcome: prior && prior.assessment ? prior.assessment.outcomeState : null, newOutcome: cls.outcome,
      reasonCodes: cls.reasonCodes, explanation, price: m.currentPrice,
      featureDeltas: scoreDelta != null ? { scoreDelta } : {},
      sourcePresence: { stillSelects: sig ? true : false, sources: sig ? (sig.sources || [sig.source]) : [] },
      dataFreshness, strategyVersion: origin.strategyVersion, modelVersion: origin.modelVersion,
    });
  }

  const transitions = prior ? [...prior.transitions, ...(transition ? [transition] : [])] : (transition ? [transition] : []);
  const episode = EP.makeEpisode({ origin, assessment, transitions });
  return { episode, transition, graded: episode.terminal };
}

function pickSectorBench(bench, sig, origin) {
  if (!bench) return [];
  const sector = (sig && sig.sectorEtf) || (origin && origin.sectorEtf) || null;
  if (sector && bench[sector]) return bench[sector];
  return [];
}

// ── Bucketing into the seven server-authoritative sections ─────────────────────────
function sectionFor(episode, ctx) {
  const a = episode.assessment; if (!a) return 'newCandidates';
  const lc = a.lifecycleState;
  if (episode.terminal) {
    const ageDays = episode.origin.firstDecisionDate ? calendarSessionsBetween(terminalDateOf(episode) || episode.origin.firstDecisionDate, ctx.date, ctx.isHoliday) : 0;
    const positive = lc === LC.LIFECYCLE.TARGET_HIT || a.outcomeState === LC.OUTCOME.EXPIRED_POSITIVE;
    if (ageDays > ARCHIVE_AFTER_DAYS) return 'archive';
    return positive ? 'completed' : 'noLongerActionable';
  }
  if (episode.origin.firstDecisionDate === ctx.date) return 'newCandidates';
  if (lc === LC.LIFECYCLE.WAITING_FOR_TRIGGER || lc === LC.LIFECYCLE.ENTERABLE) return 'waitingForTrigger';
  if (lc === LC.LIFECYCLE.WEAKENING || lc === LC.LIFECYCLE.EXTENDED || lc === LC.LIFECYCLE.VALID_BUT_DISPLACED || lc === LC.LIFECYCLE.DATA_STALE) return 'needsAttention';
  return 'stillValid';
}

// Build the full board. prevEpisodes/signals are arrays; priceBundle = { map, bench }.
function buildSupervisor({ prevEpisodes = [], signals = [], priceBundle = {}, ctx = {} }) {
  const c = { cooldownSessions: 3, costBps: EV.DEFAULT_COST_BPS, ...ctx };
  const priorBySlot = new Map();
  for (const ep of prevEpisodes) if (ep && ep.slotKey) priorBySlot.set(ep.slotKey, ep);
  const sigBySlot = new Map();
  for (const s of signals) { const k = ID.slotKey(s); if (!sigBySlot.has(k)) sigBySlot.set(k, s); }

  const slots = new Set([...priorBySlot.keys(), ...sigBySlot.keys()]);
  const episodes = [];
  const transitions = [];
  const graded = [];
  let suppressedCount = 0;

  for (const slot of slots) {
    const prior = priorBySlot.get(slot) || null;
    const sig = sigBySlot.get(slot) || null;
    const { origin, priorEpisode, suppressed } = resolveOrigin(prior, sig, c);
    if (!origin) continue;
    // A re-entry suppressed within cooldown: keep the terminal episode as-is (do NOT reopen with a
    // stale origin), and do not evaluate today's signal as a fresh entry.
    if (suppressed) { episodes.push(prior); suppressedCount++; continue; }
    const { episode, transition, graded: isGraded } = evaluateSlot(origin, sig, priorEpisode, priceBundle, c);
    episodes.push(episode);
    if (transition) transitions.push({ episodeId: episode.origin.episodeId, transition });
    if (isGraded) graded.push(episode);
  }

  // Section the board.
  const sections = { newCandidates: [], stillValid: [], waitingForTrigger: [], needsAttention: [], noLongerActionable: [], completed: [], archive: [] };
  for (const ep of episodes) sections[sectionFor(ep, c)].push(ep);

  // Server-authoritative ordering of the actionable lanes (client only renders). Optional router
  // tilt is applied here — algorithm-specific and shrunk, never a uniform multiplier.
  const rank = (arr) => arr.sort((a, b) => opportunityScore(b, c) - opportunityScore(a, c));
  rank(sections.newCandidates); rank(sections.stillValid); rank(sections.waitingForTrigger); rank(sections.needsAttention);

  return {
    generatedAt: c.generatedAt, date: c.date, strategyVersion: STRATEGY_VERSION,
    episodes, transitions, graded, sections,
    counts: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length])),
    suppressedReentries: suppressedCount,
  };
}

// Remaining-opportunity ordering for still-open episodes. Base = original score scaled by how much
// edge is still ahead (remainingRewardRisk, not-yet-consumed), then a per-ALGORITHM shrunk tilt from
// the router (if provided). No uniform global multiplier — the tilt varies by source family.
function opportunityScore(ep, ctx) {
  const a = ep.assessment || {};
  const base = num(a.currentScore) != null ? num(a.currentScore) : (num(ep.origin.originalScore) || 50);
  const rrBoost = num(a.remainingRewardRisk) != null ? Math.min(1.3, Math.max(0.6, a.remainingRewardRisk / 2)) : 1;
  const consumedPenalty = num(a.consumedPct) != null ? Math.max(0.5, 1 - a.consumedPct * 0.4) : 1;
  const tilt = ctx.router ? ctx.router.multiplierFor(ep.origin.strategyFamily, ep.origin.sourceStrategy) : 1;
  return base * rrBoost * consumedPenalty * tilt;
}

module.exports = { buildSupervisor, evaluateSlot, resolveOrigin, signalToOriginInput, sectionFor, opportunityScore, STRATEGY_VERSION, ARCHIVE_AFTER_DAYS };
