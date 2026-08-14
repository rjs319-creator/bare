'use strict';
// CATALYST–FLOW — IMMUTABLE POINT-IN-TIME EVENT SCHEMA (catalyst-event-v1).
//
// One row = one OBSERVATION of one catalyst event by one source at one moment. Rows are
// APPEND-ONLY. When a vendor revises a record we append a new revision; the earlier
// observation is never rewritten, because "what did we know, and when?" is the only
// question the whole experiment rests on.
//
// THE TRAP THIS SCHEMA IS BUILT AROUND. A historical endpoint that returns today's
// CORRECTED consensus is not point-in-time merely because the event date is old. Every
// row therefore carries `pitClass`:
//
//   IMMUTABLE_PIT            the value was written to our ledger before the event, or the
//                            provider stamps an observation time we captured ourselves.
//   RECONSTRUCTED_EXPLORATORY a today-snapshot of a historical value. Usable for
//                            exploration; EXCLUDED from promotion evidence, always.
//
// Measured on this repo's own vendor earnings archive: 110,237 of 110,238 reported rows
// carry a `lastUpdated` AFTER the announcement date. The estimates are a post-release
// snapshot, so essentially the entire fundamental-catalyst family is EXPLORATORY here.
// That is a data fact, recorded per row, not an opinion about the strategy.
//
// Pure module: no network, no clock, no fs. Callers inject timestamps.

const crypto = require('crypto');
const { SCHEMA_VERSION } = require('./config');

