'use strict';
// ADAPTERS — Market Pulse, Trade Alerts, and Options v2 → the shared decision contract.
//
// Adapters are the ONLY place the three surfaces meet. Each existing route keeps its own
// payload shape and its own storage keys untouched; the queue reads through these, so the
// change is additive and reversible (see DECISION_QUEUE_MODE in lib/decision-queue-flags).
//
// Adapter rules:
//   • An adapter may only MAP fields that already exist. It never computes a new level,
//     never invents a trigger, and never upgrades a confidence.
//   • Anything the source could not measure becomes an `unavailable()` block or a
//     `missingEvidence` entry — never an omitted field that reads as fine.
//   • Governance blocks are copied through verbatim so the queue can display them; the
//     adapter cannot alter maturity, weight, or trade eligibility.
//
// Pure; no I/O.

const dc = require('./decision-contract');
const { scoreUtility } = require('./decision-queue');

const clamp01 = v => Math.max(0, Math.min(1, v));
const num = v => (v != null && Number.isFinite(+v) ? +v : null);

// ── Trade Alerts ────────────────────────────────────────────────────────────

// Map the alerts action gate onto the shared decision states. The mapping is intentionally
// conservative: the alerts layer is SHADOW, so its best state is INVESTIGATE, never ACT_NOW.
const ALERT_STATE = Object.freeze({
  REVIEW: 'INVESTIGATE',
  WAIT: 'SET_ALERT',
  AVOID: 'AVOID',
  'EXIT/REASSESS': 'MANAGE',
});

function alertLifecycle(dec) {
  const f = dec.freshness || {};
  if (f.state === 'EXPIRED') return 'EXPIRED';
  if (dec.status === 'INVALIDATED' || dec.action === 'EXIT/REASSESS') return 'INVALIDATED';
  if (dec.setupState === 'TRIGGERED') return 'TRIGGERED';
  if (dec.setupState === 'FORMING' && dec.action === 'REVIEW') return 'ARMED';
  return 'WATCH';
}

/**
 * One Trade Alerts decision → one shared decision record. Pure.
 * @param {object} dec       lib/alerts-pipeline buildDecisions() row
 * @param {object} ctx       { governance, now }
 */
