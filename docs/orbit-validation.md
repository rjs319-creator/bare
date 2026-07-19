# ORBIT — Validation Report

Reproduce with: `node research/orbit/validate.js [limit] [range] [outerBlocks]`
(bounded real-data backfill → nested purged walk-forward → freeze artifact).

All claims below are classified as one of:
**[NESTED-OOS]** demonstrated nested outer-OOS · **[PROSPECTIVE]** live-forward shadow ·
**[IN-SAMPLE]** in-sample only · **[SPECULATIVE]**.

---

## The headline finding (honest)

ORBIT is built correctly and runs end-to-end on real data, but **it shows no durable
out-of-sample rank-IC once the evaluation spans more than one regime.** This is the
weaker, honest result — preserved and reported as required.

The tell is the gap between a small single-regime sample and a larger multi-regime one:

### Run A — 12 names, 3y, 6 outer blocks (708 samples) — SEDUCTIVE ARTIFACT
| Horizon | Purged IC | ICIR | topDecile **net** | dirAcc |
|---|---|---|---|---|
| 5d | 0.0137 | 0.04 | −0.0051 | 0.48 |
| 21d | 0.0799 | 0.24 | −0.0315 | 0.50 |
| 63d | **0.2090** | 0.83 | +0.0320 | 0.55 |

The 63-day IC of 0.21 looks strong. It is **not real edge** — it is survivorship
(12 present-day survivors) × single-regime (3y is ~all one tape) × tiny sample (3 outer
folds). The residual still retains a momentum remnant, and survivors trended up.

### Run B — 30 names, 5y (incl. 2022 bear), 8 outer blocks (3270 samples) — THE TRUTH
| Horizon | Purged IC | ICIR | posFrac | topDecile net | dirAcc | Brier |
|---|---|---|---|---|---|---|
| 5d | 0.0045 | 0.02 | 0.495 | +0.0058 | 0.48 | 0.255 |
| 21d | −0.0053 | −0.02 | 0.468 | +0.0234 | 0.52 | 0.255 |
| 63d | −0.0184 | −0.07 | 0.519 | +0.0232 | 0.50 | 0.250 |

Across a multi-year, multi-regime, larger cross-section the purged rank-IC **collapses to
~0 / slightly negative** at every horizon, directional accuracy sits at coin-flip (~0.50),
and Brier ≈ 0.25 (the base-rate baseline). **[NESTED-OOS]** ORBIT has no demonstrated durable
edge on the available data.

This exactly reproduces this project's repeated prior finding (exits / PEAD / long-short
studies): promising results in a risk-on window die out of sample over 2022. See
[[market-news-app]] memory and `docs/orbit-audit.md §D2`.

---

## Calibration (per horizon) **[NESTED-OOS]**

On Run B, the out-of-fold calibrator selection chose `platt` at 21d/63d and `none` at 5d,
but held-out Brier stayed ≈ 0.245–0.255 — i.e. **there is little to calibrate because there
is little signal.** Calibration works mechanically (unit-tested to improve a deliberately
miscalibrated synthetic set); it cannot manufacture a probability from noise, and correctly
returns `calibrated:false` when out-of-fold support is thin.

## Leakage diagnostic

`leakageInflation = leakyIC − purgedIC` is small and inconsistent in sign across runs
(−0.006 to +0.033), which is expected when the underlying signal is ~0 — there is no real
edge for leakage to inflate. The purge/embargo machinery is verified by unit test
(`test/orbit-walkforward.test.js`) to drop boundary-overlapping training events.

## Correlation with existing algorithms **[SPECULATIVE / requires live ledger]**

Not yet measured on live data. The instrument is `lib/redundancy.js`
(`buildRedundancyModel`/`creditFor`) fed by the ORBIT and peer ledgers as they accrue.
The audit's structural expectation (`docs/orbit-audit §1`): highest return-correlation with
**OMEGA-Swing** (nearest residual neighbour) and **Stable Core** (63-day momentum), because
ORBIT's residual retains a momentum remnant. With ORBIT's OOS IC ≈ 0, its **incremental
ensemble contribution is not established and is presumed ~0** until the live ledger proves
otherwise.

## Incremental ensemble contribution **[SPECULATIVE]**

Leave-ORBIT-out ensemble deltas require the shared live ledger; not yet available. Given the
~0 standalone OOS IC, no positive incremental contribution is claimed.

---

## Grade & status

- **Current grade: C (inconclusive / insufficient edge).** Not F — the OOS IC is ~0, not
  significantly negative. Not B — there is no positive purged OOS to build on once regimes
  are spanned.
- **Health: INSUFFICIENT_DATA** (no live prospective ledger yet).
- **Shadow-only: yes.** `affectsLiveRank:false`, `deploymentWeight:0`, `governanceStatus:'paper'`.
- **productionGrade:false, survivorshipSafe:false** on every payload.

Grade A is unreachable from this backfill by construction (requires nested OOS **and**
prospective shadow validation **and** a survivorship-safe universe — none of which hold).

## What would change the verdict

See `docs/orbit-promotion-policy.md`. In short: a point-in-time universe *with delisted
names* is the single highest-value missing input; without it, no result here can be called
production-grade regardless of how strong it looks.
