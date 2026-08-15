'use strict';
// CATALYST–FLOW RANKER — frozen configuration and feature flags.
//
// A leakage-safe, event-conditioned swing ranker over fresh earnings / material-guidance
// events. Every number here is part of the PREREGISTERED design (docs/catalyst-flow-ranker.md)
// and must not be tuned against a result — the trial registry records any change.
//
// SAFE DEFAULTS. Everything is off. The app must build and serve normally with none of
// these variables set and with no paid feed present; the serving layer then reports
// `state: 'DISABLED'` rather than inventing a ranking.

const CATALYST_FLOW_VERSION = 'catalyst-flow-v1';
const SCHEMA_VERSION = 'catalyst-event-v1';
const ARTIFACT_VERSION = 'catalyst-flow-artifact-v1';

// ── Feature flags (env; safe defaults) ──────────────────────────────────────
const truthy = (v) => v === '1' || String(v).toLowerCase() === 'true';

// `shadow` is the only mode this build can legitimately run in. `live` is accepted by the
// parser so the promotion path is explicit, but the serving layer refuses to leave shadow
// until the promotion gates in docs/catalyst-flow-ranker.md are recorded as PASSED.
const MODES = Object.freeze(['shadow', 'live']);

function flags(env = process.env) {
  const rawMode = String(env.CATALYST_FLOW_MODE || 'shadow').toLowerCase();
  return Object.freeze({
    enabled: truthy(env.CATALYST_FLOW_ENABLED),
    mode: MODES.includes(rawMode) ? rawMode : 'shadow',
    modelPath: env.CATALYST_FLOW_MODEL_PATH || null,
    predictionsPath: env.CATALYST_FLOW_PREDICTIONS_PATH || null,
    // Optional provider variables. Absent ⇒ the corresponding feature family is MISSING,
    // never zero-filled. `estimatesProvider` would supply genuine pre-release consensus
    // vintages; `signedOptionsProvider` a participant/side/open-close identified feed.
    estimatesProvider: env.CATALYST_FLOW_ESTIMATES_PROVIDER || null,
    signedOptionsProvider: env.CATALYST_FLOW_SIGNED_OPTIONS_PROVIDER || null,
  });
}

// ── Eligibility (v1, preregistered) ─────────────────────────────────────────
const ELIGIBILITY = Object.freeze({
  minPriorClose: 5,                 // UNADJUSTED prior close, USD
  minMedianDollarVolume: 5e6,       // trailing 20-session MEDIAN dollar volume
  dollarVolumeLookback: 20,
  maxUniverse: 2000,                // most liquid N, rebuilt independently on every date
  // Instrument classes admitted. Everything else (ETF, fund, unit, warrant, preferred,
  // right, ADR-only shells) is excluded by the security-type screen.
  allowedQuoteTypes: Object.freeze(['EQUITY']),
  excludedSuffixPatterns: Object.freeze([
    /\.(W|WS|WT|U|UN|R|RT|P|PR)[A-Z]?$/i,   // warrants, units, rights, preferreds
    /-(W|WS|WT|U|UN|R|RT|P|PR)[A-Z]?$/i,
  ]),
});

// ── Event clock ─────────────────────────────────────────────────────────────
// The vendor earnings feed carries a DATE but no before-open/after-close marker
// (measured: 0 of 12,749 sampled rows had a time field). We therefore take the
// CONSERVATIVE reading for every event: the confirmation session is the first
// regular session STRICTLY AFTER the announcement date. That is correct for an
// after-close event and merely one session late for a before-open event — it can
// never observe a session the market had not finished when the news was public.
const CLOCK = Object.freeze({
  confirmationSessionOffset: 1,     // sessions after the announcement date
  entrySessionOffset: 1,            // sessions after the confirmation session
  holdSessions: 5,                  // EXACTLY five complete trading sessions
  entryConvention: 'next-open',     // 'next-open' | 'vwap-0935-0945'
  exitConvention: 'close',
});

// Entry conventions the executor understands. The VWAP window needs intraday bars;
// when they are absent the executor REFUSES rather than silently using the open.
const ENTRY_CONVENTIONS = Object.freeze(['next-open', 'vwap-0935-0945']);

