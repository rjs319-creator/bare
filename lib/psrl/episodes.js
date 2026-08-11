'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — persistent trend-episode ledger. PURE transition logic.
//
// Once selected, a name is RETAINED and every upgrade/downgrade/invalidation
// is explained. Episode-shaped from day one (addendum §2): immutable records
// with firstEligible/firstActionable dates, daily observations, terminal
// events and right-censoring. An episode still active at the end of available
// history is RIGHT_CENSORED — never mislabeled success or failure.
// applyDay() is idempotent for a given (ledger, snapshot) pair: re-running
// the same asOf produces the same ledger.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS } = require('./config');

const STATUSES = Object.freeze([
  'NEW', 'ACTIVE', 'IMPROVING', 'CONSOLIDATING', 'EXTENDED', 'DEFENSIVE',
  'LOSING_LEADERSHIP', 'INVALIDATED', 'EXPIRED',
]);

const TERMINAL_EVENTS = Object.freeze([
  'ACCELERATION', 'ORDERLY_PAUSE', 'RESUMED_ADVANCE', 'PLATEAU', 'STAGNATION',
  'RELATIVE_LEADERSHIP_LOSS', 'ABSOLUTE_TREND_BREAK', 'STOP_OR_INVALIDATION',
  'BINARY_EVENT_DISCONTINUITY', 'LIQUIDITY_FAILURE', 'DATA_FAILURE',
  'HORIZON_EXPIRED', 'RIGHT_CENSORED',
]);

const DEFAULTS = Object.freeze({
  selectTopK: 30,           // qualifying ranks admitted per day
  expireAfterSessions: 63,  // sessions without qualifying before EXPIRED
  maxObservations: 90,      // per-episode daily observations kept
  maxClosed: 120,           // closed episodes retained for research/UI
});

const isNum = (x) => Number.isFinite(x);

function emptyLedger(asOf = null) {
  return { version: VERSIONS.episodes, asOf, episodes: {}, closed: [], counter: 0 };
}

function qualifies(card, topK) {
  return !!card && card.available && !card.disqualified && !card.support?.abstain
    && (card.quadrant === 'TRUE_LEADER' || card.quadrant === 'DEFENSIVE_LEADER')
    && isNum(card.rank) && card.rank <= topK;
}

function observationOf(card, asOf) {
  return {
    date: asOf,
    quadrant: card?.quadrant ?? null,
    stage: card?.stage ?? null,
    combined: card?.scores?.combinedAfterPenalties ?? null,
    rank: card?.rank ?? null,
    entry: card?.entry?.state ?? null,
    arrows: card?.arrows ?? null,
    pathState: card?.absPath?.state ?? null,
    price: card?.liquidity?.price ?? null,
  };
}

function statusFor(card, prevStatus) {
  if (!card || !card.available) return 'ACTIVE';
  if (card.absPath?.state === 'TREND_BROKEN') return 'INVALIDATED';
  if (card.quadrant === 'DEFENSIVE_LEADER') return 'DEFENSIVE';
  if (card.stage === 'LOSING_LEADERSHIP') return 'LOSING_LEADERSHIP';
  if (card.stage === 'EXTENDED_LEADER') return 'EXTENDED';
  if (card.absPath?.state === 'ORDERLY_PAUSE' || card.absPath?.state === 'JUMP_HOLDING') return 'CONSOLIDATING';
  if (card.arrows?.trajectory === 'UP') return 'IMPROVING';
  return prevStatus === 'NEW' ? 'ACTIVE' : (prevStatus === 'INVALIDATED' ? 'ACTIVE' : 'ACTIVE');
}

