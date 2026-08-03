'use strict';
// MEASURED SURVIVORSHIP CONTRACT (survivorship-contract-v1)
//
// THE DEFECT THIS CLOSES: benchmarks declared `survivorshipSafe: true` while
// the panel's universe starts from a present-day symbols payload (~4.2k names)
// rather than a proven complete monthly HISTORICAL listing universe. Dead
// names are included when known, but nobody has measured how many listings
// each month is missing — so a binary "safe" claim was unsupported.
//
// The binary claim becomes a MEASURED contract:
//   status ∈ proven-safe | survivorship-reduced | unknown
// `proven-safe` requires an authoritative historical listing source AND a
// measured monthly coverage gate. Anything else is at best
// `survivorship-reduced` — which BLOCKS promotion eligibility.
//
// Pure module: no network, no clock, no fs.

const SURVIVORSHIP_CONTRACT_VERSION = 'survivorship-contract-v1';

const STATUSES = Object.freeze(['proven-safe', 'survivorship-reduced', 'unknown']);
const PROVEN_SAFE_MIN_MONTHLY_COVERAGE = 0.98;
const PROVEN_SAFE_MIN_DELISTED_COVERAGE = 0.95;

// Sources accepted as authoritative for historical listing membership. A
// present-day symbols payload is NEVER one of them.
const AUTHORITATIVE_LISTING_SOURCES = Object.freeze([
  'crsp-monthly-listings', 'exchange-monthly-listings', 'nasdaq-daily-list-archive',
]);

const frac = (num, den) => (Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : null);

// makeSurvivorshipContract(input) → frozen measured contract. The status is
// DERIVED from the measurements — callers cannot claim proven-safe directly.
function makeSurvivorshipContract({
  historicalListingSource = null,          // e.g. 'symbols.json (present-day payload)'
  historicalListingSourceAuthoritative = null,   // true only for AUTHORITATIVE_LISTING_SOURCES-class feeds
  monthlyExpectedListingCount = null,      // { 'YYYY-MM': n } or null when unknown
  monthlyCoveredListingCount = null,       // { 'YYYY-MM': n } or null
  delistedSecuritiesExpected = null,
  delistedSecuritiesCovered = null,
  unknownStatusCount = null,
  totalSecurities = null,
  instrumentTypeCoverage = null,           // { commonStock: n, excluded: {...} }
  missingSymbolReasons = null,             // { reason: count }
  notes = null,
} = {}) {
  // Monthly coverage: measurable only when BOTH expected and covered exist.
  let monthlyCoverage = null, worstMonthCoverage = null;
  if (monthlyExpectedListingCount && monthlyCoveredListingCount) {
    const months = Object.keys(monthlyExpectedListingCount).sort();
    const fracs = months
      .map((ym) => frac(monthlyCoveredListingCount[ym], monthlyExpectedListingCount[ym]))
      .filter((f) => f != null);
    if (fracs.length) {
      monthlyCoverage = +(fracs.reduce((a, b) => a + b, 0) / fracs.length).toFixed(4);
      worstMonthCoverage = +Math.min(...fracs).toFixed(4);
    }
  }
  const delistedCoverage = frac(delistedSecuritiesCovered, delistedSecuritiesExpected);
  const unknownStatusFraction = frac(unknownStatusCount, totalSecurities);

  let status, statusReason;
  if (historicalListingSourceAuthoritative === true
    && monthlyCoverage != null && worstMonthCoverage != null
    && worstMonthCoverage >= PROVEN_SAFE_MIN_MONTHLY_COVERAGE
    && delistedCoverage != null && delistedCoverage >= PROVEN_SAFE_MIN_DELISTED_COVERAGE) {
    status = 'proven-safe';
    statusReason = `authoritative historical listing source with worst-month coverage ${worstMonthCoverage} ≥ ${PROVEN_SAFE_MIN_MONTHLY_COVERAGE} and delisted coverage ${+delistedCoverage.toFixed(4)} ≥ ${PROVEN_SAFE_MIN_DELISTED_COVERAGE}`;
  } else if (historicalListingSource && (delistedSecuritiesCovered > 0 || monthlyCoverage != null)) {
    status = 'survivorship-reduced';
    statusReason = historicalListingSourceAuthoritative === true
      ? 'authoritative source but coverage gate not met'
      : 'historical listing membership not proven complete (non-authoritative or unmeasured monthly universe); dead names partially included';
  } else {
    status = 'unknown';
    statusReason = 'no historical listing source or coverage measurements supplied';
  }

  return Object.freeze({
    schema: 'SurvivorshipContract',
    version: SURVIVORSHIP_CONTRACT_VERSION,
    status,
    statusReason,
    historicalListingSource,
    historicalListingSourceAuthoritative: historicalListingSourceAuthoritative === true,
    monthlyCoverage,
    worstMonthCoverage,
    delistedSecuritiesExpected: delistedSecuritiesExpected ?? null,
    delistedSecuritiesCovered: delistedSecuritiesCovered ?? null,
    delistedCoverage: delistedCoverage == null ? null : +delistedCoverage.toFixed(4),
    unknownStatusFraction: unknownStatusFraction == null ? null : +unknownStatusFraction.toFixed(4),
    instrumentTypeCoverage: instrumentTypeCoverage ? Object.freeze({ ...instrumentTypeCoverage }) : null,
    missingSymbolReasons: missingSymbolReasons ? Object.freeze({ ...missingSymbolReasons }) : null,
    notes,
    // Promotion consumers read this, never a hand-set boolean.
    promotionEligible: status === 'proven-safe',
  });
}

// Validate an incoming contract object (e.g. read from a manifest). A bare
// `survivorshipSafe: true` boolean — or a contract whose status doesn't match
// its own measurements — is rejected.
function verifySurvivorshipContract(c) {
  if (!c || typeof c !== 'object') return { valid: false, reason: 'no survivorship contract' };
  if (c.schema !== 'SurvivorshipContract') return { valid: false, reason: 'not a SurvivorshipContract (a bare survivorshipSafe boolean is not measured evidence)' };
  if (!STATUSES.includes(c.status)) return { valid: false, reason: `invalid status '${c.status}'` };
  if (c.status === 'proven-safe') {
    const ok = c.historicalListingSourceAuthoritative === true
      && Number.isFinite(c.worstMonthCoverage) && c.worstMonthCoverage >= PROVEN_SAFE_MIN_MONTHLY_COVERAGE
      && Number.isFinite(c.delistedCoverage) && c.delistedCoverage >= PROVEN_SAFE_MIN_DELISTED_COVERAGE;
    if (!ok) return { valid: false, reason: 'proven-safe claimed without an authoritative source and measured coverage above the gates' };
  }
  return { valid: true, reason: `status ${c.status} consistent with measurements` };
}

module.exports = {
  SURVIVORSHIP_CONTRACT_VERSION, STATUSES,
  PROVEN_SAFE_MIN_MONTHLY_COVERAGE, PROVEN_SAFE_MIN_DELISTED_COVERAGE,
  AUTHORITATIVE_LISTING_SOURCES,
  makeSurvivorshipContract, verifySurvivorshipContract,
};