function fromAlertDecision(dec, { governance = null, now = Date.now() } = {}) {
  const f = dec.freshness || null;
  const x = dec.execution || null;
  const r = dec.regimeFit || null;
  const p = dec.priceAtAlert || null;
  const m = dec.moveSinceAlert || null;

  const missingEvidence = [];
  if (!p || p.state !== 'CAPTURED') {
    missingEvidence.push({ field: 'priceAtAlert', required: true, reason: (p && p.reason) || 'no immutable alert price captured' });
  }
  for (const k of (x ? x.missingRequired : ['liquidity', 'spread'])) {
    missingEvidence.push({ field: `execution.${k}`, required: true, reason: x ? x.components[k].reason : 'no execution evidence supplied' });
  }
  if (!r || r.alignment === 'UNKNOWN') missingEvidence.push({ field: 'regimeFit', required: false, reason: 'regime data unavailable for this side' });

  // Dissent: the layer's own contradictions are preserved, not smoothed.
  const dissent = [];
  if (dec.setupAgreement === 'contradicts') {
    dissent.push({ agent: 'price-setup', position: `independent chart reads ${dec.trigger != null ? 'the other way' : 'no setup'}`, resolved: false });
  }
  if (r && r.vetoes && r.vetoes.length) {
    for (const v of r.vetoes) dissent.push({ agent: `regime:${v.source}`, position: v.reason, resolved: false });
  }
  if (dec.coordinated) dissent.push({ agent: 'coordination', position: 'suspected coordinated promotion — the social corroboration is not independent', resolved: false });

  const evidenceCoverage = clamp01(((x ? x.coverage : 0) + (r ? r.coverage : 0) + (p && p.state === 'CAPTURED' ? 1 : 0)) / 3);

  return dc.makeDecision({
    decisionId: `alerts:${dec.episodeId || dec.ticker}`,
    source: 'alerts',
    entity: dec.ticker || null,
    horizon: f ? f.horizonBucket : 'swing',
    state: ALERT_STATE[dec.action] || 'WAIT',
    lifecycle: alertLifecycle(dec),
    thesis: (dec.reasons || [])[0] || null,
    whatChanged: (dec.reasons || []).map(t => ({ kind: 'reason', text: t })),
    factState: { side: dec.side, setupState: dec.setupState, catalystStatus: dec.catalystStatus, priceAtAlert: p, moveSinceAlert: m },
    regimeFit: r || dc.unavailable('no side-aware regime read supplied'),
    priceReaction: m && m.available
      ? dc.measured({ consumedPct: m.consumedPct, verified: !!m.verified }, { source: 'alert-price-capture' })
      : dc.unavailable((m && m.reason) || 'no alert price to measure a reaction against'),
    trigger: dec.trigger != null ? dc.measured(dec.trigger, { source: 'chart-math' }) : dc.unavailable('no deterministic trigger from the setup'),
    invalidation: dec.invalidation != null ? dc.measured(dec.invalidation, { source: 'chart-math' }) : dc.unavailable('no deterministic invalidation from the setup'),
    targets: dec.target != null ? [{ level: dec.target, basis: 'chart-math', rr: dec.rr ?? null }] : [],
    maxChase: dec.chase && dec.chase.extended
      ? dc.measured({ extended: true, atrExt: dec.chase.atrExt, consumedPct: dec.chase.preMovePct }, { source: 'chase-risk' })
      : (dec.chase ? dc.measured({ extended: false, atrExt: dec.chase.atrExt }, { source: 'chase-risk' }) : dc.unavailable('no chase read')),
    timeStop: f && f.expiresAt
      ? dc.measured({ expiresAt: f.expiresAt, ttlHours: f.ttlHours, basis: 'horizon TTL (hypothesis, not calibrated)' }, { source: 'alerts-freshness' })
      : dc.unavailable('no TTL derivable without an alert timestamp'),
    executionConstraints: x || dc.unavailable('no execution evidence supplied'),
    factConfidence: catalystConfidence(dec.catalystStatus),
    evidenceCoverage,
    deterministicGatePassed: dec.action === 'REVIEW',
    dissent,
    missingEvidence,
    sources: dec.handle ? [{ kind: 'social', handle: dec.handle, note: 'social post — a discovery lead, not a verified fact' }] : [],
    asOf: dec.priceAsOf || dec.lastSeenDate || null,
    expiresAt: f ? f.expiresAt : null,
    eventFamily: (dec.catalysts || [])[0] || 'unclassified',
    regime: r && r.market ? r.market.tape || 'unknown' : 'unknown',
    modelVersions: {
      score: 'alerts-v2', execution: x ? x.version : null,
      regime: r ? r.version : null, freshness: f ? f.version : null,
      priceAtAlert: p ? p.version : null,
    },
    governance,
    utility: scoreUtility({
      materiality: dec.setupState === 'TRIGGERED' ? 0.9 : dec.setupState === 'FORMING' ? 0.55 : 0.2,
      novelty: dec.appearances && dec.appearances > 3 ? 0.3 : 0.7,
      evidenceQuality: evidenceCoverage,
      regimeFit: r ? r.creditFraction : undefined,
      reactionGap: m && m.available ? clamp01(1 - Math.abs(m.consumedPct) / 15) : undefined,
      liquidity: x ? x.creditFraction : undefined,
      crowding: dec.coordinated ? 1 : (dec.chase && dec.chase.extended ? 0.7 : 0.2),
      executionCost: x ? clamp01(1 - x.creditFraction) : undefined,
      // portfolioRelevance and eventRisk are left UNMEASURED on purpose — no holdings feed
      // and no per-name event calendar is wired here, so they must not score as neutral.
    }),
  });
}

// Catalyst verification → fact confidence. Social-only never exceeds LOW.
function catalystConfidence(status) {
  switch (status) {
    case 'VERIFIED_PRIMARY': return 'HIGH';
    case 'VERIFIED_SECONDARY': return 'MEDIUM';
    case 'SOCIAL_ONLY': return 'LOW';
    case 'CONFLICTED': return 'LOW';
    case 'FALSE_OR_STALE': return 'UNAVAILABLE';
    default: return 'UNAVAILABLE';
  }
}

// ── Market Pulse v2 ─────────────────────────────────────────────────────────

/**
 * One Pulse event/narrative → a shared decision record. Narrative attention is never a
 * trade signal, so the ceiling here is INVESTIGATE and price confirmation is required
 * before anything stronger is even representable.
 */
