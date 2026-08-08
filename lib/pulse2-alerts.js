'use strict';
// 📡 MARKET PULSE v2 — TRANSITION-BASED ALERTS.
//
// Alerts fire ONLY on meaningful state transitions — never because an item merely
// remains in the top ten across refreshes. Deduplication is by (eventId, transitionId)
// with per-kind cooldowns, so a flapping state cannot spam. Every alert carries the
// full context contract (what changed / evidence / market context / reaction / trade
// state / horizon / freshness / actionability).
//
// Pure: transitions + prior alert-state in → alerts + new alert-state out.

const ALERT_KINDS = Object.freeze({
  REGIME_CHANGE: { cooldownMin: 60, label: 'Market regime changed' },
  BREADTH_SHIFT: { cooldownMin: 90, label: 'Breadth materially shifted' },
  LEADERSHIP_ROTATION: { cooldownMin: 120, label: 'Sector leadership rotated' },
  NARRATIVE_APPEARED: { cooldownMin: 240, label: 'New narrative detected' },
  CLAIM_VERIFIED: { cooldownMin: 240, label: 'Claim became verified' },
  EVIDENCE_CONFLICTED: { cooldownMin: 240, label: 'Evidence conflicted/invalidated' },
  UNREACTED_REACTING: { cooldownMin: 120, label: 'Unrepriced event starting to react' },
  SETUP_ARMED: { cooldownMin: 60, label: 'Setup armed' },
  PRICE_CONFIRMED: { cooldownMin: 60, label: 'Price trigger confirmed' },
  SETUP_EXTENDED: { cooldownMin: 120, label: 'Setup extended — chase risk' },
  SETUP_FAILED: { cooldownMin: 60, label: 'Setup failed/invalidated' },
  EVENT_RISK_WINDOW: { cooldownMin: 720, label: 'Upcoming event entering risk window' },
});

const MAX_ALERTS_PER_CYCLE = 10;
const DEDUP_RETENTION = 400;   // remembered (eventId, transitionId) pairs

/** Stable transition id. Pure. */
function transitionId(t) {
  return [t.eventId || 'market', t.kind, t.from || '', t.to || '', t.date || ''].join('~');
}

/** Map a ledger/trade transition to an alert kind (or null = not alert-worthy). Pure. */
function kindOf(t) {
  if (!t || !t.kind) return null;
  switch (t.kind) {
    case 'appeared': return 'NARRATIVE_APPEARED';
    case 'evidence':
      if (t.to === 'VERIFIED') return 'CLAIM_VERIFIED';
      if (t.to === 'CONFLICTED') return 'EVIDENCE_CONFLICTED';
      return null;
    case 'invalidated': return 'EVIDENCE_CONFLICTED';
    case 'direction-flip': return 'EVIDENCE_CONFLICTED';
    case 'reaction':
      if (t.from === 'UNREACTED' && (t.to === 'REACTING_AS_EXPECTED' || t.to === 'PRICE_CONFIRMED')) return 'UNREACTED_REACTING';
      if (t.to === 'EXTENDED') return 'SETUP_EXTENDED';
      if (t.to === 'FAILED' || t.to === 'CONTRADICTED') return 'SETUP_FAILED';
      return null;
    case 'trade':
      if (t.to === 'ARMED') return 'SETUP_ARMED';
      if (t.to === 'PRICE_CONFIRMED') return 'PRICE_CONFIRMED';
      if (t.to === 'INVALIDATED' || t.to === 'CONTRADICTED') return 'SETUP_FAILED';
      return null;
    case 'market-mode': return 'REGIME_CHANGE';
    case 'breadth': return 'BREADTH_SHIFT';
    case 'leadership': return 'LEADERSHIP_ROTATION';
    case 'event-risk': return 'EVENT_RISK_WINDOW';
    default: return null;    // lifecycle/expired churn is ledger detail, not an alert
  }
}

/**
 * Derive this cycle's alerts. Pure.
 *
 * @param {object} p
 * @param {Array} p.transitions       event/trade/market transitions from this cycle
 * @param {object} p.context          { marketMode, sessionState, marketDataFreshness,
 *                                      narrativeFreshness }
 * @param {object} p.prevState        { emitted: { [transitionId]: isoTime },
 *                                      lastByKind: { [kind]: isoTime } }
 * @param {function|string} p.now     iso clock (injectable)
 * @returns {{alerts:Array, state:object, suppressed:number}}
 */
