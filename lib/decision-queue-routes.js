'use strict';
// DECISION QUEUE ROUTE — op=decisionqueue. STRICTLY READ-ONLY.
//
// This route owns NO storage. It reads the artifacts the three existing pipelines already
// wrote, maps them through the adapters, and returns one ranked queue. It cannot start an
// LLM call, hit a market-data provider, or write a Blob key. That is what makes the whole
// Decision Queue a reversible, additive change: turning DECISION_QUEUE_MODE off removes
// the route's output and nothing else in the system notices.
//
// Governance: every source layer's own governance block is echoed through verbatim, and
// the queue adds its own — the queue itself is shadow until a human flips the flag, and
// even then it changes no strategy's weight or trade eligibility.

const { readJSON, hasStore } = require('./store');
const { buildQueue, transitionAlerts } = require('./decision-queue');
const { fromAlertDecision, fromPulseEvent, fromOptionsEvent } = require('./decision-adapters');
const { resolveDecisionQueueMode, decisionQueueEnabled, decisionQueueIsShadow } = require('./decision-queue-flags');
const { statusOf, isTradeEligible, PROMOTION_GATE } = require('./strategy-gate');

const KEYS = Object.freeze({
  ALERT_DECISIONS: 'alerts/decisions.json',
  PULSE_NARRATIVES: 'pulse/v2/narratives/latest.json',
  PULSE_STATE: 'pulse/v2/market-state/latest.json',
  OPTIONS_RADAR: 'optionsflow-v2/radar.json',
});

const MAX_PER_SOURCE = 60;

function governanceFor(strategyId, note) {
  return {
    strategyId,
    maturity: statusOf(strategyId),
    tradeEligible: isTradeEligible(strategyId),
    weight: isTradeEligible(strategyId) ? 'live' : 0,
    note,
  };
}

// The queue's OWN governance block. It is not a strategy; it is a view. It says so.
function queueGovernance(mode) {
  return {
    layer: 'decision-queue',
    mode,
    shadow: decisionQueueIsShadow(mode),
    tradeEligible: false,
    weight: 0,
    promotionGate: PROMOTION_GATE,
    note: 'The Decision Queue is a read-only VIEW that reorders what the three source layers already publish. '
      + 'It owns no storage, originates no signal, and cannot change any strategy\'s maturity, weight, or trade eligibility — '
      + 'those remain governed solely by lib/strategy-gate and a deliberate human promotion. '
      + 'Its ranking formula is a versioned hypothesis with exposed components, not an expected return.',
  };
}

