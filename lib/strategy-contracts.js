'use strict';
// STRATEGY OUTCOME CONTRACTS (quant-redesign-3, Phase 4B) — the versioned, per-strategy
// definition of what a "trade" IS for every non-Day-Trade signal class: trigger, fill
// policy, exits, benchmark, cost/borrow policy, episode reset, and the label its
// evidence must be graded on. Maturity, governance, episodes and eligibility read THIS
// instead of inferring one generic label from a broad horizon name.
//
// WHY: the audit (docs/quant-redesign-3.md H4/H5) showed maturity graded every strategy
// on a generic horizon→metric map (intraday→1d, swing→5d, …) with a silent fallback to a
// DIFFERENT horizon when the intended bucket was empty, on GROSS excess and RAW pick
// counts. A contract makes the intended measurement explicit and auditable.
//
// Pure data + accessors. No network, no state. Day Trade's contract is recorded for
// completeness but is FROZEN — nothing here may alter Day Trade behavior (its entry
// mirrors current behavior exactly and carries `frozen: true`).

const CONTRACT_REGISTRY_VERSION = 'contracts-v1';

// Shared promotion bar (mirrors strategy-gate PROMOTION_GATE, restated here so the
// contract is self-contained and versioned with the outcome definition).
const PROMOTION_REQUIREMENTS = Object.freeze({
  minResolvedEpisodes: 50,
  minIndependentDates: 20,
  costNet: true,               // promotion judged on cost-net (incl. borrow for shorts)
  incrementalOverBaseline: true,
  ciExcludesZero: true,
  regimeRobust: true,
  prospectiveConfirmation: true,
});

