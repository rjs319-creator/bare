# Quant Redesign — Unified Research Contract & Vertical Slice

Companion to `docs/quant-system-audit.md`. Describes the redesigned research contract and the
**minimum vertical slice** shipped in this change (additive, tested, no live-rank change).

## Design principles
1. **One definition of a Prediction and an Outcome**, shared by training, backtesting, and
   production, so the three cannot silently disagree (`lib/research/schemas.js`).
2. **Ticker is never identity** — `securityId` is (matches `lib/security-master.js`).
3. **Causality by construction** — a signal from day-T close fills no earlier than T+1 open
   (`lib/execution-policy.js`); schema validators reject same-close fills and look-ahead cutoffs.
4. **Honesty by default** — `researchValidity.productionGrade` / `survivorshipSafe` default to
   **false**; a result is production-grade only when *proven*, never by omission.
5. **Complexity must earn its place** — a fitted model ships only if it beats the residual-momentum
   baseline on untouched, purged OOS blocks.

## Shipped modules (this slice)

| Module | Purpose | Part |
|---|---|---|
| `lib/research/schemas.js` | Immutable, versioned records + validators: SecurityMaster, UniverseSnapshot, FeatureSnapshot, **Prediction**, **ExecutableOutcome**, **ExperimentManifest** | II |
| `lib/research/features.js` | ONE pure `computeFeatureVector` (continuous, benchmark-/vol-relative) → train/serve parity by construction | V, XVI |
| `lib/research/label-purge.js` | **Exact label-end** trading-day purge, replacing the `×1.4` calendar approximation | III, XIII |
| `lib/research/baseline-ranker.js` | Date-grouped rankers: control-random, residual-momentum, production-composite passthrough, ridge-linear | VII |
| `lib/research/harness.js` | Purged, group-aware, uniqueness-weighted ranker comparison via **daily rank-IC** + block-bootstrap CI; emits a reproducible manifest | XIII, XIV, II |
| `scripts/run-validation-slice.js` | Runs the full contract on a deterministic synthetic dataset → `docs/validation-output.json` | XVII |
| `lib/evolve-labels.js` (edit) | Added `labelEndDate` (exact resolve date) + `profitable` (honest sign; a positive timeout is not a loss) | III, IV |
| `api/backtest.js` (edit) | `aucRank` now uses tie-corrected average ranks | XVIII #5 |

## Validation output (contract self-test — NOT alpha)

`docs/validation-output.json`, from `node scripts/run-validation-slice.js`. **Synthetic,
deterministic, survivorship-unsafe** — a weak momentum signal is *planted*, so positive IC here
validates the *plumbing* (purge, parity, discrimination), not market edge.

| Ranker | mean daily rank-IC (OOS, purged) | 90% CI | ICIR | verdict |
|---|---|---|---|---|
| control-random | +0.004 | [−0.030, +0.040] | 0.02 | ≈0 as expected (negative control passes) |
| **residual-momentum** | **+0.036** | **[+0.003, +0.075]** | 0.22 | recovers the planted signal (champion) |
| production-composite (noisy proxy) | +0.006 | [−0.025, +0.039] | 0.04 | ≈0 |
| ridge-linear | −0.049 | [−0.075, −0.024] | −0.41 | **overfits / inverts OOS** |

**Interpretation.** The single-feature residual-momentum baseline beats the 9-feature ridge OOS.
The ridge fits in-sample (IC +0.083) but inverts out-of-sample because `ret21` and `residMom21` are
near-duplicates → collinear → the ridge assigns `residMom21` a *negative* weight that does not
generalize. This is the intended lesson: **the harness refuses to flatter a more complex model**,
and complexity that fails to beat the baseline is rejected (Part VII). Documented next step:
per-date cross-sectional standardization + feature decorrelation / monotone constraints.

**Exact-purge impact.** Against the legacy `×1.4` calendar approximation on the same data
(6,840 candidate training rows): the approximation **leaked 23** still-overlapping labels into
training and **needlessly dropped 150** cleanly-closed labels. Exact label-end purge fixes both.

## Classification of every reported improvement

- **Demonstrated outer-OOS gain (real market data):** none — no PIT data exists (see audit P0).
- **Prospective shadow evidence:** none new this slice.
- **In-sample / synthetic-only (plumbing verified):** the harness discrimination, exact-purge
  diagnostic, parity, and determinism above — all on synthetic data.
- **Speculative:** per-date cross-sectional ridge, redundancy-discounted ensemble, neural path
  encoders (blocked until PIT data + stable tabular baselines exist).

## Not done (needs data or a larger refactor)
Real PIT constituents + delisting returns (external data); wiring `security-master.universeAt` into
the primary backtest; portfolio fill-day open→close P&L + trade↔portfolio reconciliation;
candidate-level ensemble strength (#9); redundancy-discounted effective-N (#10); out-of-fold
calibrator Brier (#18); reconstructing/scoping AI-narrative features (#12/#14).

> **Infinite predictive power is impossible.** Markets carry irreducible noise and adapt to
> discovered edges. Every extraordinary backtest result in this repo is treated as suspected
> leakage/survivorship/overfitting until disproven on untouched, purged, survivorship-safe data —
> which this repo does not yet have.
