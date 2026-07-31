'use strict';
// 🏛️ GOV-DEMAND — canonical event assembly + qualification gate (pure).
//
// Converts one collected observation + its deterministic reads (mapping,
// classification, materiality, cadence expectation, price gate) into the
// AI-Alpha-OS canonical event record. Everything here is pure — no fetches —
// so the whole decision path is unit-testable and replayable.
//
// The research setup the prereg freezes:
//   unexpected (vs own cadence) × financially material × not price-consumed
// Only events that clear ALL gates become shadow predictions. Every other
// event is still RECORDED with an honest status (the prompt's requirement to
// log rejected/abstained candidates, not just selections).

const { ACTIONS, looksRoutine } = require('./govdemand-materiality');

// Prompt Phase-15 status taxonomy (the subset this slice can honestly assign).
const STATUS = Object.freeze({
  RAW_OBSERVATION: 'RAW_OBSERVATION',            // real but expected / routine — no surprise
  EXPECTATION_SURPRISE: 'EXPECTATION_SURPRISE',  // unexpected but failed a downstream gate
  EVIDENCE_BUILDING: 'EVIDENCE_BUILDING',        // cadence history too short to judge surprise
  ACTIONABLE_SHADOW: 'ACTIONABLE_SHADOW',        // cleared every gate → shadow prediction logged
  MOVE_CONSUMED: 'MOVE_CONSUMED',                // price already reacted past the gate
  MAPPING_UNCERTAIN: 'MAPPING_UNCERTAIN',        // recipient not in the verified map
  NO_INCREMENTAL_EDGE: 'NO_INCREMENTAL_EDGE',    // immaterial relative to company revenue
  DATA_UNAVAILABLE: 'DATA_UNAVAILABLE',          // an input could not be grounded
});

// Gates (named, disclosed heuristics — frozen in the prereg, not tuned post-hoc).
const MIN_MATERIALITY = 0.02;            // obligation ≥ 2% of TTM revenue
const PRICE_CONSUMED_EXCESS_PCT = 5;     // |SPY-excess move since action date| ≥ 5% = consumed
const DIFFUSION = Object.freeze({ UNKNOWN: 'UNKNOWN', PRICE_CONSUMED: 'STAGE_6_PRICE_CONSUMED' });

// ── Price-consumed gate (pure) ───────────────────────────────────────────────
// SPY-excess close-to-close move from the last close ON/BEFORE eventTime to the
// last close on/before asOf. Null (→ gate can't pass or fail) when either
// series lacks coverage — absence of data is UNAVAILABLE, not "not consumed".
function priceConsumedGate({ candles, spyCandles, eventTime, asOf }) {
  const at = (cs, d) => {
    if (!Array.isArray(cs)) return null;
    let last = null;
    for (const c of cs) { if (c.date <= d) last = c; else break; }
    return last;
  };
  const c0 = at(candles, eventTime), c1 = at(candles, asOf);
  const s0 = at(spyCandles, eventTime), s1 = at(spyCandles, asOf);
  if (!c0 || !c1 || !s0 || !s1 || !(c0.close > 0) || !(s0.close > 0)) {
    return { excessMovePct: null, consumed: null, note: 'insufficient price coverage' };
  }
  const excessMovePct = ((c1.close - c0.close) / c0.close - (s1.close - s0.close) / s0.close) * 100;
  return { excessMovePct: +excessMovePct.toFixed(2), consumed: Math.abs(excessMovePct) >= PRICE_CONSUMED_EXCESS_PCT };
}

// ── Falsifiable causal chain (Phase 5, static template for this mechanism) ──
function causalChain(ticker) {
  return {
    causalSteps: [
      'unexpected government obligation increases contracted backlog',
      'backlog converts to reported revenue over the period of performance',
      'analyst revenue estimates revise upward',
      `${ticker} repricing follows the estimate revisions`,
    ],
    confirmingMeasurements: [
      'next quarterly report: revenue / backlog above pre-event trailing pace',
      'analyst estimate revisions turn positive within 63 sessions',
    ],
    invalidatingMeasurements: [
      'award de-obligated or protested',
      'quarterly revenue and backlog show no acceleration',
      'stock reprices on an unrelated catalyst (thesis fails even if return succeeds)',
    ],
  };
}

