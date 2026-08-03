'use strict';
// DATA-SNAPSHOT MANIFEST (snapshot-manifest-v1) — the authoritative, versioned
// description of a research panel. Replaces the single ambiguous "data cutoff"
// with three EXPLICIT timestamps:
//
//   featureAvailabilityCutoff — no feature may be computed from an observation
//                               after this instant (max decision timestamp the
//                               feature layer is allowed to see).
//   lastDecisionTimestamp     — the last decision date actually present in the
//                               panel grid. Must be <= featureAvailabilityCutoff.
//   labelObservationCutoff    — no label may consume a bar after this instant.
//                               Every mature/confirmed label's end date must be
//                               at or before it.
//
// plus lastFullyMatureDecisionDate BY HORIZON: the last decision date whose
// full forward window is observable inside labelObservationCutoff — an
// experiment's periodEnd must never exceed the horizon's entry here.
//
// The datasetHash covers the NORMALIZED panel payload (rows sorted by
// (lid, dt), keys sorted, months sorted) — never just counts or filenames — so
// any change to any row changes the hash. A manifest inconsistency marks the
// panel INVALID (verifySnapshotManifest returns errors; builders must refuse
// to publish, auditors must exit nonzero).
//
// Pure module: no network, no clock, no fs. Callers inject everything.

const crypto = require('crypto');

const SNAPSHOT_MANIFEST_VERSION = 'snapshot-manifest-v1';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Canonical JSON: keys sorted at every level, arrays preserved in order.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

