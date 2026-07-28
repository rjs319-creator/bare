// ═══════════════════════════════════════════════════════════════════════════
// RLT state machine — server-authoritative leadership-transition states.
//
//   DISCOVERED       leadership improving, evidence early
//   EMERGING_LEADER  entering upper peer-group with positive rank acceleration
//   PRIMED           leadership established, not extended, structure forming (watch)
//   ARMED            near a valid trigger, participation improving (alert, NOT a buy)
//   TRIGGERED        objective trigger occurred (fillability recorded separately)
//   ACCEPTED         trigger held + positive expected net utility remains
//   WEAKENING        open but deteriorating
//   INVALIDATED      structural downside / failure condition
//   EXPIRED          expected transition did not occur in window
//   COMPLETED        target / time exit / terminal outcome
//
// Pre-trigger states (DISCOVERED..ARMED) derive from the leadership/feature
// cross-section. Post-trigger states derive from the Swing Episode Supervisor
// lifecycle (assessment.lifecycleState — NOT `.lifecycle`, see the premove
// defect) so RLT reuses identity, retention, cooldown and terminal handling
// instead of inventing a second episode system.
//
// Pure module: no I/O.
// ═══════════════════════════════════════════════════════════════════════════

const { VERSIONS, LEADERSHIP } = require('./rlt-config');
const { LIFECYCLE } = require('./swing-lifecycle');

const STATES = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  EMERGING_LEADER: 'EMERGING_LEADER',
  PRIMED: 'PRIMED',
  ARMED: 'ARMED',
  TRIGGERED: 'TRIGGERED',
  ACCEPTED: 'ACCEPTED',
  WEAKENING: 'WEAKENING',
  INVALIDATED: 'INVALIDATED',
  EXPIRED: 'EXPIRED',
  COMPLETED: 'COMPLETED',
});

// Novice action per state — watch/wait/triggered/accepted/avoid only.
const NOVICE_ACTION = Object.freeze({
  DISCOVERED: 'watch', EMERGING_LEADER: 'watch', PRIMED: 'watch', ARMED: 'watch',
  TRIGGERED: 'triggered', ACCEPTED: 'accepted',
  WEAKENING: 'wait', INVALIDATED: 'avoid', EXPIRED: 'avoid', COMPLETED: 'avoid',
});

const REASON = Object.freeze({
  RANK_IMPROVING: 'RANK_IMPROVING',
  RANK_ACCELERATING: 'RANK_ACCELERATING',
  UPPER_PEER_GROUP: 'UPPER_PEER_GROUP',
  LEADERSHIP_ESTABLISHED: 'LEADERSHIP_ESTABLISHED',
  STRUCTURE_FORMING: 'STRUCTURE_FORMING',
  NEAR_TRIGGER: 'NEAR_TRIGGER',
  PARTICIPATION_IMPROVING: 'PARTICIPATION_IMPROVING',
  TOO_EXTENDED: 'TOO_EXTENDED',
  MOVE_CONSUMED: 'MOVE_CONSUMED',
  PEER_WEAKNESS_ONLY: 'PEER_WEAKNESS_ONLY',
  PATH_QUALITY_POOR: 'PATH_QUALITY_POOR',
  SECTOR_HEADWIND: 'SECTOR_HEADWIND',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  LIFECYCLE_DERIVED: 'LIFECYCLE_DERIVED',
});

/**
 * Derive the PRE-TRIGGER inventory state for one eligible candidate.
 * Returns { state|null, reasonCodes, cautions } — null means "not in inventory".
 * Weak sector is a CAUTION (raised uncertainty), never an automatic reject.
 */
