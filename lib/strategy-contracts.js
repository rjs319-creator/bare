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
  // HORIZON SEPARATION (redesign Phase 7). The replay evaluates 5/10/21/63 sessions; only
  // `metric` is the promotion objective. Research at another horizon is a DIFFERENT
  // contract (different identity, see lib/evidence-identity) and can never validate this
  // one — `researchHorizons` records what is measured, `promotionMetric` what may promote.
  screener:   { scoringVersion: 'screener-v2', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'published breakout entry', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'published stop', targetPolicy: 'published target', timeExitSessions: 63,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 21,
    promotionMetric: '5d', researchHorizons: ['5d', '10d', '1m', '3m'],
    role: 'candidate-generation / prioritization baseline — durable ranking alpha is NOT demonstrated (research/SWING-SCREENER-VALIDATION-V3-2026-08.md)',
    primaryLabel: 'cost-net excess vs SPY @5d (promotion objective; other horizons are research only)' },
  // momentum-v2 (predictive-redesign): 5-minute technical detection over a price/volume-
  // discovered universe is a SAME-SESSION read — the old 'position'/1m contract graded it
  // on an objective it never predicted. Daily swing levels on the card are display context.
  momentum:   { scoringVersion: 'momentum-v2', horizon: 'intraday', metric: '1d', side: 'long',
    trigger: 'live technical confirmation (5-min)', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'daily swing stop (display context)', targetPolicy: 'daily swing resistance (display context)', timeExitSessions: 1,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 1, primaryLabel: 'cost-net excess vs SPY @1d' },
  // GHOST IS AN OVERLAY (redesign Phase 7). It rides the screener cross-section and is
  // highly correlated with the Breakout score, so standalone performance is not evidence
  // of value: the promotion objective is INCREMENTAL cost-net value over the underlying
  // breakout score on IDENTICAL candidate dates.
  ghost:      { scoringVersion: 'ghost-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'tier GHOST/STALKING', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'structure stop', targetPolicy: 'none', timeExitSessions: 63,
    benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 21,
    role: 'overlay on the Breakout cross-section — never a standalone book',
    incrementalOver: 'screener',
    primaryLabel: 'INCREMENTAL cost-net excess over the screener score on identical candidate dates @5d (standalone performance is NOT a promotion objective)' },
  gapgo:      { scoringVersion: 'gapgo-v1', horizon: 'intraday', metric: '1d', side: 'long',
    trigger: 'ORB high break above gap open', fillPolicy: 'stop-through-trigger (gap-through = worse fill)',
    fillVerified: false, stopPolicy: 'below opening range low', targetPolicy: 'measured-move target',
    timeExitSessions: 1, benchmark: ['SPY'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 5,
    // Decision-time honesty: the durable decision is logged POST-CLOSE (nightly tick) from
    // the completed daily candle, so the earliest session it can own is the NEXT one. The
    // verified channel (lib/gapgo-verify, gapgo-orb-verify-v2) grades exactly that: frozen
    // EOD take decision → next-session 30-min ORB, TAKE cohort only promotion-grade.
    decisionBasis: 'EOD post-close (nightly ledger tick; dataCutoffSession = signal session)',
    eligibleEntrySession: 'next-session',
    verifyVersion: 'gapgo-orb-verify-v2',
    // The VERIFIED lane's label is the same-session R/excess contract it actually grades:
    // next-session 30-minute opening range → stop-entry at the OR high → OR-low stop → 2R
    // target → session-close time exit, cost-net, TAKE cohort only. The daily-close proxy
    // below remains the legacy ledger's label and can promote nothing.
    verifiedPrimaryLabel: 'cost-net R on the next-session 30-min ORB contract (same session as the fill), TAKE cohort only',
    promotionLane: 'gapgo-orb-verify-v2 (op=gapgoverify) — the proxy ledger is NOT promotion evidence',
    evidenceInheritance: 'NONE — gapgo-orb-verify-v1 episodes are superseded, immutable and never pooled with v2',
    // Label states what the ledger MEASURES, not what the strategy aspires to: the prospective
    // gap ledger grades a 3-session daily-close excess vs SPY, cost-net (tier by logged ADV) —
    // a PROXY of the intraday ORB trade. R-at-trigger becomes the label only when fills are
    // verified intraday (fillVerified stays false until then; the verified lane is op=gapgoverify).
    primaryLabel: 'cost-net excess vs SPY @3d close (daily-close PROXY of ORB; fills unverified; verified lane = next-session ORB, gapgo-orb-verify-v2)' },
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
    episodeCooldownSessions: 21,
    // TWO SEPARATE MODELS, never blended into one number (redesign Phase 7):
    twoStage: {
      stageA: { question: 'P(abnormal volatility expansion within the horizon)', status: 'validated as a DETECTOR (top-decile coils break ~2x base rate)', display: 'expansion likelihood — explicitly NOT a probability of profit', promotable: false },
      stageB: { question: 'cost-net R given a VERIFIED directional trigger and fill', status: 'unproven — every conviction ranker tested INVERTED vs realized R', display: 'directional trade readiness', promotable: true, lane: 'lib/coil-reliability.js' },
    },
    primaryLabel: 'Stage B only: cost-net R conditional on a verified directional trigger (Stage A expansion probability can never promote a trade)' },
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
  // CONTRACT/EVALUATOR RECONCILIATION (redesign Phase 7). The contract declared a
  // 3-session time exit and a 3-session primary label while `metric` pointed at '5d' —
  // so the promotion grade was read from a 5-session bucket the strategy never claimed.
  // The Scoreboard now carries a '3d' horizon and this contract points at it: the
  // measured objective, the exit policy and the label are one thing.
  downday:    { scoringVersion: 'downday-v1', horizon: 'swing', metric: '3d', side: 'both',
    trigger: 'red-tape context ONLY (validated conditional sleeve)', fillPolicy: 'next-session-open',
    fillVerified: false, stopPolicy: 'published stop', targetPolicy: 'published target',
    timeExitSessions: 3, benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume',
    borrowPolicy: 'fail-closed-no-feed', episodeCooldownSessions: 10,
    // The eligible cohort is explicit: only red-tape sessions are the validated context,
    // and only the bounce (long) tiers carry the evidence. Unrelated Down-Day tiers may
    // not inherit it — enforced by the registry's frozen policyTiers + the conditionGate.
    conditionGate: 'red-tape session (SPY down on the day or macro risk-off)',
    eligibleCohort: 'oversold-bounce longs on a red tape (WATCH/EMERGING/CONFIRMED)',
    delistingPolicy: 'delisted names resolve at the last observable price and are counted as attrition, never dropped',
    primaryLabel: 'cost-net excess vs SPY AND sector @3 sessions, red-tape bounce episodes only, next-session-open entry' },
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
    episodeCooldownSessions: 21,
    // INFERENCE LIMITS (redesign Phase 7). Free delayed chains carry volume and open
    // interest — not trade direction, not the initiating side, not intent. Anything the
    // data cannot support is refused rather than estimated.
    inferenceLimits: {
      canInfer: ['contract volume vs open interest', 'estimated notional premium', 'unusual-activity ranking'],
      cannotInfer: ['opening vs closing transaction', 'bought vs sold (initiating side)', 'hedge vs directional intent', 'the holder\'s net exposure'],
      rule: 'a read the data cannot support is reported as unknown — never estimated, never displayed as directional conviction',
    },
    primaryLabel: 'base+options vs base-alone on identical episodes (INCREMENTAL only)' },
  premove:    { scoringVersion: 'premove-stage-a-v1', horizon: 'swing', metric: '5d', side: 'long',
    trigger: 'objective acceptance trigger (premove-trigger-v1: pivot break + close acceptance or range+turnover confirmation; gap beyond 5% refused)',
    fillPolicy: 'conditional stop-entry (exec-v1 semantics; gap-through at the worse open)', fillVerified: false,
    stopPolicy: 'invalidation level (plan stop or vol-scaled)', targetPolicy: 'plan target or vol-scaled abnormal level',
    timeExitSessions: 21, benchmark: ['SPY', 'sector'],
    costPolicy: 'liquidity-tier costs; unknown liquidity fails closed to micro', borrowPolicy: null,
    episodeCooldownSessions: 21,
    primaryLabel: 'two-stage: P(trigger before invalidation) then cost-net R given fill — never one blended confidence' },
  // Previously-unregistered user-visible screeners (non-daytrade redesign 2026-08).
  // fillPolicy states the INTENDED executable entry; fillVerified:false records the
  // honest present state — their books grade signal-day close-to-close proxies, so
  // none of this evidence can drive Validated (lib/maturity.js proxy gate).
  trendrider: { scoringVersion: 'trendrider-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'trend-momentum rank admission', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'none published (book grades a naked 21-session hold)', targetPolicy: 'none',
    timeExitSessions: 21, benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 21, primaryLabel: 'cost-net excess vs SPY @21 sessions (close-to-close PROXY; fills unverified)' },
  aligned:    { scoringVersion: 'aligned-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'dual-horizon alignment (LT trend AND ST action bullish)', fillPolicy: 'next-session-open', fillVerified: false,
    stopPolicy: 'published stop (display only — NOT graded)', targetPolicy: 'published measured-move target (display only — NOT graded)',
    timeExitSessions: 21, benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 21, primaryLabel: 'cost-net excess vs SPY @21 sessions (close-to-close PROXY; displayed plan not graded)' },
  confluence: { scoringVersion: 'confluence-v1', horizon: 'position', metric: '1m', side: 'long',
    trigger: 'multi-strategy vote with ≥2 independent evidence families', fillPolicy: 'pullback-limit (displayed) / next-session-open (graded intent)', fillVerified: false,
    stopPolicy: 'published ATR stop (display only — NOT graded)', targetPolicy: 'published 2R target (display only — NOT graded)',
    timeExitSessions: 21, benchmark: ['SPY', 'sector'], costPolicy: 'tier-by-dollar-volume', borrowPolicy: null,
    episodeCooldownSessions: 21, primaryLabel: 'cost-net excess vs SPY @21 sessions (close-to-close PROXY; displayed plan not graded)' },
  // Pattern Radar had a SECTION_TO_ID mapping but no outcome contract, so its cooldown
  // took the generic default and its metric came from a generic horizon guess.
  chartpattern: { scoringVersion: 'pattern-decision-v2', horizon: 'swing', metric: '5d', side: 'both',
    trigger: 'family-specific structural trigger (frozen episode levels)',
    fillPolicy: 'conditional stop-entry (fill-aware episode grading)', fillVerified: false,
    stopPolicy: 'frozen episode invalidation level', targetPolicy: 'frozen measured-move target',
    timeExitSessions: 21, benchmark: ['SPY', 'sector'],
    costPolicy: 'tier-by-dollar-volume; unknown liquidity fails closed', borrowPolicy: 'fail-closed-no-feed',
    episodeCooldownSessions: 21,
    role: 'lead/watchlist per family — a family becomes actionable only on its OWN leakage-safe walk-forward record',
    primaryLabel: 'per family x direction x timeframe: cost-net lift vs matched non-pattern controls, FDR-controlled' },
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
  Pattern: 'chartpattern',
  Evidence: 'thesis', OMEGA: 'omega', AtlasX: 'atlasx',
  Challenger: 'challenger-decision', Orbit: 'orbit', OrbitMl: 'orbit-ml',
  Gridlock: 'gridlock',
  PeerProp: 'peerlab', Underreaction: 'underreaction', ExpGap: 'expgap',
  EmergingLeader: 'emergingleader',
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