/** Reason a previously-qualifying episode no longer qualifies today. */
function disqualifyReason(card) {
  if (!card) return 'DATA_STALE';
  if (!card.available) return (card.eligibility?.reasons || [])[0] === 'BELOW_LIQUIDITY_FLOOR' ? 'LIQUIDITY_FAILURE' : 'DATA_STALE';
  if (card.absPath?.state === 'TREND_BROKEN') return 'HARD_INVALIDATION';
  if (card.absPath?.state === 'JUMP_PLATEAU') return 'JUMP_PLATEAU_DETECTED';
  if (card.quadrant === 'MARKET_CARRIED_LAGGARD') return 'LOST_MARKET_LEADERSHIP';
  if (card.quadrant === 'AVOID') return 'LOST_LEADERSHIP';
  if (isNum(card.residual?.residualAccel) && card.residual.residualAccel < -0.001) return 'RESIDUAL_TREND_WEAKENED';
  if (isNum(card.extensionAtr) && card.extensionAtr > 5) return 'EXCESSIVE_EXTENSION';
  return 'DISPLACED_BY_STRONGER_CANDIDATES';
}

function terminalEventFor(reason, card) {
  if (reason === 'HARD_INVALIDATION') return 'ABSOLUTE_TREND_BREAK';
  if (reason === 'JUMP_PLATEAU_DETECTED') return 'PLATEAU';
  if (reason === 'LOST_MARKET_LEADERSHIP' || reason === 'LOST_LEADERSHIP') return 'RELATIVE_LEADERSHIP_LOSS';
  if (reason === 'LIQUIDITY_FAILURE') return 'LIQUIDITY_FAILURE';
  if (reason === 'DATA_STALE') return 'DATA_FAILURE';
  if (card?.eventRisk) return 'BINARY_EVENT_DISCONTINUITY';
  return null; // non-terminal disqualification (retained, may re-qualify)
}

/**
 * Apply one day's snapshot to the ledger. Returns { ledger, transitions } —
 * a NEW ledger object (no mutation of the input).
 */
