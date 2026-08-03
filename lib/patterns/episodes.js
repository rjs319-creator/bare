'use strict';
// PATTERN EPISODES — the persistent, stateful life of a setup.
//
// A pattern is NOT a rolling-window recomputation: once detected it becomes an EPISODE
// with FROZEN structural levels, a real state machine, an append-only transition history,
// and a unique identity. New bars upgrade or downgrade the episode; they never move the
// original trigger. Failed and expired episodes are retained with the rule that killed
// them. "Failed Today" means a previously non-failed episode transitioned to FAILED on
// the current date — never "a failed-looking chart appeared in today's scan".
//
// Pure engine: no storage, no network, no clock of its own. Persistence lives in
// pattern-routes.js; this module is fully replayable in tests.

const crypto = require('crypto');
const ST = require('./structure');

const EPISODE_SCHEMA_VERSION = 'pattern-episode-v2';

const EP_STATES = Object.freeze({
  EMERGING: 'EMERGING',
  FORMING: 'FORMING',
  READY: 'READY',
  TRIGGERED_PENDING_CONFIRMATION: 'TRIGGERED_PENDING_CONFIRMATION',
  CONFIRMED: 'CONFIRMED',
  RETESTING: 'RETESTING',
  MANAGING: 'MANAGING',
  TARGET_REACHED: 'TARGET_REACHED',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});

const TERMINAL_STATES = Object.freeze(new Set([EP_STATES.TARGET_REACHED, EP_STATES.STOPPED, EP_STATES.FAILED, EP_STATES.EXPIRED]));
const PRE_ENTRY_STATES = Object.freeze(new Set([EP_STATES.EMERGING, EP_STATES.FORMING, EP_STATES.READY, EP_STATES.TRIGGERED_PENDING_CONFIRMATION, EP_STATES.CONFIRMED, EP_STATES.RETESTING]));

const isNum = v => typeof v === 'number' && isFinite(v);
const isTerminal = s => TERMINAL_STATES.has(s);

// Default expiry (bars without an entry) per timeframe — a setup that never triggers
// ages out instead of lingering forever.
const EXPIRE_BARS = { session: 5, '20d': 15, '60d': 40, '120d': 80 };
// Post-entry time stop (bars in MANAGING before EXPIRED/timeout).
const HOLD_BARS = { session: 5, '20d': 21, '60d': 42, '120d': 63 };

// ---- identity ------------------------------------------------------------------

// The trigger's identity: type + frozen price. Part of the episode key so a genuinely
// different structural trigger is a different episode, never a silent overwrite.
function triggerIdentity(triggerLevel) {
  if (!triggerLevel || !isNum(triggerLevel.price)) return 'no-trigger';
  return `${triggerLevel.type || 'level'}@${triggerLevel.price}`;
}

// Unique episode key: ticker | family | direction | timeframe | patternStart | trigger
// identity | model version. (Closes the "resolved-record key collides" defect.)
function episodeKeyOf({ ticker, family, direction, timeframe, patternStart, triggerLevel, modelVersion }) {
  return [ticker, family, direction, timeframe, patternStart, triggerIdentity(triggerLevel), modelVersion || 'v?'].join('|');
}

function episodeIdOf(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 12);
}

// ---- creation ------------------------------------------------------------------

// Initial state from the detection's structural phase. An already-invalidated or
// expired detection never becomes an episode (there is nothing to track forward).
function initialStateFor(detection) {
  if (detection.invalidationHit) return null;
  const phase = detection.phase;
  if (phase === 'EXPIRED' || phase === 'FAILED') return null;
  if (detection.breakoutConfirmed) return detection.retesting ? EP_STATES.RETESTING : EP_STATES.CONFIRMED;
  if (detection.confirmation && detection.confirmation.status === 'INTRADAY_PENETRATION') return EP_STATES.TRIGGERED_PENDING_CONFIRMATION;
  if (phase === 'NEAR_TRIGGER') return EP_STATES.READY;
  if (phase === 'FORMING' || phase === 'STALLING') return EP_STATES.FORMING;
  return EP_STATES.EMERGING;
}

