'use strict';
// challenger-decision.js — unified four-outcome decision layer (`challenger-decision-v1`).
// SHADOW ONLY: returns a NEW structure, never mutates inputs, carries zero deployment weight.
//
// Composes the challenger ranker + competing-risk survival + structured event surprise with
// the existing failure model, remaining edge, execution/cost, regime, maturity/governance,
// portfolio concentration, freshness and uncertainty into exactly one of:
//   TRADE | WAIT | AVOID   (per candidate)   and   NO_TRADE   (board level).
// Zero TRADE when evidence is insufficient; missing data is flagged, never fabricated.

const { assessSignal } = require('./failure-model');
const { rankCrossSection } = require('./challenger-rank');
const { assessSurvival, stageOf } = require('./challenger-survival');
const { assessEvent } = require('./challenger-events');
let capBucketFn = null;
function capBucket(dv) { if (!capBucketFn) { try { capBucketFn = require('./evolve').capBucket; } catch { capBucketFn = () => 'unknown'; } } return capBucketFn(dv); }

const DECISION_VERSION = 'challenger-decision-v1';
const DECISIONS = ['TRADE', 'WAIT', 'AVOID', 'NO_TRADE'];

// Explicit gate thresholds (priors until validated by the eval harness).
const CONFIG = {
  version: DECISION_VERSION,
  minNetUtilityPct: 0.5,   // net-of-cost edge must clear this by a meaningful margin for TRADE
  minResidualScore: 55,    // challenger cross-sectional rank score floor for TRADE
  attractiveResidual: 48,  // "attractive enough to be worth WAITing on"
  maxFailureProb: 0.5,     // failure-model rejection threshold
  minExecution: 0.4,       // execution-quality floor
  minRegimeFit: 0.5,       // regime must permit (longs stand down in risk-off => ~0.45)
  minSurvivalEdge: 0.05,   // P(target)-P(stop) margin for TRADE
  minSurvivalEffN: 12,     // survival evidence must be mature (not a shrink-to-prior guess)
  minConfidence: 0.35,     // challenger-rank confidence floor for TRADE
};

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function fmtPx(v) { return isNum(v) ? (Math.round(v * 100) / 100) : null; }

// Build the WAIT trigger / invalidation / expiry text from the survival entry state.
function waitPlan(sig) {
  const side = sig.side === 'short' ? 'short' : 'long';
  const entry = fmtPx(sig.entry);
  const stop = fmtPx(sig.stop);
  const st = sig.survival ? sig.survival.entryState : null;
  const exp = sig.survival ? sig.survival.setupExpiry : null;
  let trigger = null;
  if (entry != null) {
    if (st === 'WAIT_FOR_BREAKOUT') trigger = side === 'long' ? `Break/hold above ${entry}` : `Break/hold below ${entry}`;
    else if (st === 'WAIT_FOR_PULLBACK') trigger = side === 'long' ? `Pull back toward ${entry} and stabilize` : `Bounce toward ${entry} and stall`;
    else trigger = side === 'long' ? `Reclaim/confirm above ${entry} (next-session)` : `Reject/confirm below ${entry} (next-session)`;
  }
  const invalidation = stop != null ? (side === 'long' ? `Below ${stop}` : `Above ${stop}`) : 'Setup thesis breaks';
  const expiry = exp ? { sessionsRemaining: exp.sessionsRemaining, maxHoldBars: exp.maxHoldBars } : null;
  const reasonNotNow = st === 'WAIT_FOR_PULLBACK' ? 'Extended past trigger — entering now pays up'
    : st === 'WAIT_FOR_BREAKOUT' ? 'Trigger not yet reached'
    : 'Awaiting confirmation of the setup';
  return { trigger, invalidation, expiry, reasonNotNow };
}

