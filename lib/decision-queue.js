'use strict';
// SHARED DECISION QUEUE — one ranked list across Market Pulse, Trade Alerts, and Options.
//
// Ranking is an EXPLICIT, VERSIONED, COMPONENT-EXPOSED hypothesis:
//
//   materiality × novelty × evidenceQuality × regimeFit × reactionGap
//     × portfolioRelevance × liquidity  −  crowding − eventRisk − executionCost
//
// Three things this deliberately is NOT:
//   • It is not an expected return. It has no units and no calibration. `isExpectedReturn`
//     is false on every score and the note rides along in the payload.
//   • It is not freshness ordering. A brand-new observation of an already-known state
//     scores near zero on novelty.
//   • It is not an LLM prominence ranking. Every component is a number a deterministic
//     module produced, and each one is exposed for audit.
//
// Missing components do NOT default to 1.0 — that would be the same defect the execution
// layer had. A missing multiplicative component is treated as UNKNOWN, which caps the
// utility and marks the record's component coverage.
//
// Alerts fire on TRANSITIONS, not on repeated observations of the same state.
//
// Pure; `now` is injected.

const { STATE, LIFECYCLE } = require('./decision-contract');

const UTILITY_VERSION = 'decision-utility-v1';
const UTILITY_NOTE =
  'Decision utility is a versioned RANKING HYPOTHESIS with exposed components. It has no '
  + 'units, is not calibrated, and is not an expected return or a probability. It is being '
  + 'evaluated prospectively; until that evaluation clears, treat it as an ordering only.';

// Multiplicative components (each 0..1) and subtractive penalties (each 0..1).
const MULTIPLICATIVE = Object.freeze(['materiality', 'novelty', 'evidenceQuality', 'regimeFit', 'reactionGap', 'portfolioRelevance', 'liquidity']);
const PENALTIES = Object.freeze(['crowding', 'eventRisk', 'executionCost']);

// A missing multiplicative component contributes this much — well below neutral, so
// unmeasured evidence lowers rank instead of quietly passing as average.
const UNKNOWN_COMPONENT = 0.35;
const PENALTY_WEIGHT = 0.15;   // each penalty can shave at most this much off the score

const clamp01 = v => Math.max(0, Math.min(1, v));
const isNum = v => v != null && Number.isFinite(v);

/**
 * Score one decision record. Pure.
 * @param {object} components  partial map of the named components (0..1 each)
 * @returns {{score, components, coverage, missing, version, isExpectedReturn, note}}
 */
function scoreUtility(components = {}) {
  const resolved = {};
  const missing = [];
  // The seven multiplicative terms are combined as a GEOMETRIC MEAN, not a raw product.
  // The conjunctive semantics are what matter — one weak component drags the whole score
  // down, and no strong component can compensate for a zero — but a raw product of seven
  // fractions lands near zero for every record and destroys the ordering the queue exists
  // to provide. The geometric mean keeps the same "weakest link" behaviour on a 0..1 scale
  // that the penalties can then be subtracted from meaningfully.
  let logSum = 0;
  let anyZero = false;
  for (const k of MULTIPLICATIVE) {
    const v = components[k];
    const value = isNum(v) ? clamp01(v) : UNKNOWN_COMPONENT;
    if (isNum(v)) {
      resolved[k] = { value, measured: true };
    } else {
      resolved[k] = { value, measured: false, reason: `${k} not measured — scored at the UNKNOWN floor, not at neutral` };
      missing.push(k);
    }
    if (value <= 0) anyZero = true;
    else logSum += Math.log(value);
  }
  const product = anyZero ? 0 : Math.exp(logSum / MULTIPLICATIVE.length);
  let penalty = 0;
  for (const k of PENALTIES) {
    const v = components[k];
    if (isNum(v)) {
      resolved[k] = { value: clamp01(v), measured: true, subtractive: true };
      penalty += clamp01(v) * PENALTY_WEIGHT;
    } else {
      // An UNMEASURED penalty is not assumed absent: it costs half its maximum, because
      // "we did not check for crowding" is not the same as "there is no crowding".
      resolved[k] = { value: 0.5, measured: false, subtractive: true, reason: `${k} not measured — charged at half the maximum penalty rather than assumed absent` };
      missing.push(k);
      penalty += 0.5 * PENALTY_WEIGHT;
    }
  }
  const total = MULTIPLICATIVE.length + PENALTIES.length;
  const coverage = +((total - missing.length) / total).toFixed(3);
  const score = +Math.max(0, product - penalty).toFixed(5);
  return {
    version: UTILITY_VERSION,
    score,
    components: resolved,
    coverage,
    missing,
    isExpectedReturn: false,
    isProbability: false,
    note: UTILITY_NOTE,
  };
}

