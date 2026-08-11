# PREREGISTRATION — PSRL (Persistent Staircase Relative Leadership)

**Registered:** 2026-08-11 · **Hypothesis ids:** `psrl-continuity-conditional`,
`psrl-residual-vs-raw`, `psrl-incremental-omega` (family `swing-ranking`, three separate trials)
**Status at registration:** OPEN — no confirmatory data exists or has been inspected.
The seal is this document's commit hash; any post-hoc edit shows in git history.

## 1. Motivation (exploratory — spent, never reusable)

- The panel-v3.2 momentum-horizons diagnostic (63s IC 0.0316 / ESS 24; 126s IC 0.0451 / ESS 18 —
  both **below** the ESS ≥ 30 floor) motivates longer-horizon work but is permanently excluded
  from any verdict (already so registered under `momentum-longer-horizons`).
- RLT's two recorded walk-forwards are binding **negative** prior evidence: rank-level,
  rank-acceleration and residual-momentum rankers were indistinguishable from the random control
  on this universe, and `docs/relative-leadership-transition.md` prohibits re-slicing that window.
- PSRL's registered claims are therefore restricted to the axes RLT never tested: **path
  continuity (information discreteness, return concentration, jump-vs-plateau structure) and
  persistence/dwell time** — plus the residual-vs-raw ladder as a clean replication frame.

## 2. Hypotheses (fixed designs — see lib/research/hypothesis-registry.js for full text)

- **A `psrl-continuity-conditional`** — within momentum deciles, continuous advances (low
  information discreteness, low top-1/top-3 concentration, no JUMP_PLATEAU) outperform
  jump-driven advances at 21/63 forward sessions. Signals frozen as computed by
  `lib/psrl/continuity.js` + `lib/psrl/jump.js` (`psrl-features-v1`).
- **B `psrl-residual-vs-raw`** — the residual ladder (raw → minus-SPY → minus-sector →
  market-residual → market+sector-residual, all via `lib/atlasx-residual`) shows increasing
  rank IC on identical folds. Prior evidence is against; a null **confirms** RLT.
- **C `psrl-incremental-omega`** — OMEGA+continuity / OMEGA+residual / OMEGA+both / full
  challenger over OMEGA alone: incremental rank IC, Precision@K, target-before-stop,
  stagnation/severe-loss deltas, cost-net utility.

## 3. Fixed success criteria (ALL required, per trial)

1. HAC t > 0 with BH q ≤ 0.10 within the `swing-ranking` family denominator at evaluation time
   (the denominator can only have grown; it is 16 at registration);
2. effective sample size ≥ 30 (stats-v3);
3. beats the shuffled random control on the same rows;
4. not outlier-driven (dominant-date fraction < 0.5);
5. survives both `x{h}` sensitivity views where panel labels are used;
6. economic gate: exec-engine-v1 next-open fills, net > 0 under base, doubled and
   stressed-liquidity costs.

## 4. Confirmatory data — sealed

- **Prospective:** psrl trend-episode ledger observations with `startDate > 2026-08-11`
  (none existed at sealing). The live runner (`op=psrlresearch`) reports **accrual counts only**
  and never interim ICs. One verdict attempt per trial, when ESS ≥ 30 first holds.
- **Historical:** only if a **proven-safe** era is ever built (same blocker as
  `momentum-historical-2010-2021`). The current panel is `survivorship-reduced`; results on it
  are ceiling PASS-PROVISIONAL and can never promote. The live universe (candle-cache scopes)
  is present-day listing — prospective-clean, backtest-reduced.
- Sector classification is current-vendor, NOT point-in-time — every sector-conditioned cut is
  disclosed as such and the market-only fallback is reported separately.

## 5. Prohibitions

No threshold/weight tuning against any holdout (weights are frozen in `lib/psrl/config.js`,
`psrl-score-v1`; changing them resets earned evidence via scoringVersion); no subgroup, sector,
cap-band or regime selection for the verdict; no reuse of the 2022-2026 exploratory window or
the RLT walk-forward window; no early or repeated verdict attempts; no interim metric peeking
on accruing prospective data. Any deviation is a NEW hypothesis widening the family denominator.

## 6. Even a pass is not promotion

PSRL is weight-0 SHADOW (`strategy-registry` `psrl`, maturity `shadow`; `evidenceFamilies.psrl`
annotation only). Promotion additionally requires: point-in-time lineage, no unresolved leakage,
calibration where probabilities are displayed, non-concentration across names, multiple regimes,
continuity value beyond plain momentum AND residual value beyond raw relative strength
(criteria 9-10 of the implementation contract), promotion rules fixed before final holdout
inspection, and explicit strategy-registry approval. Nothing in this system can change
production rankings; the OMEGA weights are untouched.
