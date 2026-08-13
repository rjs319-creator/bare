# Graduation-League Findings Ledger (2026-08-12)

Consolidated, deduplicated findings from the 7-agent read-only audit, with the
verdict on each of the 10 starting observations and the repair status from this
pass. Severity: P0 (governance breach) > P1 (evidence-integrity break) > P2 > P3.
"FIXED" = repaired and tested this pass; "OPEN" = documented, owner needed.

## Verdicts on the 10 starting observations

1. **Registry 0 validated / 55 paper / zero weight** — CONFIRMED in mechanism
   (PROMOTION_CEILING + fillVerified fail-closed + no promotion artifacts →
   paper → clearedWeight 0). Exact count 55 plausible (58 entries − 3 static
   production), Blob-side count unverified locally. One wrinkle repaired:
   `ignition` was still registry-production with future-tense criteria — demoted.
2. **Aggregate no-separation (−0.017 rank-IC, −1.35% spread)** — CONFIRMED as an
   honest null, but computed by the pooled independence-naive rankquality battery
   (QM-1, OPEN); the walk-forward overlap-correction PRs do not cover that path.
3. **Apex inverted → demoted zero-weight frozen benchmark** — Demotion CONFIRMED
   in code; "inverted" is NOT the recorded rationale (unledgered 625-trial weight
   search is) — that clause of the observation is incorrect. Apex still lit the
   Prime badge and scaled the Opportunities rank (RT-01/RT-02) — FIXED.
4. **Legacy backtest: no costs, survivorship universe, ~119% investment, OOS AUC
   .45** — PARTIALLY FIXED before this pass and fully quarantined
   (promotionBlocked on every response). Residuals confirmed: exit-leg friction
   never charged (EA-6, FIXED), turnover-day >100% exposure mechanism (EA-7/QM-5,
   FIXED via weight renormalization), unpurged overlapping IS/OOS split (QM-6,
   OPEN — quarantined), curated default universe honestly stamped (EA-8).
   Sharpest residual: History-Check edges re-ordered the live screener (EA-9,
   FIXED).