// State ordering for the queue's primary sort. Utility ranks WITHIN a state band, so a
// high-utility AVOID never outranks a modest ACT_NOW.
const STATE_ORDER = Object.freeze({ ACT_NOW: 0, MANAGE: 1, SET_ALERT: 2, INVESTIGATE: 3, WAIT: 4, AVOID: 5 });

/**
 * Build the ranked queue from schema-valid decision records. Pure.
 *
 * @param {Array} decisions  makeDecision() outputs, each optionally carrying `utility`
 * @param {object} ctx { now, utilityByDecisionId }
 */
function buildQueue(decisions, { now = Date.now(), utilityByDecisionId = {} } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const scored = (decisions || []).filter(Boolean).map(d => {
    const utility = d.utility || utilityByDecisionId[d.decisionId] || scoreUtility({});
    // A record past its own expiry cannot sit in an actionable band, whatever it claims.
    const expiredMs = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
    const isExpired = Number.isFinite(expiredMs) && expiredMs <= nowMs;
    const state = isExpired ? 'AVOID' : d.state;
    const lifecycle = isExpired && d.lifecycle !== 'EXPIRED' ? 'EXPIRED' : d.lifecycle;
    return {
      ...d,
      state, lifecycle,
      utility,
      expiredByClock: isExpired,
      queueReasons: isExpired ? ['Past its own expiresAt — demoted out of the actionable bands.'] : [],
    };
  });

  scored.sort((a, b) => {
    const sa = STATE_ORDER[a.state] ?? 9, sb = STATE_ORDER[b.state] ?? 9;
    if (sa !== sb) return sa - sb;
    if (b.utility.score !== a.utility.score) return b.utility.score - a.utility.score;
    // Deterministic tie-break so the queue is stable across rebuilds.
    return String(a.decisionId).localeCompare(String(b.decisionId));
  });

  const byState = {};
  for (const s of STATE) byState[s] = scored.filter(d => d.state === s);
  const byLifecycle = {};
  for (const l of LIFECYCLE) byLifecycle[l] = scored.filter(d => d.lifecycle === l);

  return {
    version: UTILITY_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    total: scored.length,
    queue: scored,
    byState,
    byLifecycle,
    // Bet clustering: correlated decisions that are really the SAME underlying bet.
    clusters: clusterBets(scored),
    utilityNote: UTILITY_NOTE,
    coverageSummary: {
      meanComponentCoverage: scored.length
        ? +(scored.reduce((s, d) => s + d.utility.coverage, 0) / scored.length).toFixed(3) : 0,
      recordsWithMissingComponents: scored.filter(d => d.utility.missing.length).length,
    },
  };
}

/**
 * Deduplicate the queue into underlying BET clusters. Two decisions are the same bet when
 * they share an entity, or share a bet key (sector/theme/factor) AND a side. Pure.
 */