// Create a NEW episode from a valid detection. Returns null when the detection cannot
// legitimately start an episode (invalid structure, no plan, already dead).
function createEpisode(detection, { now, date, context = {}, modelVersion, featureVersion } = {}) {
  if (!detection || detection.structurallyInvalid || !detection.plan || !detection.triggerLevel) return null;
  const state = initialStateFor(detection);
  if (!state) return null;
  const key = episodeKeyOf({
    ticker: detection.ticker, family: detection.family, direction: detection.direction,
    timeframe: detection.timeframe, patternStart: detection.patternStart,
    triggerLevel: detection.triggerLevel, modelVersion,
  });
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: episodeIdOf(key),
    key,
    ticker: detection.ticker,
    family: detection.family,
    label: detection.label,
    direction: detection.direction,
    timeframe: detection.timeframe,
    horizon: detection.horizon || null,
    detectedAt: now,
    detectedDate: date,
    patternStart: detection.patternStart,
    patternAsOf: detection.patternAsOf,
    pivotsUsed: detection.pivotsUsed || [],
    // FROZEN at creation — never recomputed from a rolling window again.
    frozen: {
      trigger: detection.triggerLevel,
      invalidation: detection.invalidationLevel,
      target: detection.targetLevel,
      plan: detection.plan,
      atr: detection.geometry ? detection.geometry.atr : null,
      frozenAt: now,
    },
    // current levels start equal to frozen; only versioned pre-entry amendments may move
    // target/invalidation. The TRIGGER has no current counterpart on purpose.
    current: {
      target: detection.targetLevel ? detection.targetLevel.price : null,
      invalidation: detection.invalidationLevel ? detection.invalidationLevel.price : null,
    },
    setupQuality: detection.plan.quality,
    structuralValidity: detection.structuralValidity,
    featureCoverage: detection.featureCoverage,
    missingRequiredFeatures: detection.missingRequiredFeatures || [],
    similarity: {
      initial: detection.similarity ? detection.similarity.combined : null,
      current: detection.similarity ? detection.similarity.combined : null,
    },
    regimeAtDetection: context.marketRegime || 'UNKNOWN',
    sectorRegimeAtDetection: context.sectorRegime || 'UNKNOWN',
    entry: { state: 'NONE', date: null, price: null },
    state,
    stateSince: now,
    transitions: [{ from: null, to: state, at: now, date, rule: 'DETECTED', evidence: { structuralValidity: detection.structuralValidity, confirmation: detection.confirmation && detection.confirmation.status } }],
    amendments: [],
    barsSinceDetection: 0,
    barsSinceEntry: 0,
    expiresAfterBars: EXPIRE_BARS[detection.timeframe] ?? 20,
    holdBars: HOLD_BARS[detection.timeframe] ?? 21,
    lastEvaluatedAt: now,
    lastEvaluatedDate: date,
    modelVersion: modelVersion || null,
    featureVersion: featureVersion || null,
    validationEligible: true,
    affectedProductionDecision: false,
  };
}

// ---- advancement ---------------------------------------------------------------

function transition(ep, to, { now, date, rule, evidence = {} }) {
  return {
    ...ep,
    state: to,
    stateSince: now,
    transitions: [...ep.transitions, { from: ep.state, to, at: now, date, rule, evidence }],
    lastEvaluatedAt: now,
    lastEvaluatedDate: date,
  };
}

function touched(ep, { now, date, extra = {} }) {
  return { ...ep, lastEvaluatedAt: now, lastEvaluatedDate: date, ...extra };
}