// ── Canonical event assembly ─────────────────────────────────────────────────
// All inputs are precomputed; this only combines + gates. `mapped` may be null.
function assembleEvent({ obs, action, mapped, materiality, expectation, priceGate }) {
  const eventId = `govdemand:${obs.key}`;
  const base = {
    eventId,
    schemaVersion: 'govdemand-event-v1',
    eventType: 'government-demand',
    eventSubtype: action,
    ticker: mapped ? mapped.ticker : null,
    company: mapped ? mapped.company : null,
    recipientName: obs.recipientName,
    mapping: mapped ? {
      via: mapped.via, matchedPattern: mapped.matchedPattern,
      evidence: mapped.evidence, verificationStatus: mapped.verificationStatus,
    } : null,
    // PIT triplet — eventTime is the government action date; availableAt is
    // when OUR collector saw it (USAspending has no publication timestamp).
    eventTime: obs.eventTime,
    observedAt: obs.observedAt,
    availableAt: obs.availableAt,
    primarySource: obs.primarySource,
    sourceIds: obs.sourceIds,
    awardId: obs.awardId,
    agency: obs.agency,
    subAgency: obs.subAgency,
    amountUSD: obs.amountUSD,
    direction: obs.amountUSD == null ? null : obs.amountUSD < 0 ? 'negative' : obs.amountUSD > 0 ? 'positive' : 'neutral',
    economicMechanism: 'government obligation → backlog → recognized revenue',
    affectedFinancialVariable: 'revenue',
    materiality: materiality || null,
    expectation: expectation || null,
    priceGate: priceGate || null,
    diffusionStage: priceGate && priceGate.consumed === true ? DIFFUSION.PRICE_CONSUMED : DIFFUSION.UNKNOWN,
    verificationStatus: 'source-verified',   // the OBSERVATION is from the primary source; the THESIS is not verified
  };

  const { status, rejectReason } = qualify({ obs, action, mapped, materiality, expectation, priceGate });
  const qualifies = status === STATUS.ACTIONABLE_SHADOW;
  return {
    ...base, status, qualifies, rejectReason,
    ...(qualifies ? causalChain(base.ticker) : {}),
  };
}

// The gate cascade. Order matters: cheapest/most-fatal first. Returns the
// FIRST failing gate so the record explains itself.
function qualify({ obs, action, mapped, materiality, expectation, priceGate }) {
  if (!mapped) return { status: STATUS.MAPPING_UNCERTAIN, rejectReason: 'recipient not in verified map' };
  if (action === ACTIONS.IDV_CEILING) return { status: STATUS.RAW_OBSERVATION, rejectReason: 'IDV ceiling, not obligated revenue' };
  if (action === ACTIONS.ADMIN_ZERO) return { status: STATUS.RAW_OBSERVATION, rejectReason: 'zero-dollar administrative action' };
  if (action === ACTIONS.DE_OBLIGATION) return { status: STATUS.RAW_OBSERVATION, rejectReason: 'de-obligation (negative demand; long thesis n/a)' };
  if (action === ACTIONS.UNKNOWN) return { status: STATUS.DATA_UNAVAILABLE, rejectReason: 'amount not grounded' };
  if (looksRoutine(obs)) return { status: STATUS.RAW_OBSERVATION, rejectReason: 'recompete/bridge/follow-on language — routine continuation' };
  if (!materiality || materiality.value == null) return { status: STATUS.DATA_UNAVAILABLE, rejectReason: 'materiality not computable' };
  if (materiality.value < MIN_MATERIALITY) return { status: STATUS.NO_INCREMENTAL_EDGE, rejectReason: `immaterial (${(materiality.value * 100).toFixed(2)}% of TTM revenue < ${MIN_MATERIALITY * 100}%)` };
  if (!expectation || expectation.isUnexpected == null) return { status: STATUS.EVIDENCE_BUILDING, rejectReason: 'cadence history insufficient to judge surprise' };
  if (expectation.isUnexpected === false) return { status: STATUS.RAW_OBSERVATION, rejectReason: 'within expected award cadence — no surprise' };
  if (!priceGate || priceGate.consumed == null) return { status: STATUS.EXPECTATION_SURPRISE, rejectReason: 'price data unavailable — cannot verify underreaction' };
  if (priceGate.consumed === true) return { status: STATUS.MOVE_CONSUMED, rejectReason: `price already moved ${priceGate.excessMovePct}% vs SPY since action date` };
  return { status: STATUS.ACTIONABLE_SHADOW, rejectReason: null };
}

module.exports = {
  STATUS, DIFFUSION, MIN_MATERIALITY, PRICE_CONSUMED_EXCESS_PCT,
  priceConsumedGate, assembleEvent, qualify, causalChain,
};
