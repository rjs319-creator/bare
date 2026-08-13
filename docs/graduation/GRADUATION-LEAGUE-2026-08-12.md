# Shadow Strategy Graduation League — Freeze, Contract, and Weekly Process (2026-08-12)

Companion to `STRATEGY-CENSUS-2026-08-12.md`. This document is the durable record of
Phase C (contamination freeze), Phase E (common evaluation contract), and Phase H
(weekly disposition process). Nothing here authorizes trading, deployment, or
automatic promotion.

## Phase C — evidence-contamination freeze

- **Version freeze**: strategy versions are the registry `version` fields as of
  commit `edc2a0f` (PR #332). The scoreboard summary carries `evidenceHash`
  (sha256 of the group evidence) and governance persists it; a promotion artifact
  must match the hash it was approved on. Repairs made by this pass change
  measurement, not strategy logic — where a strategy's own logic must change, the
  census marks it `repair-as-new-version`.
- **Consumed research periods**: every period inspected by the hypothesis registry
  is marked there (`lib/research/hypothesis-registry.js`); 11 sealed holdouts, 10
  untouched, 1 (WIKI momentum) irreversibly opened and recorded. The registry's
  "window spent" discipline is the consumed-data ledger of record. Known gap
  (open finding F-11 class): sealed-prefix reads are procedurally, not
  mechanically, blocked — a store-layer read-guard is the declared next hardening.
- **Auto-reweighting disabled**: the leaderboard no longer feeds any rank; the
  Opportunities/Quick Hit client rank was stripped of shadow-strategy inputs and
  drift scalars this pass (RT-01); History-Check backtest edges no longer reorder
  the live screener (EA-9); localStorage weight sliders remain but are labeled
  research-view controls that cannot touch server governance.
- **Shadow containment**: shadow strategies may influence a user-facing surface
  only through their registered contract (posterior-rank avoid-veto is the one
  sanctioned example). The red-team's attack list is in the findings ledger; all
  successful paths were closed this pass.
- **Moratorium**: no new alpha strategies until the graduation backlog is
  standardized (this census) and the weekly disposition process has produced its
  first human-reviewed cycle. The one predeclared exception is the zero-weight
  earnings-revision lane below.

## Phase E — common evaluation contract (contract-v1)

Binding framework for every league evaluation (already implemented by the
existing spine; this section freezes the choices):

```
universeSnapshotId       tradable-universe universeAsOf stamp (live) /
                         pitdata-v3 snapshot (replay; survivorshipSafe must be true
                         for any replay claim)
decisionTimestampRule    research/schemas.js: dataCutoffTs <= decisionTs,
                         eligibleEntryTs > decisionTs
featureVintagePolicy     decision-time stamps only; est-archive collectedAt <=
                         decisionTs for estimates; Form 4 gated on filingDate
forecastHorizon          the strategy contract's horizon (strategy-contracts.js);
                         no substitute horizon may be graded in its place
outcomeDefinition        scoreboard forward outcomes (label 'scoreboard-forward-v1')
                         or contract episode outcomes; delisting/no-history counted
                         (noHistoryRate, ceiling 5% fail-closed)
executableFillRule       entry-v2.2: next-session open default; trigger-verified
                         for conditional contracts; no-fill/gap-skip honest
costModelVersion         cost-v3 tiered spread+slippage + short borrow; unknown
                         liquidity must not assume the cheapest tier
exposureNeutralization   SPY excess (cost-net) + sector-ETF excess (cost-net,
                         distinct series — repaired this pass); factor residuals
                         via orbit-factor-v1 planned, not yet cross-strategy
purgeRule / embargoRule  exact labelEndDate purge + embargo (harness-v3 /
                         label-purge.js); walk-forward overlap correction default-on
independentCluster       decision-date (HAC/Newey-West, ESS); event-family for
                         sparse event strategies
baselines                SPY, sector ETF, control-random, momentum-12-1,
                         residual-momentum, low-vol arm, exposure-matched composite
                         (transparent-challenger arms)
falsificationTests       shuffled labels, placebo dates, frozen-inverse, lagged
                         features, doubled costs, drop-best-year, excision
                         (prosecutor — wiring into promising+ review is the declared
                         next step), PBO (CSCV), deflated Sharpe
promotionGateVersion     gov-v3 + promotion-artifact (add negative-control block —
                         open finding F-11) under PROMOTION_CEILING
```

Event strategies keep event-family clustering and episode outcomes; they are not
forced into daily cross-sectional labels — but PIT, cost, uncertainty, and
baseline standards above apply to all.

Decision records: the full-universe decision record (selected AND rejected, with
rejectionReasons, scores, vintages, governance state) exists today for op=today
(abstained + rejectionReasonCounts), the research harness ledgers, and episode
ledgers. Strategies whose sections never produce scoreboard rows (census:
trendrider, chartpattern, atlasx, premove, rlt, orbit, orbit-ml, coremo,
challenger-decision, optionsflow) are graded `experimental` forever — wiring
their ledgers into the scoreboard, or retiring them, is a disposition decision,
not a default.

## Phase G — tournament measurement set

Per strategy, on identical prospective dates and compatible universes (no daily
retuning): daily rank-IC (per-date, HAC-averaged — the pooled rankquality battery
is display-only and labeled), top-minus-bottom cost-net residual spread,
calibration/Brier only where probabilities are out-of-fold calibrated
(rank-semantics contract), precision conditional on abstention, independent dates
and ESS, turnover/costs/capacity, factor and sector exposure, drawdown,
concentration (excision), chronological-block stability, FDR-adjusted evidence,
and marginal contribution after measured redundancy credits.

## Phase H — weekly disposition process

Every Monday (or first session after), run and review — human in the loop, no
automatic transitions:

1. `op=maturity` — grades, FDR demotions, noHistory rates (now measurable again).
2. `op=scoreboard` — accrual; confirm `evidenceHash` advanced.
3. `op=redundancy` — measured credits; family-map coverage.
4. `op=hypotheses` — registry status; any earliest-test dates approaching
   (drift-eval clustering must be repaired before earnings-lane tests run — QM-4).
5. Census disposition review: apply the seven dispositions from the census table;
   record transitions in the governance ledger with reasons.

Promotion gate (unchanged, predeclared): positive cost-net residual CI above zero
on independent dates; direction stable across train/validation/holdout/
prospective; ≥75 independent prospective dates for frequent strategies
(preregistered calendar rules for sparse ones); multi-regime representation;
survives doubled costs and delay; no concentration dependence; beats the
exposure-matched baseline; acceptable PBO/DSR/FDR; positive marginal contribution;
no unresolved P0/P1; explicit human registry transition. The PROMOTION_CEILING
additionally caps all non-DT strategies at `promising` until an intraday-verified
fill pipeline exists.

## Earnings-revision lane (prepared, zero-weight — prerequisite work complete only when the above is bedded in)

Current state: `lib/est-archive.js` accrues write-once daily consensus vintages
(collectedAt-stamped); `lib/research/estimates-adapter.js` is stamped PIT_UNPROVEN
and fail-closed; `lib/revisions.js` (vendor mutable history) is blocked as
promotion evidence. Requirements before any evidence claim: licensed PIT consensus
vintages (or sufficient est-archive depth), SUE + revision breadth/dispersion/
recency, exact announcement timestamps, next-executable-session fills, historical
sector/size/beta/liquidity controls, cost-net residual outcomes, preregistered
linear baseline first, independent strategy ID + experiment family + prospective
ledger. Until depth suffices: typed provider interface + coverage matrix +
explicit unavailable/degraded states (est-archive already reports coverage);
never substitute current or reconstructed data.
