'use strict';
// SWING LIFECYCLE POLICY — the deterministic multi-dimensional state machine.
//
// Given an immutable origin, a fresh metrics read (lib/swing-evaluate), and context (source
// presence, rank, regime, freshness), classify the episode along FIVE independent axes so no
// single collapsed enum has to mean four different things:
//
//   lifecycle   the headline state that buckets the board
//   thesis      is the ORIGINAL thesis strengthening / intact / weakening / broken / completed?
//   action      what should a user do RIGHT NOW (enter / wait / hold / tighten / don't chase / exit)?
//   execution   where is the TRADE (suggested / waiting / filled / no-fill / stopped / target / time)?
//   outcome     the graded result (pending / win / loss / expired± / no-fill / unresolved)
//
// The cascade is ordered by authority: stale data first (never turn a missing feed into a negative
// judgment), then resolved barriers (terminal), then fill status, then thesis health, then source/
// rank displacement (a below-cutoff pick is DISPLACED, not failed). Every branch emits stable
// reason codes. Pure: no clock, no store, no network.

const LIFECYCLE = Object.freeze({
  NEW: 'NEW', WAITING_FOR_TRIGGER: 'WAITING_FOR_TRIGGER', ENTERABLE: 'ENTERABLE', TRIGGERED: 'TRIGGERED',
  THESIS_INTACT: 'THESIS_INTACT', WEAKENING: 'WEAKENING', EXTENDED: 'EXTENDED',
  VALID_BUT_DISPLACED: 'VALID_BUT_DISPLACED', NO_FILL: 'NO_FILL', INVALIDATED: 'INVALIDATED',
  TARGET_HIT: 'TARGET_HIT', EXPIRED: 'EXPIRED', DATA_STALE: 'DATA_STALE', CLOSED: 'CLOSED',
});
const THESIS = Object.freeze({ STRENGTHENING: 'STRENGTHENING', INTACT: 'INTACT', WEAKENING: 'WEAKENING', BROKEN: 'BROKEN', COMPLETED: 'COMPLETED', UNKNOWN_STALE: 'UNKNOWN_STALE' });
const ACTION = Object.freeze({ ENTER_NOW: 'ENTER_NOW', WAIT_FOR_BREAKOUT: 'WAIT_FOR_BREAKOUT', WAIT_FOR_PULLBACK: 'WAIT_FOR_PULLBACK', HOLD_MANAGE: 'HOLD_MANAGE', TIGHTEN_RISK: 'TIGHTEN_RISK', DO_NOT_CHASE: 'DO_NOT_CHASE', DO_NOT_ENTER: 'DO_NOT_ENTER', EXIT_INVALIDATE: 'EXIT_INVALIDATE', NO_ACTION_STALE: 'NO_ACTION_STALE' });
const EXECUTION = Object.freeze({ SUGGESTED: 'SUGGESTED', WAITING: 'WAITING', FILLED: 'FILLED', NO_FILL: 'NO_FILL', GAP_SKIP: 'GAP_SKIP', STOPPED: 'STOPPED', TARGET_REACHED: 'TARGET_REACHED', TIME_EXIT: 'TIME_EXIT' });
const OUTCOME = Object.freeze({ PENDING: 'PENDING', WIN: 'WIN', LOSS: 'LOSS', EXPIRED_POSITIVE: 'EXPIRED_POSITIVE', EXPIRED_NEGATIVE: 'EXPIRED_NEGATIVE', NO_FILL: 'NO_FILL', UNRESOLVED: 'UNRESOLVED' });

