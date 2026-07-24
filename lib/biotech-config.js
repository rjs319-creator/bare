'use strict';
// 🧬 BIOTECH SWING ENGINE — shared vocabulary. One source of truth for the enums, versions,
// and thresholds every biotech-* module and its tests reference, so the archetype names, the
// capital-state labels, and the action ceilings can never drift apart across files.
//
// DESIGN: the redesign separates biotech situations into distinct opportunity LANES
// (archetypes) instead of collapsing them into one blended /100 score. Each lane has its own
// horizon, its own risk profile, and its own gates — a post-catalyst continuation and an
// unresolved-binary gamble are NOT interchangeable, so they must never be ranked as if they
// were. The score that survives is a RESEARCH PRIORITY (attention ordering), never a
// probability — probabilities are withheld until a frozen, prospectively-calibrated model
// clears the validation gate (see BIOTECH-SWING-ENGINE.md).

// ── Versions (stamped into every ledgered decision for walk-forward reproducibility) ──
const VERSIONS = {
  engine: 'biotech-swing-v1',      // the deterministic engine ruleset
  scoring: 'biotech-v1',           // KEEP: downstream decision-normalizers keys off this exact string
  ai: 'biotech-ai-v1',             // the bounded evidence-interpreter prompt/tool contract
  events: 'biotech-events-v1',
  capital: 'biotech-capital-v1',
};

// ── Opportunity archetypes (Phase 4). Each candidate is routed to exactly ONE lane. ──
const ARCHETYPES = {
  POST_CATALYST: 'POST_CATALYST',        // A verified catalyst already out; market repricing (3–15 sessions)
  PRE_EVENT: 'PRE_EVENT',                // running INTO a dated future event; MUST exit before it
  CATALYST_BASE: 'CATALYST_BASE',        // prior catalyst still relevant + constructive base → breakout
  POST_EVENT_PULLBACK: 'POST_EVENT_PULLBACK', // positive catalyst then orderly pullback (buyable)
  FINANCING_RELIEF: 'FINANCING_RELIEF',  // completed offering, may now be funded through a catalyst
  SYMPATHY: 'SYMPATHY',                  // defensible mechanistic read-through from a verified leader
  BINARY_WATCH: 'BINARY_WATCH',          // unresolved binary / M&A-near-offer / rumor → NOT normal swing
  UNCLASSIFIED: 'UNCLASSIFIED',
};
const ARCHETYPE_LIST = Object.values(ARCHETYPES);

// Human labels + typical holding horizon (sessions) per lane, for the UI and the plan.
const ARCHETYPE_META = {
  POST_CATALYST: { label: 'Post-Catalyst Continuation', hold: 8, actionable: true },
  PRE_EVENT: { label: 'Pre-Event Run-Up', hold: 6, actionable: true },
  CATALYST_BASE: { label: 'Catalyst-Base Breakout', hold: 10, actionable: true },
  POST_EVENT_PULLBACK: { label: 'Buyable Post-Event Pullback', hold: 7, actionable: true },
  FINANCING_RELIEF: { label: 'Financing-Overhang Relief', hold: 10, actionable: true },
  SYMPATHY: { label: 'Mechanistic Sympathy', hold: 5, actionable: true },
  BINARY_WATCH: { label: 'Binary / Special Situation', hold: 0, actionable: false },
  UNCLASSIFIED: { label: 'Unclassified', hold: 0, actionable: false },
};

// ── Capital-structure states (Phase 3). Deterministic where evidence exists, else UNKNOWN. ──
const CAPITAL_STATES = {
  FUNDED_THROUGH_CATALYST: 'FUNDED_THROUGH_CATALYST',
  ADEQUATE_RUNWAY: 'ADEQUATE_RUNWAY',
  FINANCING_LIKELY: 'FINANCING_LIKELY',
  ACTIVE_ATM: 'ACTIVE_ATM',
  PENDING_OFFERING: 'PENDING_OFFERING',
  COMPLETED_FINANCING_RELIEF: 'COMPLETED_FINANCING_RELIEF',
  SEVERE_DILUTION_RISK: 'SEVERE_DILUTION_RISK',
  UNKNOWN: 'UNKNOWN',
};
// Capital states that force a defensive action ceiling regardless of setup quality.
const CAPITAL_DANGER = new Set([CAPITAL_STATES.PENDING_OFFERING, CAPITAL_STATES.ACTIVE_ATM, CAPITAL_STATES.SEVERE_DILUTION_RISK]);

// ── Action ceilings (Phase 6). The HIGHEST action a candidate may reach, in priority order
// (most permissive → most restrictive). A gate can only ever lower the ceiling, never raise it. ──
const ACTION = {
  PRIMARY_CONFIRMED: 'PRIMARY-SOURCE CONFIRMED', // verified catalyst, liquid, valid R:R, funded
  ACTIONABLE: 'ACTIONABLE',
  WAIT_FOR_TRIGGER: 'WAIT',                      // valid setup, entry trigger not yet met
  WAIT_FOR_FINANCING: 'WAIT FOR FINANCING',      // pending/active dilution overhang
  NEEDS_REVIEW: 'NEEDS REVIEW',                  // conflicting scientific/regulatory evidence
  WATCH_ONLY: 'WATCH ONLY',                      // unidentified reason + low liquidity
  BINARY_WATCH_ONLY: 'BINARY WATCH ONLY',        // unresolved binary inside the holding period
  LATE: 'LATE',                                  // move already consumed / overextended
  NON_EXECUTABLE: 'NON-EXECUTABLE',              // insufficient liquidity
  AVOID: 'AVOID',
};
// Rank so gates can take the minimum (most restrictive) ceiling deterministically.
const ACTION_RANK = {
  'PRIMARY-SOURCE CONFIRMED': 100, ACTIONABLE: 90, WAIT: 70, 'WAIT FOR FINANCING': 55,
  'NEEDS REVIEW': 50, 'WATCH ONLY': 40, 'BINARY WATCH ONLY': 35, LATE: 30, 'NON-EXECUTABLE': 20, AVOID: 10,
};

// ── Grading horizons (Phase 12). Sessions after the next-open entry. ──
const HORIZONS = [3, 5, 10, 21];
const BIOTECH_ETF = 'XBI';                       // the honest benchmark for a biotech swing

// ── Data-quality states (Phase 6: missing data must NOT default to neutral/positive). ──
const DATA_QUALITY = { OK: 'OK', DEGRADED: 'DEGRADED', THIN: 'THIN', MISSING: 'MISSING' };

// ── Detection thresholds (kept aligned with the legacy runner predicate). ──
const DETECT = { MIN_PCT5D: 5, MIN_RELVOL: 1.3, MIN_DOLLAR_VOL: 1_000_000, MIN_PRICE: 1.0, MAX_PCT5D: 200 };
const MICRO_DOLLAR_VOL = 15_000_000;             // below → "micro" liquidity tier

// ── Prospective-validation review floors (Phase 13). NOT a promotion switch — a documented
// gate the engine must clear before probabilities or live weight changes are even considered. ──
const VALIDATION_FLOORS = {
  minResolvedEpisodes: 150, minIndependentDates: 60, minPerArchetype: 20,
  requirePositiveVsBaseline: true, requireCiExcludesZero: true,
};

module.exports = {
  VERSIONS, ARCHETYPES, ARCHETYPE_LIST, ARCHETYPE_META,
  CAPITAL_STATES, CAPITAL_DANGER, ACTION, ACTION_RANK,
  HORIZONS, BIOTECH_ETF, DATA_QUALITY, DETECT, MICRO_DOLLAR_VOL, VALIDATION_FLOORS,
};