// Advance ONE episode with one new bar. Restores nothing itself — the caller passes the
// PRIOR episode record (persistence guarantees state survives across scans).
//   snap: { bar, now, date, intradayConfirmed (live confirmation engine verdict, optional),
//           currentSimilarity (optional), nearTriggerAtr (optional threshold) }
// Returns a NEW episode object (input never mutated).
function advanceEpisode(prev, snap = {}) {
  if (!prev || !snap.bar) return prev;
  if (isTerminal(prev.state)) return prev; // terminal episodes are retained, not re-run

  const { bar } = snap;
  const now = snap.now || new Date().toISOString();
  const date = snap.date || bar.date || null;
  // Skip double-evaluation of the same bar (idempotent daily advance).
  if (prev.lastEvaluatedDate && bar.date && String(bar.date) <= String(prev.lastEvaluatedDate)) return prev;

  const long = prev.direction !== 'SHORT';
  const atr = prev.frozen.atr;
  const trig = prev.frozen.trigger.price;
  const stopLevel = isNum(prev.current.invalidation) ? prev.current.invalidation : prev.frozen.invalidation.price;
  const targetLevel = isNum(prev.current.target) ? prev.current.target : prev.frozen.target.price;

  const vsTrigger = ST.assessBarVsLevel(bar, trig, prev.direction, atr || 1);
  const vsStop = ST.assessBarVsLevel(bar, stopLevel, long ? 'SHORT' : 'LONG', atr || 1);
  const vsTarget = ST.assessBarVsLevel(bar, targetLevel, prev.direction, atr || 1);

  let ep = touched(prev, {
    now, date,
    extra: {
      barsSinceDetection: prev.barsSinceDetection + 1,
      barsSinceEntry: prev.entry.state === 'FILLED' ? prev.barsSinceEntry + 1 : 0,
      similarity: isNum(snap.currentSimilarity) ? { ...prev.similarity, current: snap.currentSimilarity } : prev.similarity,
    },
  });

  // ---- post-entry management first ----
  if (ep.state === EP_STATES.MANAGING) {
    const stopHit = vsStop && vsStop.penetrated;   // a stop order fills on an intraday touch
    const targetHit = vsTarget && vsTarget.penetrated;
    if (stopHit && targetHit) {
      return transition(ep, EP_STATES.STOPPED, { now, date, rule: 'STOP_AND_TARGET_SAME_BAR_CONSERVATIVE', evidence: { note: 'both barriers inside one bar — resolved as STOP (conservative daily-data assumption)' } });
    }
    if (stopHit) return transition(ep, EP_STATES.STOPPED, { now, date, rule: 'STOP_HIT', evidence: { stop: stopLevel } });
    if (targetHit) return transition(ep, EP_STATES.TARGET_REACHED, { now, date, rule: 'TARGET_REACHED', evidence: { target: targetLevel } });
    if (ep.barsSinceEntry >= ep.holdBars) return transition(ep, EP_STATES.EXPIRED, { now, date, rule: 'TIME_STOP', evidence: { barsHeld: ep.barsSinceEntry } });
    return ep;
  }

  // ---- pre-entry invalidation (closing basis: one intraday wick cannot kill a setup) ----
  if (vsStop && vsStop.closedThrough) {
    return transition(ep, EP_STATES.FAILED, { now, date, rule: ep.state === EP_STATES.CONFIRMED || ep.state === EP_STATES.RETESTING ? 'POST_CONFIRM_INVALIDATION' : 'INVALIDATION_CLOSE', evidence: { invalidation: stopLevel, close: bar.close } });
  }

  // ---- entry fill: a CONFIRMED/RETESTING setup fills when a later bar reaches the
  // trigger (or gaps beyond it). The fill price is recorded honestly — a gap fills at
  // the open, never at the (better) trigger price.
  if (ep.state === EP_STATES.CONFIRMED || ep.state === EP_STATES.RETESTING) {
    if (vsTrigger && vsTrigger.penetrated) {
      const fillPrice = vsTrigger.gapThrough ? bar.open : (long ? Math.max(trig, bar.open > trig ? bar.open : trig) : Math.min(trig, bar.open < trig ? bar.open : trig));
      const filled = transition(ep, EP_STATES.MANAGING, { now, date, rule: 'ENTRY_FILLED', evidence: { fillPrice, gapThrough: !!vsTrigger.gapThrough } });
      return { ...filled, entry: { state: 'FILLED', date, price: Math.round(fillPrice * 10000) / 10000 } };
    }
    // Retest bookkeeping: back near the trigger without invalidating.
    if (ep.state === EP_STATES.CONFIRMED && vsTrigger && !vsTrigger.penetrated && isNum(vsTrigger.distanceAtr) && vsTrigger.distanceAtr > -0.75) {
      return transition(ep, EP_STATES.RETESTING, { now, date, rule: 'RETEST', evidence: { distanceAtr: vsTrigger.distanceAtr } });
    }
    if (ep.state === EP_STATES.RETESTING && vsTrigger && vsTrigger.closedThrough) {
      return transition(ep, EP_STATES.CONFIRMED, { now, date, rule: 'RETEST_HELD', evidence: { close: bar.close } });
    }
    return maybeExpire(ep, { now, date });
  }

  // ---- pre-trigger progression ----
  if (vsTrigger && vsTrigger.closedThrough) {
    return transition(ep, EP_STATES.CONFIRMED, { now, date, rule: snap.intradayConfirmed ? 'INTRADAY_AND_CLOSE_CONFIRMED' : 'CLOSE_CONFIRMED', evidence: { close: bar.close, trigger: trig } });
  }
  if (vsTrigger && vsTrigger.penetrated) {
    if (ep.state !== EP_STATES.TRIGGERED_PENDING_CONFIRMATION) {
      return transition(ep, EP_STATES.TRIGGERED_PENDING_CONFIRMATION, { now, date, rule: 'INTRADAY_PENETRATION', evidence: { high: bar.high, low: bar.low, trigger: trig } });
    }
    return maybeExpire(ep, { now, date });
  }
  if (ep.state === EP_STATES.TRIGGERED_PENDING_CONFIRMATION) {
    // Penetrated earlier but closed back away without confirming.
    return transition(ep, EP_STATES.READY, { now, date, rule: 'PENETRATION_REJECTED', evidence: { close: bar.close } });
  }
  // Near-trigger promotion for developing structures.
  const nearAtr = isNum(snap.nearTriggerAtr) ? snap.nearTriggerAtr : 0.5;
  if ((ep.state === EP_STATES.EMERGING || ep.state === EP_STATES.FORMING)
      && vsTrigger && isNum(vsTrigger.distanceAtr) && vsTrigger.distanceAtr >= -nearAtr) {
    return transition(ep, EP_STATES.READY, { now, date, rule: 'NEAR_TRIGGER', evidence: { distanceAtr: vsTrigger.distanceAtr } });
  }
  return maybeExpire(ep, { now, date });
}

