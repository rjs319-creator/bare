# Data-Sufficiency Audit — the "no edge" result, re-examined

_Audit date: 2026-07-18. Author: lead quant/ML engineer pass. Scope: the historical-learning
stack (ORBIT residual-drift screener, ORBIT-ML cross-sectional rank specialist, PIT contract +
negative controls). This document classifies the prior "no edge" finding, grades the existing
screeners, states the exact frozen promotion criteria, and names the real bottleneck._

## 1. What "no edge" actually was

The prior implementation reported **NO-EDGE + CLEAN** (`lib/orbit-controls.js` verdict), backed
by a purged, embargoed walk-forward. Re-running the reproducible artifact today
(`node research/orbit_ml/validate.js 24 5y 8`) gives:

| Horizon | Purged rank-IC | ICIR | Leaky IC | Leakage inflation |
|--------:|---------------:|-----:|---------:|------------------:|
| 5d      | 0.0002         | 0.001| 0.0032   | 0.003 |
| 21d     | 0.0027         | 0.010| −0.0031  | −0.006 |
| 63d     | 0.0157         | 0.052| 0.0338   | 0.018 |

- Marginal ensemble contribution (leave-ORBIT-out vs a residual-momentum peer, 21d):
  `withIC 0.018 / withoutIC 0.034 → marginalDelta −0.016` (**hurts the ensemble**).
- Negative controls: shuffled-label IC ≈ 0, no future-feature leak, random-ranker ≈ 0,
  survives doubled cost, robust to dropping the best year. **The evaluation is unbiased.**
- **`researchValidity: productionGrade=false, survivorshipSafe=false, pointInTimeSafe=false`**
  — 24 names, universe enumerated from *current* survivor lists, delisted names absent,
  sector membership current (not point-in-time).

### Interpretation of the sub-questions
- Real vs synthetic data: **real** (Yahoo daily candles, 5y, 2616 samples).
- Full eligible universe vs past picks only: **neither** — a bounded 24-name cross-section
  (the backfill *does* keep rejected/non-selected names, so it is not "past picks only", but it
  is far from the full eligible universe).
- Unique stocks / decision dates / range: **24 names, ~95 distinct dates, 5y.**
- Delisted present: **no.** PIT universe membership: **no.**
- Adjusted prices: handled (Yahoo adjusted). Train/test overlap: **no** (purged + embargoed).
- Purge/embargo enforced: **yes** (leakage inflation ≈ 0 confirms it). Transforms fit in-fold:
  **yes.** Holdout reused: **no** (single reproducible run).
- Costs applied: **yes** (net residual returns; doubled-cost control passes).
- Rank edge before costs: **no** (gross IC already ≈ 0).
- Statistically inconclusive vs truly negative: **inconclusive** — IC ≈ 0 with ICIR ≤ 0.05 is
  indistinguishable from zero at this sample size, not a confident negative.

## 2. Classification (corrected)

**`INSUFFICIENT_DATA`** — not `CREDIBLE_NO_EDGE`.

The prior framing ("no edge + clean") was correct about the *evaluation* (no leakage, unbiased,
cost-robust) but **too strong as a verdict**. The audit's own rule is explicit:

> Do not call it `CREDIBLE_NO_EDGE` unless the data was sufficiently point-in-time,
> survivorship-safe, full-universe, chronologically validated and adequately sampled.

Two of those five conditions fail hard: the universe is **survivorship-biased** (no delisted
names) and **not point-in-time** (current sector/constituent membership), and it is not
full-universe (24 names). Chronological validation and in-sample row count are fine; unique-name
breadth and PIT survivorship are not. Therefore no "no edge" conclusion is certifiable. What *is*
certifiable: **within the reachable free/Starter data, there is no measurable gross rank edge, no
leakage, and the learned ranker adds no incremental value over residual momentum.** That is a
statement about the data regime, not a proof that alpha is absent.

This matches every prior session's finding: the only durable, regime-robust signal reachable with
this data is weak momentum (~0.10 IC) plus regime avoidance; nothing incremental survived.

## 3. Per-screener scorecards (synthesis of existing research)

These are drawn from the already-built research harnesses (`research/*`, `lib/*-backtest.js`,
`op=research/exits/longshort/pead`, `ghost-backtest`, ORBIT/ORBIT-ML walk-forwards). Grades use
the audit taxonomy. All are measured on the **same survivorship-limited universe** — so grades
are provisional pending a PIT panel (see §5).

| Screener / factor family | 5d | 21d | 63d | Grade | Note |
|---|---|---|---|---|---|
| Residual / market-rel momentum | + | + | + | `PREDICTIVE_EDGE` (weak) | ~0.10 IC, the one real core factor |
| Sector-relative momentum | + | + | + | `PREDICTIVE_EDGE` (weak) | correlated with the above |
| Ghost SF/RM/AF (accumulation) | ~ | + | + | `PREDICTIVE_EDGE` (weak) | momentum-family, ~0.10 IC |
| Ghost AV (vacuum/base/dry-up) | 0 | 0 | 0 | `UNSUPPORTED` | IC ≈ 0.04, confirmed dead |
| BONUS (fundamental accel) | · | + | + | `PREDICTIVE_EDGE` | large-cap IC +0.118, **additive** (+0.009 to composite) |
| IN (insider buying) | · | ~ | ~ | `RISK_FILTER` | small-cap IC +0.067 but redundant w/ momentum (Δ −0.004) |
| Macro / regime router | · | · | · | `RISK_FILTER` | edge inverts in risk-off; avoidance is the lever |
| ORBIT-ML learned rank | 0 | 0 | 0 | `INCONCLUSIVE` | IC ≈ 0, marginalDelta −0.016 |
| Breakout structure gate (volSurge, VCP) | 0 | 0 | 0 | `HARMFUL` | net-negative; was a binding gate, now relaxed |
| PEAD (earnings drift) | · | ~ | 0 | `REGIME_SPECIALIST` | risk-on-window artifact; died OOS |
| Gap-&-Go continuation | + | · | · | `PREDICTIVE_EDGE` | the one event edge that survived deflation |

