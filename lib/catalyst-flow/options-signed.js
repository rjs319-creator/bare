'use strict';
// CATALYST–FLOW — PROVIDER-NEUTRAL SIGNED OPENING-FLOW INTERFACE (family C).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE. A signed customer OPENING flow feature needs a
// source that identifies three things per trade: WHO (customer / professional customer /
// firm / market maker), WHICH SIDE (buy or sell), and WHETHER IT OPENED OR CLOSED a
// position. The free Yahoo option chain this app already uses gives none of them — it is
// an end-of-day snapshot of volume and open interest. Calls are not "bullish" and puts are
// not "bearish": a call print can be a customer buying to open, a customer selling to
// close, or a market maker hedging. Relabelling chain volume as signed opening flow would
// not be an approximation, it would be a different measurement wearing its name.
//
// So: a provider that cannot declare `identifiesParticipant && identifiesSide &&
// identifiesOpenClose` is REFUSED. It cannot populate a single family-C value, at any
// coverage level, under any flag.
//
// WHEN THERE IS NO SIGNED FEED (the state of this repo today):
//   • optionsSignedCoverage = false
//   • every family-C value is null — NOT zero
//   • the no-options arm (E2) still runs
//   • the with-options arm (E3) reports INSUFFICIENT_DATA
//   • NO_INCREMENTAL_ALPHA is never printed for an empty arm — an unmeasured thing has
//     not been measured to be worthless.
//
// Exchange coverage rides along because Cboe's C1 history is longer than BZX/EDGX/C2.
// A study that quietly mixes a C1-only early period with a four-exchange later period is
// comparing two different instruments; `exchanges` and `exchangeCoverageComplete` keep
// that visible rather than averaged away.
//
// Pure module: no network. A real provider is injected as an adapter.

const { NAMES_BY_FAMILY, FAMILY } = require('./registry');

const SIGNED_INTERFACE_VERSION = 'catalyst-signed-options-v1';
const FAMILY_C_NAMES = NAMES_BY_FAMILY[FAMILY.C];

const REQUIRED_CAPABILITIES = Object.freeze([
  'identifiesParticipant',   // customer vs professional customer vs firm vs market maker
  'identifiesSide',          // buy vs sell
  'identifiesOpenClose',     // opening vs closing transaction
]);

// The all-missing family-C vector. Every value is null; nothing is zero-filled.
const missingVector = () => Object.fromEntries(FAMILY_C_NAMES.map((n) => [n, null]));

// Why an adapter is unusable, stated in terms a reader can act on.
function describeAdapter(adapter) {
  if (!adapter) return { usable: false, reason: 'no signed-options provider configured' };
  const missing = REQUIRED_CAPABILITIES.filter((c) => adapter[c] !== true);
  if (missing.length) {
    return {
      usable: false,
      reason: `provider "${adapter.name || 'unnamed'}" cannot ${missing.join(' / ')} — it is a chain snapshot, not signed opening flow`,
      missingCapabilities: missing,
    };
  }
  if (typeof adapter.fetchSignedOpenClose !== 'function') {
    return { usable: false, reason: `provider "${adapter.name}" declares the capabilities but exposes no fetchSignedOpenClose()` };
  }
  return { usable: true, reason: null, missingCapabilities: [] };
}

// The coverage report the whole experiment keys off. `arm E3` reads ONLY this.
function coverageReport(adapter) {
  const d = describeAdapter(adapter);
  return Object.freeze({
    version: SIGNED_INTERFACE_VERSION,
    optionsSignedCoverage: d.usable,
    provider: adapter && adapter.name ? adapter.name : null,
    reason: d.reason,
    missingCapabilities: d.missingCapabilities || REQUIRED_CAPABILITIES.slice(),
    // Never claim full-market coverage for a partial-exchange history.
    exchanges: (adapter && Array.isArray(adapter.exchanges)) ? [...adapter.exchanges] : [],
    exchangeCoverageComplete: !!(adapter && adapter.exchangeCoverageComplete === true),
    armE3Status: d.usable ? 'MEASURABLE' : 'INSUFFICIENT_DATA',
  });
}

// Fetch signed opening flow for one (symbol, session). Returns the all-missing vector with
// `coverage:false` whenever the provider is absent or unqualified — the caller cannot
// accidentally receive a plausible-looking zero.
async function fetchSignedFlow(adapter, { symbol, session, availableAtTs = null } = {}) {
  const cov = coverageReport(adapter);
  if (!cov.optionsSignedCoverage) {
    return { symbol, session, coverage: false, reason: cov.reason, availableAtTs: null, values: missingVector() };
  }
  let raw = null;
  try {
    raw = await adapter.fetchSignedOpenClose({ symbol, session });
  } catch (e) {
    return { symbol, session, coverage: false, reason: `provider error: ${String(e && e.message || e).slice(0, 120)}`, availableAtTs: null, values: missingVector() };
  }
  if (!raw || typeof raw !== 'object') {
    return { symbol, session, coverage: false, reason: 'provider returned no row for this symbol/session', availableAtTs: null, values: missingVector() };
  }
  // Only DECLARED family-C names survive; an adapter cannot smuggle in an undeclared column.
  const values = missingVector();
  for (const n of FAMILY_C_NAMES) {
    if (raw[n] !== undefined && raw[n] !== null && Number.isFinite(Number(raw[n]))) values[n] = Number(raw[n]);
    else if (raw[n] !== undefined && raw[n] !== null) values[n] = raw[n];
  }
  return {
    symbol, session, coverage: true, reason: null,
    availableAtTs: raw.availableAtTs || availableAtTs || null,
    exchanges: cov.exchanges,
    exchangeCoverageComplete: cov.exchangeCoverageComplete,
    values,
  };
}

// The EXPLORATORY arm's escape hatch. Free-chain features may be studied — separately and
// under their own name — but they can never be presented as, compared as, or substituted
// for signed opening flow. The label is baked into the return value so a downstream
// reader cannot lose it.
function exploratoryChainArm(values) {
  return Object.freeze({
    arm: 'X_FREE_CHAIN_EXPLORATORY',
    isSignedOpeningFlow: false,
    substitutableForFamilyC: false,
    comparableToE3: false,
    caveat: 'Free option-chain volume/OI cannot determine participant, side, or open/close. Not a proxy for signed customer opening flow.',
    values: { ...(values || {}) },
  });
}

// Never let an empty arm be reported as a finding about alpha.
function armVerdict({ coverage, pairedCohorts, result }) {
  if (!coverage) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'no signed opening-flow feed — the arm was never measured', result: null };
  }
  if (!(pairedCohorts > 0)) {
    return { verdict: 'INSUFFICIENT_DATA', reason: 'signed feed present but no paired decision-date cohorts were produced', result: null };
  }
  return { verdict: 'MEASURED', reason: null, result };
}

module.exports = {
  SIGNED_INTERFACE_VERSION, REQUIRED_CAPABILITIES, FAMILY_C_NAMES,
  missingVector, describeAdapter, coverageReport, fetchSignedFlow,
  exploratoryChainArm, armVerdict,
};