function maybeExpire(ep, { now, date }) {
  if (ep.entry.state === 'NONE' && ep.barsSinceDetection >= ep.expiresAfterBars) {
    return transition(ep, EP_STATES.EXPIRED, { now, date, rule: 'AGED_OUT', evidence: { bars: ep.barsSinceDetection, limit: ep.expiresAfterBars } });
  }
  return ep;
}

// ---- amendments ----------------------------------------------------------------

// Explicit, versioned, pre-entry-only amendment of the CURRENT target/invalidation.
// The frozen trigger can never be amended. Returns null when not allowed.
function amendEpisode(ep, { field, value, reason, now, date }) {
  if (!ep || !PRE_ENTRY_STATES.has(ep.state) || ep.entry.state !== 'NONE') return null;
  if (field !== 'target' && field !== 'invalidation') return null;
  if (!isNum(value) || !reason) return null;
  const prevValue = ep.current[field];
  return {
    ...ep,
    current: { ...ep.current, [field]: value },
    amendments: [...ep.amendments, { field, from: prevValue, to: value, reason, at: now, date, version: ep.amendments.length + 1 }],
  };
}

// ---- dedup ---------------------------------------------------------------------

// Two detections describe the SAME structure when they share ticker/family/direction/
// timeframe and either reference overlapping pivots or have near-identical triggers.
function sameStructure(a, b) {
  if (a.ticker !== b.ticker || a.family !== b.family || a.direction !== b.direction || a.timeframe !== b.timeframe) return false;
  const atr = (a.geometry && a.geometry.atr) || (b.geometry && b.geometry.atr) || null;
  const ta = a.triggerLevel && a.triggerLevel.price;
  const tb = b.triggerLevel && b.triggerLevel.price;
  if (isNum(ta) && isNum(tb) && isNum(atr) && atr > 0 && Math.abs(ta - tb) <= 0.5 * atr) return true;
  const pa = new Set((a.pivotsUsed || []).map(p => p.date || p.idx));
  const shared = (b.pivotsUsed || []).filter(p => pa.has(p.date || p.idx)).length;
  const denom = Math.min(pa.size, (b.pivotsUsed || []).length) || 1;
  return shared / denom >= 0.5;
}

