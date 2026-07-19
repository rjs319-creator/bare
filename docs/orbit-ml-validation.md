# ORBIT-ML — Validation Report

Reproduce: `node research/orbit_ml/validate.js [limit] [range] [outerBlocks]`.
Claims tagged: **[NESTED-OOS]** / **[PROSPECTIVE]** / **[IN-SAMPLE]** / **[SPECULATIVE]**.

## Headline (honest)

ORBIT-ML is built, tested, and integrated as a shadow EVOLVE specialist — and, like ORBIT
before it, **it shows no durable out-of-sample rank quality and no incremental ensemble
value.** This is the weaker, honest result, preserved as required.

### Rank-model nested purged walk-forward **[NESTED-OOS]**
24 large-cap survivors, 5y (incl. 2022 bear), 2616 samples, 6–7 outer folds:

| Horizon | Purged rank-IC | ICIR | posFrac | leaky IC | leakage inflation |
|---|---|---|---|---|---|
| 5d | 0.0002 | 0.00 | 0.516 | 0.0032 | +0.0030 |
| 21d | 0.0027 | 0.01 | 0.511 | −0.0031 | −0.0058 |
| 63d | 0.0157 | 0.05 | 0.519 | 0.0338 | +0.0181 |

Purged rank-IC ≈ 0 at every horizon; positive-IC date fraction ≈ 0.51 (coin flip). The 63d
number is the largest but its ICIR is 0.05 and leaky > purged (leakage inflation +0.018),
consistent with a small survivorship/leakage artifact, not edge.

### Marginal ensemble contribution **[NESTED-OOS]**
Leave-ORBIT-out rank-IC (ORBIT-ML drift added to a residual-momentum peer, 21d, same resolved
cross-section): `withIC 0.018` vs `withoutIC 0.034` → **marginalDelta −0.016 → "hurts-ensemble."**
ORBIT-ML does not add incremental information; on this sample it is redundant-and-noisy relative
to residual momentum. Per the promotion policy this **fails the incremental-value gate outright**.

### Calibration **[NESTED-OOS]**
Reused ORBIT calibration (`evolve.fitCalibrator` isotonic + Platt/beta selection by held-out
Brier). With rank-IC ≈ 0 there is essentially nothing to calibrate; the null-when-unsupported
contract holds (probabilities are `null`, only the rank score is exposed).

### GBM / LambdaRank challenger **[SPECULATIVE — not run]**
`gbmStatus` reports **not available**: no frozen LightGBM/CatBoost artifact (no Python/LightGBM
in this environment). The JSON-tree evaluator + adapter are implemented and unit-tested, so a
frozen artifact from `research/orbit_ml/` would evaluate deterministically in Node — but **no
boosted result is fabricated.** Given the linear ranker's ≈0 OOS IC and negative marginal
contribution, a boosted model is not expected to rescue it on this survivorship-biased data.

## Correlation with existing algorithms **[SPECULATIVE / needs live ledger]**
Measured via `lib/redundancy.js` on the joint resolved cross-section as ledgers accrue. Structural
expectation (`docs/orbit-ml-audit §1`): high correlation with residual momentum / OMEGA / Stable
Core. The leave-one-out result above already indicates redundancy.

## Health & grade
- **Grade C** (inconclusive) trending toward the incremental-value gate FAILING (marginalDelta<0).
- **Health INSUFFICIENT_DATA** (no prospective ledger yet).
- **Shadow-only:** registered EVOLVE specialist with **no source mapping** → `affectsLiveRank:false`,
  `routerWeight:0`. Cannot reach live rank.
- `productionGrade:false, survivorshipSafe:false, pointInTimeSafe:false`.

## Point-in-time & survivorship limitations
Current-survivor universe, no delisted names, current sector map. No production-grade claim.

## Data required for production-grade validation
A point-in-time universe **with delisted securities + delisting returns + historical sector
membership + reliable security IDs**. Until then, no ORBIT-ML result is production-grade.
