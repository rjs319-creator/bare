'use strict';
// OPTIONS EVENT LIFECYCLE v2 — stable identity, immutable first-seen state,
// meaningful transitions, deduplicated alerts, and CORRECT open-interest
// attribution (the later OI observation attaches to the ORIGINAL event).
//
// Identity: one OPEN event per ticker+side cluster. The first-seen snapshot
// (decision-session state) is written once and never rewritten — later sessions
// append history and transitions, they never edit the decision record. An event
// disappearing from the scan does NOT delete it: it goes stale and remains in the
// ledger for evaluation.
//
// Alerts fire ONLY on meaningful transitions, each with a transitionId that is
// recorded so a re-run/retry of the same session can never re-alert (idempotent),
// plus per-kind session cooldowns.
//
// Pure + injected clock/session. Storage lives in the route.

const { MODEL_VERSION, TRADE_STATUS, ACTIVITY_STATUS, ALERT_COOLDOWNS } = require('./options-config-v2');
const { oiConfirm } = require('./options-snapshot');

const MAX_EVENTS = 500;
const MAX_HISTORY = 30;
const MAX_TRANSITIONS = 40;
const MAX_EMITTED = 3000;

const OI_STATUS = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED_BUILDING: 'CONFIRMED_BUILDING',
  WEAKENED: 'WEAKENED',
  FLAT: 'FLAT',
  UNAVAILABLE: 'UNAVAILABLE',
});

const ACTIVITY_RANK = { NORMAL: 0, UNUSUAL_LOW_QUALITY: 1, UNUSUAL: 2, HIGHLY_UNUSUAL: 3, EXCEPTIONAL: 4 };

function eventKey(ticker, side) { return `${String(ticker).toUpperCase()}:${side}`; }

function makeEventId(ticker, side, session, seq) {
  return `oev2_${String(session).slice(0, 10)}_${String(ticker).toUpperCase().toLowerCase()}_${side}_${seq}`;
}

