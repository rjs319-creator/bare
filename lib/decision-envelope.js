'use strict';
// CANONICAL DECISION ENVELOPE (decision-envelope-v1)
//
// One shared vocabulary for what happened to a candidate at decision time, and one
// resolver for the identity fields every prospective decision row should carry
// (strategy version, calibration version, code commit, provenance). The app grew
// ≥5 per-ledger selection vocabularies ('excluded', 'eligible-not-selected',
// 'nearThreshold', 'prosecutorRejected', …) that no consumer could compare; this
// module maps them all onto ONE five-value enum without touching the legacy fields —
// ledgers keep writing their native vocabulary, the envelope adds the normalized view.
//
// Pure: no network, no clock, no store. Code identity comes from run-manifest's
// codeVersion() (env-derived), resolved once per call site, never per row.

const { STRATEGY_REGISTRY } = require('./strategy-registry');
const { codeVersion } = require('./run-manifest');

const ENVELOPE_VERSION = 'decision-envelope-v1';

// The canonical five-value selection state:
//   selected     evaluated and chosen (displayed/ranked/inventoried) — shadow picks included
//   rejected     evaluated and NOT chosen (failed a gate, ranked out, near-threshold)
//   suppressed   eligible but deliberately withheld (governance, cooldown, wait-recommendation)
//   unavailable  could not be evaluated (missing data, feed down, no candles)
//   error        evaluation attempted and failed
const SELECTION_STATES = Object.freeze(['selected', 'rejected', 'suppressed', 'unavailable', 'error']);

// Legacy per-ledger vocabularies → canonical state. Unknown values fail CLOSED to
// 'error' rather than being guessed into a benign state — an unrecognized label is a
// contract violation the caller should see, not silently absorb.
const LEGACY_STATE_MAP = Object.freeze({
  // selected-family
  selected: 'selected', shadow: 'selected', 'in-inventory': 'selected', active: 'selected',
  // rejected-family
  rejected: 'rejected', excluded: 'rejected', 'eligible-not-selected': 'rejected',
  nearthreshold: 'rejected', 'near-threshold': 'rejected', prosecutorrejected: 'rejected',
  currentalgonotselected: 'rejected', removed: 'rejected',
  // suppressed-family
  suppressed: 'suppressed', waitrecommended: 'suppressed', 'wait-recommended': 'suppressed',
  cooldown: 'suppressed', gated: 'suppressed',
  // unavailable-family
  unavailable: 'unavailable', 'no-data': 'unavailable', missing: 'unavailable', stale: 'unavailable',
  // error-family
  error: 'error', failed: 'error',
});

function normalizeSelectionState(raw) {
  if (raw == null) return null;                       // unknown stays unknown, never invented
  const key = String(raw).toLowerCase();
  return LEGACY_STATE_MAP[key] || 'error';
}

// Strategy identity from the canonical registry. Unknown ids resolve to nulls — the
// row still records the raw id it claimed, and the nulls are visible downstream.
function strategyIdentity(strategyId) {
  const entry = strategyId ? STRATEGY_REGISTRY.find((s) => s.id === strategyId) : null;
  return {
    strategyId: strategyId || null,
    strategyVersion: (entry && entry.scoringVersion) || null,
    registered: !!entry,
  };
}

// The per-call-site envelope context: resolve code identity once, stamp many rows.
// `calibrationVersion` stays null unless the caller genuinely has a versioned
// calibrator — a null here is the honest default the schema expects.
function envelopeContext({ provenance = 'prospective_live', calibrationVersion = null } = {}) {
  const code = codeVersion();
  return Object.freeze({
    envelopeVersion: ENVELOPE_VERSION,
    codeCommit: (code && code.sha) || null,
    deployId: (code && code.deploymentId) || null,
    provenance,
    calibrationVersion,
  });
}

module.exports = {
  ENVELOPE_VERSION, SELECTION_STATES,
  normalizeSelectionState, strategyIdentity, envelopeContext,
};