const PIT_CLASSES = Object.freeze(['IMMUTABLE_PIT', 'RECONSTRUCTED_EXPLORATORY']);
const EVENT_TYPES = Object.freeze(['EARNINGS', 'GUIDANCE', 'EARNINGS_AND_GUIDANCE']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Deterministic canonical JSON — key order must not change a payload hash.
//
// Keys whose value is `undefined` are OMITTED, exactly as JSON.stringify omits them.
// Without this, `{...row, rowHash: undefined}` serialises a `"rowHash":undefined` member
// that an object simply lacking the key does not, so a revision's stored hash could not be
// recomputed by a verifier — the append-only chain would be unauditable from revision 2 on.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  return `{${Object.keys(v).sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
const payloadHash = (payload) => sha256(canonicalJson(payload === undefined ? null : payload));

// A stable eventId must survive a re-ingest of the same event from the same source and
// must NOT change when the vendor revises the figures — revisions are new versions of the
// SAME event, not new events.
const eventId = ({ symbol, eventDate, eventType, source }) =>
  `${String(symbol).toUpperCase()}|${eventDate}|${eventType}|${source}`;

const isIsoDate = (v) => typeof v === 'string' && ISO_DATE_RE.test(v);
const isIsoTs = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

// Every required field, with the reason it is required. A row failing any of these is
// REJECTED — a partially-observed event silently admitted is how leakage gets in.
const REQUIRED = Object.freeze([
  'eventId', 'symbol', 'securityIdAsOf', 'eventType',
  'providerEventTimestamp', 'firstSeenAt', 'ingestedAt',
  'featureCutoffTs', 'decisionDate', 'plannedEntryTs',
  'source', 'rawPayloadHash', 'revision', 'pitClass',
]);

// Build one immutable observation row.
//
// `revision` starts at 1 and increments per appended observation of the same eventId.
// `supersedes` links to the prior revision's rowHash so the chain is verifiable.
function buildEventRow(input) {
  const {
    symbol, securityIdAsOf, eventType, providerEventTimestamp,
    firstSeenAt, ingestedAt, featureCutoffTs, decisionDate, plannedEntryTs,
    source, rawPayload, revision = 1, supersedes = null, pitClass,
    epsActual = null, epsConsensusPreRelease = null, epsConsensusAsOfTs = null,
    revenueActual = null, revenueConsensusPreRelease = null, revenueConsensusAsOfTs = null,
    guidancePrevious = null, guidanceNew = null, guidanceConsensusPreEvent = null,
    rawTextRef = null, rawTextHash = null,
    dataQuality = {},
  } = input || {};

  const eventDate = isIsoTs(providerEventTimestamp) ? providerEventTimestamp.slice(0, 10) : null;
  const id = eventId({ symbol, eventDate, eventType, source });

  const row = {
    schema: SCHEMA_VERSION,
    eventId: id,
    symbol: String(symbol || '').toUpperCase() || null,
    securityIdAsOf: securityIdAsOf || null,
    eventType,
    providerEventTimestamp,
    firstSeenAt,
    ingestedAt,
    featureCutoffTs,
    decisionDate,
    plannedEntryTs,
    source,
    rawPayloadHash: payloadHash(rawPayload),
    revision,
    supersedes,
    pitClass,

    epsActual: numOrNull(epsActual),
    epsConsensusPreRelease: numOrNull(epsConsensusPreRelease),
    epsConsensusAsOfTs,
    revenueActual: numOrNull(revenueActual),
    revenueConsensusPreRelease: numOrNull(revenueConsensusPreRelease),
    revenueConsensusAsOfTs,
    guidancePrevious, guidanceNew, guidanceConsensusPreEvent,
    rawTextRef,
    rawTextHash: rawTextHash || (rawTextRef ? sha256(rawTextRef) : null),

    dataQuality: { ...dataQuality },
  };
  row.rowHash = payloadHash(row);
  return row;
}

// Validate a row. Returns { ok, errors[] } — never throws, so a bad vendor row is
// COUNTED as an ingestion rejection rather than killing a sweep.
function validateEventRow(row) {
  const errors = [];
  if (!row || typeof row !== 'object') return { ok: false, errors: ['not an object'] };
  if (row.schema !== SCHEMA_VERSION) errors.push(`schema must be ${SCHEMA_VERSION}`);
  for (const f of REQUIRED) if (row[f] === null || row[f] === undefined || row[f] === '') errors.push(`missing ${f}`);
  if (row.eventType && !EVENT_TYPES.includes(row.eventType)) errors.push(`eventType not in ${EVENT_TYPES.join('/')}`);
  if (row.pitClass && !PIT_CLASSES.includes(row.pitClass)) errors.push(`pitClass not in ${PIT_CLASSES.join('/')}`);
  for (const f of ['providerEventTimestamp', 'firstSeenAt', 'ingestedAt', 'featureCutoffTs', 'plannedEntryTs']) {
    if (row[f] && !isIsoTs(row[f])) errors.push(`${f} is not an ISO timestamp`);
  }
  if (row.decisionDate && !isIsoDate(row.decisionDate)) errors.push('decisionDate is not YYYY-MM-DD');

  // ── The ordering invariants. These are the leakage contract. ──
  const t = (v) => (isIsoTs(v) ? Date.parse(v) : null);
  const ev = t(row.providerEventTimestamp), seen = t(row.firstSeenAt);
  const cut = t(row.featureCutoffTs), entry = t(row.plannedEntryTs);
  if (ev != null && seen != null && seen < ev) errors.push('firstSeenAt precedes the event timestamp');
  if (cut != null && entry != null && entry <= cut) errors.push('plannedEntryTs is not strictly after the feature cutoff');

  // firstSeenAt AFTER the feature cutoff means we did not hold this observation when the
  // decision was notionally made. For an IMMUTABLE_PIT row that is a contradiction and a
  // hard error. For a RECONSTRUCTED_EXPLORATORY row it is the DEFINING property — a
  // historical archive is always first seen late — so it is recorded as a warning and as
  // `observedAfterCutoff`, which is precisely why such rows cannot support promotion.
  const warnings = [];
  if (seen != null && cut != null && cut < seen) {
    if (row.pitClass === 'IMMUTABLE_PIT') errors.push('featureCutoffTs precedes firstSeenAt on a row marked IMMUTABLE_PIT');
    else warnings.push('observed after the feature cutoff — reconstructed history, excluded from promotion evidence');
  }

  // A consensus snapshot taken AFTER the release cannot be a pre-release consensus.
  for (const [val, ts, name] of [
    [row.epsConsensusPreRelease, row.epsConsensusAsOfTs, 'eps'],
    [row.revenueConsensusPreRelease, row.revenueConsensusAsOfTs, 'revenue'],
  ]) {
    if (val == null) continue;
    const asOf = t(ts);
    if (asOf == null) { errors.push(`${name} consensus has no observation timestamp`); continue; }
    if (ev != null && asOf >= ev && row.pitClass === 'IMMUTABLE_PIT') {
      errors.push(`${name} consensus was observed at/after the release but is marked IMMUTABLE_PIT`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, observedAfterCutoff: warnings.length > 0 };
}

// Append an observation to a ledger, NEVER overwriting. A revision of a known event gets
// the next revision number and a `supersedes` link to the prior row's hash.
// Returns a NEW array (the input is not mutated).
function appendObservation(ledger, row) {
  const prior = (ledger || []).filter((r) => r.eventId === row.eventId);
  if (!prior.length) return [...(ledger || []), row];
  const last = prior[prior.length - 1];
  // An identical re-observation is a no-op: same payload hash ⇒ nothing new was learned.
  if (last.rawPayloadHash === row.rawPayloadHash) return ledger || [];
  // Rehash over the row WITHOUT its hash field, the same shape buildEventRow hashed, so
  // any verifier can recompute `rowHash` from the stored row and walk the supersedes chain.
  const { rowHash: _prior, ...revised } = { ...row, revision: last.revision + 1, supersedes: last.rowHash };
  revised.rowHash = payloadHash(revised);
  return [...(ledger || []), revised];
}

// The observation of `eventId` that was known at `asOfTs` — the ONLY read a feature
// builder may use. Later revisions are invisible by construction.
function observationAsOf(ledger, id, asOfTs) {
  const at = Date.parse(asOfTs);
  if (!Number.isFinite(at)) return null;
  let best = null;
  for (const r of ledger || []) {
    if (r.eventId !== id) continue;
    const seen = Date.parse(r.firstSeenAt);
    if (!Number.isFinite(seen) || seen > at) continue;
    if (!best || r.revision > best.revision) best = r;
  }
  return best;
}

module.exports = {
  SCHEMA_VERSION, PIT_CLASSES, EVENT_TYPES, REQUIRED,
  sha256, canonicalJson, payloadHash, eventId,
  buildEventRow, validateEventRow, appendObservation, observationAsOf,
};
