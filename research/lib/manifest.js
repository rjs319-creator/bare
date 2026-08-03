'use strict';
// DATA-SNAPSHOT MANIFEST (snapshot-manifest-v2) — the authoritative, versioned
// description of a research panel.
//
// v2 corrections over v1 (each a verified defect):
//   * v1's `lastFullyMatureDecisionDate` meant "latest decision date with ANY
//     finite outcome" — outcome-dependent selection (3 early delistings made a
//     1,704-name pending cohort look mature). v2 replaces it with COHORT
//     fields computed on the market-session calendar:
//       lastFullyObservedCohortDateByHorizon — last decision date whose whole
//         cross-sectional window elapsed with zero pending rows and coverage
//         above the documented minimum;
//       cohortEligibilityByHorizon / ineligibleCohortCounts / cohortCoveragePolicy;
//       lastLabelReadyDecisionDateByHorizon — the honestly-renamed old value
//         (diagnostic only; NEVER an experiment boundary).
//   * v1 hashed only the panel payload. v2 requires content hashes for every
//     upstream source: security-master payload, universe payload, Merkle roots
//     over corporate-action and price partitions, the market calendar and the
//     cohort-eligibility artifact — never versions/timestamps/counts alone.
//   * v2 records build provenance: code commit, dirty-worktree flag, dirty
//     diff hash, build command, deterministic generation parameters, price
//     retrieval range, per-source schema versions. A build without a commit
//     (or dirty without a diff hash) can only ever be
//     'exploratory-non-reproducible' — never confirmatory.
//
// verifySnapshotManifest RECOMPUTES cohort maturity independently from the
// rows and the trading calendar and rejects a manifest that declares a partial
// cohort mature, admits pending rows into an eligible cohort, claims a later
// fully-observed date than the calendar permits, or omits coverage statistics.
//
// Pure module: no network, no clock, no fs. Callers inject everything.

const crypto = require('crypto');
const COHORT = require('./cohort');

const SNAPSHOT_MANIFEST_VERSION = 'snapshot-manifest-v2';

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

// Hash any JSON-serializable payload (full content, not counts).
const definitionHash = (obj) => sha256(canonicalJson(obj));