function fromPulseEvent(ev, { governance = null, marketState = null, regimeStack = null, crossAsset = null } = {}) {
  const conf = ev.claimStatus === 'VERIFIED' ? 'HIGH'
    : ev.claimStatus === 'SUPPORTED' ? 'MEDIUM'
      : ev.claimStatus === 'SINGLE_SOURCE' ? 'LOW'
        : 'UNAVAILABLE';

  const missingEvidence = [];
  if (!ev.priceConfirmed) missingEvidence.push({ field: 'priceReaction', required: true, reason: 'no direction-aware price confirmation — a narrative alone is not a setup' });
  if (!ev.eventOccurredAt) missingEvidence.push({ field: 'eventOccurredAt', required: false, reason: 'event time unknown; only publication/discovery time is available' });

  const dissent = [];
  if (ev.claimStatus === 'CONFLICTED') dissent.push({ agent: 'provenance', position: 'sources conflict on this claim', resolved: false });
  if (ev.contradictions) for (const c of ev.contradictions) dissent.push({ agent: 'provenance', position: String(c), resolved: false });

  const coverage = clamp01(
    ((ev.sourceCount ? Math.min(1, ev.sourceCount / 3) : 0)
      + (ev.priceConfirmed ? 1 : 0)
      + (crossAsset && crossAsset.available ? 1 : 0)) / 3,
  );

  return dc.makeDecision({
    decisionId: `pulse:${ev.eventId || ev.id}`,
    source: 'pulse2',
    entity: ev.entity || ev.ticker || 'market',
    horizon: ev.horizon || 'swing',
    // Attention is not action: an unconfirmed narrative can only ever be INVESTIGATE.
    state: ev.priceConfirmed && conf !== 'UNAVAILABLE' ? 'SET_ALERT' : 'INVESTIGATE',
    lifecycle: ev.lifecycleState || 'WATCH',
    thesis: ev.headline || ev.claim || null,
    whatChanged: (ev.transitions || []).map(t => ({ kind: t.kind, text: t.reason || t.kind, at: t.at || null })),
    factState: { claimStatus: ev.claimStatus, eventFamily: ev.family, freshnessReason: ev.freshnessReason },
    regimeFit: regimeStack || dc.unavailable('no regime stack supplied'),
    crossAssetConfirmation: crossAsset || dc.unavailable('no cross-asset matrix supplied'),
    priceReaction: ev.priceConfirmed
      ? dc.measured({ state: ev.reactionState, direction: ev.direction }, { source: 'pulse2-direction' })
      : dc.unavailable('narrative not price-confirmed — attention is not a trade signal'),
    factConfidence: conf,
    evidenceCoverage: coverage,
    deterministicGatePassed: !!ev.priceConfirmed,
    dissent,
    missingEvidence,
    sources: (ev.sources || []).map(s => ({ kind: s.lane || 'news', id: s.sourceId, url: s.url, publishedAt: s.publishedAt || null })),
    asOf: ev.lastSeenAt || ev.firstSeenAt || null,
    expiresAt: ev.expiresAt || null,
    eventFamily: ev.family || 'unclassified',
    regime: marketState && marketState.mode ? marketState.mode.mode : 'unknown',
    modelVersions: { pulse: 'pulse2', events: ev.modelVersion || null },
    governance,
    utility: scoreUtility({
      materiality: ev.materiality != null ? clamp01(ev.materiality) : (ev.priceConfirmed ? 0.7 : 0.35),
      novelty: ev.freshnessReason === 'NEW_PUBLICATION' ? 0.9
        : ev.freshnessReason === 'NEW_MATERIAL_UPDATE' ? 0.8
          : ev.freshnessReason === 'REDISCOVERED' || ev.freshnessReason === 'SYNDICATED_COPY' ? 0.1
            : ev.freshnessReason === 'ONGOING_EVENT' ? 0.3 : undefined,
      evidenceQuality: coverage,
      regimeFit: regimeStack && regimeStack.fit != null ? clamp01(regimeStack.fit) : undefined,
      reactionGap: num(ev.reactionGap) != null ? clamp01(ev.reactionGap) : undefined,
      crowding: ev.crowded ? 0.8 : undefined,
    }),
  });
}

// ── Options v2 ──────────────────────────────────────────────────────────────

const OPT_STATE = Object.freeze({
  PRICE_CONFIRMED: 'INVESTIGATE',      // shadow layer: still never ACT_NOW
  READY: 'SET_ALERT',
  WATCH_FOR_PRICE_TRIGGER: 'SET_ALERT',
  CONTRADICTS_SETUP: 'AVOID',
  AVOID_EVENT_RISK: 'AVOID',
  INVALIDATED: 'MANAGE',
  STALE: 'AVOID',
});