/** Read the three sources and adapt them. Every failure degrades to an explicit lane note. */
async function collectDecisions() {
  const lanes = {};
  const decisions = [];

  const [alertDoc, pulseDoc, stateDoc, radarDoc] = await Promise.all([
    readJSON(KEYS.ALERT_DECISIONS, null).catch(() => null),
    readJSON(KEYS.PULSE_NARRATIVES, null).catch(() => null),
    readJSON(KEYS.PULSE_STATE, null).catch(() => null),
    readJSON(KEYS.OPTIONS_RADAR, null).catch(() => null),
  ]);

  // ── Trade Alerts ──
  const alertRows = (alertDoc && Array.isArray(alertDoc.decisions)) ? alertDoc.decisions : null;
  if (!alertRows) {
    lanes.alerts = { available: false, reason: 'no alerts decision document has been built yet (op=alertsgrade has not run, or storage is unconfigured)' };
  } else {
    const gov = governanceFor('xalerts', 'Trade Alerts is SHADOW: social posts are leads, not facts.');
    for (const row of alertRows.slice(0, MAX_PER_SOURCE)) {
      try { decisions.push(fromAlertDecision(row, { governance: gov })); } catch { /* one bad row must not blank the lane */ }
    }
    lanes.alerts = { available: true, considered: alertRows.length, adapted: decisions.length, builtAt: alertDoc.generatedAt || null };
  }

  // ── Market Pulse v2 ──
  const before = decisions.length;
  const pulseEvents = (pulseDoc && Array.isArray(pulseDoc.events)) ? pulseDoc.events
    : (pulseDoc && pulseDoc.narratives && Array.isArray(pulseDoc.narratives.events)) ? pulseDoc.narratives.events : null;
  if (!pulseEvents) {
    lanes.pulse2 = { available: false, reason: 'no Market Pulse v2 narrative document available (collector has not run, or storage is unconfigured)' };
  } else {
    const gov = governanceFor('pulse2', 'Market Pulse v2 narrative intelligence: narrative attention is not a trade signal.');
    const marketState = stateDoc && stateDoc.state ? stateDoc.state : null;
    for (const ev of pulseEvents.slice(0, MAX_PER_SOURCE)) {
      try { decisions.push(fromPulseEvent(ev, { governance: gov, marketState, regimeStack: pulseDoc.regimeStack || null, crossAsset: pulseDoc.crossAsset || null })); } catch { /* skip */ }
    }
    lanes.pulse2 = { available: true, considered: pulseEvents.length, adapted: decisions.length - before, builtAt: pulseDoc.generatedAt || null };
  }

  // ── Options v2 ──
  const before2 = decisions.length;
  const optEvents = (radarDoc && Array.isArray(radarDoc.events)) ? radarDoc.events : null;
  if (!optEvents) {
    lanes.optionsV2 = { available: false, reason: 'no Options v2 radar document available (op=optionsscan2 has not run, the flag is off, or storage is unconfigured)' };
  } else {
    const gov = governanceFor('optionsflow-v2', 'Options v2 is SHADOW: delayed chains cannot establish opening/closing or buyer/seller.');
    for (const ev of optEvents.slice(0, MAX_PER_SOURCE)) {
      try { decisions.push(fromOptionsEvent(ev, { governance: gov })); } catch { /* skip */ }
    }
    lanes.optionsV2 = { available: true, considered: optEvents.length, adapted: decisions.length - before2, builtAt: radarDoc.generatedAt || null };
  }

  return { decisions, lanes };
}

async function runDecisionQueue(req, res) {
  const mode = resolveDecisionQueueMode();
  if (!decisionQueueEnabled(mode)) {
    return res.json({
      disabled: true, mode,
      note: 'DECISION_QUEUE_MODE is off. The three sections render from their own routes exactly as before. '
        + 'Set DECISION_QUEUE_MODE=shadow to enable the read-only shared queue.',
      governance: queueGovernance(mode),
    });
  }
  if (!hasStore()) {
    return res.json({
      configured: false, mode, queue: [], total: 0,
      note: 'Blob storage is not configured — the queue has nothing to read. This is a DEGRADED state, not an empty market.',
      governance: queueGovernance(mode),
    });
  }

  const now = Date.now();
  const { decisions, lanes } = await collectDecisions();
  const built = buildQueue(decisions, { now });

  // Transition-only alerting is computed but NOT persisted here — this route is read-only.
  // The caller (or a future privileged tick) owns the alert-state key.
  const { alerts } = transitionAlerts(null, built.queue, { now });

  // A lane that failed must read as DEGRADED, never as "nothing is happening".
  const failedLanes = Object.entries(lanes).filter(([, l]) => !l.available).map(([k]) => k);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  return res.json({
    configured: true,
    mode,
    schema: 'decision-queue-v1',
    generatedAt: built.generatedAt,
    total: built.total,
    queue: built.queue,
    byState: built.byState,
    byLifecycle: built.byLifecycle,
    clusters: built.clusters,
    coverageSummary: built.coverageSummary,
    utilityNote: built.utilityNote,
    lanes,
    degraded: failedLanes.length > 0,
    degradedLanes: failedLanes,
    degradedNote: failedLanes.length
      ? `${failedLanes.join(', ')} unavailable — those sections contributed NOTHING to this queue. That is a provider/pipeline gap, not an absence of opportunities.`
      : null,
    newTransitions: alerts,
    governance: queueGovernance(mode),
  });
}

module.exports = { runDecisionQueue, collectDecisions, KEYS, queueGovernance };