function deriveAlerts({ transitions = [], context = {}, prevState = null, now = () => new Date().toISOString() } = {}) {
  const nowISO = typeof now === 'function' ? now() : now;
  const nowMs = Date.parse(nowISO);
  const emitted = { ...((prevState && prevState.emitted) || {}) };
  const lastByKind = { ...((prevState && prevState.lastByKind) || {}) };
  const alerts = [];
  let suppressed = 0;

  for (const t of transitions) {
    const kind = kindOf(t);
    if (!kind) continue;
    const id = transitionId(t);
    if (emitted[id]) { suppressed++; continue; }                       // exact-transition dedup
    const cfg = ALERT_KINDS[kind];
    const keyScope = `${kind}:${t.eventId || 'market'}`;
    const last = lastByKind[keyScope];
    if (last && nowMs - Date.parse(last) < cfg.cooldownMin * 60000) { suppressed++; continue; }
    if (alerts.length >= MAX_ALERTS_PER_CYCLE) { suppressed++; continue; }

    alerts.push({
      id, kind, label: cfg.label, at: nowISO,
      eventId: t.eventId || null,
      headline: t.headline || null,
      whatChanged: t.from != null || t.to != null ? `${t.from ?? '—'} → ${t.to ?? '—'}` : (t.reason || t.kind),
      evidenceStatus: t.evidence || null,
      reactionState: t.reaction || null,
      tradeState: t.tradeState || null,
      trigger: t.trigger ?? null,
      invalidation: t.invalidation ?? null,
      horizon: t.horizon || null,
      marketContext: context.marketMode || null,
      sessionState: context.sessionState || null,
      marketDataFreshness: context.marketDataFreshness || null,
      narrativeFreshness: context.narrativeFreshness || null,
      actionability: t.actionability
        || (kind === 'PRICE_CONFIRMED' || kind === 'SETUP_ARMED'
          ? 'Actionable only with fresh regular-session data and a complete risk plan — see the card.'
          : 'Context/awareness — not an entry signal.'),
    });
    emitted[id] = nowISO;
    lastByKind[keyScope] = nowISO;
  }

  // Bound dedup memory (keep the newest).
  const ids = Object.keys(emitted);
  if (ids.length > DEDUP_RETENTION) {
    ids.sort((a, b) => (emitted[a] < emitted[b] ? -1 : 1));
    for (const id of ids.slice(0, ids.length - DEDUP_RETENTION)) delete emitted[id];
  }
  return { alerts, state: { emitted, lastByKind }, suppressed };
}

/** Market-level transitions from consecutive market-state snapshots. Pure. */
function marketTransitions(prevSnap, snap) {
  const out = [];
  if (!snap) return out;
  const prevMode = prevSnap && prevSnap.mode ? prevSnap.mode.mode : null;
  const mode = snap.mode ? snap.mode.mode : null;
  if (prevMode && mode && prevMode !== mode && mode !== 'INSUFFICIENT_DATA' && prevMode !== 'INSUFFICIENT_DATA') {
    out.push({ kind: 'market-mode', from: prevMode, to: mode, headline: 'Market regime', date: snap.etDate });
  }
  const pb = prevSnap && prevSnap.breadth && prevSnap.breadth.available ? prevSnap.breadth.pctAbove50dma : null;
  const b = snap.breadth && snap.breadth.available ? snap.breadth.pctAbove50dma : null;
  if (pb != null && b != null && Math.abs(b - pb) >= 10) {
    out.push({ kind: 'breadth', from: `${pb}%`, to: `${b}%`, headline: 'Breadth (% above 50DMA)', date: snap.etDate });
  }
  const pl = prevSnap && prevSnap.sectors && prevSnap.sectors.available ? (prevSnap.sectors.leading || [])[0] : null;
  const l = snap.sectors && snap.sectors.available ? (snap.sectors.leading || [])[0] : null;
  if (pl && l && pl !== l) {
    out.push({ kind: 'leadership', from: pl, to: l, headline: 'Sector leadership', date: snap.etDate });
  }
  return out;
}

module.exports = {
  ALERT_KINDS, MAX_ALERTS_PER_CYCLE, DEDUP_RETENTION,
  transitionId, kindOf, deriveAlerts, marketTransitions,
};