const REASON = Object.freeze({
  RANK_CUTOFF: 'RANK_CUTOFF', SOURCE_DROPPED: 'SOURCE_DROPPED', SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  DATA_STALE: 'DATA_STALE', STOP_BREACH: 'STOP_BREACH', TARGET_REACHED: 'TARGET_REACHED',
  ENTRY_NOT_TRIGGERED: 'ENTRY_NOT_TRIGGERED', GAP_BEYOND_MAX_ENTRY: 'GAP_BEYOND_MAX_ENTRY',
  MAX_HOLD_REACHED: 'MAX_HOLD_REACHED', TREND_BREAK: 'TREND_BREAK', RS_DETERIORATION: 'RS_DETERIORATION',
  SECTOR_ROLLOVER: 'SECTOR_ROLLOVER', REGIME_RISK_OFF: 'REGIME_RISK_OFF', VOLUME_FADE: 'VOLUME_FADE',
  BREAKOUT_FAILURE: 'BREAKOUT_FAILURE', EXCESSIVE_EXTENSION: 'EXCESSIVE_EXTENSION', EDGE_CONSUMED: 'EDGE_CONSUMED',
  RISK_REWARD_INADEQUATE: 'RISK_REWARD_INADEQUATE', STRONGER_CANDIDATES: 'STRONGER_CANDIDATES',
  THESIS_STILL_INTACT: 'THESIS_STILL_INTACT', THESIS_STRENGTHENING: 'THESIS_STRENGTHENING',
  SCORE_IMPROVED: 'SCORE_IMPROVED', SCORE_DECLINED: 'SCORE_DECLINED', NEW_CANDIDATE: 'NEW_CANDIDATE',
  AWAITING_TRIGGER: 'AWAITING_TRIGGER', FILLED_MANAGING: 'FILLED_MANAGING',
});

const TERMINAL = Object.freeze(new Set([LIFECYCLE.TARGET_HIT, LIFECYCLE.INVALIDATED, LIFECYCLE.EXPIRED, LIFECYCLE.NO_FILL, LIFECYCLE.CLOSED]));
const isTerminal = (s) => TERMINAL.has(s);

const CFG = Object.freeze({
  scoreStrengthen: 8,        // score delta to call the thesis strengthening
  scoreWeaken: 8,            // score drop to call it weakening
  extendedConsumedPct: 0.85, // fraction of the original move already consumed → extended
  extendedAtr: 3.0,          // ATRs above the 20-DMA → extended
  minRemainingRR: 1.0,       // reward:risk floor for a fresh entry to still be worth it
  rankCutoff: 10,            // top-N below which a still-valid pick is DISPLACED, not failed
  rankDropDisplace: 8,       // rank worsening by ≥ this while thesis intact → displaced
});

function num(v) { return (v === null || v === undefined || v === "" || typeof v === "boolean") ? null : (Number.isFinite(+v) ? +v : null); }

// Is the ORIGINAL thesis strengthening / weakening / intact, from feature drift?
function thesisHealth(m, ctx) {
  const codes = [];
  const scoreDelta = num(m.scoreDelta) != null ? num(m.scoreDelta)
    : (num(ctx.currentScore) != null && num(ctx.originalScore) != null ? num(ctx.currentScore) - num(ctx.originalScore) : null);
  const side = ctx.side === 'short' ? 'short' : 'long';
  const rs = num(m.rsSpy10);
  const belowMa20 = num(m.priceVsMa20) != null ? (side === 'long' ? m.priceVsMa20 < 0 : m.priceVsMa20 > 0) : false;
  const volFade = ctx.volumeFade === true;

  let weakenSignals = 0;
  if (scoreDelta != null && scoreDelta <= -CFG.scoreWeaken) { weakenSignals++; codes.push(REASON.SCORE_DECLINED); }
  if (rs != null && rs < 0) { weakenSignals++; codes.push(REASON.RS_DETERIORATION); }
  if (belowMa20) { weakenSignals++; codes.push(REASON.TREND_BREAK); }
  if (volFade) { weakenSignals++; codes.push(REASON.VOLUME_FADE); }
  if (ctx.sectorRollover === true) { weakenSignals++; codes.push(REASON.SECTOR_ROLLOVER); }

  if (weakenSignals >= 2) return { state: THESIS.WEAKENING, codes };
  if (scoreDelta != null && scoreDelta >= CFG.scoreStrengthen && (rs == null || rs >= 0)) {
    return { state: THESIS.STRENGTHENING, codes: [REASON.SCORE_IMPROVED, REASON.THESIS_STRENGTHENING] };
  }
  if (weakenSignals === 1) return { state: THESIS.WEAKENING, codes };  // one clear crack still de-escalates
  return { state: THESIS.INTACT, codes: [REASON.THESIS_STILL_INTACT] };
}