5. **Core Performance resolved-only** — CONFIRMED (stablecore never got the
   Scoreboard's mtm-v1 port): resolved-only, gross of costs, stale cached
   entries, delistings stay OPEN forever, hardcoded retracted health baseline
   (EA-1..4, F-06) — FIXED (MTM lane, net lane, noHistory counter, none-validated
   health basis).
6. **Leaderboard reweights Opportunities / duplicates / mixed horizons** —
   PARTIALLY FIXED before the pass (no longer feeds any rank; MIN_RANKED_N floor).
   CONFIRMED residuals: scope-collapsed duplicate rows, mixed metrics/horizons/
   directions in one sort, stale "re-weights the Opportunities ranking" header
   (RT-04) — FIXED (scope-keyed rows, comparable-metric grouping, honest header).
7. **Opportunities research picks with buy language, 7% vs 30% cohort** —
   CONFIRMED, and worse than stated: the client rank was weighted 0.26 by demoted
   Ghost, 0.16 by the forbidden conviction sleeve, scaled by demoted Apex drift,
   with a ghost admission gate (RT-01 P0) — FIXED (shadow inputs stripped,
   sleeveA badge removed, honest research framing). Mitigations that already
   existed (no sizing, empty state, risk-off stand-down) verified real.
8. **OMEGA Ensemble "production" language while 0/12 cells passed** —
   PRESENTATION-ONLY/STALE: empty book is honest, 0/N cells displayed in red;
   the one live "production" string was the redundancy-mode label — FIXED
   (renamed) — plus static "0 of 18" drift noted.
9. **Market Pulse stale narrative / single-source / 4-hour statement** — STALE
   (fixed by PR #317 in the live v2 path: dual clocks, REDISCOVERED labeling,
   single-source lineage chips, honest cache status). CONFIRMED residuals: the
   sitewide hardcoded "Refreshes every 4 hours" footer (F-6) — FIXED — and the
   v1 fallback's conflated clock (F-7, OPEN, reachable only in pulse2 outage).
10. **OMEGA-Swing honest no-edge (406 delisted, IC −0.027 vs momentum +0.029)** —
    CONFIRMED accurate and artifact-backed (`lib/omega-research-verdict.json`);
    the citation pattern every other surface should copy.

## P0

- **RT-01 Opportunities/Quick Hit shadow-weighted rank** (opportunities.js,
  quickhit.js; corroborated by census F1) — FIXED: rank invariant to
  conviction/ghost/drift; ghost annotation only; sleeveA badge removed;
  reliability join scope-keyed (RT-07).

## P1

- **F-01 summary projection drops noHistory** (apex-routes.js) — FIXED: persisted
  groups now carry noHistory/noHistoryRate; maturity's survivorship ceiling is
  measurable again. NOTE: a scoreboard rewrite must run before grades reflect it.
- **F-02/F-03 sector control degenerate + gross for 7 SECTOR_BENCH sections**
  (apex-routes.js) — FIXED: independent SPY market channel for sector-benched
  rows; sector excess cost-netted; bases labeled.
- **F-05 unknown liquidity graded at cheapest tier** (costs.js) — FIXED:
  section-aware tier defaults; unknown-liquidity lead-only sections no longer
  assume 'liquid'.
- **F-06 stablecore retracted hardcoded baseline drives kill-switch** — FIXED:
  none-validated PENDING basis; retracted UI prose removed.
- **EA-1/2/3/4 stablecore accounting** — FIXED: MTM open-position lane, cost-net
  lane, noHistory counter; entry-basis staleness stamped (full next-open re-log is
  a new-version change, deferred with the census disposition).
- **F-08 provisional hypotheses cite a nonexistent report** (hypothesis-registry)
  — FIXED with a correction to the audit claim: verification showed only
  `unscheduled-gap-orb`'s provisional status rests on the missing
  ALPHA-STRATEGY-TEST-REPORT (downgraded to open with an evidence-lost note);
  `downday-v-reversal` and `coil-compression` cite in-repo documents that exist
  and keep their status. The report's other citations back no-edge conclusions
  (conservative direction). The missing VRP synthetic record remains OPEN.
- **RT-02 Apex lights Prime badge / whynow credit while shadow** — FIXED: gated on
  registry eligibility.
- **RT-03 gapgo TAKE + risk% from a shadow strategy** — FIXED: suggestedRiskPct
  gated server-side; "validated event edge" header and TAKE/size copy reworded.
- **data-lineage F-1 Form 4 look-ahead** (edgar.js) — FIXED: publication-date
  gating; ghost historical walk-forwards remain BLOCKED as promotion evidence
  until re-run.
- **F-07 static "validated"/numeric UI prose layer** — PARTIALLY FIXED (worst
  offenders: TRUST map claims, Core Momentum "validated/IR", Down-Day
  "Validated", gapgo header, best-setups-to-buy copy); full sweep of every
  numeric tooltip remains OPEN.

## P2 (repaired this pass)

- EA-6 exit-leg friction uncharged in legacy backtest — FIXED.
- EA-7/QM-5 turnover-day leverage >100% in portfolio sim — FIXED (weights
  renormalized by actual held count).
- EA-9 History-Check edges reorder live screener — FIXED (display-only badge;
  rank uncoupling).
- EA-10 gap-through barrier exits clipped at stop/target — FIXED in
  lib/outcome.js (exits realize the worse open).
- RT-04 leaderboard dedup/metric mixing/header — FIXED.
- RT-05 fade API "Validated trade: SHORT…Size" plan — FIXED (avoid-only wording +
  maturity stamp).
- RT-06 HOWTO buy/size copy for shadow strategies (omega/apex/ignition/
  confluence/opportunities) — FIXED.
- PR-02 SOURCE_FAMILY missing 'events' (CERN full independence credit) — FIXED
  (+ registry-id coverage test).
- F2 EVOLVE + govdemand unregistered — FIXED (registered shadow).
- RT-09/F3/F-13 ignition production inconsistency — FIXED (demoted to shadow;
  human re-promotion path unchanged).
- Census F5 dead mapping ghost:'screener' — FIXED.
- F-6 sitewide 4-hour footer — FIXED.
- QM lead-B "production (measured redundancy)" mode string — FIXED.

## Repaired in the follow-up batch (same pass, second commit)

- QM-1 — rankquality now runs a DATE-CLUSTERED IC lane (per-date Spearman, HAC
  mean via evidence-stats); verdicts read the clustered significance and the
  pooled battery is labeled `pooled-iid-descriptive`. The scoreboard feed
  (rqItems) carries dates.
- QM-2 — challenger-eval's walk-forward embargo is APPLIED (boundary +
  embargoDays rows excluded) and the trainedShadow ridge fit is label-end
  purged per row horizon.
