# PREREGISTRATION — Longer-Horizon Momentum (63/126 sessions)

**Registered:** 2026-08-03 · **Hypothesis id:** `momentum-longer-horizons` (family `swing-ranking`)
**Status at registration:** OPEN — no confirmatory data exists or has been inspected.
The seal is this document's commit hash; any post-hoc edit shows in git history.

## 1. Motivation (exploratory — spent, never reusable)

The panel-v3.2 exploratory diagnostic (`research/data/momentum-horizons-diagnostic.json`,
2022-2026 eligible cohorts, dataset `b361e861486d810f`) found:

| horizon | mean IC | HAC t | ESS |
|---|---|---|---|
| 63s | 0.0316 | 5.48 | 24 |
| 126s | 0.0451 | 7.09 | 18 |

Both fail the minimum effective sample (ESS ≥ 30). **That window is the motivating
observation and is permanently excluded from any confirmatory verdict.** This
preregistration exists so the confirmatory test is fixed before any new data is seen.

## 2. Hypothesis

Frozen 12-1 momentum (`m121`: total-return ratio bar −252 → bar −21, exactly as computed
by `research/15-panel-features-v3.js`) positively ranks cross-sectional forward
total return at 63 and 126 sessions. Two tests, declared as two trials in the
`swing-ranking` family denominator.

## 3. Fixed design (no degrees of freedom remain)

- **Signal:** `m121` as built by the panel. No variants, no re-weighting, no interaction terms.
- **Cohorts:** month-end decision dates under the panel-v3 universe rule (cap band, ADV
  floor, US common stock, identity-resolved), admitted **only** via the
  cohort-eligibility ledger (window elapsed on the session calendar, pendingRows = 0,
  outcome coverage ≥ 95%).
- **Label:** `f63` / `f126` total-return labels (fwd-outcome-v3; confirmed delistings
  included; unresolved excluded and disclosed).
- **Primary metric:** mean per-date Spearman rank IC over eligible cohorts,
  Newey-West HAC t (horizon-lagged), effective sample size per `stats-v3`.
- **Success criteria (ALL required, per horizon):**
  1. HAC t > 0 with BH q ≤ 0.10 within the `swing-ranking` family denominator
     (`familyTrials` at evaluation time — the denominator can only have grown);
  2. effective sample size ≥ 30;
  3. mean IC exceeds the shuffled random control on the same rows;
  4. not outlier-driven (dominant-date fraction < 0.5, per harness);
  5. holds in BOTH symmetric sensitivity views (include all provider-unconfirmed
     extremes / exclude all, via the `x{h}` flags);
  6. economic gate: execution-engine (`exec-engine-v1`) top-decile long portfolio,
     next-session-open entry, net > 0 under base, doubled and stressed-liquidity costs.
- **Secondary (robustness, non-binding):** the same IC on non-overlapping cohorts
  (every 3rd month at 63s, every 6th at 126s).

## 4. Confirmatory data — sealed eras (registry `HOLDOUTS`)

- **Era A — historical, one shot:** 2010-01 … 2021-12 panel, buildable ONLY when an
  authoritative monthly historical listing universe with delisting reasons exists and the
  survivorship contract measures **proven-safe** for that era
  (`research/data/history-expansion.BLOCKED.json` documents the current blocker).
  Evaluated **once**; the holdout is then opened forever.
- **Era B — prospective:** decision cohorts strictly after 2026-02-28 (63s) and
  2025-11-30 (126s) — none of which had observable outcomes at sealing — evaluated as
  they become fully observed. **A verdict may be attempted exactly once, when ESS ≥ 30
  first holds.** Until then the runner reports accrual counts only and refuses to reveal
  interim ICs.

Honest arithmetic: at monthly cohorts with 63/126-session overlap, prospective-only
accrual to ESS ≥ 30 takes on the order of 7+ years. The practical confirmatory path is
Era A, which is blocked on data procurement — a human decision, not an automatic purchase.

## 5. Prohibitions

No threshold or parameter tuning; no subgroup, sector, cap-band or regime selection for
the verdict; no additional horizons; no universe changes; no winsorization changes; no
early or repeated verdict attempts; no reuse of the 2022-2026 exploratory window.
Any deviation is a NEW hypothesis that must be preregistered separately and widens the
family denominator.

## 6. Even a pass is not promotion

A pass yields at most PASS-PROVISIONAL through harness-v3's tiers. Promotion still
requires: proven-safe survivorship for the evaluated era, measured execution-engine cost
evidence, prospective agreement with timestamped predictions (min sample 30),
calibration where probabilities are used, a hash-verified human review artifact, and
explicit strategy-registry approval. The harness cannot change production rankings.

## 7. Analysis code

`research/58-momentum-horizons-confirmatory.js` — committed alongside this document,
implements exactly this protocol, and structurally refuses to run ahead of the sealed
conditions (it prints accrual status, never interim ICs).