function fromOptionsEvent(ev, { governance = null, now = Date.now() } = {}) {
  const missingEvidence = [];
  const hyp = ev.falsePositiveHypotheses || null;
  if (!hyp) missingEvidence.push({ field: 'falsePositiveHypotheses', required: true, reason: 'no false-positive hypothesis ledger attached' });
  const liq = ev.contractLiquidity || null;
  if (!liq) missingEvidence.push({ field: 'contractLiquidity', required: true, reason: 'no contract-level executable liquidity check for the selected contract and size' });

  // Every unrefuted benign explanation is preserved as dissent — it contests the read.
  const dissent = [];
  for (const h of (hyp ? hyp.hypotheses || [] : [])) {
    if (h.verdict !== 'REFUTED') {
      dissent.push({ agent: `false-positive:${h.id}`, position: h.statement, evidence: h.evidence || [], resolved: h.verdict === 'REFUTED' });
    }
  }
  if (ev.interpretation && (ev.interpretation.evidenceAgainst || []).length) {
    dissent.push({ agent: 'interpretation', position: ev.interpretation.evidenceAgainst[0], resolved: false });
  }

  const coverage = ev.componentCoverage != null ? clamp01(ev.componentCoverage)
    : clamp01(((hyp ? 1 : 0) + (liq ? 1 : 0) + (ev.volatilityContext ? 1 : 0)) / 3);

  return dc.makeDecision({
    decisionId: `options:${ev.eventId || ev.id}`,
    source: 'options-v2',
    entity: ev.ticker || null,
    horizon: 'swing',
    state: OPT_STATE[ev.tradeStatus] || 'INVESTIGATE',
    lifecycle: ev.tradeStatus === 'PRICE_CONFIRMED' ? 'TRIGGERED'
      : ev.tradeStatus === 'INVALIDATED' ? 'INVALIDATED'
        : ev.tradeStatus === 'STALE' ? 'EXPIRED'
          : ev.tradeStatus === 'READY' ? 'ARMED' : 'WATCH',
    thesis: ev.summary || null,
    whatChanged: (ev.transitions || []).map(t => ({ kind: t.kind, text: t.reason || t.kind, at: t.at || null })),
    factState: {
      activityStatus: ev.activityStatus,
      tradeStatus: ev.tradeStatus,
      // Direction is the honest provisional state — never derived from call/put dominance.
      directionState: ev.interpretation ? ev.interpretation.state : null,
    },
    positioning: ev.interpretation
      ? dc.measured({ state: ev.interpretation.state, evidenceStrength: ev.evidenceStrength || null }, { source: 'options-interpret-v2' })
      : dc.unavailable('no interpretation available for this event'),
    priceReaction: ev.tradeStatus === 'PRICE_CONFIRMED'
      ? dc.measured({ confirmed: true }, { source: 'options-trade-gate-v2' })
      : dc.unavailable('no INDEPENDENT price trigger has been reached — options activity alone is not actionable'),
    trigger: ev.stockPlan && ev.stockPlan.trigger != null ? dc.measured(ev.stockPlan.trigger, { source: 'chart-math' }) : dc.unavailable('no independent price trigger'),
    invalidation: ev.stockPlan && ev.stockPlan.invalidation != null ? dc.measured(ev.stockPlan.invalidation, { source: 'chart-math' }) : dc.unavailable('no independent invalidation'),
    targets: ev.stockPlan && ev.stockPlan.target != null ? [{ level: ev.stockPlan.target, basis: 'chart-math' }] : [],
    executionConstraints: liq || dc.unavailable('no contract-level executable liquidity check'),
    // Anomaly score is NOT confidence in a fact — fact confidence here is about data quality.
    factConfidence: ev.dataQuality >= 0.8 ? 'HIGH' : ev.dataQuality >= 0.5 ? 'MEDIUM' : ev.dataQuality > 0 ? 'LOW' : 'UNAVAILABLE',
    evidenceCoverage: coverage,
    deterministicGatePassed: ev.tradeStatus === 'PRICE_CONFIRMED',
    dissent,
    missingEvidence,
    sources: [{ kind: 'options-chain', mode: ev.sourceMode || 'DELAYED_CHAIN', note: 'delayed chain: opening/closing and buyer/seller are not observable' }],
    asOf: ev.asOf || ev.session || null,
    expiresAt: ev.expiresAt || null,
    eventFamily: 'options-anomaly',
    regime: ev.regime || 'unknown',
    modelVersions: { anomaly: ev.configId || null, gate: ev.gateVersion || null },
    governance,
    utility: scoreUtility({
      materiality: ev.anomalyScore != null ? clamp01(ev.anomalyScore / 100) : undefined,
      novelty: ev.persistenceSessions ? clamp01(1 / (1 + ev.persistenceSessions)) : undefined,
      evidenceQuality: coverage,
      liquidity: liq && liq.executableFraction != null ? clamp01(liq.executableFraction) : undefined,
      eventRisk: ev.earningsBeforeExpiry ? 1 : undefined,
      executionCost: liq && liq.estimatedSlippageFrac != null ? clamp01(liq.estimatedSlippageFrac) : undefined,
      crowding: dissent.length ? clamp01(dissent.length / 4) : undefined,
    }),
  });
}

module.exports = { fromAlertDecision, fromPulseEvent, fromOptionsEvent, catalystConfidence, ALERT_STATE, OPT_STATE };