// Collapse overlapping same-structure detections to the single best (highest structural
// validity, then similarity).
function dedupeDetections(detections = []) {
  const kept = [];
  const sorted = detections.slice().sort((x, y) => (y.structuralValidity || 0) - (x.structuralValidity || 0) || ((y.similarity && y.similarity.combined) || 0) - ((x.similarity && x.similarity.combined) || 0));
  for (const d of sorted) {
    if (!kept.some(k => sameStructure(k, d))) kept.push(d);
  }
  return kept;
}

// Find the existing (non-terminal) episode this detection belongs to, if any — so a
// sliding window re-detecting the same structure UPDATES the episode instead of
// spawning a duplicate.
function matchEpisode(episodes = [], detection, modelVersion) {
  const key = episodeKeyOf({
    ticker: detection.ticker, family: detection.family, direction: detection.direction,
    timeframe: detection.timeframe, patternStart: detection.patternStart,
    triggerLevel: detection.triggerLevel, modelVersion,
  });
  const exact = episodes.find(e => e.key === key);
  if (exact) return exact;
  return episodes.find(e => !isTerminal(e.state) && sameStructure(
    { ticker: e.ticker, family: e.family, direction: e.direction, timeframe: e.timeframe, triggerLevel: e.frozen.trigger, pivotsUsed: e.pivotsUsed, geometry: { atr: e.frozen.atr } },
    detection
  )) || null;
}

// ---- queries -------------------------------------------------------------------

// STRICT "Failed Today": the episode's transition INTO FAILED happened on `date` from a
// previously non-failed state.
function failedOn(ep, date) {
  if (!ep || ep.state !== EP_STATES.FAILED) return false;
  const t = ep.transitions[ep.transitions.length - 1];
  return !!t && t.to === EP_STATES.FAILED && t.from !== EP_STATES.FAILED && t.date === date;
}

// Each episode appears in exactly ONE primary bucket (attributes like "strong" are
// badges, not extra cards).
function primaryBucket(ep, { date } = {}) {
  switch (ep.state) {
    case EP_STATES.CONFIRMED:
    case EP_STATES.TRIGGERED_PENDING_CONFIRMATION: return 'triggeredNow';
    case EP_STATES.READY: return 'ready';
    case EP_STATES.EMERGING:
    case EP_STATES.FORMING: return 'developing';
    case EP_STATES.RETESTING: return 'retests';
    case EP_STATES.MANAGING: return 'manage';
    case EP_STATES.FAILED: return failedOn(ep, date) ? 'failedToday' : 'failedEarlier';
    case EP_STATES.EXPIRED: return 'expired';
    case EP_STATES.TARGET_REACHED:
    case EP_STATES.STOPPED: return 'resolved';
    default: return 'developing';
  }
}

module.exports = {
  EP_STATES, TERMINAL_STATES, PRE_ENTRY_STATES, EPISODE_SCHEMA_VERSION,
  EXPIRE_BARS, HOLD_BARS,
  episodeKeyOf, episodeIdOf, triggerIdentity,
  createEpisode, advanceEpisode, amendEpisode,
  dedupeDetections, sameStructure, matchEpisode,
  failedOn, primaryBucket, isTerminal,
};
