'use strict';
// Expectations Revision Engine — SHADOW-ONLY adapter contract (prepared, NOT
// activated). Pure functions only: nothing here fetches data, touches routes,
// or feeds any live score/rank/weight/maturity. Every output is stamped
// shadow:true + pitStatus:'PIT_UNPROVEN' until (a) the sample audit
// (lib/research/estimates-audit) and (b) vendor PIT semantics both pass —
// flipping that stamp is a deliberate future decision, not a side effect.
//
// The one rule that matters: asOf() returns only observations whose knownAt is
// PRESENT and <= the decision timestamp. Missing availability = excluded
// (fail-closed), never assumed-known.

const crypto = require('crypto');

const PIT_STATUS = 'PIT_UNPROVEN';
// Normalized revisions divide by max(|previous|, floor) so near-zero EPS bases
// can't explode a percentage; raw changes are always preserved alongside.
const EPS_SCALE_FLOOR = 0.10;
const MS_PER_DAY = 86400000;

const toMs = (v) => { const t = v == null ? NaN : Date.parse(v); return Number.isFinite(t) ? t : null; };
const numOrNull = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

const contentHash = (raw) => crypto.createHash('sha256').update(stableStringify(raw)).digest('hex');

/**
 * Normalize one vendor row into the adapter observation schema. `fields` maps
 * schema roles to raw column names (from the audit's columnMapping picks).
 */
function normalizeObservation(raw, fields, { source = 'nasdaq-data-link', ingestedAt = null } = {}) {
  const get = (role) => (fields[role] != null ? raw[fields[role]] : null);
  return Object.freeze({
    securityId: get('securityId') ?? null,
    symbolAtObservation: get('ticker') ?? null,
    fiscalPeriod: get('fiscalPeriod') ?? null,
    metric: get('metric') ?? 'EPS',
    estimateValue: numOrNull(get('estimateValue')),
    estimateType: get('estimateType') ?? 'consensus_mean',
    analystCount: numOrNull(get('analystCount')),
    upRevisions: numOrNull(get('upRevisions')),
    downRevisions: numOrNull(get('downRevisions')),
    dispersion: numOrNull(get('dispersion')),
    sourcePublishedAt: get('publishedAt') ?? null,
    knownAt: get('asOfDate') ?? get('publishedAt') ?? null,
    ingestedAt,
    source,
    rawContentHash: contentHash(raw),
    provenance: Object.freeze({ shadow: true, pitStatus: PIT_STATUS, fields: Object.freeze({ ...fields }) }),
  });
}

/**
 * Point-in-time filter: observations genuinely available by decisionTs.
 * Fail-closed — an observation with no parseable knownAt is EXCLUDED.
 */
function asOf(observations, decisionTs) {
  const cutoff = toMs(decisionTs);
  if (cutoff == null) return [];
  return observations.filter(o => {
    const known = toMs(o && o.knownAt);
    return known != null && known <= cutoff;
  });
}

// Latest available observation strictly by knownAt (ties keep the later array entry).
function latestAsOf(observations, decisionTs) {
  const eligible = asOf(observations, decisionTs);
  return eligible.reduce((best, o) => (best == null || toMs(o.knownAt) >= toMs(best.knownAt) ? o : best), null);
}

/**
 * Change in estimate over a trailing window, as of decisionTs. Returns raw and
 * floor-scaled normalized change (never unstable percent-of-near-zero), plus
 * the two observations' knownAt for staleness inspection.
 */
function revisionOverWindow(observations, decisionTs, windowDays) {
  const cutoff = toMs(decisionTs);
  if (cutoff == null) return { raw: null, normalized: null, windowDays };
  const current = latestAsOf(observations, decisionTs);
  const prior = latestAsOf(observations, new Date(cutoff - windowDays * MS_PER_DAY).toISOString());
  if (!current || !prior || current.estimateValue == null || prior.estimateValue == null) {
    return { raw: null, normalized: null, windowDays };
  }
  const raw = current.estimateValue - prior.estimateValue;
  const normalized = raw / Math.max(Math.abs(prior.estimateValue), EPS_SCALE_FLOOR);
  return { raw, normalized, windowDays, currentKnownAt: current.knownAt, priorKnownAt: prior.knownAt };
}

