'use strict';
// Tech Operational Evidence — shared schema: deterministic IDs, content hashes,
// timestamp semantics, and entity constructors.
//
// Timestamp contract (all stored as UTC ISO strings):
//   effectiveDate   — the date the underlying activity happened (e.g. the npm download day,
//                     the release published_at date, the SEC period end). May precede observation.
//   firstObservedAt — the first time THIS system saw the fact. For backfilled history this is
//                     the backfill run time and the observation carries basis:'backfill'.
//   retrievedAt     — when the current payload was fetched (== firstObservedAt on first write;
//                     revisions get their own observation rather than overwriting).
//   publicAt        — best-known moment the fact became publicly observable (used for
//                     forward-ledger entry eligibility; conservative when unknown).

const crypto = require('node:crypto');
const { stableStringify } = require('../immutable-ledger');

const SCHEMA_VERSION = 'tech-evidence-v1';

// Source arms. `pit` arms expose genuine point-in-time history and may backfill;
// `forward` arms only observe the present and must accrue history honestly.
const SOURCES = Object.freeze({
  sec: Object.freeze({ id: 'sec', label: 'SEC Company Facts', kind: 'pit', scored: true }),
  npm: Object.freeze({ id: 'npm', label: 'npm downloads', kind: 'pit', scored: true }),
  github: Object.freeze({ id: 'github', label: 'GitHub releases', kind: 'pit', scored: true }),
  statuspage: Object.freeze({ id: 'statuspage', label: 'Status page incidents', kind: 'pit', scored: false }),
  greenhouse: Object.freeze({ id: 'greenhouse', label: 'Greenhouse job board', kind: 'forward', scored: false }),
  lever: Object.freeze({ id: 'lever', label: 'Lever job board', kind: 'forward', scored: false }),
  huggingface: Object.freeze({ id: 'huggingface', label: 'Hugging Face hub', kind: 'forward', scored: false }),
  usaspending: Object.freeze({ id: 'usaspending', label: 'USAspending awards', kind: 'pit', scored: false }),
  pricing: Object.freeze({ id: 'pricing', label: 'Pricing page changes', kind: 'forward', scored: false }),
});

const SOURCE_IDS = Object.freeze(Object.keys(SOURCES));
// The prespecified experiment family: scored arms × horizons {5,10}. 1-session results
// are reported descriptively and are NOT part of the FDR family.
const SCORED_ARMS = Object.freeze(SOURCE_IDS.filter((s) => SOURCES[s].scored));
const HORIZONS = Object.freeze([1, 5, 10]);
const FAMILY_HORIZONS = Object.freeze([5, 10]);

const ARM_STATES = Object.freeze({
  COLLECTING: 'COLLECTING',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  NULL: 'NULL',
  PROMISING_RESEARCH: 'PROMISING_RESEARCH',
  VALIDATED: 'VALIDATED', // reserved for docs/model-promotion-policy.md — never auto-assigned here
});

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : stableStringify(v)).digest('hex');
const shortHash = (v, len = 24) => sha(v).slice(0, len);

const isIsoDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// Deterministic observation ID: identical fetches converge on one ID (idempotent retries);
// a restated value for the same (source, entity, metric, effectiveDate) yields a NEW id —
// stored as a revision observation, never an overwrite. `discriminator` separates distinct
// facts that would otherwise collide (two releases on one day, two same-amount awards,
// two incidents on one day) — collision would silently drop the second fact.
function observationId({ source, entity, metric, effectiveDate, value, discriminator = null }) {
  return `obs-${shortHash({ source, entity, metric, effectiveDate, value, discriminator })}`;
}

function makeObservation({
  source, ticker, entity, metric, effectiveDate, value, unit = null,
  sourceUrl = null, payloadHash = null, publicAt = null, basis = 'live',
  mappingId = null, mappingVersion = null, quality = null, detail = null,
  discriminator = null, retrievedAt,
}) {
  if (!SOURCES[source]) throw new Error(`unknown source "${source}"`);
  if (!isIsoDate(effectiveDate)) throw new Error(`observation needs effectiveDate YYYY-MM-DD, got ${effectiveDate}`);
  if (!retrievedAt) throw new Error('observation needs retrievedAt (UTC ISO)');
  const id = observationId({ source, entity, metric, effectiveDate, value, discriminator });
  return Object.freeze({
    v: SCHEMA_VERSION, id, source, ticker: ticker || null, entity, metric,
    effectiveDate, value, unit, discriminator,
    sourceUrl, payloadHash,
    publicAt: publicAt || null,
    basis, // 'live' | 'backfill'
    mappingId, mappingVersion,
    firstObservedAt: retrievedAt, retrievedAt,
    quality: quality || null,
    detail: detail || null,
  });
}

function signalId({ arm, ticker, cutoffDate }) {
  return `sig-${shortHash({ arm, ticker, cutoffDate, v: SCHEMA_VERSION })}`;
}

function forwardEventId({ arm, ticker, cutoffDate }) {
  return `fwd-${shortHash({ arm, ticker, cutoffDate, v: SCHEMA_VERSION })}`;
}

// Hash of normalized upstream content (pricing pages, filing passages) so change
// detection never needs to store the full raw payload.
function contentHash(text) {
  return sha(String(text == null ? '' : text));
}

module.exports = {
  SCHEMA_VERSION, SOURCES, SOURCE_IDS, SCORED_ARMS, HORIZONS, FAMILY_HORIZONS, ARM_STATES,
  sha, shortHash, isIsoDate,
  observationId, makeObservation, signalId, forwardEventId, contentHash,
};
