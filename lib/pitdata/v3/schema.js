'use strict';
// PIT-DATA-V3 SCHEMA (pit-data-v3) — versioned, longitudinal, append-only data
// foundation. Built BESIDE pit-data-v2 (lib/pitdata/*.js): nothing here reads or
// rewrites a v2 artifact, and no live consumer reads v3 until the reconciliation
// gates AND a separate human promotion artifact exist (lib/pitdata/v3/reconcile.js).
//
// Fixes the verified v2 defects at the schema layer:
//   * DEFECT 4 — v2 hashed `{rows: N}` and stored a null payload for /stock-list.
//     v3 content objects hash the EXACT canonical payload and store it: two
//     different same-length payloads produce different hashes, always.
//   * Content is separated from observation: identical payloads share ONE content
//     object; every sighting is its own append-only observation record, so the
//     same payload seen on two dates keeps both observations.
//   * DEFECT 3 — provenance is a per-run input ('historical_reconstruction' for
//     backfill, 'prospective_live' for recurring collection), never a constant.
//   * Four distinct timestamps (effectiveAt / sourcePublishedAt / observedAt /
//     ingestedAt) are kept apart; intervals are HALF-OPEN [effectiveFrom,
//     effectiveTo) and comparisons preserve full ISO timestamps (no calendar-day
//     truncation).
//
// Pure module: no network, no clock, no store.

const crypto = require('crypto');
const { redactSecrets } = require('../../redact');

const PITDATA_V3_VERSION = 'pit-data-v3';

// ── Storage layout (all under the shadow pitdata/v3/ Blob prefix) ─────────────
const P = Object.freeze({
  content: (fullSha256) => `pitdata/v3/raw/content/${fullSha256}.json`,
  observation: (date, runId, sequence) => `pitdata/v3/raw/observations/${date}/${runId}/${sequence}.json`,
  run: (date, runId) => `pitdata/v3/runs/${date}/${runId}.json`,
  state: (collector) => `pitdata/v3/state/${collector}.json`,
  listings: (shard) => `pitdata/v3/listings/${shard}.json`,
  aliases: (shard) => `pitdata/v3/aliases/${shard}.json`,
  universe: (policyVersion, date) => `pitdata/v3/universes/${policyVersion}/${date}.json`,
  health: (date) => `pitdata/v3/health/${date}.json`,
  reconciliation: (date) => `pitdata/v3/reconciliation/${date}.json`,
  promotion: (date) => `pitdata/v3/promotion/${date}.json`,
});

const PROVENANCE = Object.freeze({
  PROSPECTIVE_LIVE: 'prospective_live',
  HISTORICAL_RECONSTRUCTION: 'historical_reconstruction',
});

// The two EXPLICIT query policies. They are never mixed silently: every resolver
// result carries the policy it was answered under.
//   prospective_replay — only information genuinely known by the decision knownAt.
//   retrospective_universe_reconstruction — may use later-acquired STABLE listing/
//     delisting facts to correct survivorship, is marked reconstructed:true, and
//     must never leak later fundamentals/estimates/news/mutable features.
const QUERY_POLICIES = Object.freeze({
  PROSPECTIVE_REPLAY: 'prospective_replay',
  RETROSPECTIVE_UNIVERSE_RECONSTRUCTION: 'retrospective_universe_reconstruction',
});

const INTERVAL_SEMANTICS = 'half-open [effectiveFrom, effectiveTo)';

// ── Canonical JSON + content addressing ───────────────────────────────────────
// Deterministic stringify: object keys sorted at every depth so the SAME logical
// payload always produces the SAME hash regardless of vendor key order.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

// Hash of the EXACT canonical response payload — never a summary of it.
function contentHashOf(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function sanitizeParams(params) {
  const clean = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (/^(apikey|api[-_]?key|token|secret|authorization)$/i.test(k)) continue;
    clean[k] = v;
  }
  return clean;
}

// Immutable content object: identical payloads share one object (hash = key).
function makeContentObject(payload) {
  const canonical = canonicalJson(payload);
  return Object.freeze({
    schema: 'PitContentV3', version: PITDATA_V3_VERSION,
    contentHash: crypto.createHash('sha256').update(canonical).digest('hex'),
    bytes: canonical.length,
    rows: Array.isArray(payload) ? payload.length : null,
    payload,   // the EXACT payload — auditors re-derive the hash from this
  });
}