// Decide ONE candidate. `flags` carries board-level context computed once in decideBoard.
function decideOne(sig, ctx = {}, flags = {}) {
  const reasons = [];
  const cr = sig.challengerRank || {};
  const sv = sig.survival || {};
  const fm = sig.failure || {};
  const ev = sig.eventSurprise || {};

  const netUtil = isNum(cr.expectedNetUtilityPct) ? cr.expectedNetUtilityPct : null;
  const residual = isNum(cr.residualScore) ? cr.residualScore : null;
  const confidence = isNum(cr.confidence) ? cr.confidence : 0;
  const failureProb = isNum(fm.failureProb) ? fm.failureProb : null;
  const exec = sig.execution && isNum(sig.execution.quality) ? sig.execution.quality : null;
  const regimeFit = isNum(sig.regimeFit) ? sig.regimeFit : null;
  const entryState = sv.entryState || null;
  const survivalEdge = isNum(sv.pTargetBeforeStop) && isNum(sv.pStopBeforeTarget) ? sv.pTargetBeforeStop - sv.pStopBeforeTarget : null;
  const survivalMature = isNum(sv.effN) && sv.effN >= CONFIG.minSurvivalEffN && !sv.shrunkToPrior;
  const dataFresh = flags.dataFresh !== false;
  const sourceDisabled = flags.disabledSources instanceof Set && sig.source ? flags.disabledSources.has(sig.source) : false;
  const redundant = !!sig.redundantWithStronger;

  const base = {
    ticker: sig.ticker, id: sig.id, company: sig.company || null, horizon: sig.horizon, side: sig.side,
    source: sig.source || null, section: sig.section || null, strategyFamily: sig.strategyFamily || null,
    // Baselines + subgroup labels carried through for point-in-time logging and evaluation.
    productionScore: isNum(sig.score) ? sig.score : null,
    momentumBaseline: isNum(sig.percentile) ? sig.percentile : null,
    capTier: capBucket(sig.liquidity && sig.liquidity.dollarVol),
    stage: stageOf(sig),
    regimeLabel: (flags.regimeLabel) || (ctx.regime && ctx.regime.label) || 'neutral',
    eventType: (sig.eventSurprise && sig.eventSurprise.category) || (sig.event && sig.event.type) || 'none',
    shadow: true, deploymentWeight: 0, governanceStatus: flags.governanceStatus || 'paper',
    expectedNetUtilityPct: netUtil, residualScore: residual, percentileRank: isNum(cr.percentileRank) ? cr.percentileRank : null,
    confidence, uncertainty: isNum(cr.uncertainty) ? cr.uncertainty : null,
    failureProb, executionQuality: exec, regimeFit,
    survival: {
      pTargetBeforeStop: sv.pTargetBeforeStop ?? null, pStopBeforeTarget: sv.pStopBeforeTarget ?? null,
      pNeither: sv.pNeither ?? null, entryState, effN: sv.effN ?? 0, shrunkToPrior: !!sv.shrunkToPrior,
      expectedSessionsToResolution: sv.expectedSessionsToResolution ?? null, edgeNowPct: sv.edgeNowPct ?? null,
      edgeAfterWaitPct: sv.edgeAfterWaitPct ?? null, basis: sv.basis || 'eod-next-session',
    },
    event: { category: ev.category || null, score: isNum(ev.score) ? ev.score : null, degraded: !!ev.degraded, contradictionFlags: ev.contradictionFlags || [] },
    entry: fmtPx(sig.entry), stop: fmtPx(sig.stop), target: fmtPx(sig.target), rr: isNum(sig.rr) ? sig.rr : null,
    holdWindow: sig.holdWindow || null,
    primaryDriver: (cr.positiveDrivers && cr.positiveDrivers[0] && cr.positiveDrivers[0].label) || null,
    primaryRisk: (fm.drivers && fm.drivers[0] && fm.drivers[0].modeLabel) || (cr.negativeDrivers && cr.negativeDrivers[0] && cr.negativeDrivers[0].label) || null,
    missingFlags: cr.missingFlags || [],
    freshnessTimestamp: ctx.asOf || null,
    challengerRank: cr, eventRecord: sig.eventRecord || null,
    trigger: null, invalidation: null, expiry: null,
  };

  // --- INVALID / hard-AVOID gates first (early returns) ---
  if (entryState === 'INVALID' || residual == null) {
    reasons.push('setup invalid or insufficient data to rank');
    return { ...base, decision: 'AVOID', reasons };
  }
  if (sourceDisabled) { reasons.push(`source strategy '${sig.source}' is governance-disabled`); return { ...base, decision: 'AVOID', reasons }; }
  if (!dataFresh) { reasons.push('board data stale/contradictory'); return { ...base, decision: 'AVOID', reasons }; }
  if (redundant) { reasons.push('redundant with a materially stronger candidate on the same underlying'); return { ...base, decision: 'AVOID', reasons }; }
  if (netUtil != null && netUtil <= 0) { reasons.push(`negative net-of-cost edge (${netUtil}%)`); return { ...base, decision: 'AVOID', reasons }; }
  if (failureProb != null && failureProb > CONFIG.maxFailureProb) { reasons.push(`failure probability ${failureProb} exceeds ${CONFIG.maxFailureProb}`); return { ...base, decision: 'AVOID', reasons }; }
  if (regimeFit != null && regimeFit < CONFIG.minRegimeFit) { reasons.push('regime restricts this side (e.g. long stands down in risk-off)'); return { ...base, decision: 'AVOID', reasons }; }
  if (entryState === 'STALE') { reasons.push('setup is stale/over-extended'); return { ...base, decision: 'AVOID', reasons }; }
  if ((ev.contradictionFlags && ev.contradictionFlags.length >= 2)) { reasons.push(`contradictory event signals: ${ev.contradictionFlags.join(', ')}`); return { ...base, decision: 'AVOID', reasons }; }

  // --- TRADE gate (every condition must hold) ---
  const tradeChecks = [
    ['entry timing supports entering now', entryState === 'ENTER_NOW'],
    ['positive net edge by margin', netUtil != null && netUtil >= CONFIG.minNetUtilityPct],
    ['residual rank above floor', residual >= CONFIG.minResidualScore],
    ['failure risk acceptable', failureProb == null || failureProb <= CONFIG.maxFailureProb],
    ['execution acceptable', exec == null || exec >= CONFIG.minExecution],
    ['regime permits', regimeFit == null || regimeFit >= CONFIG.minRegimeFit],
    ['survival edge sufficient', survivalEdge != null && survivalEdge >= CONFIG.minSurvivalEdge],
    ['survival evidence mature', survivalMature],
    ['confidence above floor', confidence >= CONFIG.minConfidence],
  ];
  const failed = tradeChecks.filter(([, ok]) => !ok);
  if (failed.length === 0) {
    reasons.push('all TRADE gates cleared');
    return { ...base, decision: 'TRADE', reasons, trigger: base.entry != null ? `Enter next session near ${base.entry}` : 'Enter next session', invalidation: base.stop != null ? `Stop ${base.stop}` : null, expiry: sv.setupExpiry || null };
  }

  // --- WAIT: attractive but not entering now (timing/confirmation/maturity gaps only) ---
  const timingOnly = failed.every(([label]) => /timing|survival|confidence|residual/.test(label));
  const attractive = residual >= CONFIG.attractiveResidual && (netUtil == null || netUtil > 0);
  if (attractive && (entryState === 'WAIT_FOR_PULLBACK' || entryState === 'WAIT_FOR_BREAKOUT' || entryState === 'WAIT_FOR_CONFIRMATION' || timingOnly)) {
    const plan = waitPlan(sig);
    reasons.push('attractive but entry not yet supported: ' + failed.map(([l]) => l).join('; '));
    reasons.push(plan.reasonNotNow);
    return { ...base, decision: 'WAIT', reasons, trigger: plan.trigger, invalidation: plan.invalidation, expiry: plan.expiry };
  }

  reasons.push('does not clear TRADE gates and not attractive enough to wait: ' + failed.map(([l]) => l).join('; '));
  return { ...base, decision: 'AVOID', reasons };
}

