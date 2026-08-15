'use strict';
// CATALYST–FLOW — SERVING (read-only).
//
// A request READS the published artifact and nothing else. It does not train, does not
// load LightGBM, does not recompute a rank, and has no fallback path that could produce a
// ranking the offline pipeline never published. Every failure mode resolves to a NAMED
// STATE with a reason, which the UI renders verbatim:
//
//   DISABLED           CATALYST_FLOW_ENABLED is not set (the default)
//   UNAVAILABLE        no storage configured, or nothing has ever been published
//   STALE              an artifact exists but its decision date is too old to act on
//   INVALID            an artifact exists but fails its own schema contract
//   SHADOW             a valid, fresh artifact — displayed, weight zero, influences nothing
//   LIVE               reserved; refused until every promotion gate is recorded PASSED
//
// The last one is the important one. `CATALYST_FLOW_MODE=live` does not make this live.
// The gates in config.PROMOTION_GATES must be recorded as passed on IMMUTABLE point-in-time
// evidence, and until they are, `resolveMode` returns SHADOW with the failing gates named.

const { flags, PROMOTION_GATES, CATALYST_FLOW_VERSION } = require('./config');
const { validateArtifact, freshness } = require('./artifact');
const STORE = require('./store');

const SERVING_VERSION = 'catalyst-flow-serving-v1';

// Which promotion gates a published artifact can evidence on its own. Gates it cannot
// evidence are treated as NOT passed — silence is never consent here.
function evaluateGates(doc) {
  const dq = (doc && doc.dataQuality) || {};
  const passed = {
    pitImmutableEvidence: dq.pitClass === 'IMMUTABLE_PIT',
    delistingsIncluded: dq.delistingsIncluded === true,
    signedOptionsCoverage: doc && doc.arm === 'E3_CATALYST_FLOW_RANKER' ? dq.optionsSignedCoverage === true : true,
    ablationSurvivesFDR: dq.ablationSurvivesFDR === true,
    positiveNetOfStressCost: dq.positiveNetOfStressCost === true,
    deflatedSharpePositive: dq.deflatedSharpePositive === true,
    holdoutUntouched: dq.holdoutUntouched === true,
  };
  const failing = PROMOTION_GATES.filter((g) => passed[g] !== true);
  return { passed, failing, allPassed: failing.length === 0 };
}

// Mode is EARNED, not configured.
function resolveMode(doc, env = process.env) {
  const f = flags(env);
  if (f.mode !== 'live') return { mode: 'shadow', reason: 'configured shadow', failingGates: [] };
  const g = evaluateGates(doc);
  if (!g.allPassed) {
    return { mode: 'shadow', reason: `live requested but ${g.failing.length} promotion gate(s) not passed`, failingGates: g.failing };
  }
  return { mode: 'live', reason: 'all promotion gates passed', failingGates: [] };
}

// The single read the route performs.
async function readLatestRanking({ sessions = [], today = null, env = process.env } = {}) {
  const f = flags(env);
  const base = { version: SERVING_VERSION, engineVersion: CATALYST_FLOW_VERSION, weight: 0, influencesLivePicks: false };

  if (!f.enabled) {
    return { ...base, state: 'DISABLED', reason: 'CATALYST_FLOW_ENABLED is not set — the engine is off by default', artifact: null };
  }
  if (!STORE.hasStore()) {
    return { ...base, state: 'UNAVAILABLE', reason: 'no blob storage configured (BLOB_READ_WRITE_TOKEN absent)', artifact: null };
  }

  const pointer = await STORE.readLatest();
  const date = pointer && pointer.decisionDate ? pointer.decisionDate : null;
  const doc = date ? await STORE.readPrediction(date) : null;
  if (!doc) {
    return { ...base, state: 'UNAVAILABLE', reason: 'no prediction artifact has been published — the offline trainer has not run', artifact: null };
  }

  const v = validateArtifact(doc);
  if (!v.ok) {
    return { ...base, state: 'INVALID', reason: `artifact failed its schema contract: ${v.errors.slice(0, 3).join('; ')}`, artifact: null, errors: v.errors };
  }

  const fr = (sessions.length && today) ? freshness(doc, { sessions, today }) : { fresh: true, ageSessions: null, reason: 'freshness not evaluated (no session axis supplied)' };
  const m = resolveMode(doc, env);
  const gates = evaluateGates(doc);

  if (!fr.fresh) {
    return { ...base, state: 'STALE', reason: `artifact decision date ${doc.decisionDate} is ${fr.ageSessions} sessions old`, artifact: doc, gates, mode: m.mode };
  }

  return {
    ...base,
    state: m.mode === 'live' ? 'LIVE' : 'SHADOW',
    reason: m.reason,
    mode: m.mode,
    failingGates: m.failingGates,
    gates,
    freshness: fr,
    // The limitations the UI is required to display alongside any ranking.
    limitations: limitationsOf(doc),
    artifact: doc,
  };
}

// Plain-language limitations derived from the artifact's own dataQuality — never a
// hand-maintained list that can drift away from what was actually measured.
function limitationsOf(doc) {
  const dq = (doc && doc.dataQuality) || {};
  const out = [];
  if (dq.pitClass !== 'IMMUTABLE_PIT') {
    out.push('The fundamental-catalyst features rest on a vendor snapshot of historical consensus, not on a point-in-time vintage. This ranking is EXPLORATORY and cannot support promotion.');
  }
  if (dq.optionsSignedCoverage !== true) {
    out.push('No signed customer opening option flow is available. Those features are MISSING (not zero), and the with-options arm is INSUFFICIENT_DATA — not a finding about alpha.');
  }
  if (dq.delistingsIncluded !== true) {
    out.push('Delisting returns are not fully represented, so historical evidence behind this ranking is not survivorship-proven.');
  }
  if (dq.spreadIsProxy === true) {
    out.push('Liquidity cost uses a high/low spread PROXY; the app has no NBBO quote feed.');
  }
  out.push('Scores are ORDINAL relevance from a ranking model. They are not expected returns and not probabilities.');
  return out;
}

module.exports = { SERVING_VERSION, evaluateGates, resolveMode, readLatestRanking, limitationsOf };