// FILL VERIFICATION IS DERIVED, NEVER DECLARED (redesign Phase 6 rule 1).
//
// `fillVerified` on a contract is documentation of the CURRENT pipeline, and a flag a
// human can flip is exactly the wrong control on the question "did this plan actually
// fill?". The value the promotion gate reads comes from the canonical episode ledger:
// `evidence.fillVerification[id]` (produced by lib/episode-ledger.deriveFillVerified over
// that strategy's own resolved episodes). Absent ⇒ FALSE. A contract flag can never turn
// verification ON — only the episodes can.
function fillVerifiedFor(id, evidence = null) {
  const derived = evidence && evidence.fillVerification && evidence.fillVerification[id];
  if (derived && typeof derived.fillVerified === 'boolean') {
    return { fillVerified: derived.fillVerified, basis: 'derived-from-episodes', detail: derived.reason || null, resolved: derived.resolved ?? null };
  }
  return {
    fillVerified: false,
    basis: 'no derived episode evidence',
    detail: 'no canonical episode ledger has been reduced for this strategy — fill verification is unproven and fails closed (a contract flag cannot grant it)',
    resolved: null,
  };
}

// Does this strategy's contract require observed borrow for a short to be executable?
function borrowRequired(id) {
  const c = CONTRACTS[id];
  return !!(c && c.borrowPolicy === 'fail-closed-no-feed');
}

module.exports = {
  CONTRACT_REGISTRY_VERSION, PROMOTION_REQUIREMENTS, CONTRACTS, SECTION_TO_ID,
  DEFAULT_COOLDOWN_SESSIONS,
  contractFor, contractForSection, metricFor, cooldownForSection, borrowRequired, fillVerifiedFor,
};