function clusterBets(decisions) {
  const groups = new Map();
  for (const d of decisions || []) {
    const side = (d.factState && d.factState.side) || null;
    const betKey = (d.portfolioRelevance && d.portfolioRelevance.betKey)
      || (d.factState && d.factState.betKey)
      || null;
    const key = betKey ? `bet:${betKey}|${side || 'na'}` : `entity:${d.entity || d.decisionId}`;
    if (!groups.has(key)) groups.set(key, { key, betKey, side, members: [], entities: new Set() });
    const g = groups.get(key);
    g.members.push(d.decisionId);
    if (d.entity) g.entities.add(d.entity);
  }
  return [...groups.values()].map(g => ({
    key: g.key,
    betKey: g.betKey,
    side: g.side,
    size: g.members.length,
    decisionIds: g.members,
    entities: [...g.entities],
    // A cluster of >1 is a concentration warning: acting on all of them is one bet, not N.
    concentrationWarning: g.members.length > 1
      ? `${g.members.length} queued decisions express the same underlying bet — sizing them independently multiplies the same risk.`
      : null,
  })).sort((a, b) => b.size - a.size);
}

// ── Transition-only alerting ────────────────────────────────────────────────
// The queue re-renders continuously; alerting must not. An alert fires when a decision
// enters a MATERIALLY different state, never when the same state is observed again.

const MATERIAL_FIELDS = Object.freeze(['state', 'lifecycle']);

/**
 * Diff a new queue against the previous alert state and emit only genuine transitions.
 * Pure — returns { alerts, nextState }.
 *
 * @param {object} prevState  { [decisionId]: { state, lifecycle, emittedAt } }
 * @param {Array}  queue      buildQueue().queue
 * @param {object} opts       { now, cooldownMs }
 */
function transitionAlerts(prevState, queue, { now = Date.now(), cooldownMs = 3_600_000 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const prev = prevState || {};
  const alerts = [];
  const nextState = { ...prev };

  for (const d of queue || []) {
    const before = prev[d.decisionId] || null;
    const after = { state: d.state, lifecycle: d.lifecycle };
    if (!before) {
      // First sighting is a transition into existence — but only worth alerting when the
      // decision arrives already actionable. A new WAIT is not news.
      if (d.state === 'ACT_NOW' || d.state === 'MANAGE' || d.lifecycle === 'TRIGGERED') {
        alerts.push(mkAlert(d, null, after, 'appeared', nowMs));
      }
      nextState[d.decisionId] = { ...after, emittedAt: nowMs };
      continue;
    }
    const changed = MATERIAL_FIELDS.filter(f => before[f] !== after[f]);
    if (!changed.length) {
      // Same state observed again — explicitly NOT an alert.
      nextState[d.decisionId] = { ...before, ...after };
      continue;
    }
    if (before.emittedAt && nowMs - before.emittedAt < cooldownMs) {
      nextState[d.decisionId] = { ...before, ...after };
      continue;   // within cooldown: record the state, suppress the notification
    }
    alerts.push(mkAlert(d, before, after, changed.join('+'), nowMs));
    nextState[d.decisionId] = { ...after, emittedAt: nowMs };
  }
  return { alerts, nextState };
}

function mkAlert(d, before, after, kind, nowMs) {
  return {
    // Deduped by transition identity, so a retried build cannot double-notify.
    transitionId: `${d.decisionId}|${before ? before.state + '>' + before.lifecycle : 'new'}|${after.state}>${after.lifecycle}`,
    decisionId: d.decisionId,
    entity: d.entity,
    source: d.source,
    kind,
    from: before ? { state: before.state, lifecycle: before.lifecycle } : null,
    to: after,
    whatChanged: (d.whatChanged || []).slice(-3),
    utility: d.utility ? d.utility.score : null,
    at: new Date(nowMs).toISOString(),
  };
}

module.exports = {
  UTILITY_VERSION, UTILITY_NOTE, MULTIPLICATIVE, PENALTIES, UNKNOWN_COMPONENT, STATE_ORDER,
  scoreUtility, buildQueue, clusterBets, transitionAlerts,
};
