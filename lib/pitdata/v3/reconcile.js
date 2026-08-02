'use strict';
// PIT-DATA-V3 RECONCILIATION — the full gate battery an engineering-complete
// report must clear, PLUS the structural separation the v2 report lacked
// (DEFECT 9): passing every gate makes a report ENGINEERING-COMPLETE ONLY. It
// never sets survivorshipSafe=true and never switches a consumer. That requires
// a SEPARATE, explicit, human-reviewed PROMOTION artifact created through
// makePromotionProposal → a privileged route with an explicit approver — and
// even then applying it is a code change, not a flag flip.
//
// Gates are configurable but DECLARED here so the pass bar is code-reviewed,
// not improvised at runtime.
//
// Pure module: no network, no clock, no store. Callers supply the inputs.

const S = require('./schema');
const R = require('./resolve');

const GATES_V3 = Object.freeze({
  // run / raw integrity
  latestRunMaxAgeDays: 3,           // latest run complete and fresh
  requireAllPagesCollected: true,
  rawIntegritySampleMin: 5,         // independently re-hashed content objects
  rawIntegrityFailuresMax: 0,
  // longitudinal accumulation
  minDistinctProspectiveDates: 5,
  // breadth
  minListings: 5000,
  minConfirmedDelisted: 1000,
  minRenamedListings: 50,
  minIpoDatedFrac: 0.5,             // listings with a listing-start date
  // identity — measured over the UNIVERSE-RELEVANT subset (see
  // isUniverseRelevant): the full symbol space is dominated by OTC/foreign
  // paper that can never enrich past 'low' and is irrelevant to the US
  // common-stock policy. A listing leaves the denominator ONLY on POSITIVE
  // evidence it is out of scope; unknowns stay in (fail closed), and a
  // near-empty relevant subset fails the gate rather than passing vacuously.
  maxLowConfidenceFrac: 0.30,
  minRelevantListings: 1000,
  maxUnresolvedIdentityConflicts: 0,
  requireTickerReuseTestCoverage: true,   // supplied by the test-suite marker input
  // classification coverage
  minInstrumentTypeFrac: 0.60,
  minCommonStockClassifiedFrac: 0.40,
  minExchangeKnownFrac: 0.80,
  minCountryCurrencyFrac: 0.40,
  minSectorFrac: 0.40,
  minCorporateActionFrac: 0.10,     // listings with actionsCollected
  minCapAdvCoverageFrac: 0.40,      // PIT cap+ADV joinable
  // longitudinal universe sanity
  minHistoricalUniverseDates: 3,    // representative reconstructed universe counts across dates
  maxV1OnlyFrac: 0.02,              // ≤2% of v1 symbols missing from v3
  maxExternalControlDivergence: 0.25, // vs external control totals when supplied
  // data quality
  maxDuplicateSecurityDateFrac: 0.001,
  maxImpossibleTimestamps: 0,
  maxUnresolvedLabelFrac: 0.60,     // unresolved/pending label rate by horizon (when supplied)
});

const frac = (a, b) => (b > 0 ? a / b : 0);

// US-common-stock policy scope for identity gating. A listing is RELEVANT
// unless the store holds POSITIVE evidence excluding it:
//   * not currently active (delisted/unknown-status listings are graded by
//     other gates, not the identity-confidence one),
//   * instrument type positively non-common (etf/fund/adr/warrant/…),
//   * exchange known and outside the policy set (OTC/foreign venues),
//   * country known and non-US.
// Unknown facts NEVER exclude — an unenriched listing keeps counting against
// the low-confidence fraction until the sweep either lifts it or proves it
// out of scope. This is what makes the gate reachable without being gameable.
const RELEVANT_EXCHANGES = Object.freeze(['NASDAQ', 'NYSE', 'AMEX']);
function isUniverseRelevant(l) {
  const active = (l.status || []).some((iv) => iv.value === 'active' && !iv.effectiveTo);
  if (!active) return false;
  const types = (l.instrumentType || []).map((iv) => iv.value).filter(Boolean);
  if (types.length && types.every((t) => t !== 'common_stock' && t !== 'stock-unverified')) return false;
  const ex = l.identity && l.identity.exchange;
  if (ex && !RELEVANT_EXCHANGES.includes(String(ex).toUpperCase())) return false;
  const last = (l.classification || [])[(l.classification || []).length - 1];
  if (last && last.value && last.value.country && String(last.value.country).toUpperCase() !== 'US') return false;
  return true;
}

