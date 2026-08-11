'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL — research surface. PURE.
//
// Registers the three PSRL experiments as NEW trials in the `swing-ranking`
// family (they widen the family denominator; see lib/research/
// hypothesis-registry.js and research/PREREGISTRATION-PSRL-2026-08.md).
// The status projection reports ACCRUAL ONLY — it never reveals interim
// confirmatory metrics (momentum-horizons discipline). The 2022-2026
// exploratory panel window is spent and can motivate, never confirm.
//
// Ranker functions are exported so walk-forward comparisons run PSRL axes on
// IDENTICAL folds next to the RLT baseline ladder (rank-level, rank-accel,
// residual-momentum, control-random) — the only comparison that means
// anything given RLT's recorded null results.
// ═══════════════════════════════════════════════════════════════════════════

const EXPERIMENTS = Object.freeze([
  Object.freeze({
    id: 'psrl-continuity-conditional',
    familyId: 'swing-ranking',
    question: 'Among stocks with similar total past momentum, do continuous (low information-discreteness, low jump-concentration) paths outperform jump-driven paths?',
    design: 'within-momentum-decile contrast: high vs low continuity; low vs high top1Share; STEADY_ADVANCE vs JUMP_PLATEAU; OMEGA vs OMEGA+continuity',
    primaryMetric: 'per-date rank IC of the continuity contrast within momentum deciles; HAC t; BH q within swing-ranking familyTrials at evaluation',
    minEffectiveSample: 30,
  }),
  Object.freeze({
    id: 'psrl-residual-vs-raw',
    familyId: 'swing-ranking',
    question: 'Does beta-adjusted residual leadership rank forward returns better than raw return, stock-minus-SPY, and stock-minus-sector?',
    design: 'ranker ladder on identical folds: raw / minus-SPY / minus-sector / market-residual / market+sector-residual',
    primaryMetric: 'incremental rank IC of residual rankers over raw relative-strength rankers; HAC t; BH q within swing-ranking',
    minEffectiveSample: 30,
  }),
  Object.freeze({
    id: 'psrl-incremental-omega',
    familyId: 'swing-ranking',
    question: 'Does PSRL add out-of-sample value beyond OMEGA and plain momentum?',
    design: 'OMEGA / OMEGA+continuity / OMEGA+residual-leadership / OMEGA+both / full PSRL challenger, purged walk-forward, exec-engine-v1 costs',
    primaryMetric: 'incremental rank IC, Precision@K, target-before-stop, stagnation & severe-loss deltas, cost-net expected utility',
    minEffectiveSample: 30,
  }),
]);

// ── rankers (pure: PSRL card → score or null) ───────────────────────────────

const num = (x) => (Number.isFinite(x) ? x : null);

const RANKERS = Object.freeze({
  'psrl-continuity': (card) => num(card?.continuity?.w63?.discreteness?.continuity),
  'psrl-anti-concentration': (card) => {
    const t = card?.continuity?.w63?.concentration?.top1Share;
    return Number.isFinite(t) ? 1 - t : null;
  },
  'psrl-residual-leadership': (card) => num(card?.scores?.relativeLeadership),
  'psrl-persistent-trend': (card) => num(card?.scores?.persistentTrend),
  'psrl-combined': (card) => num(card?.scores?.combinedAfterPenalties),
  'psrl-raw-market-rel': (card) => num(card?.residual?.byHorizon?.[63]?.marketRel),
  'psrl-market-residual': (card) => num(card?.residual?.byHorizon?.[63]?.residual),
});

// ── accrual status (never interim confirmatory metrics) ─────────────────────

function experimentStatus({ ledger } = {}) {
  const eps = Object.values(ledger?.episodes || {});
  const closed = ledger?.closed || [];
  const resolved = closed.filter((e) => e.terminalEvent && e.terminalEvent !== 'RIGHT_CENSORED');
  const distinctStartDates = new Set([...eps, ...closed].map((e) => e.startDate)).size;
  return {
    registry: EXPERIMENTS.map((e) => ({ ...e, status: 'open', mode: 'exploratory-accruing' })),
    accrual: {
      activeEpisodes: eps.length,
      closedEpisodes: closed.length,
      resolvedTerminal: resolved.length,
      rightCensoredActive: eps.filter((e) => e.rightCensored).length,
      distinctStartDates,
      note: 'Accrual counts only. Interim ICs are never computed or revealed on accruing prospective data; a verdict may be attempted once preregistered conditions hold (ESS ≥ 30, family BH correction, cost gates). Historical evaluation runs on the survivorship-reduced research panel and cannot promote.',
    },
    survivorship: {
      liveUniverse: 'current candle-cache scopes — present-day listing, survivorship-reduced for backtests',
      sectorMap: 'current-vendor classification — NOT point-in-time; disclosed on any sector-conditioned result',
    },
    rankers: Object.keys(RANKERS),
  };
}

// ── CFL connection (addendum §16): deterministic attribution categories ─────
// Used when the Counterfactual Lab grades PSRL's misses and duds against
// COMPLETED episodes only. Category constants are defined here so CFL and
// PSRL cannot drift apart; challenger training never updates from a handful
// of recent trades (CFL's own contract).
const ATTRIBUTION = Object.freeze({
  missedWinner: Object.freeze([
    'NOT_DISCOVERED', 'RANKED_TOO_LOW', 'TREND_LIFE_TOO_SHORT', 'FAILURE_VETO_TOO_STRONG',
    'ENTRY_MODEL_TOO_LATE', 'FORECASTABILITY_ABSTAINED', 'UNPREDICTABLE_BEFOREHAND',
  ]),
  dud: Object.freeze([
    'PLATEAU_MODEL_FAILED', 'STAGNATION_MODEL_FAILED', 'BREAKDOWN_MODEL_FAILED',
    'TREND_LIFE_TOO_LONG', 'SECTOR_DETERIORATION_MISSED', 'CHANGEPOINT_TOO_LATE',
    'CATALYST_MISREAD', 'ENTRY_TOO_EXTENDED',
  ]),
});

module.exports = { EXPERIMENTS, RANKERS, ATTRIBUTION, experimentStatus };