Baselines every screener is compared against already exist in the harnesses: market-relative
momentum, sector-relative momentum, equal-weight universe, random matched portfolios, the
fixed-weight Challenger, and an equal-weight ensemble. No learned model has beaten all of them
out-of-sample.

## 4. What was built this pass (the genuine delta only)

95% of the requested infrastructure already exists (PIT contract, negative controls, purged
walk-forward, RankNet meta-ranker, OOF calibration, shadow router, cost-aware selection,
experiment/model registries, feature registries + leakage tests). Per DRY/YAGNI, this pass added
only what was missing:

1. **`lib/promotion-readiness.js` (`promo-v1`)** — a single, frozen, machine-checkable gate that
   fuses `datasetSuitability` + `researchValidity` + coverage + walk-forward IC/ICIR +
   marginalDelta + controls verdict into one authoritative `{ready, status, blockers}`. Default is
   NOT READY; it must be argued up. It can never itself activate a model (`affectsLiveRank:false`).
   Proven to be able to say **yes** on a synthetic passing dataset, so its **no** on real data is
   meaningful. Today it returns `INSUFFICIENT_DATA`.
2. **Full-universe candidate ledger** — the ORBIT-ML shadow tick (`op=orbitmltick`) now stores the
   ranked cross-section **and every excluded/ineligible name with its rejection reason**
   (`no-history` / `insufficient-history` / `insufficient-features`) plus `universeSize`, so the
   forward training population is never "past picks only".
3. **`op=promotionreadiness`** — a public, cheap, never-500 read that reports the gate verdict +
   coverage live (currently `INSUFFICIENT_DATA`).

Nothing touches production ranks; all new behavior is shadow/read-only.

## 5. The real bottleneck and the exact data needed

The bottleneck is **data, not method**. To convert `INSUFFICIENT_DATA` into a certifiable verdict
(edge or no-edge) requires a survivorship-safe, point-in-time panel:

- **Delisted securities** retained in historical universes (the panel must contain names that
  later died, priced through their delisting).
- **Point-in-time index/sector membership** (who was actually in the universe on each date).
- **Breadth**: ≥ ~100 unique names across ≥ ~60 decision dates spanning ≥ 2 regimes (incl. a
  2022-type bear), plus ≥ ~20 **prospective** (live-forward, resolved) decision dates that the
  shadow ledger is now accumulating.

The `datasetSuitability` gate blocks training-based promotion until `hasDelisted &&
pointInTimeUniverse` are both true. The free/Starter feeds do not provide this; a paid PIT
security-master + delisting feed (or CRSP-equivalent) is the unlock. Until then, the honest
posture is: keep the models in shadow, keep logging the full-universe forward ledger, and do not
claim a verdict.

## 6. Frozen promotion criteria (from `lib/promotion-readiness.js`)

No learned model (ORBIT / ORBIT-ML / a Challenger meta-ranker) may go live until **all** hold:

1. **Survivorship-safe & PIT**: `hasDelisted && pointInTimeUniverse`, `researchValidity`
   survivorship/PIT-safe. *(hard block, metrics-independent.)*
2. **Coverage**: ≥ 100 unique names, ≥ 60 decision dates.
3. **Nested outer-OOS edge** at 21d: purged rank-IC ≥ 0.03 with |ICIR| ≥ 0.30 across ≥ 8 outer
   blocks spanning ≥ 2 regimes.
4. **Incremental value**: leave-one-out marginalDelta > 0 (beats the best existing peer).
5. **Controls clean**: negative-controls verdict `ROBUST` (no leakage, cost- and regime-robust).
6. **Prospective confirmation**: ≥ 20 live-forward resolved decision dates, live monitor not
   `DEGRADING`/`BROKEN`.
7. **Multiple-testing honesty**: deflated-Sharpe accounting (`lib/evolve-dsr.js`).

Meeting the gate certifies *eligibility only*; live activation remains an explicit human
governance action. Today: **0 of 7 fully met → NOT READY → `INSUFFICIENT_DATA`.**

## Operating commands

```
# reproduce the audit numbers (real data, ~17s)
node research/orbit_ml/validate.js 24 5y 8

# negative-controls / leakage battery (expensive)
curl 'https://market-news-app-chi.vercel.app/api/tracker?op=orbitcontrols&limit=24&range=5y'

# the frozen promotion gate (cheap, public, shadow)
curl 'https://market-news-app-chi.vercel.app/api/tracker?op=promotionreadiness'

# accrue the full-universe forward ledger (privileged; the warm cron runs it)
curl 'https://market-news-app-chi.vercel.app/api/tracker?op=orbitmltick&date=YYYY-MM-DD'
curl 'https://market-news-app-chi.vercel.app/api/tracker?op=orbitmlresolve'
```