// Classify why the board has no tradeable candidate right now.
function noTradeCause(decisionsAll, ctx) {
  const density = ctx.density || null;
  const regimeGate = density && density.regimeGate;
  if (regimeGate && regimeGate.applied) return { cause: 'unfavorable-regime', label: regimeGate.label || 'Regime unfavorable', detail: (density.reasons || []).join('; ') };
  const anyAttractive = decisionsAll.some((d) => isNum(d.residualScore) && d.residualScore >= CONFIG.attractiveResidual);
  const anyMatureSurvival = decisionsAll.some((d) => d.survival && !d.survival.shrunkToPrior && d.survival.effN >= CONFIG.minSurvivalEffN);
  if (density && density.decision === 'no-trade' && density.qualifyingCount === 0) return { cause: 'no-positive-net-edge', label: 'No candidate with positive remaining net edge', detail: (density.reasons || []).join('; ') };
  if (!anyMatureSurvival) return { cause: 'insufficient-validation', label: 'Survival evidence too thin (shadow cold-start)', detail: 'All candidates shrink to broad priors; not enough resolved history yet.' };
  if (!anyAttractive) return { cause: 'weak-opportunity-density', label: 'Weak opportunity density', detail: density ? (density.reasons || []).join('; ') : 'No sufficiently strong candidate.' };
  return { cause: 'no-actionable-entry', label: 'Candidates attractive but none enterable now', detail: 'Best names are WAIT (timing/confirmation pending).' };
}

