'use strict';
// DAY-TRADE TECHNOLOGY BOARD — tech-command-daytrade-v1.
//
// A READ-ONLY PROJECTION of the frozen Day Trade engine onto the technology
// universe. This module does not re-score, re-rank, re-gate or re-decide anything:
// it filters the engine's own lane output to technology names, preserves the
// engine's lifecycle state and plan verbatim, and adds clearly-separated
// technology-relative ANNOTATIONS (relative strength vs QQQ and vs the name's
// subsector) that are labeled annotation-only and never feed the decision.
//
// The Day Trade algorithm is frozen. If a future validation ever earns the right
// for a tech-relative factor to move a Day Trade decision, that change belongs in
// the Day Trade engine behind its own governance — not here.
//
// Pure: payload in, frozen board out.

const DAYTRADE_VIEW_VERSION = 'tech-command-daytrade-v1';

// The engine's lifecycle vocabulary → the page's action vocabulary. The engine
// state is ALWAYS carried through untouched beside the mapped action.
const ACTION_BY_STATE = Object.freeze({
  ACTIONABLE_NOW: 'TRIGGERED',
  REVERSAL_RECLAIM: 'TRIGGERED',
  ARMED: 'READY',
  OPENING_RANGE_FORMING: 'READY',
  WATCHING: 'WATCH',
  BUILDING: 'WATCH',
  PRIOR_SESSION_WATCH: 'WATCH',
  MANAGING: 'MANAGE',
  TOO_EXTENDED: 'AVOID',
  STALLING: 'AVOID',
  FAILED: 'INVALIDATED',
  EXPIRED: 'EXPIRED',
  TARGET_REACHED: 'TARGET_REACHED',
  CLOSED: 'EXPIRED',
});
const ACTIONS = Object.freeze(['TRIGGERED', 'READY', 'WATCH', 'MANAGE', 'AVOID', 'INVALIDATED', 'EXPIRED', 'TARGET_REACHED']);
const ACTION_RANK = Object.freeze({ TRIGGERED: 0, MANAGE: 1, READY: 2, WATCH: 3, TARGET_REACHED: 4, AVOID: 5, INVALIDATED: 6, EXPIRED: 7 });

// Transitions worth an alert. Anything not listed is a state change the board
// shows but does not push — unchanged states never alert at all.
const ALERTABLE = Object.freeze([
  { from: 'WATCH', to: 'READY', kind: 'trigger-armed', priority: 'normal' },
  { from: 'READY', to: 'TRIGGERED', kind: 'trigger-confirmed', priority: 'high' },
  { from: 'WATCH', to: 'TRIGGERED', kind: 'trigger-confirmed', priority: 'high' },
  { from: 'TRIGGERED', to: 'MANAGE', kind: 'in-position', priority: 'normal' },
  { from: 'TRIGGERED', to: 'INVALIDATED', kind: 'setup-failed', priority: 'high' },
  { from: 'MANAGE', to: 'INVALIDATED', kind: 'stop-hit', priority: 'high' },
  { from: 'READY', to: 'EXPIRED', kind: 'setup-expired', priority: 'low' },
  { from: 'TRIGGERED', to: 'TARGET_REACHED', kind: 'target-reached', priority: 'normal' },
  { from: 'MANAGE', to: 'TARGET_REACHED', kind: 'target-reached', priority: 'normal' },
  { from: 'INVALIDATED', to: 'TRIGGERED', kind: 'reclaim-confirmed', priority: 'high' },
]);

const num = v => (Number.isFinite(v) ? v : null);

/** Every card the engine emitted, from every lane, deduplicated by ticker. */
function allCardsOf(payload) {
  const lanes = (payload && payload.lanes) || {};
  const extra = [payload && payload.bestOpportunities, payload && payload.momentumLiquid,
    payload && payload.explosiveSmall, payload && payload.momentumRun, payload && payload.momentumExpanded];
  const seen = new Map();
  const push = (card, laneName) => {
    if (!card || !card.ticker) return;
    const prev = seen.get(card.ticker);
    // Keep the richest record: an explicit lane card beats a legacy list entry.
    if (!prev || (laneName && !prev.lane)) seen.set(card.ticker, { ...card, lane: laneName || (prev && prev.lane) || null });
  };
  for (const [laneName, arr] of Object.entries(lanes)) for (const c of arr || []) push(c, laneName);
  for (const arr of extra) for (const c of arr || []) push(c, null);
  return [...seen.values()];
}

