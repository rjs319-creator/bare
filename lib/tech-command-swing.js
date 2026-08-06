'use strict';
// SWING TECHNOLOGY BOARD — tech-command-swing-v1.
//
// A technology PROJECTION of the app's already-governed swing cross-section
// (op=today → horizons.swing, which has already run merge, ranking, the central
// eligibility gate and the data-staleness gate). This module:
//
//   • preserves the upstream governance verbatim — signalClass
//     (ACTIONABLE / QUALIFIED_LEAD / RESEARCH), sizingEligible and retainedLabel
//     decide the ceiling on what action may be emitted, so a RESEARCH signal can
//     never become an actionable recommendation by passing through this page;
//   • adds technology-relative CONTEXT (QQQ-relative, subsector-relative, rank
//     within subsector, rank acceleration) and displays it as evidence;
//   • DOES NOT re-rank on that context. The previously tested sector-neutral /
//     volatility-aware replacement produced negative ranking IC and is not
//     deployed: the board's order is the upstream governed score. The composed
//     evidence record is a decomposition shown to the reader with
//     usedForRanking:false.
//
// Horizon: 3–30 sessions. Actions: WATCH / READY / ENTER / DO_NOT_CHASE / HOLD /
// REDUCE / EXIT_INVALIDATE.
//
// Pure: signals + context in, frozen board out.

const EV = require('./tech-command-evidence');

const SWING_VIEW_VERSION = 'tech-command-swing-v1';
const HOLD_SESSIONS = Object.freeze({ min: 3, max: 30 });

const ACTIONS = Object.freeze(['ENTER', 'READY', 'WATCH', 'DO_NOT_CHASE', 'HOLD', 'REDUCE', 'EXIT_INVALIDATE']);
const ACTION_RANK = Object.freeze({ ENTER: 0, READY: 1, DO_NOT_CHASE: 2, WATCH: 3, HOLD: 4, REDUCE: 5, EXIT_INVALIDATE: 6 });

// Ceiling imposed by the upstream evidence class. A research overlay cannot buy.
const CLASS_CEILING = Object.freeze({ ACTIONABLE: 'ENTER', QUALIFIED_LEAD: 'READY', RESEARCH: 'WATCH' });

const MAX_CHASE_PCT = 3.0;          // beyond this above the entry the setup is a chase, not an entry
const EARNINGS_BLACKOUT_DAYS = 3;   // a print inside this window blocks a fresh entry
const MIN_DOLLAR_VOLUME = 5e6;      // liquidity floor for a swing entry

const num = v => (Number.isFinite(v) ? v : null);
const planComplete = (e, s, t, side) => {
  if (!(Number.isFinite(e) && Number.isFinite(s) && Number.isFinite(t))) return false;
  return side === 'short' ? (s > e && t < e) : (s < e && t > e);
};

// ── Why the name is not (or no longer) a fresh entry ─────────────────────────
const REMOVAL_REASON = Object.freeze({
  NOT_FRESH: 'no longer a fresh entry — the setup aged past its entry window',
  TRIGGER_FAILED: 'trigger failed — price rejected the breakout level',
  RS_DETERIORATED: 'relative strength deteriorated vs QQQ and its subsector',
  EVENT_RISK: 'event risk increased — an earnings print now falls inside the hold window',
  TARGET_REACHED: 'target reached',
  STOP_INVALIDATED: 'invalidation level breached',
  EXPIRED: 'expired without triggering',
  RETAINED: 'retained as hold/monitor — thesis intact, not a new entry',
  DATA_STALE: 'inputs went stale — cannot be presented as a live decision',
});

/**
 * @param {{signals: Array, universe: object, context?: Object<string, object>,
 *          regime?: object, priorBoard?: object, now?: Date, limit?: number}} input
 *   context: { TICKER: { rsVsQqq21, rsVsSubsector21, subsectorRank, subsectorCount,
 *                        rankAccel, earningsInDays, earningsDate, dollarVolume,
 *                        spreadPct, atrPct, asOf } }
 */