// Enrich a signal set with challenger sub-models WITHOUT mutating inputs, then rank.
function enrichAndRank(signals, ctx = {}) {
  const regime = ctx.regime || {};
  const survivalTable = ctx.survivalTable || null;
  const useLLM = false; // sync path is mechanical only; LLM enrichment happens upstream if desired
  // 1) failure + event surprise (needed by the cross-sectional ranker)
  const enriched = (signals || []).map((s) => {
    const failure = assessSignal(s, { regime });
    const { record, surprise } = assessEvent(s, ctx, useLLM ? s.__llmEvent : null);
    return { ...s, failure, eventSurprise: surprise, eventRecord: record };
  });
  // 2) cross-sectional residual-return ranking (reads failure + eventSurprise)
  const ranked = rankCrossSection(enriched, { asOf: ctx.asOf || null, snapshot: ctx.snapshot || null });
  // 3) competing-risk survival per candidate
  return ranked.map((s) => ({ ...s, survival: assessSurvival(s, { table: survivalTable, regime }) }));
}

// Mark intra-board redundancy: keep the highest residual per ticker as primary.
function markRedundancy(ranked, extraRedundantIds) {
  const bestByTicker = new Map();
  for (const s of ranked) {
    const t = s.ticker;
    const cur = bestByTicker.get(t);
    const score = (s.challengerRank && s.challengerRank.residualScore) || 0;
    if (!cur || score > cur.score) bestByTicker.set(t, { id: s.id, score });
  }
  const extra = extraRedundantIds instanceof Set ? extraRedundantIds : new Set();
  return ranked.map((s) => {
    const best = bestByTicker.get(s.ticker);
    const redundant = (best && best.id !== s.id) || extra.has(s.id);
    return redundant ? { ...s, redundantWithStronger: true } : s;
  });
}

// Board-level entry point. `signals` = enriched signals (decision.rankSignals output).
function decideBoard(signals, ctx = {}) {
  const governanceStatus = ctx.governanceStatus || 'paper';
  const flags = {
    dataFresh: ctx.dataFresh !== false,
    disabledSources: ctx.disabledSources instanceof Set ? ctx.disabledSources : new Set(ctx.disabledSources || []),
    governanceStatus,
    regimeLabel: (ctx.regime && ctx.regime.label) || 'neutral',
  };
  const ranked = markRedundancy(enrichAndRank(signals, ctx), ctx.redundantIds);
  const decided = ranked.map((s) => decideOne(s, ctx, flags));

  const buckets = { TRADE: [], WAIT: [], AVOID: [] };
  for (const d of decided) buckets[d.decision].push(d);
  const byResidual = (a, b) => (b.residualScore || 0) - (a.residualScore || 0);
  buckets.TRADE.sort(byResidual); buckets.WAIT.sort(byResidual); buckets.AVOID.sort(byResidual);

  const boardDecision = buckets.TRADE.length > 0 ? 'TRADE_AVAILABLE' : 'NO_TRADE';
  const cause = boardDecision === 'NO_TRADE' ? noTradeCause(decided, ctx) : null;

  return {
    version: DECISION_VERSION,
    shadow: true,
    deploymentWeight: 0,
    governanceStatus,
    generatedAt: ctx.asOf || null,
    boardDecision,
    noTradeCause: cause,
    counts: { trade: buckets.TRADE.length, wait: buckets.WAIT.length, avoid: buckets.AVOID.length, total: decided.length },
    decisions: buckets,
    config: CONFIG,
    regime: ctx.regime || null,
    density: ctx.density || null,
    note: 'Challenger runs in shadow mode; recommendations carry zero deployment weight and do not affect production ranks.',
  };
}

module.exports = {
  DECISION_VERSION,
  DECISIONS,
  CONFIG,
  decideOne,
  decideBoard,
  enrichAndRank,
  markRedundancy,
  noTradeCause,
  waitPlan,
};
