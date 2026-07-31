'use strict';
// ⚡ GRIDLOCK — event lifecycle machine (pure, deterministic).
//
// Reuses the Market Pulse attention-lifecycle vocabulary (NEW → EMERGING →
// BUILDING → CROWDED → FADING) and adds the project-outcome terminal states a
// PHYSICAL event needs (COMPLETED / DELAYED / CANCELLED / INVALIDATED).
// Transitions fire only on deterministic evidence — new filings, permits,
// financing, construction progress, delays, cancellations, price response,
// contradictory sources — never on model opinion. The complete history is kept
// on the event so any state is auditable back to the evidence that caused it.

const { LIFECYCLE } = require('./gridlock-schema');

// Evidence kinds a transition may cite (deterministic observations only).
const EVIDENCE_KINDS = Object.freeze([
  'new-filing', 'contract-modification', 'permit-granted', 'permit-denied',
  'financing-closed', 'construction-progress', 'regulatory-decision',
  'project-delay', 'project-cancellation', 'project-completed',
  'independent-source-added', 'contradictory-source', 'price-response',
  'attention-saturation', 'staleness',
]);

const ALLOWED = Object.freeze({
  [LIFECYCLE.NEW]:        [LIFECYCLE.EMERGING, LIFECYCLE.FADING, LIFECYCLE.INVALIDATED, LIFECYCLE.CANCELLED, LIFECYCLE.DELAYED],
  [LIFECYCLE.EMERGING]:   [LIFECYCLE.BUILDING, LIFECYCLE.FADING, LIFECYCLE.INVALIDATED, LIFECYCLE.CANCELLED, LIFECYCLE.DELAYED],
  [LIFECYCLE.BUILDING]:   [LIFECYCLE.CROWDED, LIFECYCLE.FADING, LIFECYCLE.COMPLETED, LIFECYCLE.INVALIDATED, LIFECYCLE.CANCELLED, LIFECYCLE.DELAYED],
  [LIFECYCLE.CROWDED]:    [LIFECYCLE.FADING, LIFECYCLE.COMPLETED, LIFECYCLE.INVALIDATED, LIFECYCLE.CANCELLED, LIFECYCLE.DELAYED],
  [LIFECYCLE.FADING]:     [LIFECYCLE.BUILDING, LIFECYCLE.COMPLETED, LIFECYCLE.INVALIDATED, LIFECYCLE.CANCELLED, LIFECYCLE.DELAYED],
  [LIFECYCLE.DELAYED]:    [LIFECYCLE.BUILDING, LIFECYCLE.EMERGING, LIFECYCLE.CANCELLED, LIFECYCLE.COMPLETED, LIFECYCLE.INVALIDATED],
  [LIFECYCLE.INVALIDATED]: [],   // terminal
  [LIFECYCLE.COMPLETED]:  [],    // terminal
  [LIFECYCLE.CANCELLED]:  [],    // terminal
});

function isTerminal(state) { return (ALLOWED[state] || []).length === 0; }

// Apply one transition. Returns a NEW event object (immutable) or an error.
// `evidence` must name a deterministic observation: { kind, note?, sourceId?, at }.
function applyTransition(event, toState, evidence) {
  if (!event || !event.lifecycle) return { ok: false, error: 'event with lifecycle required' };
  if (!Object.values(LIFECYCLE).includes(toState)) return { ok: false, error: `unknown state ${toState}` };
  if (!evidence || !EVIDENCE_KINDS.includes(evidence.kind)) {
    return { ok: false, error: `transition requires deterministic evidence kind (got ${evidence && evidence.kind})` };
  }
  if (!evidence.at) return { ok: false, error: 'evidence.at timestamp required' };
  const from = event.lifecycle;
  if (from === toState) return { ok: false, error: 'no-op transition' };
  if (!(ALLOWED[from] || []).includes(toState)) {
    return { ok: false, error: `illegal transition ${from} → ${toState}` };
  }
  const entry = {
    from, to: toState, at: evidence.at, evidenceKind: evidence.kind,
    note: evidence.note || null, sourceId: evidence.sourceId || null,
  };
  return {
    ok: true,
    event: {
      ...event,
      lifecycle: toState,
      lifecycleHistory: [...(event.lifecycleHistory || []), entry],
      updatedAt: evidence.at,
    },
  };
}

// Deterministic auto-advance rules evaluated at refresh time. Conservative on
// purpose: only rules whose inputs are hard observations.
//   NEW → EMERGING       when a second independent publisher confirms
//   EMERGING → BUILDING  when certainty reaches CONTRACTED+ (a binding fact)
//   any → DELAYED        when effectiveStartDate slips (recorded as PROJECT_DELAY merge)
//   NEW/EMERGING → FADING when no new evidence for `staleDays`
function autoAdvance(event, { todayIso, staleDays = 45 } = {}) {
  const at = todayIso || new Date().toISOString().slice(0, 10);
  if (isTerminal(event.lifecycle)) return { changed: false, event };

  if (event.lifecycle === LIFECYCLE.NEW && (event.independentSourceCount || 0) >= 2) {
    const r = applyTransition(event, LIFECYCLE.EMERGING, { kind: 'independent-source-added', at, note: `${event.independentSourceCount} independent publishers` });
    if (r.ok) return { changed: true, event: r.event };
  }
  const contractedPlus = ['CONTRACTED', 'PERMITTED', 'FINANCED', 'UNDER_CONSTRUCTION'].includes(event.certainty);
  if (event.lifecycle === LIFECYCLE.EMERGING && contractedPlus) {
    const r = applyTransition(event, LIFECYCLE.BUILDING, { kind: 'contract-modification', at, note: `certainty=${event.certainty}` });
    if (r.ok) return { changed: true, event: r.event };
  }
  if (event.certainty === 'OPERATING' && [LIFECYCLE.BUILDING, LIFECYCLE.CROWDED, LIFECYCLE.FADING].includes(event.lifecycle)) {
    const r = applyTransition(event, LIFECYCLE.COMPLETED, { kind: 'project-completed', at, note: 'certainty=OPERATING' });
    if (r.ok) return { changed: true, event: r.event };
  }
  const lastEvidenceAt = (event.sourceEvidence || [])
    .map(s => String(s.retrievedAt || '').slice(0, 10)).sort().pop() || String(event.announcedAt || '').slice(0, 10);
  if ([LIFECYCLE.NEW, LIFECYCLE.EMERGING].includes(event.lifecycle) && lastEvidenceAt) {
    const ageDays = Math.floor((Date.parse(at) - Date.parse(lastEvidenceAt)) / 864e5);
    if (Number.isFinite(ageDays) && ageDays >= staleDays) {
      const r = applyTransition(event, LIFECYCLE.FADING, { kind: 'staleness', at, note: `${ageDays}d without new evidence` });
      if (r.ok) return { changed: true, event: r.event };
    }
  }
  return { changed: false, event };
}

module.exports = { EVIDENCE_KINDS, ALLOWED, isTerminal, applyTransition, autoAdvance };