function buildSwingBoard({ signals, universe, context = {}, regime = null, priorBoard = null, now = new Date(), limit = 5 } = {}) {
  const nowIso = new Date(now).toISOString();
  const warnings = [];
  const byTicker = (universe && universe.byTicker) || {};
  const list = (signals || []).filter(s => s && s.ticker && byTicker[String(s.ticker).toUpperCase()]);
  const droppedNonTech = (signals || []).length - list.length;
  if (!signals || !signals.length) warnings.push('No governed swing cross-section was available — the swing board is empty because its source could not be read.');

  const rows = list.map(sig => buildRow(sig, byTicker[String(sig.ticker).toUpperCase()], context[String(sig.ticker).toUpperCase()] || null, regime, nowIso));

  // Carry forward previously published names that dropped out of the fresh scan —
  // they change lifecycle state and explain themselves, they never vanish.
  const present = new Set(rows.map(r => r.ticker));
  const carried = [];
  for (const prev of ((priorBoard && priorBoard.rows) || [])) {
    if (present.has(prev.ticker)) continue;
    carried.push(Object.freeze({
      ...prev,
      action: prev.action === 'ENTER' || prev.action === 'READY' ? 'HOLD' : prev.action,
      persisted: true,
      whyStillHere: 'Published earlier and no longer in the fresh scan — retained with an explicit reason.',
      removalReason: REMOVAL_REASON.NOT_FRESH,
      lastEvaluatedAt: nowIso,
      evidence: prev.evidence,
    }));
  }

  const all = [...rows, ...carried];
  // ORDER = the upstream governed score. Technology-relative context is displayed,
  // never used to re-rank (the sector-neutral replacement failed prospectively).
  all.sort((a, b) => (ACTION_RANK[a.action] - ACTION_RANK[b.action])
    || ((b.governedScore ?? -Infinity) - (a.governedScore ?? -Infinity))
    || a.ticker.localeCompare(b.ticker));

  const featured = all.filter(r => !r.persisted).slice(0, limit);
  const byAction = {};
  for (const a of ACTIONS) byAction[a] = all.filter(r => r.action === a).map(r => r.ticker);

  return Object.freeze({
    schema: SWING_VIEW_VERSION,
    generatedAt: nowIso,
    horizonSessions: HOLD_SESSIONS,
    rankBasis: 'upstream governed swing score (op=today rankSignals). Technology-relative evidence is DISPLAYED only — the sector-neutral/volatility-aware replacement is not deployed (it produced negative ranking IC).',
    rows: Object.freeze(all),
    featured: Object.freeze(featured),
    byAction: Object.freeze(byAction),
    counts: Object.freeze({ total: all.length, persisted: carried.length, ...Object.fromEntries(ACTIONS.map(a => [a, byAction[a].length])) }),
    droppedNonTech,
    empty: featured.length === 0,
    emptyReason: featured.length === 0
      ? 'No technology swing setups currently clear the execution and evidence gates. Picks are never forced.'
      : null,
    warnings: Object.freeze(warnings),
  });
}