function sessionsBetween(aISO, bISO) {
  // Approximate session distance from calendar days (bounded use: staleness only).
  const a = Date.parse(`${aISO}T00:00:00Z`), b = Date.parse(`${bISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function historyRow(ev, session) {
  return {
    session,
    anomalyScore: ev.anomaly ? ev.anomaly.anomalyScore : null,
    activityStatus: ev.anomaly ? ev.anomaly.activityStatus : null,
    interpretation: ev.interpretation ? ev.interpretation.state : null,
    tradeStatus: ev.gate ? ev.gate.tradeStatus : null,
    underlying: ev.underlying ?? null,
  };
}

// Immutable first-seen decision snapshot — everything needed to evaluate the event
// later WITHOUT any future information.
function firstSeenSnapshot(item, session, nowISO) {
  return {
    session,
    at: nowISO,
    modelVersion: item.modelVersion || MODEL_VERSION,
    anomalyScore: item.anomaly ? item.anomaly.anomalyScore : null,
    anomalyPercentile: item.anomaly ? item.anomaly.anomalyPercentile : null,
    activityStatus: item.anomaly ? item.anomaly.activityStatus : null,
    absoluteSizeTier: item.anomaly ? item.anomaly.absoluteSizeTier : null,
    dataQuality: item.anomaly ? item.anomaly.dataQuality : null,
    liquidityQuality: item.anomaly ? item.anomaly.liquidityQuality : null,
    baselineSampleSize: item.anomaly ? item.anomaly.baselineSampleSize : null,
    interpretation: item.interpretation ? { state: item.interpretation.state, confidence: item.interpretation.confidence } : null,
    tradeStatus: item.gate ? item.gate.tradeStatus : null,
    gateVersion: item.gate ? item.gate.gateVersion : null,
    underlying: item.underlying ?? null,
    estNotional: item.estNotional ?? null,
    // The contracts whose OI the NEXT session must confirm — symbol + the OI we saw.
    contracts: (item.contracts || []).map(c => ({
      contractSymbol: c.contractSymbol, side: c.side, strike: c.strike, expiry: c.expiry,
      openInterest: c.openInterest || 0, volume: c.volume || 0,
    })).filter(c => c.contractSymbol),
    sourceMode: item.sourceMode || null,
    setup: item.setup && item.setup.valid ? {
      direction: item.setup.direction, trigger: item.setup.trigger,
      invalidation: item.setup.invalidation, target: item.setup.target, rr: item.setup.rr,
    } : null,
  };
}

/**
 * Fold one session's ticker events into the ledger.
 * @param {{events?:Array, emittedAlertIds?:string[]}} prevLedger
 * @param {Array} items per-ticker session events:
 *   { ticker, side, anomaly, interpretation, gate, underlying, estNotional,
 *     contracts, setup, sourceMode, modelVersion }
 * @param {{session:string, now?:()=>string}} ctx
 * @returns {{events, emittedAlertIds, transitions, alerts}}
 */
function foldEventsV2(prevLedger, items, { session, now = () => new Date().toISOString() } = {}) {
  const nowISO = typeof now === 'function' ? now() : now;
  const events = ((prevLedger && prevLedger.events) || []).map(e => ({ ...e }));
  const emitted = new Set((prevLedger && prevLedger.emittedAlertIds) || []);
  const transitions = [];
  let seq = events.length;

  const push = (ev, kind, detail) => {
    const t = { transitionId: `${ev.id}:${kind}:${session}`, eventId: ev.id, ticker: ev.ticker, kind, session, detail: detail || null };
    ev.transitions = [...(ev.transitions || []), t].slice(-MAX_TRANSITIONS);
    transitions.push(t);
    return t;
  };

  for (const item of items || []) {
    if (!item || !item.ticker || !item.side) continue;
    const key = eventKey(item.ticker, item.side);
    let ev = events.find(e => e.key === key && e.status === 'open');

    if (!ev) {
      ev = {
        id: makeEventId(item.ticker, item.side, session, seq++),
        key,
        ticker: String(item.ticker).toUpperCase(),
        side: item.side,
        modelVersion: item.modelVersion || MODEL_VERSION,
        status: 'open',
        firstSeen: firstSeenSnapshot(item, session, nowISO),
        lastSeenSession: session,
        appearances: 1,
        oiConfirmation: { status: OI_STATUS.PENDING, forSession: session, attachedSession: null, detail: null },
        history: [historyRow(item, session)],
        transitions: [],
        current: null,
      };
      events.push(ev);
      push(ev, 'opened', { activityStatus: ev.firstSeen.activityStatus, tradeStatus: ev.firstSeen.tradeStatus });
    } else if (ev.lastSeenSession !== session) {
      const prev = ev.current || {};
      ev.appearances = (ev.appearances || 1) + 1;
      ev.lastSeenSession = session;
      ev.history = [...(ev.history || []), historyRow(item, session)].slice(-MAX_HISTORY);

      const curActivity = item.anomaly ? item.anomaly.activityStatus : null;
      if (curActivity && prev.activityStatus && ACTIVITY_RANK[curActivity] > ACTIVITY_RANK[prev.activityStatus]) {
        push(ev, 'activity_upgrade', { from: prev.activityStatus, to: curActivity });
      }
      const curInterp = item.interpretation ? item.interpretation.state : null;
      if (curInterp && prev.interpretation && curInterp !== prev.interpretation) {
        push(ev, 'direction_change', { from: prev.interpretation, to: curInterp });
      }
      const curTrade = item.gate ? item.gate.tradeStatus : null;
      if (curTrade && prev.tradeStatus !== curTrade
        && [TRADE_STATUS.READY, TRADE_STATUS.PRICE_CONFIRMED, TRADE_STATUS.CONTRADICTS_SETUP, TRADE_STATUS.INVALIDATED, TRADE_STATUS.AVOID_EVENT_RISK].includes(curTrade)) {
        push(ev, 'trade_status_change', { from: prev.tradeStatus || null, to: curTrade });
      }
      if (ev.appearances === 2 || ev.appearances === 3) {
        push(ev, 'persistence', { appearances: ev.appearances });
      }
      const prevScore = prev.anomalyScore, curScore = item.anomaly ? item.anomaly.anomalyScore : null;
      if (prevScore != null && curScore != null && curScore >= prevScore + 15) {
        push(ev, 'acceleration', { from: prevScore, to: curScore });
      }
      if (curTrade === TRADE_STATUS.INVALIDATED) { ev.status = 'closed_invalidated'; ev.closedSession = session; }
    }

    // Rolling current state (NOT part of the immutable first-seen snapshot).
    ev.current = {
      session,
      anomalyScore: item.anomaly ? item.anomaly.anomalyScore : null,
      anomalyPercentile: item.anomaly ? item.anomaly.anomalyPercentile : null,
      activityStatus: item.anomaly ? item.anomaly.activityStatus : null,
      dataQuality: item.anomaly ? item.anomaly.dataQuality : null,
      liquidityQuality: item.anomaly ? item.anomaly.liquidityQuality : null,
      interpretation: item.interpretation ? item.interpretation.state : null,
      interpretationConfidence: item.interpretation ? item.interpretation.confidence : null,
      tradeStatus: item.gate ? item.gate.tradeStatus : null,
      underlying: item.underlying ?? null,
    };
  }

  // Staleness (never deletion — the record stays for evaluation).
  const seenKeys = new Set((items || []).filter(i => i && i.ticker && i.side).map(i => eventKey(i.ticker, i.side)));
  for (const ev of events) {
    if (ev.status !== 'open' || seenKeys.has(ev.key)) continue;
    if (sessionsBetween(ev.lastSeenSession, session) > 5) {
      ev.status = 'closed_stale';
      ev.closedSession = session;
      push(ev, 'stale', null);
    }
  }

  const alerts = buildAlerts(transitions, events, emitted, session);
  return {
    events: events.slice(-MAX_EVENTS),
    emittedAlertIds: [...emitted].slice(-MAX_EMITTED),
    transitions,
    alerts,
  };
}

// ── Alerts: meaningful transitions only, deduplicated, cooled down ───────────
const ALERTABLE = new Set(['opened', 'activity_upgrade', 'direction_change', 'trade_status_change', 'persistence', 'acceleration', 'oi_confirmed', 'oi_weakened', 'stale']);

function buildAlerts(transitions, events, emitted, session) {
  const alerts = [];
  for (const t of transitions) {
    if (!ALERTABLE.has(t.kind)) continue;
    if (emitted.has(t.transitionId)) continue;   // idempotent under retries
    const ev = events.find(e => e.id === t.eventId);
    if (!ev) continue;
    // 'opened' alerts only for genuinely notable activity — not every UNUSUAL row.
    if (t.kind === 'opened') {
      const st = ev.firstSeen.activityStatus;
      if (st !== ACTIVITY_STATUS.HIGHLY_UNUSUAL && st !== ACTIVITY_STATUS.EXCEPTIONAL) continue;
    }
    // Cooldown: same kind on the same event within N sessions is suppressed.
    const cd = ALERT_COOLDOWNS[t.kind] != null ? ALERT_COOLDOWNS[t.kind] : ALERT_COOLDOWNS.default;
    const recent = (ev.transitions || []).filter(x => x.kind === t.kind && x.session !== session && sessionsBetween(x.session, session) <= cd);
    if (recent.length && t.kind !== 'trade_status_change') continue;

    emitted.add(t.transitionId);
    alerts.push({
      alertId: t.transitionId,
      eventId: ev.id,
      ticker: ev.ticker,
      session,
      kind: t.kind,
      detail: t.detail,
      whatChanged: describeTransition(t, ev),
      activityStatus: ev.current ? ev.current.activityStatus : ev.firstSeen.activityStatus,
      tradeStatus: ev.current ? ev.current.tradeStatus : ev.firstSeen.tradeStatus,
      directionKnown: !!(ev.current && (ev.current.interpretation === 'BULLISH_PROVISIONAL' || ev.current.interpretation === 'BEARISH_PROVISIONAL')),
      trigger: ev.firstSeen.setup ? ev.firstSeen.setup.trigger : null,
      invalidation: ev.firstSeen.setup ? ev.firstSeen.setup.invalidation : null,
      dataDelayed: true,
      notActionableWhy: ev.current && ev.current.tradeStatus === TRADE_STATUS.PRICE_CONFIRMED
        ? null
        : 'Not actionable: no independent price confirmation yet (see the event\'s trade status).',
    });
  }
  return alerts;
}

function describeTransition(t, ev) {
  switch (t.kind) {
    case 'opened': return `New ${String(ev.firstSeen.activityStatus || '').toLowerCase().replace(/_/g, ' ')} options event on ${ev.ticker}.`;
    case 'activity_upgrade': return `${ev.ticker} activity intensified: ${t.detail.from} → ${t.detail.to}.`;
    case 'direction_change': return `${ev.ticker} direction read changed: ${t.detail.from} → ${t.detail.to}.`;
    case 'trade_status_change': return `${ev.ticker} trade status: ${t.detail.from || 'n/a'} → ${t.detail.to}.`;
    case 'persistence': return `${ev.ticker} unusual activity persisted (${t.detail.appearances} sessions).`;
    case 'acceleration': return `${ev.ticker} anomaly accelerating (${t.detail.from} → ${t.detail.to}).`;
    case 'oi_confirmed': return `${ev.ticker}: next-session open interest CONFIRMS new positioning on the original event.`;
    case 'oi_weakened': return `${ev.ticker}: next-session open interest did NOT build — original activity likely day-traded or closed.`;
    case 'stale': return `${ev.ticker} event went stale (activity no longer observed).`;
    default: return `${ev.ticker}: ${t.kind}.`;
  }
}

// ── OI confirmation attribution (to the ORIGINAL event) ──────────────────────
// Tickers whose open events still await a next-session OI read.
function pendingOiTickers(events, { session } = {}) {
  const out = new Set();
  for (const ev of events || []) {
    if (!ev.oiConfirmation || ev.oiConfirmation.status !== OI_STATUS.PENDING) continue;
    if (session && ev.firstSeen.session >= session) continue;   // needs a LATER session
    if (ev.firstSeen.contracts && ev.firstSeen.contracts.length) out.add(ev.ticker);
  }
  return [...out];
}

/**
 * Attach a LATER session's OI observations to the ORIGINAL events. Immutable on
 * firstSeen; only `oiConfirmation` (a designed-to-be-attached field) changes.
 * @param {Array} events ledger events
 * @param {Object<string,{openInterest:number}>} contractIndex OCC symbol → contract from the LATER session's chain
 * @param {{session:string}} ctx the later (attaching) session
 * @returns {{events, transitions}}
 */
function attachOiConfirmations(events, contractIndex, { session } = {}) {
  const out = (events || []).map(e => ({ ...e }));
  const transitions = [];
  for (const ev of out) {
    if (!ev.oiConfirmation || ev.oiConfirmation.status !== OI_STATUS.PENDING) continue;
    if (!session || ev.firstSeen.session >= session) continue;   // only a later session may attach
    const contracts = ev.firstSeen.contracts || [];
    if (!contracts.length) {
      ev.oiConfirmation = { status: OI_STATUS.UNAVAILABLE, forSession: ev.firstSeen.session, attachedSession: session, detail: 'no stable contract identifiers were recorded' };
      continue;
    }
    const inIndex = contracts.some(c => contractIndex && contractIndex[c.contractSymbol]);
    if (!inIndex) {
      if (sessionsBetween(ev.firstSeen.session, session) > 6) {
        // The follow-up observation never arrived (ticker rotated out / provider
        // gap): say UNAVAILABLE rather than guessing — never PENDING forever.
        ev.oiConfirmation = { status: OI_STATUS.UNAVAILABLE, forSession: ev.firstSeen.session, attachedSession: session, detail: 'no follow-up chain observation within the confirmation window' };
      }
      continue;   // otherwise stay PENDING — the next eligible observation may still arrive
    }
    const details = [];
    let matched = 0, building = 0, reducing = 0;
    for (const c of contracts) {
      const later = contractIndex && contractIndex[c.contractSymbol];
      if (!later) { details.push({ contractSymbol: c.contractSymbol, state: 'not-reobserved' }); continue; }
      matched++;
      const conf = oiConfirm({ priorOi: c.openInterest, oi: later.openInterest });
      if (conf.state === 'OI_BUILDING') building++;
      else if (conf.state === 'OI_REDUCING') reducing++;
      details.push({ contractSymbol: c.contractSymbol, state: conf.state, oiChange: conf.oiChange, oiChangePct: conf.oiChangePct });
    }
    let status, kind = null;
    if (!matched) { status = OI_STATUS.UNAVAILABLE; }
    else if (building > 0 && building >= reducing) { status = OI_STATUS.CONFIRMED_BUILDING; kind = 'oi_confirmed'; }
    else if (reducing > 0) { status = OI_STATUS.WEAKENED; kind = 'oi_weakened'; }
    else { status = OI_STATUS.FLAT; kind = 'oi_weakened'; }
    ev.oiConfirmation = { status, forSession: ev.firstSeen.session, attachedSession: session, detail: details };
    if (kind) {
      const t = { transitionId: `${ev.id}:${kind}:${session}`, eventId: ev.id, ticker: ev.ticker, kind, session, detail: { status, matched, building, reducing } };
      ev.transitions = [...(ev.transitions || []), t].slice(-MAX_TRANSITIONS);
      transitions.push(t);
    }
  }
  return { events: out, transitions };
}

module.exports = {
  OI_STATUS, MAX_EVENTS, eventKey, makeEventId, firstSeenSnapshot,
  foldEventsV2, buildAlerts, describeTransition,
  pendingOiTickers, attachOiConfirmations, sessionsBetween,
};