/**
 * Project the Day Trade payload onto the technology universe.
 *
 * @param {{payload: object, universe: object, annotations?: Object<string, object>,
 *          priorProjection?: object, now?: Date}} input
 *   annotations: { TICKER: { rsVsQqqPct, rsVsSubsectorPct, subsectorBenchmark, asOf } }
 *                — ANNOTATION ONLY. Never used to include, exclude, rank or gate.
 */
function projectDaytradeBoard({ payload, universe, annotations = {}, priorProjection = null, now = new Date() } = {}) {
  const nowIso = new Date(now).toISOString();
  const warnings = [];
  if (!payload || payload.ok === false) warnings.push('Day Trade board unavailable — the technology day-trade lane is empty because its source could not be read, not because nothing qualified.');
  const sourceReadOnly = !payload || payload.readOnly !== false;
  if (payload && payload.readOnly === false) warnings.push('Day Trade payload came from a MUTATING source; this projection is still read-only.');

  const byTicker = (universe && universe.byTicker) || {};
  const cards = allCardsOf(payload);
  const inTech = cards.filter(c => byTicker[String(c.ticker).toUpperCase()]);
  const droppedNonTech = cards.length - inTech.length;

  const rows = inTech.map(card => {
    const t = String(card.ticker).toUpperCase();
    const u = byTicker[t];
    const ann = annotations[t] || null;
    const state = card.lifecycleState || null;
    const action = ACTION_BY_STATE[state] || (state ? 'WATCH' : 'WATCH');
    const plan = card.livePlan || card.originalPlan || null;
    const exec = card.execution || null;
    return Object.freeze({
      ticker: t,
      company: u.company,
      subsector: u.subsector,
      subsectorLabel: u.subsectorLabel,
      // ── Engine truth, carried through verbatim ────────────────────────────
      engine: 'daytrade-early-runner (frozen)',
      engineStrategyVersion: (payload && payload.strategyVersion) || null,
      lifecycleState: state,
      action,
      actionable: card.actionable === true,
      lane: card.lane || null,
      thesisValid: card.thesisValid ?? null,
      planValid: card.planValid ?? null,
      planBasis: card.planBasis || null,
      currentSessionFresh: card.currentSessionFresh ?? null,
      freshnessStatus: card.freshnessStatus || null,
      // ── Price / participation ─────────────────────────────────────────────
      price: num(card.currentPrice ?? card.last),
      pctChange: num(card.dayChangePct ?? card.pctChange),
      relVol: num(card.relVol),
      dollarVolume: num(card.avgDollarVol),
      spreadPct: exec ? num(exec.spreadPct) : null,
      spreadStatus: exec ? exec.spreadStatus : 'unknown',
      liquidityGate: exec && exec.gate ? { blocked: exec.gate.blocked === true, reasons: exec.gate.reasons || [] } : null,
      costRoundTripBps: exec && exec.cost ? num(exec.cost.roundTripBps) : null,
      // ── Intraday structure (engine-measured) ──────────────────────────────
      aboveVwap: card.aboveVwap ?? null,
      vwap: num(card.currentVwap),
      openingRangeForming: card.openingRangeForming ?? null,
      triggerConfirmed: card.triggerConfirmed ?? null,
      residualVsSpy: num(card.residualVsSpy),
      extensionAtr: num(card.extensionAtr),
      distFromHod: num(card.distFromHod),
      remainingRR: num(card.remainingRR),
      runnerScore: num(card.runnerScore),
      dudScore: num(card.dudScore),
      dudWarnings: card.dudReasons || card.dudWhy || null,
      // ── Plan ──────────────────────────────────────────────────────────────
      trigger: plan ? num(plan.trigger ?? plan.entry) : null,
      entry: plan ? num(plan.entry) : null,
      invalidation: plan ? num(plan.stop) : null,
      target: plan ? num(plan.target) : null,
      timeStop: plan && plan.expiresAt ? plan.expiresAt : null,
      chaseDistancePct: (plan && Number.isFinite(plan.entry) && Number.isFinite(card.currentPrice) && plan.entry > 0)
        ? +(((card.currentPrice - plan.entry) / plan.entry) * 100).toFixed(2) : null,
      catalyst: card.catalyst || card.newsCatalyst || card.reason || null,
      // ── Provenance ────────────────────────────────────────────────────────
      lastEvaluatedAt: card.validatedAt || card.quoteAsOf || card.intradayBarAsOf || null,
      quoteAsOf: card.quoteAsOf || null,
      intradayBarAsOf: card.intradayBarAsOf || null,
      candidateAsOf: card.candidateAsOf || null,
      transitionReason: card.explanation || null,
      reasonCodes: card.reasonCodes || [],
      setupId: card.setupId || null,
      // ── Technology-relative ANNOTATIONS (never part of the decision) ──────
      techAnnotations: ann ? Object.freeze({
        rsVsQqqPct: num(ann.rsVsQqqPct),
        rsVsSubsectorPct: num(ann.rsVsSubsectorPct),
        subsectorBenchmark: ann.subsectorBenchmark || u.benchmark,
        asOf: ann.asOf || null,
        note: 'Annotation only — these numbers are displayed beside the frozen Day Trade decision and do not modify it.',
      }) : null,
    });
  });

  rows.sort((a, b) => (ACTION_RANK[a.action] - ACTION_RANK[b.action])
    || ((b.relVol ?? 0) - (a.relVol ?? 0))
    || a.ticker.localeCompare(b.ticker));

  const byAction = {};
  for (const a of ACTIONS) byAction[a] = rows.filter(r => r.action === a).map(r => r.ticker);

  const transitions = diffTransitions(priorProjection, rows, nowIso);

  return Object.freeze({
    schema: DAYTRADE_VIEW_VERSION,
    generatedAt: nowIso,
    authority: 'read-only-projection',
    readOnly: true,
    sourceReadOnly,
    sourceEngine: 'daytrade-early-runner-v2 (frozen — consumed, never modified)',
    sourceGeneratedAt: (payload && payload.generatedAt) || null,
    sourceSession: (payload && payload.session) || null,
    sourceDataFreshness: (payload && payload.dataFreshness) || null,
    rows: Object.freeze(rows),
    byAction: Object.freeze(byAction),
    counts: Object.freeze({ total: rows.length, ...Object.fromEntries(ACTIONS.map(a => [a, byAction[a].length])) }),
    droppedNonTech,
    transitions: Object.freeze(transitions),
    empty: rows.length === 0,
    emptyReason: rows.length === 0
      ? (!payload || payload.ok === false
        ? 'Day Trade source unavailable — no technology day trades can be shown (this is a data gap, not an all-clear).'
        : 'No technology names are currently on the Day Trade board.')
      : null,
    warnings: Object.freeze(warnings),
  });
}