// One entry per registry strategy id. Fields:
//   scoringVersion        version stamped by the normalizer — a change resets governance evidence
//   horizon / metric      intended hold bucket + the Scoreboard horizon key it is graded on
//   side                  'long' | 'short' | 'both'
//   trigger / fillPolicy  how an entry becomes REAL (an intended level is not a fill)
//   fillVerified          whether the CURRENT grading pipeline proves an executable fill
//                         (false = legacy close/level-assumed grading; honest, not aspirational)
//   stopPolicy/targetPolicy/timeExitSessions   exit contract
//   benchmark             excess-return benchmark(s)
//   costPolicy            how round-trip friction is charged
//   borrowPolicy          for short-capable strategies: 'fail-closed-no-feed' means a short
//                         is research/watch-only until observed borrow data exists
//   episodeCooldownSessions  a reappearance after this many sessions since last seen is a NEW
//                         episode (replaces "first ticker appearance forever" dedup)
//   primaryLabel          the utility label promotion is judged on
const CONTRACTS = {
  screener:   { scoringVersion: 'screener-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'published breakout entry', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'published stop', targetPolicy: 'published target', timeExitSessions: 63,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 21, primaryLabel: 'cost-net excess vs SPY @5d' },
  momentum:   { scoringVersion: 'momentum-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'list membership', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'none (list rotation)', targetPolicy: 'none', timeExitSessions: 63,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'cost-net excess vs SPY @1m' },
  ghost:      { scoringVersion: 'ghost-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'tier GHOST/STALKING', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'structure stop', targetPolicy: 'none', timeExitSessions: 63,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 21, primaryLabel: 'cost-net excess vs SPY @5d' },
  gapgo:      { scoringVersion: 'gapgo-v1', horizon: 'intraday', metric: '1d', side: 'long',
    trigger: 'ORB high break above gap open', fillPolicy: 'stop-through-trigger (gap-through = worse fill)',
    fillVerified: false, stopPolicy: 'below opening range low', targetPolicy: 'measured-move target',
    timeExitSessions: 1, benchmark: ['SPY'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 5, primaryLabel: 'cost-net R at ORB trigger (unfilled events retained)' },
  daytrade:   { scoringVersion: 'daytrade-v2', horizon: 'intraday', metric: '1d', side: 'long',
    trigger: 'ACTIONABLE_NOW envelope', fillPolicy: 'per Day Trade engine', fillVerified: false,
    stopPolicy: 'per Day Trade engine', targetPolicy: 'per Day Trade engine', timeExitSessions: 1,
    benchmark: ['SPY'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 5, primaryLabel: 'per Day Trade engine (FROZEN — excluded from this redesign)',
    frozen: true },
  coil:       { scoringVersion: 'coil-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'WATCHLIST until a price/volume trigger fires — pAbnormalExpansion is NOT a buy probability',
    fillPolicy: 'conditional on trigger', fillVerified: false,
    stopPolicy: 'published stop', targetPolicy: 'published target', timeExitSessions: 21,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 21, primaryLabel: 'two-stage: P(abnormal expansion) then cost-net R given trigger' },
  custom:     { scoringVersion: 'apex-v3', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'Apex/Loaded tier', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'structure stop', targetPolicy: 'model target', timeExitSessions: 63,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'cost-net excess vs SPY @1m' },
  biotech:    { scoringVersion: 'biotech-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'catalyst lead (NO published levels — lead, not a trade plan)', fillPolicy: 'lead-only',
    fillVerified: false, stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 21,
    benchmark: ['XBI', 'SPY'], costPolicy: 'biotech-tier', borrowPolicy: null,
    episodeCooldownSessions: 21, primaryLabel: 'XBI-residual excess by event type' },
  downday:    { scoringVersion: 'downday-v1', horizon: 'swing', metric: '5d', side: 'both',
    trigger: 'red-tape context ONLY (validated conditional sleeve)', fillPolicy: 'next-session-open',
    fillVerified: false, stopPolicy: 'published stop', targetPolicy: 'published target',
    timeExitSessions: 3, benchmark: ['SPY'], costPolicy: 'tier-by-dollar-volume',
    borrowPolicy: 'fail-closed-no-feed', episodeCooldownSessions: 10,
    primaryLabel: 'cost-net excess @3-session window, red-tape episodes only' },
  ignition:   { scoringVersion: 'ignition-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'acceleration rank', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'trailing structure', targetPolicy: 'none', timeExitSessions: 10,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 10, primaryLabel: 'cost-net excess vs SPY @5d' },
  coremo:     { scoringVersion: 'coremo-v1', horizon: 'portfolio', metric: '3m', side: 'long',
    trigger: '12-1 momentum book membership', fillPolicy: 'quarterly rebalance at open',
    fillVerified: false, stopPolicy: 'none (rebalance drop)', targetPolicy: 'none',
    timeExitSessions: 63, benchmark: ['SPY'], costPolicy: 'turnover-aware', borrowPolicy: null,
    episodeCooldownSessions: 63, primaryLabel: 'cost-net excess vs SPY @3m incl. turnover' },
  fade:       { scoringVersion: 'fade-v1', horizon: 'swing', metric: '5d', side: 'short',
    trigger: 'overheated social names — VALIDATED ONLY AS AN AVOID FILTER, not a live short book',
    fillPolicy: 'next-session-open', fillVerified: false, stopPolicy: 'published stop',
    targetPolicy: 'published target', timeExitSessions: 5, benchmark: ['SPY'],
    costPolicy: 'tier-by-dollar-volume+borrow', borrowPolicy: 'fail-closed-no-feed',
    episodeCooldownSessions: 10, primaryLabel: 'cost-net (incl. borrow) excess @5d' },
  gapdown:    { scoringVersion: 'gapdown-v1', horizon: 'intraday', metric: '1d', side: 'short',
    trigger: 'opening-range-low break', fillPolicy: 'stop-through-trigger', fillVerified: false,
    stopPolicy: 'above opening range high', targetPolicy: 'measured move', timeExitSessions: 1,
    benchmark: ['SPY'], costPolicy: 'tier-by-dollar-volume+borrow', borrowPolicy: 'fail-closed-no-feed',
    episodeCooldownSessions: 5, primaryLabel: 'cost-net (incl. borrow) R at OR-low trigger' },
  events:     { scoringVersion: 'cern-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'forced-flow event', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'decay-curve exit', timeExitSessions: 42,
    benchmark: ['SPY'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'per-event-type decay-curve excess' },
  readthrough:{ scoringVersion: 'ReadThrough-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'AI lead (no levels)', fillPolicy: 'lead-only', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 42, benchmark: ['SPY', 'sector'],
    costPolicy: 'unknown-liquidity-must-not-assume-cheapest', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'incremental value over price/setup baseline (shadow)' },
  anomaly:    { scoringVersion: 'Anomaly-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'AI lead (no levels)', fillPolicy: 'lead-only', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 42, benchmark: ['SPY', 'sector'],
    costPolicy: 'unknown-liquidity-must-not-assume-cheapest', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'incremental value over price/setup baseline (shadow)' },
  secondwave: { scoringVersion: 'SecondWave-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'AI lead (no levels)', fillPolicy: 'lead-only', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 42, benchmark: ['SPY', 'sector'],
    costPolicy: 'unknown-liquidity-must-not-assume-cheapest', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'incremental value over price/setup baseline (shadow)' },
  crossasset: { scoringVersion: 'CrossAsset-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'AI lead (no levels)', fillPolicy: 'lead-only', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 42, benchmark: ['SPY', 'sector'],
    costPolicy: 'unknown-liquidity-must-not-assume-cheapest', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'incremental value over price/setup baseline (shadow)' },
  toneshift:  { scoringVersion: 'ToneShift-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'AI lead (no levels)', fillPolicy: 'lead-only', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 42, benchmark: ['SPY', 'sector'],
    costPolicy: 'unknown-liquidity-must-not-assume-cheapest', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'incremental value over price/setup baseline (shadow)' },
  tone:       { scoringVersion: 'tone-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'earnings-call tone read', fillPolicy: 'lead-only', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 42, benchmark: ['SPY', 'sector'],
    costPolicy: 'unknown-liquidity-must-not-assume-cheapest', borrowPolicy: null,
    episodeCooldownSessions: 42, primaryLabel: 'incremental value over price/setup baseline (shadow)' },
  attention:  { scoringVersion: 'attention-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'sticky/fast attention read', fillPolicy: 'lead-only', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 21, benchmark: ['SPY'],
    costPolicy: 'unknown-liquidity-must-not-assume-cheapest', borrowPolicy: null,
    episodeCooldownSessions: 21, primaryLabel: 'incremental value over price/setup baseline (shadow)' },
  optionsflow:{ scoringVersion: 'optionsflow-v1', horizon: 'swing', metric: '5d', side: 'both',
    trigger: 'positioning read (evidence, not a plan)', fillPolicy: 'lead-only', fillVerified: false,
    stopPolicy: 'none', targetPolicy: 'none', timeExitSessions: 21, benchmark: ['SPY'],
    costPolicy: 'unknown-liquidity-must-not-assume-cheapest', borrowPolicy: 'fail-closed-no-feed',
    episodeCooldownSessions: 21, primaryLabel: 'base+options vs base-alone on identical episodes' },
  premove:    { scoringVersion: 'premove-stage-a-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'objective acceptance trigger (premove-trigger-v1: pivot break + close acceptance or range+turnover confirmation; gap beyond 5% refused)',
    fillPolicy: 'conditional stop-entry (exec-v1 semantics; gap-through at the worse open)', fillVerified: false,
    stopPolicy: 'invalidation level (plan stop or vol-scaled)', targetPolicy: 'plan target or vol-scaled abnormal level',
    timeExitSessions: 21, benchmark: ['SPY', 'sector'],
    costPolicy: 'liquidity-tier costs; unknown liquidity fails closed to micro', borrowPolicy: null,
    episodeCooldownSessions: 21,
    primaryLabel: 'two-stage: P(trigger before invalidation) then cost-net R given fill — never one blended confidence' },
  rlt:        { scoringVersion: 'rlt-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'objective acceptance trigger per family (breakout-acceptance / first-pullback / pivot-reclaim / tight-range continuation; premove-trigger-v1 rules; gap beyond 5% refused)',
    fillPolicy: 'conditional stop-entry (exec-v1; gap-through at the worse open; no-fill honest)', fillVerified: false,
    stopPolicy: 'pivot minus 1 ATR (leadership-structure invalidation)',
    targetPolicy: 'pivot plus 1.5 ATR (barrier geometry shared with ATLAS-X)',
    timeExitSessions: 10, benchmark: ['SPY', 'sector'],
    costPolicy: 'liquidity-tier costs (cost-v2); unknown liquidity fails closed', borrowPolicy: null,
    episodeCooldownSessions: 21,
    primaryLabel: 'two-stage: Stage A P(up-trigger before invalidation/timeout, competing-risk) then Stage B target-before-stop conditional on verified fill — outcomes per trigger family, never pooled blindly' },
};

// Scoreboard sections → strategy id (the Scoreboard groups by section; contracts key by id).
const SECTION_TO_ID = {
  screener: 'screener', momentum: 'momentum', Ghost: 'ghost', GapGo: 'gapgo',
  daytrade: 'daytrade', coil: 'coil', Biotech: 'biotech', DownDay: 'downday',
  Ignition: 'ignition', CoreMomentum: 'coremo', Fade: 'fade', GapDown: 'gapdown',
  CERN: 'events', ReadThrough: 'readthrough', Anomaly: 'anomaly', SecondWave: 'secondwave',
  CrossAsset: 'crossasset', ToneShift: 'toneshift', Tone: 'tone', Attention: 'attention',
  OptionsFlow: 'optionsflow', PreMove: 'premove', Rlt: 'rlt',
  // Sections whose strategies have no trade contract yet must still RESOLVE to their
  // id: an unmapped section is indistinguishable from a typo, and when one of these
  // strategies gains a contract its cooldown starts applying with no map edit needed.
  Evidence: 'thesis', OMEGA: 'omega', AtlasX: 'atlasx',
  Challenger: 'challenger-decision', Orbit: 'orbit', OrbitMl: 'orbit-ml',
};

const DEFAULT_COOLDOWN_SESSIONS = 21;

function contractFor(id) { return CONTRACTS[id] || null; }
function contractForSection(section) { return CONTRACTS[SECTION_TO_ID[section]] || null; }

// The Scoreboard horizon key a strategy's evidence must be graded on. Falls back to the
// caller-provided generic metric ONLY when no contract exists — and says so.
function metricFor(id, fallbackMetric) {
  const c = CONTRACTS[id];
  if (c && c.metric) return { metric: c.metric, basis: 'contract' };
  return { metric: fallbackMetric || '1m', basis: 'generic-fallback (no contract)' };
}

// Episode cooldown (in calendar days ≈ sessions here; the ledger is daily) for a
// Scoreboard section. A reappearance after this gap starts a NEW episode.
function cooldownForSection(section) {
  const c = contractForSection(section);
  return (c && Number.isFinite(c.episodeCooldownSessions)) ? c.episodeCooldownSessions : DEFAULT_COOLDOWN_SESSIONS;
}

// Does this strategy's contract require observed borrow for a short to be executable?
function borrowRequired(id) {
  const c = CONTRACTS[id];
  return !!(c && c.borrowPolicy === 'fail-closed-no-feed');
}

module.exports = {
  CONTRACT_REGISTRY_VERSION, PROMOTION_REQUIREMENTS, CONTRACTS, SECTION_TO_ID,
  DEFAULT_COOLDOWN_SESSIONS,
  contractFor, contractForSection, metricFor, cooldownForSection, borrowRequired,
};