// The normalized-payload hash of a panel document: months sorted, each month's
// rows sorted by (lid, dt, s) with row keys sorted. Metadata is EXCLUDED so the
// hash identifies the data itself (two builds of identical rows hash equal even
// if generatedAt differs).
function normalizedPanelHash(panelByMonth) {
  const months = Object.keys(panelByMonth || {}).sort();
  const parts = [];
  for (const m of months) {
    const rows = [...(panelByMonth[m] || [])].sort((a, b) => {
      const ka = `${a.lid || ''}|${a.dt || ''}|${a.s || ''}`;
      const kb = `${b.lid || ''}|${b.dt || ''}|${b.s || ''}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    parts.push(`${m}:${canonicalJson(rows)}`);
  }
  return sha256(parts.join('\n'));
}

// Hash any JSON-serializable definition object (security master, universe rule).
const definitionHash = (obj) => sha256(canonicalJson(obj));

// buildSnapshotManifest(input) → frozen manifest object. Every field the audit
// gate depends on is REQUIRED; optional context fields default to null (never
// silently invented).
function buildSnapshotManifest(input = {}) {
  const req = (k) => {
    if (input[k] === undefined || input[k] === null) throw new Error(`snapshot-manifest: required field '${k}' missing`);
    return input[k];
  };
  return Object.freeze({
    schema: 'DataSnapshotManifest',
    schemaVersion: SNAPSHOT_MANIFEST_VERSION,
    snapshotId: req('snapshotId'),
    datasetHash: req('datasetHash'),
    codeCommit: input.codeCommit || null,
    generatedAt: req('generatedAt'),
    securityMasterHash: req('securityMasterHash'),
    universeDefinitionHash: req('universeDefinitionHash'),
    // [{ name, version, retrievedAt, earliestObservation, latestObservation }]
    sources: Object.freeze([...(req('sources'))]),
    featureAvailabilityCutoff: req('featureAvailabilityCutoff'),
    lastDecisionTimestamp: req('lastDecisionTimestamp'),
    labelObservationCutoff: req('labelObservationCutoff'),
    // { '21': iso, '63': iso, '126': iso } — last decision whose full window matured
    lastFullyMatureDecisionDate: Object.freeze({ ...req('lastFullyMatureDecisionDate') }),
    marketCalendarVersion: input.marketCalendarVersion || 'observed-trading-days-v1',
    priceAdjustmentBasis: req('priceAdjustmentBasis'),
    corporateActionSource: input.corporateActionSource || null,
    corporateActionStatus: req('corporateActionStatus'),
    sectorClassificationBasis: req('sectorClassificationBasis'),
    rowCount: req('rowCount'),
    securityCount: req('securityCount'),
    listingStatusCounts: Object.freeze({ ...(input.listingStatusCounts || {}) }),
    labelStateCounts: Object.freeze(JSON.parse(JSON.stringify(req('labelStateCounts')))),
    missingnessByFeature: Object.freeze({ ...(input.missingnessByFeature || {}) }),
    excludedRowCounts: Object.freeze({ ...(input.excludedRowCounts || {}) }),
    knownLimitations: Object.freeze([...(input.knownLimitations || [])]),
    supersedes: input.supersedes || null,   // previous datasetHash, if any
  });
}

// ── invariant verification ────────────────────────────────────────────────────
// verifySnapshotManifest(manifest, panelByMonth, opts) → { valid, errors, stats }
// Row contract expected: { s, lid, dt, f{h}/s{h}/le{h} per horizon }, where
// le{h} is the label-end date (last bar the label consumed) — REQUIRED for any
// row whose s{h} is 'm' or 'c'.
function verifySnapshotManifest(manifest, panelByMonth, { horizons = [21, 63, 126] } = {}) {
  const errors = [];
  const push = (msg) => { if (errors.length < 40) errors.push(msg); };

  if (!manifest || manifest.schema !== 'DataSnapshotManifest') {
    return { valid: false, errors: ['not a DataSnapshotManifest'], stats: null };
  }
  const months = Object.keys(panelByMonth || {}).sort();
  let rowCount = 0;
  const lids = new Set();
  const seenKeys = new Set();
  let dupKeys = 0, nullLid = 0, decisionsAfterLast = 0, matureAfterCutoff = 0, matureMissingEnd = 0;
  let lastDt = '';
  const lastMatureByH = {};
  for (const h of horizons) lastMatureByH[h] = '';

  for (const m of months) {
    for (const r of panelByMonth[m] || []) {
      rowCount++;
      if (!r.lid) { nullLid++; continue; }
      lids.add(r.lid);
      const key = `${r.lid}|${r.dt}`;
      if (seenKeys.has(key)) dupKeys++; else seenKeys.add(key);
      if (r.dt > lastDt) lastDt = r.dt;
      if (r.dt > manifest.lastDecisionTimestamp) decisionsAfterLast++;
      for (const h of horizons) {
        // Trainable = a non-null label value. A 'c' row whose label was
        // withheld (unverified reason) is NOT trainable and needs no le{h}.
        if (r[`f${h}`] == null) continue;
        const le = r[`le${h}`];
        if (!le) { matureMissingEnd++; continue; }
        if (le > manifest.labelObservationCutoff) matureAfterCutoff++;
        else if (r.dt > lastMatureByH[h]) lastMatureByH[h] = r.dt;
      }
    }
  }

  if (dupKeys > 0) push(`${dupKeys} duplicate (listingId, decisionTs) keys — identity resolution failed`);
  if (nullLid > 0) push(`${nullLid} rows with null listingId — indefensible identity must be excluded, not embedded`);
  if (decisionsAfterLast > 0) push(`${decisionsAfterLast} rows decided after lastDecisionTimestamp ${manifest.lastDecisionTimestamp}`);
  if (matureAfterCutoff > 0) push(`${matureAfterCutoff} trainable labels end after labelObservationCutoff ${manifest.labelObservationCutoff}`);
  if (matureMissingEnd > 0) push(`${matureMissingEnd} trainable labels missing le{h} (label-end date) — unverifiable maturity`);
  if (manifest.lastDecisionTimestamp > manifest.featureAvailabilityCutoff) {
    push(`lastDecisionTimestamp ${manifest.lastDecisionTimestamp} exceeds featureAvailabilityCutoff ${manifest.featureAvailabilityCutoff}`);
  }
  if (manifest.rowCount !== rowCount) push(`manifest.rowCount ${manifest.rowCount} != actual ${rowCount}`);
  if (manifest.securityCount !== lids.size) push(`manifest.securityCount ${manifest.securityCount} != actual ${lids.size}`);
  for (const h of horizons) {
    if (!(String(h) in manifest.lastFullyMatureDecisionDate)) { push(`lastFullyMatureDecisionDate missing horizon ${h}`); continue; }
    const declared = manifest.lastFullyMatureDecisionDate[String(h)];   // null is valid when no trainable labels exist yet
    if (lastMatureByH[h] && (!declared || declared < lastMatureByH[h])) {
      push(`lastFullyMatureDecisionDate[${h}]=${declared} earlier than observed mature decision ${lastMatureByH[h]}`);
    }
  }
  const actualHash = normalizedPanelHash(panelByMonth);
  if (manifest.datasetHash !== actualHash) push(`datasetHash mismatch: manifest ${String(manifest.datasetHash).slice(0, 12)}… != actual ${actualHash.slice(0, 12)}…`);

  return {
    valid: errors.length === 0,
    errors,
    stats: {
      rowCount, securityCount: lids.size, dupKeys, nullLid,
      lastDecision: lastDt || null,
      lastMatureByHorizon: Object.fromEntries(horizons.map((h) => [h, lastMatureByH[h] || null])),
    },
  };
}

module.exports = {
  SNAPSHOT_MANIFEST_VERSION,
  canonicalJson, sha256, normalizedPanelHash, definitionHash,
  buildSnapshotManifest, verifySnapshotManifest,
};