function applyDay(ledger, snapshot, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const prev = ledger && ledger.episodes ? ledger : emptyLedger();
  if (prev.asOf === snapshot.asOf) return { ledger: prev, transitions: [], idempotent: true };

  const byTicker = new Map((snapshot.cards || []).map((c) => [c.ticker, c]));
  const episodes = {};
  const closed = [...(prev.closed || [])];
  const transitions = [];
  let counter = prev.counter || 0;
  const asOf = snapshot.asOf;

  // 1) Update existing episodes.
  for (const [ticker, ep] of Object.entries(prev.episodes)) {
    const card = byTicker.get(ticker) || null;
    const obs = observationOf(card, asOf);
    const price = obs.price;
    const stillQualifies = qualifies(card, o.selectTopK * 2); // retention band is looser than admission
    const next = {
      ...ep,
      observations: [...ep.observations.slice(-(o.maxObservations - 1)), obs],
      currentScores: { combined: obs.combined, rank: obs.rank },
      currentQuadrant: obs.quadrant, currentStage: obs.stage,
      currentArrows: obs.arrows, currentEntry: obs.entry,
      trendAge: card?.trendAge ?? ep.trendAge,
      peakScore: Math.max(ep.peakScore ?? -Infinity, obs.combined ?? -Infinity),
      peakPrice: Math.max(ep.peakPrice ?? -Infinity, price ?? -Infinity),
      mfe: isNum(price) && isNum(ep.startPrice) && ep.startPrice > 0
        ? Math.max(ep.mfe ?? 0, price / ep.startPrice - 1) : ep.mfe,
      mae: isNum(price) && isNum(ep.startPrice) && ep.startPrice > 0
        ? Math.min(ep.mae ?? 0, price / ep.startPrice - 1) : ep.mae,
      rightCensored: true, // active episodes are censored until a terminal event
    };

    if (stillQualifies) {
      next.lastQualifyingDate = asOf;
      next.sessionsSinceQualifying = 0;
      const s = statusFor(card, ep.status);
      if (s !== ep.status) transitions.push({ ticker, from: ep.status, to: s, date: asOf, reason: 'STATE_UPDATE' });
      next.status = s;
      if (!next.firstActionableDate && card.entry && card.entry.state.startsWith('BUY')) {
        next.firstActionableDate = asOf;
      }
    } else {
      const reason = disqualifyReason(card);
      const terminal = terminalEventFor(reason, card);
      next.sessionsSinceQualifying = (ep.sessionsSinceQualifying || 0) + 1;
      if (terminal && terminal !== null && (reason === 'HARD_INVALIDATION' || reason === 'JUMP_PLATEAU_DETECTED'
        || reason === 'LIQUIDITY_FAILURE' || reason === 'DATA_STALE')) {
        next.status = 'INVALIDATED';
        next.terminalEvent = terminal;
        next.terminalDate = asOf;
        next.invalidationDate = asOf;
        next.rightCensored = false;
        transitions.push({ ticker, from: ep.status, to: 'INVALIDATED', date: asOf, reason });
        closed.push(next);
        continue;
      }
      if (next.sessionsSinceQualifying >= o.expireAfterSessions) {
        next.status = 'EXPIRED';
        next.terminalEvent = 'HORIZON_EXPIRED';
        next.terminalDate = asOf;
        next.rightCensored = false;
        transitions.push({ ticker, from: ep.status, to: 'EXPIRED', date: asOf, reason });
        closed.push(next);
        continue;
      }
      if (ep.status !== 'LOSING_LEADERSHIP' && (reason === 'LOST_MARKET_LEADERSHIP' || reason === 'RESIDUAL_TREND_WEAKENED' || reason === 'LOST_LEADERSHIP')) {
        next.status = 'LOSING_LEADERSHIP';
        transitions.push({ ticker, from: ep.status, to: 'LOSING_LEADERSHIP', date: asOf, reason });
      }
      next.reasonHistory = [...(ep.reasonHistory || []).slice(-19), { date: asOf, reason }];
    }
    episodes[ticker] = next;
  }

  // 2) Admit new episodes.
  for (const card of snapshot.cards || []) {
    if (episodes[card.ticker] || !qualifies(card, o.selectTopK)) continue;
    counter++;
    const obs = observationOf(card, asOf);
    episodes[card.ticker] = {
      episodeId: `psrl:${card.ticker}:${asOf}:${counter}`,
      symbol: card.ticker,
      episodeVersion: VERSIONS.episodes,
      engineVersion: snapshot.engineVersion,
      featureVersion: snapshot.featureVersion,
      scoreVersion: snapshot.scoreVersion,
      startDate: asOf,
      firstSeenAt: asOf,
      firstEligibleDate: asOf,
      firstActionableDate: card.entry?.state?.startsWith('BUY') ? asOf : null,
      startPrice: obs.price,
      initialScores: {
        persistentTrend: card.scores?.persistentTrend, relativeLeadership: card.scores?.relativeLeadership,
        combined: card.scores?.combinedAfterPenalties,
      },
      initialQuadrant: card.quadrant, initialStage: card.stage,
      initialArrows: card.arrows, initialEntry: card.entry?.state,
      observations: [obs],
      currentScores: { combined: obs.combined, rank: obs.rank },
      currentQuadrant: obs.quadrant, currentStage: obs.stage,
      currentArrows: obs.arrows, currentEntry: obs.entry,
      trendAge: card.trendAge ?? null,
      peakScore: obs.combined, peakPrice: obs.price,
      mfe: 0, mae: 0,
      lastQualifyingDate: asOf,
      sessionsSinceQualifying: 0,
      invalidationDate: null,
      status: 'NEW',
      terminalEvent: null, terminalDate: null,
      rightCensored: true,
      dataQuality: card.support?.grade ?? null,
      reasonHistory: [],
    };
    transitions.push({ ticker: card.ticker, from: null, to: 'NEW', date: asOf, reason: 'ADMITTED' });
  }

  return {
    ledger: {
      version: VERSIONS.episodes,
      asOf,
      episodes,
      closed: closed.slice(-o.maxClosed),
      counter,
    },
    transitions,
    idempotent: false,
  };
}

module.exports = { STATUSES, TERMINAL_EVENTS, DEFAULTS, emptyLedger, applyDay, qualifies, disqualifyReason, terminalEventFor };