// inputs:
//   listingShards, aliasShards       — the v3 store
//   latestRun                        — newest run manifest (or null)
//   state                            — collector state doc (or null)
//   rawSample                        — [{ contentHash, payload }] to re-hash independently
//   v1Master                         — lib/security-master doc for cross-version diff
//   universeSamples                  — [{ date, counts }] reconstructed historical universes
//   externalControls                 — { activeUsListings: N } | null
//   labelStats                       — { unresolvedFrac } | null
//   tickerReuseTestsPass             — boolean marker from the test suite
//   now                              — ms
function reconcileV3(inputs = {}) {
  const {
    listingShards = {}, aliasShards = {}, latestRun = null, state = null,
    rawSample = [], v1Master = null, universeSamples = [], externalControls = null,
    labelStats = null, tickerReuseTestsPass = false, now = 0, gates = GATES_V3,
  } = inputs;

  const listings = R.allListingsV3(listingShards);
  const n = listings.length;
  const confirmedDelisted = listings.filter((l) => (l.status || []).some((iv) => iv.value === 'delisted' && iv.confirmation));
  const renamed = listings.filter((l) => new Set((l.aliases || []).map((a) => a.value)).size > 1);
  const lowConf = listings.filter((l) => l.identityConfidence === 'low');
  const relevant = listings.filter(isUniverseRelevant);
  const relevantLowConf = relevant.filter((l) => l.identityConfidence === 'low');
  const conflicts = listings.filter((l) => (l.identityCandidates || []).length > 1);
  const withIpo = listings.filter((l) => l.identity && l.identity.ipoDate);
  const withType = listings.filter((l) => (l.instrumentType || []).length > 0);
  const commonClassified = listings.filter((l) => (l.instrumentType || []).some((iv) => iv.value === 'common_stock'));
  const withExchange = listings.filter((l) => l.identity && l.identity.exchange);
  const withCls = listings.filter((l) => (l.classification || []).length > 0);
  const withCountryCcy = listings.filter((l) => (l.classification || []).some((iv) => iv.value && iv.value.country && iv.value.currency));
  const withActions = listings.filter((l) => l.actionsCollected);
  const withCapAdv = listings.filter((l) => l.marketDataCoverage === true);

  // Raw integrity: re-derive each sampled hash from its stored payload.
  const rawChecked = rawSample.length;
  const rawFailures = rawSample.filter((s) => !s || S.contentHashOf(s.payload) !== s.contentHash).length;

  // v1 cross-version diff.
  const v3Symbols = new Set();
  for (const l of listings) { v3Symbols.add(l.symbol); for (const a of l.aliases || []) v3Symbols.add(String(a.value || '').toUpperCase()); }
  const v1Symbols = Object.keys((v1Master && v1Master.records) || {}).map((s) => s.toUpperCase());
  const v1Only = v1Symbols.filter((s) => !v3Symbols.has(s));

  // Duplicate security-date sanity over status intervals.
  let dupPairs = 0, statusIvs = 0, impossibleTimestamps = 0;
  const seenPair = new Set();
  const nowIso = now ? new Date(now).toISOString() : null;
  for (const l of listings) {
    for (const iv of l.status || []) {
      statusIvs++;
      const key = `${l.listingId}|${iv.value}|${iv.effectiveFrom || ''}`;
      if (seenPair.has(key)) dupPairs++; else seenPair.add(key);
      if (iv.effectiveFrom && iv.effectiveTo && S.isoFloor(iv.effectiveTo) < S.isoFloor(iv.effectiveFrom)) impossibleTimestamps++;
      if (nowIso && iv.knownAt && iv.knownAt > nowIso) impossibleTimestamps++;   // future knowledge is impossible
    }
  }

  const runAgeDays = latestRun && latestRun.endedAt && now
    ? (now - new Date(latestRun.endedAt).getTime()) / 86400000 : null;
  const prospectiveDates = (state && state.prospectiveDates) || [];

  const counts = {
    listings: n,
    confirmedDelisted: confirmedDelisted.length,
    renamed: renamed.length,
    lowConfidence: lowConf.length,
    universeRelevant: relevant.length,
    relevantLowConfidence: relevantLowConf.length,
    identityConflicts: conflicts.length,
    withIpoDate: withIpo.length,
    withInstrumentType: withType.length,
    commonStockClassified: commonClassified.length,
    withExchange: withExchange.length,
    withClassification: withCls.length,
    withCountryCurrency: withCountryCcy.length,
    withCorporateActions: withActions.length,
    withCapAdvCoverage: withCapAdv.length,
    prospectiveDates: prospectiveDates.length,
    universeSampleDates: universeSamples.length,
    v1Symbols: v1Symbols.length, v1Only: v1Only.length,
    rawChecked, rawFailures,
    statusIntervals: statusIvs, duplicatePairs: dupPairs, impossibleTimestamps,
  };

  const externalDivergence = externalControls && externalControls.activeUsListings > 0
    ? Math.abs(counts.listings - externalControls.activeUsListings) / externalControls.activeUsListings
    : null;

  const gateResults = {
    latestRunCompleteAndFresh: !!(latestRun && latestRun.complete && runAgeDays != null && runAgeDays <= gates.latestRunMaxAgeDays),
    allPagesCollected: !!(latestRun && latestRun.complete
      && latestRun.requestedPages.length > 0
      && latestRun.requestedPages.every((p) => latestRun.completedPages.includes(p))),
    rawHashesReproducible: rawChecked >= gates.rawIntegritySampleMin && rawFailures <= gates.rawIntegrityFailuresMax,
    manifestInternallyConsistent: !!(latestRun && latestRun.completedPages.every((p) => latestRun.contentHashes[p])),
    minProspectiveDates: prospectiveDates.length >= gates.minDistinctProspectiveDates,
    minListings: n >= gates.minListings,
    minConfirmedDelisted: confirmedDelisted.length >= gates.minConfirmedDelisted,
    minRenamed: renamed.length >= gates.minRenamedListings,
    ipoDateCoverage: frac(withIpo.length, n) >= gates.minIpoDatedFrac,
    // Identity confidence is gated on the UNIVERSE-RELEVANT subset; a subset
    // below minRelevantListings fails closed (never a vacuous pass).
    lowConfidenceIdentity: relevant.length >= gates.minRelevantListings
      && frac(relevantLowConf.length, relevant.length) <= gates.maxLowConfidenceFrac,
    identityConflictsResolved: conflicts.length <= gates.maxUnresolvedIdentityConflicts,
    tickerReuseTestCoverage: !gates.requireTickerReuseTestCoverage || !!tickerReuseTestsPass,
    instrumentTypeCoverage: frac(withType.length, n) >= gates.minInstrumentTypeFrac,
    commonStockClassification: frac(commonClassified.length, n) >= gates.minCommonStockClassifiedFrac,
    exchangeCoverage: frac(withExchange.length, n) >= gates.minExchangeKnownFrac,
    countryCurrencyCoverage: frac(withCountryCcy.length, n) >= gates.minCountryCurrencyFrac,
    sectorCoverage: frac(withCls.length, n) >= gates.minSectorFrac,
    corporateActionCoverage: frac(withActions.length, n) >= gates.minCorporateActionFrac,
    capAdvCoverage: frac(withCapAdv.length, n) >= gates.minCapAdvCoverageFrac,
    historicalUniverseSamples: universeSamples.length >= gates.minHistoricalUniverseDates,
    v1Diff: v1Symbols.length > 0 && frac(v1Only.length, v1Symbols.length) <= gates.maxV1OnlyFrac,
    externalControlTotals: externalDivergence == null ? false : externalDivergence <= gates.maxExternalControlDivergence,
    labelStateRates: labelStats == null ? false : (labelStats.unresolvedFrac != null && labelStats.unresolvedFrac <= gates.maxUnresolvedLabelFrac),
    noDuplicateSecurityDates: statusIvs > 0 && frac(dupPairs, statusIvs) <= gates.maxDuplicateSecurityDateFrac,
    noImpossibleTimestamps: impossibleTimestamps <= gates.maxImpossibleTimestamps,
  };

  const failed = Object.entries(gateResults).filter(([, v]) => !v).map(([k]) => k);
  const engineeringComplete = failed.length === 0;

  return {
    schema: 'PitReconciliationV3', version: S.PITDATA_V3_VERSION,
    generatedAt: now ? new Date(now).toISOString() : null,
    counts,
    fractions: {
      lowConfidence: +frac(lowConf.length, n).toFixed(4),                    // full symbol space (transparency)
      relevantLowConfidence: +frac(relevantLowConf.length, Math.max(1, relevant.length)).toFixed(4),   // what the gate uses
      instrumentType: +frac(withType.length, n).toFixed(4),
      exchangeKnown: +frac(withExchange.length, n).toFixed(4),
      ipoDated: +frac(withIpo.length, n).toFixed(4),
      v1Only: +frac(v1Only.length, Math.max(1, v1Symbols.length)).toFixed(4),
      externalDivergence: externalDivergence == null ? null : +externalDivergence.toFixed(4),
    },
    v1OnlySample: v1Only.slice(0, 50),
    gates: gateResults, gateThresholds: gates, failedGates: failed,
    engineeringComplete,
    // STRUCTURAL: this report can NEVER assert safety or switch a consumer.
    survivorshipSafe: false,
    consumerSwitchAllowed: false,
    note: engineeringComplete
      ? 'All gates PASS — engineering-complete. A consumer switch STILL requires a separate human promotion artifact (makePromotionProposal) and a reviewed code change.'
      : `Gates FAIL (${failed.length}) — v3 remains shadow; consumers stay on their current source.`,
  };
}

// The separate, explicit promotion artifact. Refuses to exist without an
// engineering-complete report, a named human approver and the report's hash
// (so the approval is bound to the exact evidence reviewed).
function makePromotionProposal({ reconReport, approvedBy, note = null, now = 0 }) {
  if (!reconReport || reconReport.engineeringComplete !== true) {
    return { ok: false, error: 'promotion requires an engineering-complete reconciliation report' };
  }
  if (!approvedBy || typeof approvedBy !== 'string' || approvedBy.trim().length < 3) {
    return { ok: false, error: 'promotion requires an explicit named human approver' };
  }
  const reportHash = S.contentHashOf(reconReport);
  return {
    ok: true,
    proposal: Object.freeze({
      schema: 'PitPromotionProposalV3', version: S.PITDATA_V3_VERSION,
      createdAt: now ? new Date(now).toISOString() : null,
      approvedBy: approvedBy.trim(), note,
      reconciliationHash: reportHash,
      failedGates: reconReport.failedGates,
      // A PROPOSAL, not a switch: applying it is a reviewed code change.
      applied: false,
      appliesAutomatically: false,
    }),
  };
}

module.exports = { GATES_V3, RELEVANT_EXCHANGES, isUniverseRelevant, reconcileV3, makePromotionProposal };