- QM-3 — the promotion criterion's netExpectancy CI is date-clustered
  (HAC + moving-block, widest wins); the IID bootstrap survives only as a
  labeled thin-series fallback.
- QM-4 — drift-eval verdicts run on date-clustered HAC statistics
  (signedClustered / longShortClustered); the IID stats are retained as
  labeled descriptives. Preregistered "t ≥ 2 via drift-eval" gates now get the
  statistic they assumed.
- F-11 (artifact half) — promotion artifacts REQUIRE a `negativeControls`
  block: absent, non-boolean, failed, or empty batteries all fail closed
  (NEGATIVE_CONTROLS_FAILED). Wiring `prosecuteClaim` into the maturity review
  remains open.
- EA-5 — the Scoreboard UI renders the mtm-v1 lane (open+resolved cost-net
  average per group).

## OPEN (documented, prioritized, not repaired this pass)

- F-11 (second half): wire lib/cfl/prosecutor.prosecuteClaim into the
  maturity/governance review for strategies at promising or better.
- QM-6 legacy backtest unpurged overlapping split (quarantined).
- QM-7 ghost-backtest purge gap < label span (frozen weights contain it).
- F-04 silent SPY fallback inside sector-labeled headline stat.
- F-09 evidence artifacts overwritten in place; research/data unversioned.
- F-10 registry citation of an audit-rejected record; deriveStatus conflates
  inconclusive with no-edge.
- F-11 prosecutor battery unwired; promotion artifact lacks a negative-control
  block.
- F-12 incremental-over-baseline gates declared but unenforced; equal-weight/
  random baselines asserted not measured.
- F-14 ExpGap graded SPY-vs-SPY.
- F-15 assorted contract drift (downday 3d vs 5d; fillPolicy strings; twin
  holdout ledgers).
- EA-5 mtm lane computed but unrendered in Scoreboard UI.
- EA-11/12/13/14 legacy forwardReturn surfaces; dividends unused; core benchmark
  window mismatch; op=exits/op=longshort unstamped.
- F-5 lineage cohort-gate coverage gap (gateCohort only in swing-screener-engine).
- F-2/F-3 lineage sector-vintage at grade time (stamped bench honored — remaining
  gap is legacy unstamped rows + secmaster sector labeling).
- PR-03..PR-12 redundancy-model refinements (overlap-aware ESS, horizon
  matching, exposure-controlled residual credits, coverage beyond picks+ghost,
  router consolidation, omega size string).
- RT-08 ltrecs unregistered Buy/Sell lenses; RT-10 localStorage research
  sliders; RT-11 residual stale labels (cfl-lab header fixed; biotech/fade
  wording fixed).
- Census: 10 sections that never produce scoreboard rows; momentum-v2 DT-universe
  isolation.