function buildRow(sig, u, ctx, regime, nowIso) {
  const side = sig.side === 'short' ? 'short' : 'long';
  const entry = num(sig.entry), stop = num(sig.stop), target = num(sig.target), price = num(sig.price);
  const complete = planComplete(entry, stop, target, side);
  const signalClass = sig.signalClass || sig.evidenceClass || null;
  const sizingEligible = sig.sizingEligible === true;
  const stale = sig.retainedLabel === 'DATA_STALE' || sig.state === 'stale';
  const triggered = sig.stateHint === 'triggered' || sig.state === 'triggered'
    || (complete && Number.isFinite(price) && (side === 'short' ? price <= entry : price >= entry));
  const dollarVolume = num(ctx && ctx.dollarVolume) ?? num(sig.liquidity && sig.liquidity.dollarVol);
  const liquid = dollarVolume == null ? null : dollarVolume >= MIN_DOLLAR_VOLUME;
  const earningsInDays = num(ctx && ctx.earningsInDays) ?? num(sig.event && sig.event.inDays);
  const earningsBlocks = earningsInDays != null && earningsInDays >= 0 && earningsInDays <= EARNINGS_BLACKOUT_DAYS;
  const chasePct = (complete && Number.isFinite(price) && entry > 0)
    ? +(((price - entry) / entry) * 100 * (side === 'short' ? -1 : 1)).toFixed(2) : null;

  // EXECUTION gates decide the mechanical action (can this be traded as it stands?).
  // GOVERNANCE gates decide the ceiling (is this allowed to be an action at all?).
  // Keeping them apart is what makes the governance demotion visible instead of
  // being silently absorbed into a generic WATCH.
  const executionGates = [];
  if (stale) executionGates.push('inputs are stale');
  if (!complete) executionGates.push('trade plan is incomplete (entry/invalidation/target must all be present and consistent)');
  if (!triggered) executionGates.push('trigger has not occurred');
  if (liquid === false) executionGates.push(`dollar volume below the $${MIN_DOLLAR_VOLUME / 1e6}M swing floor`);
  if (liquid == null) executionGates.push('liquidity unknown');
  if (earningsBlocks) executionGates.push(`earnings in ${earningsInDays} session(s) — inside the entry blackout`);
  if (chasePct != null && chasePct > MAX_CHASE_PCT) executionGates.push(`price is ${chasePct}% beyond the entry — a chase, not an entry`);

  const governanceGates = [];
  if (!signalClass) governanceGates.push('no upstream eligibility verdict — cannot be treated as cleared');
  else if (signalClass !== 'ACTIONABLE') governanceGates.push(`upstream evidence class is ${signalClass}, not ACTIONABLE`);
  if (!sizingEligible) governanceGates.push('not sizing-eligible under the central eligibility gate');
  const gates = [...governanceGates, ...executionGates];

  let action;
  let removalReason = null;
  if (stale) { action = 'WATCH'; removalReason = REMOVAL_REASON.DATA_STALE; }
  else if (sig.retainedLabel === 'INVALIDATED' || sig.state === 'failed') { action = 'EXIT_INVALIDATE'; removalReason = REMOVAL_REASON.STOP_INVALIDATED; }
  else if (sig.state === 'resolved') { action = 'REDUCE'; removalReason = REMOVAL_REASON.TARGET_REACHED; }
  else if (sig.state === 'expired') { action = 'WATCH'; removalReason = REMOVAL_REASON.EXPIRED; }
  else if (sig.retainedLabel === 'HOLD' || sig.retainedLabel === 'MONITOR') { action = 'HOLD'; removalReason = REMOVAL_REASON.RETAINED; }
  else if (chasePct != null && chasePct > MAX_CHASE_PCT) { action = 'DO_NOT_CHASE'; }
  else if (!executionGates.length) action = 'ENTER';
  else if (complete && !triggered) action = 'READY';
  else action = 'WATCH';

  // Governance ceiling — applied LAST and only ever DOWNWARD, so nothing above can
  // lift a research signal into an actionable one. A row that cannot be sized can
  // never be an ENTER either, whatever its class.
  const classCeiling = CLASS_CEILING[signalClass] || 'WATCH';
  const ceiling = sizingEligible ? classCeiling
    : (ACTION_RANK[classCeiling] < ACTION_RANK['READY'] ? 'READY' : classCeiling);
  const demoted = ACTION_RANK[action] < ACTION_RANK[ceiling] ? ceiling : action;
  const demotedFrom = demoted !== action ? action : null;

  const evidence = composeSwingEvidence(sig, u, ctx, regime);

  return Object.freeze({
    ticker: String(sig.ticker).toUpperCase(),
    company: u.company || sig.company || null,
    subsector: u.subsector,
    subsectorLabel: u.subsectorLabel,
    side,
    action: demoted,
    demotedFrom,
    persisted: false,
    // ── Upstream governance, preserved verbatim ──────────────────────────────
    signalClass, sizingEligible, sizingWeight: sig.sizingWeight ?? null,
    retainedLabel: sig.retainedLabel || null,
    upstreamState: sig.state || sig.stateHint || null,
    sources: sig.sources || (sig.source ? [sig.source] : []),
    governedScore: num(sig.score),
    governedPercentile: num(sig.percentile),
    calibrationStatus: sig.calibrationStatus || 'uncalibrated',
    probability: null,
    probabilityNote: 'No out-of-sample calibration artifact exists for this board — no probability is displayed.',
    // ── Why it is here / why now ─────────────────────────────────────────────
    whyOnBoard: (sig.sources || [sig.source]).filter(Boolean).join(' + ') || 'unattributed source',
    whyNow: sig.note || sig.catalyst || (triggered ? 'Trigger level has been taken.' : 'Setup is built but the trigger has not printed.'),
    setupType: sig.setup || sig.tier || sig.strategyFamily || null,
    // ── Plan ─────────────────────────────────────────────────────────────────
    trigger: entry, entryZone: complete ? { low: Math.min(entry, price ?? entry), high: Math.max(entry, price ?? entry) } : null,
    entry, invalidation: stop, target, rr: num(sig.rr),
    price, chasePct,
    expectedHoldingPeriod: `${HOLD_SESSIONS.min}–${HOLD_SESSIONS.max} sessions`,
    // ── Catalyst / event ─────────────────────────────────────────────────────
    catalyst: sig.catalyst || null,
    event: sig.event || null,
    earningsInDays, earningsDate: (ctx && ctx.earningsDate) || null,
    earningsRisk: earningsBlocks ? 'blocking' : (earningsInDays != null && earningsInDays <= 30 ? 'inside-hold-window' : 'none'),
    // ── Technology-relative context (displayed, not ranked on) ───────────────
    techContext: ctx ? Object.freeze({
      rsVsQqq21: num(ctx.rsVsQqq21), rsVsSubsector21: num(ctx.rsVsSubsector21),
      subsectorRank: num(ctx.subsectorRank), subsectorCount: num(ctx.subsectorCount),
      rankAccel: num(ctx.rankAccel), atrPct: num(ctx.atrPct), spreadPct: num(ctx.spreadPct),
      dollarVolume, benchmark: u.benchmark, asOf: ctx.asOf || null,
      usedForRanking: false,
    }) : null,
    // ── Evidence ─────────────────────────────────────────────────────────────
    evidence,
    supporting: evidence.supporting,
    contradicting: evidence.contradicting,
    // ── Gates / lifecycle ────────────────────────────────────────────────────
    gatesFailed: Object.freeze(gates),
    executionGatesFailed: Object.freeze(executionGates),
    governanceGatesFailed: Object.freeze(governanceGates),
    removalReason,
    whatWouldRemoveIt: Object.freeze([
      'invalidation level trades through',
      'relative strength vs QQQ and its subsector rolls over',
      'the entry window ages out without a trigger',
      'an earnings print moves inside the hold window',
      'the upstream eligibility gate downgrades the source',
    ]),
    lastEvaluatedAt: nowIso,
    dataAsOf: (ctx && ctx.asOf) || sig.detectedAt || null,
  });
}