// Append-only observation of one response at one moment. NEVER rewritten; a
// correction appends a superseding observation instead.
function makeObservation({
  endpoint, params = {}, runId, sequence, date,
  effectiveAt = null, sourcePublishedAt = null, observedAt, ingestedAt,
  httpStatus, contentHash, provenance,
}) {
  return Object.freeze({
    schema: 'PitObservationV3', version: PITDATA_V3_VERSION,
    endpoint: redactSecrets(endpoint), params: Object.freeze(sanitizeParams(params)),
    runId, sequence, date,
    // Four distinct time axes, kept apart on purpose:
    effectiveAt,           // when the fact was true in the world (null = unknown)
    sourcePublishedAt,     // when the source published it (null = unknown)
    observedAt,            // when THIS system first observed it (knownAt)
    ingestedAt,            // when persistence completed
    httpStatus: httpStatus ?? null,
    contentHash,
    provenance: provenance === PROVENANCE.PROSPECTIVE_LIVE
      ? PROVENANCE.PROSPECTIVE_LIVE : PROVENANCE.HISTORICAL_RECONSTRUCTION,
  });
}

// Run manifest — the per-run completeness record. `completedPages` is a SET of
// page ids so an idempotent retry can never double-count a page.
function makeRunManifest({ runId, date, collector, provenance, startedAt }) {
  return {
    schema: 'PitRunManifestV3', version: PITDATA_V3_VERSION,
    runId, date, collector,
    provenance: provenance === PROVENANCE.PROSPECTIVE_LIVE
      ? PROVENANCE.PROSPECTIVE_LIVE : PROVENANCE.HISTORICAL_RECONSTRUCTION,
    startedAt: startedAt || null, endedAt: null,
    requestedPages: [], completedPages: [],
    rowCounts: {}, contentHashes: {},
    failures: [], retries: 0,
    // Vendor plan gates (e.g. pagination refused on the current subscription):
    // recorded, never retried, and the run completes WITH LIMITATIONS — the
    // reconciliation coverage gates then fail on the real (truncated) numbers.
    limitations: [],
    complete: false,
    completenessStatus: 'in-progress',   // in-progress | complete | complete-with-limitations | failed
  };
}

// ── Half-open effective intervals with full-ISO comparison ────────────────────
// "at ts" means effectiveFrom <= ts < effectiveTo. Timestamps compare as full ISO
// strings; a date-only bound is normalized to midnight UTC (start of that day) so
// the half-open convention stays exact instead of truncating queries to days.
const isoFloor = (t) => (t && t.length === 10 ? `${t}T00:00:00.000Z` : t);
// "Known by DATE" means known by the END of that date (matches v2 semantics).
const knownAtCeil = (t) => (t && t.length === 10 ? `${t}T23:59:59.999Z` : t);

function inHalfOpenInterval(iv, ts) {
  if (!iv || !ts) return false;
  const t = isoFloor(ts);
  if (iv.effectiveFrom && t < isoFloor(iv.effectiveFrom)) return false;
  if (iv.effectiveTo && t >= isoFloor(iv.effectiveTo)) return false;   // exclusive upper bound
  return true;
}

function makeIntervalV3({ value, effectiveFrom = null, effectiveTo = null, knownAt, source, provenance, confirmation = null }) {
  return Object.freeze({
    value, effectiveFrom, effectiveTo,   // half-open: [effectiveFrom, effectiveTo)
    intervalSemantics: INTERVAL_SEMANTICS,
    knownAt: knownAt || null, source: source || null,
    provenance: provenance === PROVENANCE.PROSPECTIVE_LIVE
      ? PROVENANCE.PROSPECTIVE_LIVE : PROVENANCE.HISTORICAL_RECONSTRUCTION,
    confirmation,
  });
}

// Knowledge policy check for one fact. prospective_replay: the fact must have been
// known by the query's knownAt. retrospective_universe_reconstruction: ONLY stable
// listing facts (status/alias/listing-life) may bypass the knowledge cut; mutable
// facts (classification, fundamentals, floats, …) still must respect it.
const STABLE_FACT_KINDS = Object.freeze(['status', 'alias', 'listing']);
function knowledgeAdmits({ factKnownAt, queryKnownAt, policy, factKind = null }) {
  if (!queryKnownAt) return policy !== QUERY_POLICIES.PROSPECTIVE_REPLAY;   // replay without a cut is invalid → fail closed
  if (policy === QUERY_POLICIES.RETROSPECTIVE_UNIVERSE_RECONSTRUCTION && STABLE_FACT_KINDS.includes(factKind)) return true;
  if (!factKnownAt) return false;                       // unknown knowledge time fails closed under replay
  return factKnownAt <= knownAtCeil(queryKnownAt);
}

const shardKeyFor = (symbol) => {
  const c = String(symbol || '').toUpperCase()[0];
  return c >= 'A' && c <= 'Z' ? c : '0';
};
const SHARD_KEYS = Object.freeze(['0', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))]);

module.exports = {
  PITDATA_V3_VERSION, P, PROVENANCE, QUERY_POLICIES, INTERVAL_SEMANTICS, STABLE_FACT_KINDS,
  canonicalJson, contentHashOf, sanitizeParams,
  makeContentObject, makeObservation, makeRunManifest, makeIntervalV3,
  inHalfOpenInterval, knowledgeAdmits, isoFloor, knownAtCeil,
  shardKeyFor, SHARD_KEYS,
};