function isExtended(m) {
  const consumed = num(m.consumedPct);
  const ext = num(m.extensionAtr);
  const rr = num(m.remainingRewardRisk);
  const codes = [];
  let extended = false;
  if (consumed != null && consumed >= CFG.extendedConsumedPct) { extended = true; codes.push(REASON.EDGE_CONSUMED); }
  if (ext != null && ext >= CFG.extendedAtr) { extended = true; codes.push(REASON.EXCESSIVE_EXTENSION); }
  if (rr != null && rr < CFG.minRemainingRR) { extended = true; codes.push(REASON.RISK_REWARD_INADEQUATE); }
  return { extended, codes };
}

// The full classification cascade.
//   ctx: { side, sourceStillSelects, currentRank, originalRank, currentScore, originalScore,
//          regimeRiskOff, dataStale, fillDeadline, volumeFade, sectorRollover, isNew }
function classify(origin, metrics, ctx = {}) {
  const m = metrics || {};
  const side = origin.side === 'short' ? 'short' : 'long';
  const c = { ...ctx, side };
  const fill = m.fill || { status: 'unfilled' };
  const barrier = m.barrier || { barrier: 'none' };
  const hasTrigger = num(origin.originalEntry) != null && num(origin.firstSuggestedPrice) != null &&
    (side === 'long' ? origin.originalEntry > origin.firstSuggestedPrice * 1.001 : origin.originalEntry < origin.firstSuggestedPrice * 0.999);

  // 1) STALE DATA — never a negative judgment. Retain the prior confirmed state; flag it.
  if (c.dataStale) {
    return finalize({
      lifecycle: LIFECYCLE.DATA_STALE, thesis: THESIS.UNKNOWN_STALE, action: ACTION.NO_ACTION_STALE,
      execution: c.priorExecution || EXECUTION.SUGGESTED, outcome: OUTCOME.UNRESOLVED,
      reasonCodes: [c.sourceUnavailable ? REASON.SOURCE_UNAVAILABLE : REASON.DATA_STALE],
    });
  }

  // 2) RESOLVED BARRIERS (post-fill) — terminal.
  if (fill.status === 'filled' && barrier.barrier === 'stop') {
    return finalize({ lifecycle: LIFECYCLE.INVALIDATED, thesis: THESIS.BROKEN, action: ACTION.EXIT_INVALIDATE, execution: EXECUTION.STOPPED, outcome: OUTCOME.LOSS, reasonCodes: [REASON.STOP_BREACH] });
  }
  if (fill.status === 'filled' && barrier.barrier === 'target') {
    return finalize({ lifecycle: LIFECYCLE.TARGET_HIT, thesis: THESIS.COMPLETED, action: ACTION.HOLD_MANAGE, execution: EXECUTION.TARGET_REACHED, outcome: OUTCOME.WIN, reasonCodes: [REASON.TARGET_REACHED] });
  }
  if (fill.status === 'filled' && barrier.barrier === 'time') {
    const pos = num(m.returnSinceFill) != null ? m.returnSinceFill >= 0 : (num(m.returnSinceSuggestion) || 0) >= 0;
    return finalize({ lifecycle: LIFECYCLE.EXPIRED, thesis: THESIS.COMPLETED, action: ACTION.HOLD_MANAGE, execution: EXECUTION.TIME_EXIT, outcome: pos ? OUTCOME.EXPIRED_POSITIVE : OUTCOME.EXPIRED_NEGATIVE, reasonCodes: [REASON.MAX_HOLD_REACHED] });
  }

  // 3) FILL STATUS.
  if (fill.status === 'gap-skip') {
    return finalize({ lifecycle: LIFECYCLE.NO_FILL, thesis: THESIS.INTACT, action: ACTION.DO_NOT_CHASE, execution: EXECUTION.GAP_SKIP, outcome: OUTCOME.NO_FILL, reasonCodes: [REASON.GAP_BEYOND_MAX_ENTRY] });
  }
  const age = num(m.sessionsSinceSuggestion);
  const deadline = num(c.fillDeadline) != null ? c.fillDeadline : (num(origin.originalHoldingWindow) || 10);
  if (fill.status === 'unfilled') {
    if (age != null && age >= deadline) {
      return finalize({ lifecycle: LIFECYCLE.NO_FILL, thesis: THESIS.INTACT, action: ACTION.DO_NOT_ENTER, execution: EXECUTION.NO_FILL, outcome: OUTCOME.NO_FILL, reasonCodes: [REASON.ENTRY_NOT_TRIGGERED] });
    }
    // Still within the window — awaiting the trigger. New on day 0.
    if (c.isNew || age === 0) {
      return finalize({ lifecycle: hasTrigger ? LIFECYCLE.WAITING_FOR_TRIGGER : LIFECYCLE.ENTERABLE, thesis: THESIS.INTACT, action: hasTrigger ? ACTION.WAIT_FOR_BREAKOUT : ACTION.ENTER_NOW, execution: hasTrigger ? EXECUTION.WAITING : EXECUTION.SUGGESTED, outcome: OUTCOME.PENDING, reasonCodes: [REASON.NEW_CANDIDATE] });
    }
    return finalize({ lifecycle: LIFECYCLE.WAITING_FOR_TRIGGER, thesis: THESIS.INTACT, action: ACTION.WAIT_FOR_BREAKOUT, execution: EXECUTION.WAITING, outcome: OUTCOME.PENDING, reasonCodes: [REASON.AWAITING_TRIGGER] });
  }

  // 4) FILLED & OPEN — thesis health, then displacement, then extension.
  const th = thesisHealth(m, c);
  const ext = isExtended(m);
  const disp = displacement(c);
  const regimeCodes = c.regimeRiskOff ? [REASON.REGIME_RISK_OFF] : [];

  // A real thesis crack de-escalates first.
  if (th.state === THESIS.WEAKENING) {
    return finalize({ lifecycle: LIFECYCLE.WEAKENING, thesis: THESIS.WEAKENING, action: ACTION.TIGHTEN_RISK, execution: EXECUTION.FILLED, outcome: OUTCOME.PENDING, reasonCodes: [...th.codes, ...regimeCodes] });
  }
  // Displacement is the cardinal anti-disappearance state: a pick that left its source or dropped
  // below the cutoff is DISPLACED (still valid), never silently reclassified. It outranks the
  // "extended / don't-chase" nuance, whose reason codes are still carried for the reader.
  if (disp) {
    return finalize({ lifecycle: LIFECYCLE.VALID_BUT_DISPLACED, thesis: th.state, action: ACTION.HOLD_MANAGE, execution: EXECUTION.FILLED, outcome: OUTCOME.PENDING, reasonCodes: [...disp, ...(ext.extended ? ext.codes : []), ...th.codes] });
  }
  // Still selected, but run too far to enter fresh.
  if (ext.extended) {
    return finalize({ lifecycle: LIFECYCLE.EXTENDED, thesis: th.state, action: ACTION.DO_NOT_CHASE, execution: EXECUTION.FILLED, outcome: OUTCOME.PENDING, reasonCodes: [...ext.codes, ...regimeCodes] });
  }
  // Healthy, filled, managing.
  return finalize({ lifecycle: LIFECYCLE.THESIS_INTACT, thesis: th.state, action: ACTION.HOLD_MANAGE, execution: EXECUTION.FILLED, outcome: OUTCOME.PENDING, reasonCodes: [REASON.FILLED_MANAGING, ...th.codes, ...regimeCodes] });
}

// Displacement reasons for a still-valid pick that fell out of the current selection/rank.
function displacement(c) {
  const codes = [];
  if (c.sourceStillSelects === false) codes.push(REASON.SOURCE_DROPPED);
  const cr = num(c.currentRank), or = num(c.originalRank);
  if (cr != null && cr > CFG.rankCutoff) codes.push(REASON.RANK_CUTOFF);
  if (cr != null && or != null && (cr - or) >= CFG.rankDropDisplace) codes.push(REASON.STRONGER_CANDIDATES);
  return codes.length ? codes : null;
}

function finalize(s) {
  return Object.freeze({
    lifecycle: s.lifecycle, thesis: s.thesis, action: s.action, execution: s.execution, outcome: s.outcome,
    reasonCodes: Object.freeze([...new Set(s.reasonCodes.filter(Boolean))]),
    terminal: isTerminal(s.lifecycle),
  });
}

module.exports = { LIFECYCLE, THESIS, ACTION, EXECUTION, OUTCOME, REASON, TERMINAL, isTerminal, CFG, classify, thesisHealth, isExtended };