// Merkle root over a list of {name, hash} leaves (sorted by name so partition
// order never changes the root). Changing ANY partition's content changes the
// root; so does adding or removing a partition.
function merkleRoot(leaves) {
  const ls = [...(leaves || [])]
    .filter((l) => l && l.name && l.hash)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((l) => sha256(`${l.name}:${l.hash}`));
  if (!ls.length) return null;
  let level = ls;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256(level[i] + level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

const REQUIRED_SOURCE_HASHES = Object.freeze([
  'securityMasterPayloadHash',
  'universePayloadHash',
  'corpactionsMerkleRoot',
  'priceCacheMerkleRoot',
  'marketCalendarHash',
  'cohortEligibilityHash',
]);

const REPRODUCIBILITY = Object.freeze({
  CONFIRMATORY: 'confirmatory-reproducible',
  EXPLORATORY_DIFF: 'exploratory-diff-recorded',
  NON_REPRODUCIBLE: 'exploratory-non-reproducible',
});

// Derive the reproducibility class from build facts — callers cannot claim a
// stronger class than the facts support.
function reproducibilityClass({ codeCommit, worktreeDirty, dirtyDiffHash }) {
  if (!codeCommit) return REPRODUCIBILITY.NON_REPRODUCIBLE;
  if (worktreeDirty) return dirtyDiffHash ? REPRODUCIBILITY.EXPLORATORY_DIFF : REPRODUCIBILITY.NON_REPRODUCIBLE;
  return REPRODUCIBILITY.CONFIRMATORY;
}

// buildSnapshotManifest(input) → frozen manifest object. Every field the audit
// gate depends on is REQUIRED; optional context fields default to null (never
// silently invented).
function buildSnapshotManifest(input = {}) {
  const req = (k) => {
    if (input[k] === undefined || input[k] === null) throw new Error(`snapshot-manifest: required field '${k}' missing`);
    return input[k];
  };
  const sourceHashes = { ...req('sourceHashes') };
  for (const k of REQUIRED_SOURCE_HASHES) {
    if (typeof sourceHashes[k] !== 'string' || sourceHashes[k].length < 16) {
      throw new Error(`snapshot-manifest: sourceHashes.${k} must be a content hash (got ${JSON.stringify(sourceHashes[k])}) — versions, timestamps and counts are not provenance`);
    }
  }
  const build = { ...req('build') };
  const requiredBuild = ['buildCommand', 'generationParams', 'sourceSchemaVersions'];
  for (const k of requiredBuild) {
    if (build[k] === undefined || build[k] === null) throw new Error(`snapshot-manifest: build.${k} missing`);
  }
  if (typeof build.worktreeDirty !== 'boolean') throw new Error('snapshot-manifest: build.worktreeDirty must be boolean');
  build.codeCommit = build.codeCommit || null;
  build.dirtyDiffHash = build.dirtyDiffHash || null;
  build.priceCacheRetrievalRange = build.priceCacheRetrievalRange || null;
  // Reproducibility is DERIVED, never declared upward.
  const derived = reproducibilityClass(build);
  if (build.reproducibility && build.reproducibility !== derived) {
    throw new Error(`snapshot-manifest: declared reproducibility '${build.reproducibility}' contradicts build facts ('${derived}')`);
  }
  build.reproducibility = derived;

  return Object.freeze({
    schema: 'DataSnapshotManifest',
    schemaVersion: SNAPSHOT_MANIFEST_VERSION,
    snapshotId: req('snapshotId'),
    datasetHash: req('datasetHash'),
    generatedAt: req('generatedAt'),
    sourceHashes: Object.freeze(sourceHashes),
    build: Object.freeze(build),
    // [{ name, version, retrievedAt, earliestObservation, latestObservation }]
    sources: Object.freeze([...(req('sources'))]),
    featureAvailabilityCutoff: req('featureAvailabilityCutoff'),
    lastDecisionTimestamp: req('lastDecisionTimestamp'),
    labelObservationCutoff: req('labelObservationCutoff'),
    // Honest rename of v1's misleading field: the last decision date carrying
    // ANY label-ready row — a data-availability diagnostic, never a boundary.
    lastLabelReadyDecisionDateByHorizon: Object.freeze({ ...req('lastLabelReadyDecisionDateByHorizon') }),
    // Cohort-maturity contract (the experiment boundary).
    lastFullyObservedCohortDateByHorizon: Object.freeze({ ...req('lastFullyObservedCohortDateByHorizon') }),
    cohortEligibilityByHorizon: Object.freeze(JSON.parse(JSON.stringify(req('cohortEligibilityByHorizon')))),
    cohortCoveragePolicy: Object.freeze({ ...req('cohortCoveragePolicy') }),
    ineligibleCohortCounts: Object.freeze(JSON.parse(JSON.stringify(req('ineligibleCohortCounts')))),
    marketCalendarVersion: input.marketCalendarVersion || 'us-sessions-v1',
    priceAdjustmentBasis: req('priceAdjustmentBasis'),
    corporateActionSource: input.corporateActionSource || null,
    corporateActionStatus: req('corporateActionStatus'),
    sectorClassificationBasis: req('sectorClassificationBasis'),
    survivorship: Object.freeze(JSON.parse(JSON.stringify(req('survivorship')))),
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
// verifySnapshotManifest(manifest, panelByMonth, { horizons, calendar }) →
// { valid, errors, stats }. The CALENDAR IS REQUIRED: cohort maturity is
// recomputed independently from the rows and the trading calendar; a manifest
// cannot be validated by trusting its own cohort claims.
function verifySnapshotManifest(manifest, panelByMonth, { horizons = [21, 63, 126], calendar = null } = {}) {
  const errors = [];
  const push = (msg) => { if (errors.length < 60) errors.push(msg); };

  if (!manifest || manifest.schema !== 'DataSnapshotManifest') {
    return { valid: false, errors: ['not a DataSnapshotManifest'], stats: null };
  }
  if (manifest.schemaVersion !== SNAPSHOT_MANIFEST_VERSION) {
    push(`manifest schemaVersion '${manifest.schemaVersion}' is not ${SNAPSHOT_MANIFEST_VERSION} — rebuild the panel`);
  }
  if (!calendar) {
    return { valid: false, errors: [...errors, 'verification requires the market-session calendar — cohort maturity cannot be recomputed without it'], stats: null };
  }
  if (manifest.sourceHashes && manifest.sourceHashes.marketCalendarHash && calendar.calendarHash
    && manifest.sourceHashes.marketCalendarHash !== calendar.calendarHash) {
    push(`marketCalendarHash mismatch: manifest ${manifest.sourceHashes.marketCalendarHash.slice(0, 12)}… != supplied calendar ${calendar.calendarHash.slice(0, 12)}…`);
  }
  for (const k of REQUIRED_SOURCE_HASHES) {
    if (!manifest.sourceHashes || typeof manifest.sourceHashes[k] !== 'string') push(`sourceHashes.${k} missing — incomplete provenance`);
  }
  if (!manifest.cohortCoveragePolicy || !Number.isFinite(manifest.cohortCoveragePolicy.minOutcomeCoverage)) {
    push('cohortCoveragePolicy.minOutcomeCoverage missing — coverage statistics are required');
  }

  const months = Object.keys(panelByMonth || {}).sort();
  let rowCount = 0;
  const lids = new Set();
  const seenKeys = new Set();
  let dupKeys = 0, nullLid = 0, decisionsAfterLast = 0, matureAfterCutoff = 0, matureMissingEnd = 0;
  let lastDt = '';
  const lastLabelReadyByH = {};
  for (const h of horizons) lastLabelReadyByH[h] = '';

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
        else if (r.dt > lastLabelReadyByH[h]) lastLabelReadyByH[h] = r.dt;
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

  // ── INDEPENDENT cohort recomputation from rows + calendar ──────────────────
  const minCov = (manifest.cohortCoveragePolicy && Number.isFinite(manifest.cohortCoveragePolicy.minOutcomeCoverage))
    ? manifest.cohortCoveragePolicy.minOutcomeCoverage : COHORT.DEFAULT_MIN_OUTCOME_COVERAGE;
  const ledger = COHORT.computeCohortLedger({
    panelByMonth, calendar, horizons,
    labelObservationCutoff: manifest.labelObservationCutoff,
    minOutcomeCoverage: minCov,
  });
  const recomputedByH = {};
  for (const h of horizons) {
    const hk = String(h);
    const v = ledger.byHorizon[hk];
    recomputedByH[hk] = v.lastFullyObservedCohortDate;
    const declared = manifest.lastFullyObservedCohortDateByHorizon && manifest.lastFullyObservedCohortDateByHorizon[hk];
    if (declared === undefined) { push(`lastFullyObservedCohortDateByHorizon missing horizon ${hk}`); continue; }
    if (declared && (!v.lastFullyObservedCohortDate || declared > v.lastFullyObservedCohortDate)) {
      push(`lastFullyObservedCohortDateByHorizon[${hk}]=${declared} later than the calendar permits (recomputed ${v.lastFullyObservedCohortDate || 'none'}) — a partial cohort is being declared fully observed`);
    }
    if (declared && v.lastFullyObservedCohortDate && declared < v.lastFullyObservedCohortDate) {
      push(`lastFullyObservedCohortDateByHorizon[${hk}]=${declared} earlier than recomputed ${v.lastFullyObservedCohortDate} — stale manifest`);
    }
    const summ = manifest.cohortEligibilityByHorizon && manifest.cohortEligibilityByHorizon[hk];
    if (!summ) { push(`cohortEligibilityByHorizon missing horizon ${hk}`); continue; }
    if (summ.eligibleCohorts !== v.eligibleCohorts) {
      push(`cohortEligibilityByHorizon[${hk}].eligibleCohorts=${summ.eligibleCohorts} != recomputed ${v.eligibleCohorts}`);
    }
    // Any pending row inside a cohort the manifest treats as eligible.
    for (const c of v.cohorts) {
      if (c.pendingRows > 0 && summ.eligibleCohorts > 0 && manifest.lastFullyObservedCohortDateByHorizon[hk]
        && c.decisionDate <= manifest.lastFullyObservedCohortDateByHorizon[hk] && c.eligible) {
        push(`cohort ${c.decisionDate}@${hk} has ${c.pendingRows} pending rows yet sits inside the declared fully-observed range`);
      }
    }
  }
  if (manifest.sourceHashes && manifest.sourceHashes.cohortEligibilityHash
    && manifest.sourceHashes.cohortEligibilityHash !== ledger.ledgerHash) {
    push(`cohortEligibilityHash mismatch: manifest ${manifest.sourceHashes.cohortEligibilityHash.slice(0, 12)}… != recomputed ${ledger.ledgerHash.slice(0, 12)}…`);
  }

  const actualHash = normalizedPanelHash(panelByMonth);
  if (manifest.datasetHash !== actualHash) push(`datasetHash mismatch: manifest ${String(manifest.datasetHash).slice(0, 12)}… != actual ${actualHash.slice(0, 12)}…`);

  return {
    valid: errors.length === 0,
    errors,
    stats: {
      rowCount, securityCount: lids.size, dupKeys, nullLid,
      lastDecision: lastDt || null,
      lastLabelReadyByHorizon: Object.fromEntries(horizons.map((h) => [h, lastLabelReadyByH[h] || null])),
      lastFullyObservedCohortByHorizon: recomputedByH,
    },
    recomputedLedger: ledger,
  };
}

module.exports = {
  SNAPSHOT_MANIFEST_VERSION, REQUIRED_SOURCE_HASHES, REPRODUCIBILITY,
  canonicalJson, sha256, normalizedPanelHash, definitionHash, merkleRoot,
  reproducibilityClass, buildSnapshotManifest, verifySnapshotManifest,
};
