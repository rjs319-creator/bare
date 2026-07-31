# GRIDLOCK — Validation & Promotion Policy

**Current status: SHADOW. Portfolio weight 0. No win rate claimed. No probability shown. No live-portfolio inclusion. The prospective ledger starts at zero and everything is earned forward.**

## Prospective tracking (what accrues from day one)

Every tick logs EVERY beneficial candidate — gate passes (`Actionable`) **and** gate failures (`Tracked`, with the exact failing gate) — to the PIT day ledger `gridlock/day/<date>.json`, with: score version, CPS version + value, feature snapshot (components, penalties, tape), classification, exposure role, event id/type, lifecycle at entry, regime label, sector bench, and the inclusion/exclusion reason. Non-beneficial classifications are recorded in the snapshot's `recordedRejections`.

`op=gridlockresolve` (nightly) resolves matured horizons **1 / 5 / 10 / 21 sessions**: entry = next-session OPEN after the pick date (signal-day close is never tradeable), gross + cost-net return (`lib/costs.js roundTripCostPct`), excess vs SPY, excess vs the pick's own sector ETF, MFE, MAE, sessions-to-MFE. Resolution keys are stable (`date|ticker`) and horizons fill idempotently.

## Evaluation axes

The ledger rows carry the split keys directly: event type, ISO region, exposure role, classification (direct vs second-order vs equipment), CPS bucket, score bucket, gate status (timing-confirmed vs not), lifecycle state, regime, liquidity tier, sector. The Scoreboard (`section: 'Gridlock'`) additionally provides the standard first-seen episode dedup, regime split, liquidity split and score-decile check, benchmarked **sector-relative** (SECTOR_BENCH membership) plus SPY-excess.

## Baselines (all already in the repo — reuse, don't reinvent)

- SPY and sector-ETF excess: native to the Scoreboard resolution.
- Same-sector/size random and simple momentum: `lib/baselines.js` (`matched random pick`, `mom126`).
- Existing Read-Through results: same Scoreboard, section ReadThrough — direct comparison.
- OMEGA-SWING alone vs OMEGA+gridlock-overlap: the `physical_constraint` annotation on the OMEGA payload marks overlapping tickers so the with/without cohort comparison is computable from the two ledgers.
- Event-time evaluation: `lib/drift-eval.js evalDrift` (enters close AFTER the event, SPY-excess, by-year + by-regime splits) once ≥200 resolved events exist.
- Walk-forward: `lib/walk-forward.js purgedWalkForward` (date-grouped, embargoed) for any fitted change.

## No-lookahead guarantees

- `availableAt`/`retrievedAt` on every source record; announced dates never substitute for observation time on prospectively ingested events.
- Tape reads only use bars ≤ asOf (tested).
- Exposure relationships are effective-dated (`validFrom`/`validTo`, tested).
- Seeded historical events cannot become actionable (freshness decays to 0, tested).
- Resolution enters at the NEXT session open (tested pattern shared with govdemand).
- Optimization and validation must never share a sample: the initial weights are frozen priors; any future re-weighting must be fit on purged walk-forward folds and validated on later, untouched data.

## Promotion gate (configurable bars, frozen here before any data accrued)

Registered in `lib/strategy-registry.js` (`id:'gridlock'`, criteria field). ALL required before `maturity` may flip from `shadow`:

1. ≥150 matured (21-session) prospective candidates across ≥75 distinct dates.
2. ≥10 independent canonical events and ≥10 distinct companies contributing.
3. More than one macro-regime period represented.
4. Region data coverage ≥ `partial` on ≥80% of contributing days.
5. No lookahead leakage (spot-audit of ledger rows vs source retrievedAt).
6. Positive mean cost-net sector-relative excess at 5d and 21d.
7. Beats SPY, sector ETF, matched-random and simple-momentum baselines, and adds value over the existing Read-Through record.
8. Max drawdown and MAE distribution acceptable (no worse than the OMEGA shadow book's).
9. Stable across time splits (first half vs second half both positive).
10. Not dependent on one outlier (positive after dropping the best single name).
11. Not explained by sector momentum (sector-relative excess positive, not just raw).
12. Out-of-fold calibration testing BEFORE any probability is ever displayed.
13. An explicit, reviewable registry `maturity` flip (a PR, not a config drift).

Until then: weight 0, SHADOW badge everywhere, no probabilities, no live-portfolio inclusion, never presented as validated alpha. `summarizeResolution` refuses a verdict below 30 resolved and the UI says so.

## Honest prior

The app's own history (ORBIT ≈ 0, NSL all null, RLT no-edge, OMEGA no-edge survivorship-free) says the expected outcome of any new signal family is **null**. GRIDLOCK's value today is an orthogonal, verified, PIT event dataset and a clean falsifiable test — not a claimed edge.
