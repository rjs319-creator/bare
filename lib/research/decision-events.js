'use strict';
// APPEND-ONLY DECISION-EVENT STORAGE (decision-events-v1) — Phase 6 of the data
// foundation: every evaluated candidate (selected, rejected, suppressed,
// unavailable, error) becomes ONE immutable decision event, capable of
// representing MULTIPLE intraday decision times per day (the v2 store held one
// snapshot per calendar day, so a second decision pass overwrote nothing only
// because it was refused entirely).
//
// Invariants:
//   * APPEND-ONLY, NO ESCAPE HATCH. There is no force/overwrite parameter in
//     this module at all. A decision, once recorded, is never rewritable —
//     especially not after outcomes are known.
//   * DETERMINISTIC IDEMPOTENCY KEY: the same (securityId, decisionTs,
//     strategyId, scoringVersion) always maps to the same event id, so
//     re-emitting is a recorded no-op, never a duplicate.
//   * OBSERVER-ONLY: events record the live path; nothing reads them back into
//     ranking. `affectsLiveRank` is forced false on every event.
//   * Ticker is carried as symbolAtDecision; securityId should be a v3
//     listingId once available (a bare ticker is accepted but flagged).
//
// Pure core + injected persistence.

const crypto = require('crypto');
const ENV = require('../decision-envelope');

const DECISION_EVENTS_VERSION = 'decision-events-v1';
const EVENTS_PREFIX = 'research/decision-events/';

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// The universal envelope fields every evaluated candidate should carry.
// Missing identity fields are recorded as null and surfaced in `caveats` —
// never silently defaulted.
function makeDecisionEvent(fields = {}) {
  const {
    securityId = null, symbolAtDecision = null, decisionTs = null, dataCutoffTs = null,
    strategyId = null, scoringVersion = null, modelVersion = null, calibrationVersion = null,
    featureSchemaVersion = null, universeSnapshotId = null,
    rawInputHashes = {}, features = {}, featureMissingness = {},
    selectionState = null, eligibilityReasons = [], exclusionReasons = [],
    rank = null, cohortSize = null, sourceStrategy = null,
    regimeInputs = null, entryPolicy = null, trigger = null, invalidation = null,
    codeCommit = null, deployId = null, provenance = 'prospective_live',
    expectedCosts = null, uncertainty = null,
  } = fields;

  const caveats = [];
  const normalizedState = ENV.normalizeSelectionState(selectionState);
  if (!normalizedState) caveats.push('selection-state-missing');
  if (!decisionTs) caveats.push('decision-timestamp-missing');
  if (!dataCutoffTs) caveats.push('data-cutoff-missing');
  if (!universeSnapshotId) caveats.push('universe-snapshot-unpinned');
  if (!securityId) caveats.push('security-id-missing');
  else if (!String(securityId).startsWith('pitv3:') && !String(securityId).startsWith('pitv2:')) {
    caveats.push('security-id-is-bare-ticker: switch to the v3 listingId once identity is available');
  }

  const eventId = sha16([securityId || symbolAtDecision || '?', decisionTs || '?', strategyId || '?', scoringVersion || '?'].join('|'));
  return Object.freeze({
    schema: 'DecisionEvent', version: DECISION_EVENTS_VERSION,
    eventId,
    securityId, symbolAtDecision, decisionTs, dataCutoffTs,
    strategyId, scoringVersion, modelVersion, calibrationVersion,
    featureSchemaVersion, universeSnapshotId,
    rawInputHashes: Object.freeze({ ...rawInputHashes }),
    features: Object.freeze({ ...features }),
    featureMissingness: Object.freeze({ ...featureMissingness }),
    selectionState: normalizedState,
    eligibilityReasons: Object.freeze([...eligibilityReasons]),
    exclusionReasons: Object.freeze([...exclusionReasons]),
    rank, cohortSize, sourceStrategy,
    regimeInputs: regimeInputs ? Object.freeze({ ...regimeInputs }) : null,
    entryPolicy, trigger, invalidation,
    codeCommit, deployId, provenance,
    expectedCosts, uncertainty,
    caveats: Object.freeze(caveats),
    affectsLiveRank: false,   // structurally an observation, never an instruction
  });
}

const eventPath = (event) => {
  const day = String(event.decisionTs || 'undated').slice(0, 10);
  return `${EVENTS_PREFIX}${day}/${event.eventId}.json`;
};
const dayIndexPath = (day) => `${EVENTS_PREFIX}${day}/index.json`;

// Append one event. Write-once by idempotency key; NO force parameter exists.
async function appendDecisionEvent(deps, event) {
  if (!event || !event.eventId) return { written: false, reason: 'invalid-event' };
  const path = eventPath(event);
  const existing = await deps.readJSON(path, null);
  if (existing) return { written: false, reason: 'already-recorded', eventId: event.eventId };
  await deps.writeJSON(path, { ...event, ingestedAt: new Date(deps.now ? deps.now() : Date.now()).toISOString() }, 0);
  const day = String(event.decisionTs || 'undated').slice(0, 10);
  const idx = (await deps.readJSON(dayIndexPath(day), null)) || { day, eventIds: [] };
  if (!idx.eventIds.includes(event.eventId)) idx.eventIds.push(event.eventId);
  await deps.writeJSON(dayIndexPath(day), idx, 0);
  return { written: true, reason: 'appended', eventId: event.eventId };
}

async function loadDecisionEvents(deps, day) {
  const idx = await deps.readJSON(dayIndexPath(day), null);
  if (!idx) return [];
  const events = await Promise.all(idx.eventIds.map(async (id) => deps.readJSON(`${EVENTS_PREFIX}${day}/${id}.json`, null)));
  return events.filter(Boolean);
}

module.exports = {
  DECISION_EVENTS_VERSION, EVENTS_PREFIX,
  makeDecisionEvent, appendDecisionEvent, loadDecisionEvents, eventPath, dayIndexPath,
};