function deriveInventoryState({ leadership, features, sectorState = null } = {}) {
  const reasonCodes = [];
  const cautions = [];
  if (!leadership) return { state: null, reasonCodes: [REASON.INSUFFICIENT_EVIDENCE], cautions };

  const L = LEADERSHIP;
  const pct = leadership.pctile;
  const vel5 = leadership.rankVel5;
  const accel = leadership.rankAccel;
  const setup = features ? features.setup : null;
  const path = features ? features.path : null;
  const turnover = features ? features.turnover : null;

  const rankImproving = vel5 != null && vel5 >= L.minRankVelocity * 5;
  const rankRising10 = leadership.rankVel10 != null && leadership.rankVel10 >= L.minRankRise10;
  const upperGroup = pct != null && pct >= L.upperTercile;
  const leader = pct != null && pct >= L.topQuintile && leadership.aboveMedianStreak >= 5;
  const positiveResidual = leadership.positiveSectorResidual === true;
  const accelerating = accel != null && accel > 0;

  // Path acceptability: a single gap or pure peer-collapse rank is not a path.
  const pathOk = path == null
    || ((path.smoothness == null || path.smoothness >= 0.2)
      && (path.spikeShare == null || path.spikeShare <= 0.75));
  const peerWeaknessOnly = leadership.leaderOnPeerWeaknessOnly === true;
  const extended = setup && setup.extensionState === 'extended';
  const consumed = setup && setup.consumedRangePosition != null
    && setup.consumedRangePosition > L.maxConsumedMove
    && (setup.remainingRR == null || setup.remainingRR < 1);
  const structure = setup && setup.pivot != null
    && setup.remainingRR != null && setup.remainingRR >= 1;
  const nearTrigger = setup && setup.pivot != null && setup.distanceToPivotAtr != null
    && setup.distanceToPivotAtr >= 0 && setup.pivot > 0
    && (setup.distanceToPivotAtr * setup.atr) / setup.pivot <= L.armedProximity;
  const participation = turnover && turnover.turnoverAccel != null && turnover.turnoverAccel > 1.0;

  if (sectorState && (sectorState.state === 'WEAKENING' || sectorState.state === 'RISK_OFF')) {
    cautions.push(REASON.SECTOR_HEADWIND);
  }
  if (peerWeaknessOnly) cautions.push(REASON.PEER_WEAKNESS_ONLY);
  if (!pathOk) cautions.push(REASON.PATH_QUALITY_POOR);

  // Extension/consumption demotes an otherwise-primed name to watch-only DISCOVERED.
  const blockedFromSetup = extended || consumed;
  if (extended) cautions.push(REASON.TOO_EXTENDED);
  if (consumed) cautions.push(REASON.MOVE_CONSUMED);

  let state = null;
  if (leader && !blockedFromSetup && structure && nearTrigger && participation && pathOk && !peerWeaknessOnly) {
    state = STATES.ARMED;
    reasonCodes.push(REASON.LEADERSHIP_ESTABLISHED, REASON.NEAR_TRIGGER, REASON.PARTICIPATION_IMPROVING);
  } else if (leader && !blockedFromSetup && structure && pathOk && !peerWeaknessOnly) {
    state = STATES.PRIMED;
    reasonCodes.push(REASON.LEADERSHIP_ESTABLISHED, REASON.STRUCTURE_FORMING);
  } else if (upperGroup && accelerating && pathOk && !peerWeaknessOnly) {
    state = STATES.EMERGING_LEADER;
    reasonCodes.push(REASON.UPPER_PEER_GROUP, REASON.RANK_ACCELERATING);
  } else if ((rankImproving || rankRising10) && positiveResidual) {
    state = STATES.DISCOVERED;
    reasonCodes.push(REASON.RANK_IMPROVING);
  }
  return { state, reasonCodes, cautions };
}

/**
 * Derive the POST-TRIGGER state from a supervisor episode (+ optional Stage-B).
 */
function deriveEpisodeState(episode, stageB = null) {
  const a = episode && episode.assessment ? episode.assessment : null;
  const lc = a ? (a.lifecycleState ?? a.lifecycle ?? null) : null;
  switch (lc) {
    case LIFECYCLE.TARGET_HIT:
    case LIFECYCLE.CLOSED: return STATES.COMPLETED;
    case LIFECYCLE.INVALIDATED: return STATES.INVALIDATED;
    case LIFECYCLE.EXPIRED:
    case LIFECYCLE.NO_FILL: return STATES.EXPIRED;
    case LIFECYCLE.WEAKENING:
    case LIFECYCLE.DATA_STALE: return STATES.WEAKENING;
    case LIFECYCLE.TRIGGERED:
    case LIFECYCLE.THESIS_INTACT:
    case LIFECYCLE.EXTENDED:
    case LIFECYCLE.VALID_BUT_DISPLACED:
      return stageB && stageB.waterfall && stageB.waterfall.expectedNetUtilityBps > 0
        ? STATES.ACCEPTED : STATES.TRIGGERED;
    case LIFECYCLE.ENTERABLE: return STATES.ARMED;
    default: return null;   // pre-trigger: fall back to the inventory state
  }
}

/**
 * Immutable transition record. Every field the audit trail requires.
 */
function makeTransition({
  ticker, session, prevState, newState, reasonCodes = [], evidenceChanges = {},
  price = null, residualRank = null, sectorState = null, triggerState = null,
  fillState = null, dataFreshSessions = null, at = null,
} = {}) {
  return Object.freeze({
    version: VERSIONS.states,
    at, session, ticker,
    prevState: prevState || null,
    newState,
    reasonCodes: Object.freeze([...reasonCodes]),
    evidenceChanges: Object.freeze({ ...evidenceChanges }),
    price, residualRank, sectorState, triggerState, fillState,
    modelVersion: VERSIONS.stageA,
    featureVersion: VERSIONS.features,
    dataFreshSessions,
  });
}

/** Diff two dated state maps → transition records (only actual changes). */
function diffStates({ prev = {}, next = {}, session = null, at = null } = {}) {
  const out = [];
  const tickers = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const ticker of tickers) {
    const p = prev[ticker] || null;
    const n = next[ticker] || null;
    const prevState = p ? p.state : null;
    const newState = n ? n.state : null;
    if (prevState === newState) continue;
    out.push(makeTransition({
      ticker, session, at,
      prevState,
      newState: newState || 'DROPPED',
      reasonCodes: n ? n.reasonCodes : ['NO_LONGER_QUALIFIES'],
      price: n ? n.price : (p ? p.price : null),
      residualRank: n ? n.residualRank : null,
      sectorState: n ? n.sectorState : null,
      triggerState: n ? n.triggerState : null,
      fillState: n ? n.fillState : null,
      dataFreshSessions: n ? n.dataFreshSessions : null,
    }));
  }
  return out;
}

module.exports = {
  STATES, NOVICE_ACTION, REASON,
  deriveInventoryState, deriveEpisodeState, makeTransition, diffStates,
};
