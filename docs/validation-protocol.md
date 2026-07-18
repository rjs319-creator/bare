# Validation Protocol

The evaluation contract every candidate ranker/model must pass before it can be *considered* for
promotion. Implemented by `lib/research/harness.js` (+ `lib/evolve-walkforward.js` for the fitted
EVOLVE ensemble). Nothing here promotes a model; promotion is governed by
`docs/model-promotion-policy.md`.

## 1. Nested chronological validation

**Inner loop** (tuning only): feature selection, hyperparameters, barrier parameters, calibration,
thresholds, regime parameters, ensemble weights. Uses **purged + embargoed** folds keyed on actual
label-end timestamps (`lib/research/label-purge.js`) — never calendar-day approximations.

**Outer loop** (performance estimation): untouched chronological blocks. Each model is **frozen**
before its outer block is scored; outer results never feed back into tuning. Prefer **8–12** outer
blocks when history permits, expanding or rolling windows, spanning diverse regimes. Reserve one
final locked test era where feasible.

## 2. Purge & embargo (exact)

A training event is kept only if its label **fully closed** at least `embargo` **trading days**
before the test block opens, measured on the real trading-date axis (holiday-immune). Events with no
recorded `labelEndDate` are dropped — never assumed closed. The harness also reports how many events
the legacy `×1.4` calendar approximation would have *leaked* (kept while still overlapping) or
*needlessly dropped*, so the correction is measured, not asserted.

## 3. Dependence corrections (do not double-count)

- **Atomic unit = the daily cross-sectional rank-IC** — one number per decision date. This treats
  all names on a date as a single correlated observation (same-date common shock), not N independent
  ones.
- **Uniqueness weighting** (López de Prado) down-weights overlapping labels per ticker×horizon
  (`lib/evolve-uniqueness.js`); the harness reports effective-N < raw-N.
- **Block bootstrap** over dated ICs for the confidence interval (`harness.summarizeICs`), seeded and
  deterministic.
- **Cross-specialist redundancy** (open gap, audit #10): effective independent-model count must
  discount correlated specialists before any "confirmation" or sample-size gate.

## 4. Metrics reported

- **Ranking:** daily Spearman rank-IC (mean, median, std), **ICIR**, t-stat + significance,
  fraction of positive-IC dates, top-minus-bottom spread, top-K precision.
- **Classification/calibration:** Brier, log loss, reliability table, calibration slope/intercept,
  ECE — fit **inside training folds only** (audit #18: the legacy in-sample calibrator Brier is
  optimistic).
- **Trading:** gross/net and benchmark-/sector-residual returns, turnover, costs, fill rate, Sharpe,
  Sortino, max drawdown, expected shortfall, profit factor, holding period, signal decay at
  next-open / VWAP / +1d / later.
- **Robustness:** by outer block, regime, sector, cap tier, liquidity, volatility, horizon, side,
  missing-data state, model version.
- **Statistical credibility:** clustered/bootstrap CIs, **deflated Sharpe** (`lib/evolve-dsr.js`),
  probability of backtest overfitting where feasible, multiple-testing adjustment, and the manifest's
  `relatedExperimentsAttempted` count.

## 5. Survivorship gate (hard)

If the study universe is reconstructed from present-day lists (the current reality — no PIT
constituents exist), the run is stamped `survivorshipSafe:false` and the verdict is **PROVISIONAL —
cannot support production promotion**, regardless of how strong the metrics look. This is enforced
in `harness.runExperiment`.

## 6. Prospective shadow validation

After historical approval: freeze the artifact; score all candidates prospectively; record every
selection **and** rejection; require adequate duration and enough *independent* decision dates;
compare prospective performance against the historical CI. Promotion is never automatic.

## 7. Reproducibility

Every run emits an `ExperimentManifest` (`lib/research/schemas.js`) pinning dataset hash,
security-master version, universe policy, feature manifest, label version, fold definitions, model &
calibration params, cost model, code commit, seed, the **primary metric declared before evaluation**,
results, and confidence intervals. Same script + same data ⇒ byte-identical results (verified by
`test/research-slice.test.js`).
