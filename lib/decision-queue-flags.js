'use strict';
// DECISION QUEUE FEATURE FLAG — the rollback lever for the shared queue.
//
// Follows the OPTIONS_V2_MODE / PULSE2_MODE convention already used in this repo:
// a single env-resolved mode with a pure resolver, defaulting OFF so the queue is
// opt-in until it has been observed in production.
//
//   DECISION_QUEUE_MODE:
//     'off'    — DEFAULT. `op=decisionqueue` returns { disabled: true } and the three
//                existing tabs render exactly as before. Nothing else changes: the queue
//                is a READ over the same stored payloads and owns no storage of its own.
//     'shadow' — the queue builds and is readable, and is labelled SHADOW everywhere.
//                It still cannot originate or boost a live pick.
//     'on'     — the queue builds and is readable without the shadow qualifier. Reaching
//                this state is a deliberate human act after the promotion gate clears;
//                it STILL does not change any strategy's weight or trade eligibility,
//                which remain governed solely by lib/strategy-gate.
//
// Nothing in this file can change governance. The three source layers stay at whatever
// maturity the registry says; the queue only reorders what they already publish.

const DECISION_QUEUE_FLAGS_VERSION = 'decision-queue-flags-v1';
const MODES = Object.freeze(['off', 'shadow', 'on']);
const DEFAULT_MODE = 'off';

function resolveDecisionQueueMode(raw) {
  const m = String(raw ?? process.env.DECISION_QUEUE_MODE ?? '').toLowerCase();
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

function decisionQueueEnabled(raw) {
  return resolveDecisionQueueMode(raw) !== 'off';
}

/** Is the queue still explicitly labelled shadow? Pure. */
function decisionQueueIsShadow(raw) {
  return resolveDecisionQueueMode(raw) !== 'on';
}

module.exports = {
  DECISION_QUEUE_FLAGS_VERSION, MODES, DEFAULT_MODE,
  resolveDecisionQueueMode, decisionQueueEnabled, decisionQueueIsShadow,
};
