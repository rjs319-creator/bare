'use strict';
// PIT-DATA-V2 RECONCILIATION — dual-read report: the v2 shadow identity store vs the
// v1 production master (lib/security-master.js). Production consumers stay on v1;
// this report is what must clear the coverage gates BEFORE any consumer switches or
// any survivorshipSafe=true claim is made.

const S = require('./schema');
const R = require('./resolve');

const RECON_PATH = 'pitdata/reconciliation.json';

// Coverage gates, declared here so the pass bar is code-reviewed, not improvised.
// Deliberately conservative; every gate must pass to even PROPOSE a consumer switch.
const COVERAGE_GATES = Object.freeze({
  minListings: 5000,          // v2 must know a real breadth of listings
  minConfirmedDelisted: 1000, // with vendor-confirmed delistings (v1 has ~55)
  maxV1OnlyFrac: 0.02,        // ≤2% of v1's known symbols may be missing from v2
  minSymbolChangeFeed: true,  // rename feed collected (ticker-reuse defense)
});

function reconcile({ shards, v1Master, now = Date.now() }) {
  const v2 = R.allListings(shards);
  const v2Symbols = new Set();
  for (const l of v2) {
    v2Symbols.add(l.symbol);
    for (const a of l.aliases || []) v2Symbols.add(String(a.value || '').toUpperCase());
  }
  const v2Delisted = v2.filter((l) => (l.status || []).some((iv) => iv.value === 'delisted' && iv.confirmation));

  const v1Records = (v1Master && v1Master.records) || {};
  const v1Symbols = Object.keys(v1Records).map((s) => s.toUpperCase());
  const v1Only = v1Symbols.filter((s) => !v2Symbols.has(s));
  const v1Removed = (v1Master && v1Master.removed) || [];

  const counts = {
    v2Listings: v2.length,
    v2ConfirmedDelisted: v2Delisted.length,
    v2LowConfidenceIdentity: v2.filter((l) => l.identityConfidence === 'low').length,
    v1Symbols: v1Symbols.length,
    v1Removed: Array.isArray(v1Removed) ? v1Removed.length : 0,
    v1OnlySymbols: v1Only.length,
  };

  const gates = {
    minListings: counts.v2Listings >= COVERAGE_GATES.minListings,
    minConfirmedDelisted: counts.v2ConfirmedDelisted >= COVERAGE_GATES.minConfirmedDelisted,
    maxV1OnlyFrac: counts.v1Symbols === 0 ? false
      : counts.v1OnlySymbols / counts.v1Symbols <= COVERAGE_GATES.maxV1OnlyFrac,
    symbolChangeCollected: v2.some((l) => (l.aliases || []).some((a) => a.source === 'fmp-symbol-change')),
  };
  const passed = Object.values(gates).every(Boolean);

  return {
    version: S.PITDATA_VERSION,
    generatedAt: new Date(now).toISOString(),
    counts,
    v1OnlySample: v1Only.slice(0, 50),
    gates, gateThresholds: COVERAGE_GATES,
    passed,
    // The claim a passing report would UNLOCK, never auto-apply: switching a consumer
    // remains a human, versioned action.
    survivorshipSafe: false,
    note: passed
      ? 'Coverage gates PASS — a consumer switch may be PROPOSED (human action; nothing switches automatically).'
      : 'Coverage gates FAIL — production consumers stay on v1; v2 remains shadow.',
  };
}

module.exports = { RECON_PATH, COVERAGE_GATES, reconcile };