const revision7d = (obs, ts) => revisionOverWindow(obs, ts, 7);
const revision30d = (obs, ts) => revisionOverWindow(obs, ts, 30);
const revision90d = (obs, ts) => revisionOverWindow(obs, ts, 90);

/** Net up/down revision breadth from the latest available observation. */
function revisionBreadth(observations, decisionTs) {
  const o = latestAsOf(observations, decisionTs);
  if (!o || o.upRevisions == null || o.downRevisions == null) return null;
  const denom = Math.max(o.analystCount ?? 0, o.upRevisions + o.downRevisions, 1);
  return (o.upRevisions - o.downRevisions) / denom;
}

/** Recent-window revision minus the prior same-length window (raw-change diff). */
function revisionAcceleration(observations, decisionTs, windowDays = 30) {
  const cutoff = toMs(decisionTs);
  if (cutoff == null) return null;
  const recent = revisionOverWindow(observations, decisionTs, windowDays);
  const prior = revisionOverWindow(observations, new Date(cutoff - windowDays * MS_PER_DAY).toISOString(), windowDays);
  if (recent.raw == null || prior.raw == null) return null;
  return { raw: recent.raw - prior.raw, normalized: (recent.normalized ?? 0) - (prior.normalized ?? 0), windowDays };
}

/** Change in analyst dispersion (disagreement) over a window, when available. */
function disagreementChange(observations, decisionTs, windowDays = 30) {
  const cutoff = toMs(decisionTs);
  if (cutoff == null) return null;
  const current = latestAsOf(observations, decisionTs);
  const prior = latestAsOf(observations, new Date(cutoff - windowDays * MS_PER_DAY).toISOString());
  if (!current || !prior || current.dispersion == null || prior.dispersion == null) return null;
  return { raw: current.dispersion - prior.dispersion, windowDays };
}

/** Days until the given earnings datetime, from the decision timestamp. */
function daysToEarnings(decisionTs, earningsTs) {
  const d = toMs(decisionTs), e = toMs(earningsTs);
  if (d == null || e == null) return null;
  return (e - d) / MS_PER_DAY;
}

/** Missingness + staleness of the observation set as of decisionTs. */
function missingnessAndStaleness(observations, decisionTs) {
  const eligible = asOf(observations, decisionTs);
  const latest = latestAsOf(observations, decisionTs);
  const fields = ['estimateValue', 'analystCount', 'upRevisions', 'downRevisions', 'dispersion'];
  const missing = latest ? fields.filter(f => latest[f] == null) : fields;
  const staleDays = latest ? (toMs(decisionTs) - toMs(latest.knownAt)) / MS_PER_DAY : null;
  return { eligibleCount: eligible.length, latestKnownAt: latest ? latest.knownAt : null, staleDays, missingFields: missing };
}

/**
 * Full shadow feature vector for one security/period/metric observation set.
 * Probability-free by construction; stamped shadow + PIT_UNPROVEN.
 */
function shadowFeatures(observations, decisionTs, { earningsTs = null } = {}) {
  return Object.freeze({
    shadow: true,
    pitStatus: PIT_STATUS,
    decisionTs,
    revision7d: revision7d(observations, decisionTs),
    revision30d: revision30d(observations, decisionTs),
    revision90d: revision90d(observations, decisionTs),
    revisionBreadth: revisionBreadth(observations, decisionTs),
    revisionAcceleration: revisionAcceleration(observations, decisionTs),
    disagreementChange: disagreementChange(observations, decisionTs),
    daysToEarnings: daysToEarnings(decisionTs, earningsTs),
    coverage: missingnessAndStaleness(observations, decisionTs),
  });
}

module.exports = {
  normalizeObservation, asOf, latestAsOf,
  revisionOverWindow, revision7d, revision30d, revision90d,
  revisionBreadth, revisionAcceleration, disagreementChange,
  daysToEarnings, missingnessAndStaleness, shadowFeatures,
  contentHash, PIT_STATUS, EPS_SCALE_FLOOR,
};