// ── Cost cases (all three are always reported) ──────────────────────────────
const COST_CASES = Object.freeze({
  fixed10bps: { kind: 'fixed', perSideBps: 10 },
  liquidityAware: { kind: 'liquidity-aware' },     // pretrade spread/ADV model, lib/costs tiers
  stress25bps: { kind: 'fixed', perSideBps: 25 },
});
const PRIMARY_COST_CASE = 'liquidityAware';

// ── Ranking / portfolio ─────────────────────────────────────────────────────
const PORTFOLIO = Object.freeze({
  maxPositions: 10,
  maxPerSector: 3,
  enterRank: 10,                    // enter at rank ≤ 10
  retainRank: 30,                   // retain only while rank ≤ 30 …
  retainEdgeOverCost: 1.0,          // … and estimated edge > 1.0 × round-trip cost
  weighting: 'equal',
});

// Integer relevance grades inside each decision-date group (percentile boundaries are
// computed WITHIN the date only — never pooled across dates, never using future dates).
const GRADE_BINS = Object.freeze([
  { grade: 4, minPct: 0.995 },
  { grade: 3, minPct: 0.95 },
  { grade: 2, minPct: 0.80 },
  { grade: 1, minPct: 0.50 },
  { grade: 0, minPct: 0 },
]);
// Below this cohort size the percentile bins cannot be resolved (a 0.5% bin needs ≥200
// names); a deterministic rank-based fallback is used instead and recorded per date.
const MIN_COHORT_FOR_PERCENTILE_BINS = 200;

// ── Validation (preregistered; only these two training schemes are compared) ─
const VALIDATION = Object.freeze({
  outerTestMonths: Object.freeze([3, 6]),
  trainingSchemes: Object.freeze(['rolling-3y', 'expanding']),
  purgeSessions: CLOCK.holdSessions,     // a label spans exactly this many sessions …
  embargoSessions: 5,                    // … plus at least 5 signal dates removed at each boundary
  finalHoldoutMonths: 12,
  label_gain: Object.freeze([0, 1, 2, 4, 8]),
  ndcgAt: 10,
});

// The four locked primary arms and the two locked ablations. Nothing else may be
// reported as a primary result.
const ARMS = Object.freeze(['E0_CURRENT_OMEGA', 'E1_SIMPLE_PEAD', 'E2_CATALYST_RANKER', 'E3_CATALYST_FLOW_RANKER']);
const ABLATIONS = Object.freeze([
  { id: 'E2_MINUS_E1', minuend: 'E2_CATALYST_RANKER', subtrahend: 'E1_SIMPLE_PEAD', asks: 'incremental value of nonlinear ranking' },
  { id: 'E3_MINUS_E2', minuend: 'E3_CATALYST_FLOW_RANKER', subtrahend: 'E2_CATALYST_RANKER', asks: 'incremental value of licensed signed options flow' },
]);
// Benjamini-Hochberg is applied across exactly this family (4 arms + 2 ablations).
const DECLARED_TEST_FAMILY_SIZE = ARMS.length + ABLATIONS.length;

// ── Promotion gates ─────────────────────────────────────────────────────────
// ALL must pass, on immutable point-in-time evidence only, before mode may leave shadow.
const PROMOTION_GATES = Object.freeze([
  'pitImmutableEvidence',        // no arm may rest on reconstructed/EXPLORATORY history
  'delistingsIncluded',          // delisted securities + delisting returns present
  'signedOptionsCoverage',       // E3 only: genuine participant/side/open-close feed
  'ablationSurvivesFDR',         // the declared ablation survives BH across the family
  'positiveNetOfStressCost',     // positive at the 25bps-per-side stress case
  'deflatedSharpePositive',      // DSR > 0 after deflation by the recorded trial count
  'holdoutUntouched',            // final 12-24m holdout opened exactly once, after freeze
]);

module.exports = {
  CATALYST_FLOW_VERSION, SCHEMA_VERSION, ARTIFACT_VERSION,
  MODES, flags,
  ELIGIBILITY, CLOCK, ENTRY_CONVENTIONS,
  COST_CASES, PRIMARY_COST_CASE,
  PORTFOLIO, GRADE_BINS, MIN_COHORT_FOR_PERCENTILE_BINS,
  VALIDATION, ARMS, ABLATIONS, DECLARED_TEST_FAMILY_SIZE,
  PROMOTION_GATES,
};