function composeSwingEvidence(sig, u, ctx, regime) {
  const items = [];
  const q = v => (v == null ? 'unknown' : 'medium');
  const pctToStrength = (p, scale) => (p == null ? null : Math.max(-1, Math.min(1, p / scale)));

  if (Number.isFinite(sig.percentile)) {
    items.push(EV.makeEvidence({
      family: 'price-trend', label: 'Cross-sectional rank of the price setup',
      value: sig.percentile, strength: (sig.percentile - 50) / 50, quality: 'medium',
      source: 'op=today rankSignals', detail: `${sig.percentile}th percentile of the ranked cross-section`,
    }));
  }
  if (ctx && ctx.rsVsQqq21 != null) {
    items.push(EV.makeEvidence({
      family: 'relative-strength', label: 'Relative strength vs QQQ (21 sessions)',
      value: ctx.rsVsQqq21, strength: pctToStrength(ctx.rsVsQqq21, 10), quality: 'medium',
      source: 'daily candles', asOf: ctx.asOf,
    }));
  }
  if (ctx && ctx.rsVsSubsector21 != null) {
    items.push(EV.makeEvidence({
      family: 'relative-strength', label: `Relative strength vs ${u.subsectorLabel} (${u.benchmark || 'benchmark'})`,
      value: ctx.rsVsSubsector21, strength: pctToStrength(ctx.rsVsSubsector21, 10), quality: 'medium',
      source: 'daily candles', asOf: ctx.asOf,
    }));
  }
  const dv = ctx && ctx.dollarVolume;
  if (dv != null) {
    items.push(EV.makeEvidence({
      family: 'participation', label: 'Dollar volume',
      value: dv, strength: dv >= 5 * MIN_DOLLAR_VOLUME ? 0.6 : dv >= MIN_DOLLAR_VOLUME ? 0.2 : -0.8,
      quality: 'high', source: 'daily candles', asOf: ctx.asOf,
    }));
  }
  if (ctx && ctx.atrPct != null) {
    items.push(EV.makeEvidence({
      family: 'volatility-execution', label: 'ATR as % of price',
      value: ctx.atrPct, strength: ctx.atrPct > 8 ? -0.5 : ctx.atrPct < 1 ? -0.2 : 0.3,
      quality: 'medium', source: 'daily candles', asOf: ctx.asOf,
    }));
  }
  if (ctx && ctx.earningsInDays != null) {
    items.push(EV.makeEvidence({
      family: 'events-catalysts', label: 'Sessions to the next earnings print',
      value: ctx.earningsInDays,
      strength: ctx.earningsInDays <= EARNINGS_BLACKOUT_DAYS ? -0.9 : ctx.earningsInDays <= 30 ? -0.3 : 0.1,
      quality: 'medium', source: 'earnings calendar', asOf: ctx.asOf,
      direction: ctx.earningsInDays <= 30 ? 'contradicting' : 'supporting',
    }));
  }
  if (sig.catalyst) {
    items.push(EV.makeEvidence({
      family: 'news-thesis', label: 'Named catalyst', strength: 0.4, quality: q(sig.catalyst),
      source: (sig.sources || []).join(',') || 'source', detail: String(sig.catalyst).slice(0, 200),
    }));
  }
  if (regime && regime.states) {
    const s = regime.states.leadership === 'leading' ? 0.5 : regime.states.leadership === 'lagging' ? -0.5 : 0;
    const p = regime.states.participation === 'broad' ? 0.3 : regime.states.participation === 'narrow' ? -0.3 : 0;
    items.push(EV.makeEvidence({
      family: 'market-regime', label: 'Technology regime',
      strength: Math.max(-1, Math.min(1, s + p)), quality: regime.coverage && regime.coverage.breadthSufficient ? 'medium' : 'low',
      source: 'tech-command-regime', asOf: regime.generatedAt,
      detail: regime.classification,
    }));
  }

  const composed = EV.composeEvidence(items, {
    expectedFamilies: ['price-trend', 'relative-strength', 'participation', 'volatility-execution', 'events-catalysts', 'market-regime'],
  });
  return Object.freeze({ ...composed, usedForRanking: false });
}

module.exports = {
  SWING_VIEW_VERSION, HOLD_SESSIONS, ACTIONS, ACTION_RANK, CLASS_CEILING,
  MAX_CHASE_PCT, EARNINGS_BLACKOUT_DAYS, MIN_DOLLAR_VOLUME, REMOVAL_REASON,
  buildSwingBoard, buildRow, composeSwingEvidence, planComplete,
};
