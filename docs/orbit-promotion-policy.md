# ORBIT — Promotion Policy

ORBIT starts and remains **shadow-only** (`affectsLiveRank:false`, `deploymentWeight:0`,
`governanceStatus:'paper'`, registry `core:false`). Promotion is gated and monotonic-in-rigor:
it can only advance by clearing evidence bars, never by an impressive backtest.

## Grades (native A–F, mapped to the app's maturity vocabulary)
| Grade | Meaning | Maturity map |
|---|---|---|
| A | nested outer-OOS **and** prospective shadow validation, calibrated, positive incremental value, survivorship-safe | validated |
| B | promising nested outer-OOS, prospective/regime coverage incomplete | promising |
| C | inconclusive / insufficient support | experimental |
| D | statistically meaningful degradation | experimental |
| F | persistent negative value, calibration failure, leakage, or broken data | disabled |

Current grade: **C** (see `docs/orbit-validation.md`).

## Hard gates for ANY production influence (all required)
1. **Survivorship-safe universe.** Point-in-time membership **with delisted names** — until
   `security-master.universeAt` is populated and the backfill consumes it, `survivorshipSafe`
   is false and **production-grade is blocked outright**, regardless of metrics.
2. **Nested outer-OOS edge.** Purged, embargoed rank-IC positive with ICIR and a positive-IC
   date fraction across ≥8 outer blocks spanning ≥2 regimes (must survive a 2022-type bear).
3. **Positive net expectancy after costs** at the horizon claimed (top-decile/top-K net > 0),
   not just a positive IC.
4. **Calibration.** Horizon-specific OOF calibrator with held-out Brier beating the base rate
   and slope ≈ 1; otherwise probabilities are exposed as `null` + a rank score only.
5. **Prospective shadow validation.** A live-forward ORBIT ledger (≥ ~20 independent decision
   dates) with health `HEALTHY`, reproducing the OOS edge out-of-time.
6. **Incremental information.** Positive marginal contribution beyond existing algorithms via
   `lib/redundancy.js` (low return-correlation / real leave-ORBIT-out ensemble lift).
7. **Multiple-testing honesty.** Deflated Sharpe (`evolve-dsr`) accounting for the number of
   configurations tried (logged in the experiment manifest).

## Promotion steps
1. Shadow accrual (now): log daily, resolve forward, monitor. Grade auto-updates.
2. Grade B: purged OOS positive on a survivorship-safe universe → keep paper, keep accruing
   prospective evidence.
3. Grade A: gates 1–7 all cleared → eligible for a *capped* router weight via
   `lib/algorithm-router.js` (still shrunk, capped per-algo/family, hysteresis-limited). Never
   an unconditional live-rank injection.
4. Any regression to D/F → immediate router disable (emergency), revert to paper.

## Demotion
`orbit-monitor` BROKEN at the live horizon, or a calibration/data-integrity failure, forces
grade F and router weight 0 with no hysteresis (immediate).