/** Meaningful state changes only — an unchanged state produces nothing. */
function diffTransitions(prior, rows, nowIso) {
  const priorByTicker = new Map(((prior && prior.rows) || []).map(r => [r.ticker, r]));
  const out = [];
  for (const r of rows) {
    const p = priorByTicker.get(r.ticker);
    if (!p) {
      if (r.action === 'TRIGGERED' || r.action === 'READY') {
        out.push({ ticker: r.ticker, from: null, to: r.action, kind: 'new-candidate', priority: r.action === 'TRIGGERED' ? 'high' : 'normal', at: nowIso, reason: r.transitionReason });
      }
      continue;
    }
    if (p.action === r.action) {
      // Same action, but the engine may have flagged a structural loss worth saying.
      if (p.aboveVwap === true && r.aboveVwap === false) {
        out.push({ ticker: r.ticker, from: p.action, to: r.action, kind: 'vwap-lost', priority: 'normal', at: nowIso, reason: 'Lost VWAP while the state was unchanged.' });
      }
      continue;
    }
    const rule = ALERTABLE.find(x => x.from === p.action && x.to === r.action);
    out.push({
      ticker: r.ticker, from: p.action, to: r.action,
      kind: rule ? rule.kind : 'state-change',
      priority: rule ? rule.priority : 'low',
      alertable: !!rule,
      at: nowIso,
      reason: r.transitionReason || null,
    });
  }
  return out;
}

module.exports = {
  DAYTRADE_VIEW_VERSION, ACTION_BY_STATE, ACTIONS, ACTION_RANK, ALERTABLE,
  allCardsOf, projectDaytradeBoard, diffTransitions,
};
