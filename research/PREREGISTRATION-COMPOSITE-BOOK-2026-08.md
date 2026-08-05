# Preregistration — Composite Book v1 + VRP Overlay (2026-08)

**Registered:** 2026-08-05 · **Hypothesis ids:** `composite-book-v1` (family `regime`, confirmatory) and `vrp-overlay-synthetic` (family `volatility-structure`, exploratory). The seal is this document's commit hash.

## §1 The reframe

Two deliberate departures from the per-signal frame that has produced ~45 honest nulls:

1. **Evaluate the book, not the signals.** Institutional edges are portfolios of individually-weak, mutually-uncorrelated tilts. The program's surviving pieces (CERN forced-flow — the ONLY live-positive cell, LB 54.8% on 7/7; Down-Day V-reversal — study-validated with a live ledger) are exactly that shape. Pooling their events reaches a testable sample months sooner than any sleeve alone.
2. **Get paid for risk instead of forecasting.** The variance risk premium is the most persistent retail-accessible return stream documented (CBOE PUT/BXM class); it requires no predictive edge, only disciplined risk-bearing plus the regime gate — the program's one validated lever.

## §2 composite-book-v1 — fixed design

- Sleeves FROZEN in `lib/alphabook-routes.js`: CERN (first-appearance events, logOnly types excluded, each graded at its type's own horizon; short alpha = symmetric short-benchmark read) + DOWNDAY (tick-resolved 3-session excess). Equal weight. Sleeve changes = a NEW book version + registration.
- **Confirmatory lane:** ONLY events logged after 2026-08-05 (`prospective` block of op=alphabook). Success (ALL): ≥120 pooled resolved events; pooled beat-rate Wilson 90% LB > 0.50; pooled mean-alpha t ≥ 2; each sleeve's mean alpha positive. ONE evaluation, no earlier than 2027-02-01. Holdout `composite-book-prospective`.
- The pre-boundary retrospective read (live-logged 2026-06..08 rows) is motivating context: PIT by construction, but it predates registration and includes the period in which the sleeves were selected — it can never confirm.
- Costs at evaluation: exec-engine small AND micro capital tiers (the capacity-asymmetry read).

## §3 vrp-overlay-synthetic — fixed design

One pass of `research/71-vrp-overlay.js`: synthetic SPY put-write on a 21-session entry grid, 30d ATM, Black-Scholes with σ = VIX at entry, r = 4%, hold to expiry, cash-secured. Variants: ungated / macro-risk-off-gated (skip entries when the macro layer reads risk-off) / IV>RV-gated (enter only when VIX > 1.1 × trailing-21-session realized vol). Report monthly P&L, annualized Sharpe, max drawdown, worst month vs SPY buy-and-hold. Frozen lead criterion: a gated variant beats SPY's Sharpe AND worst month > −25% of collateral. Recorded biases: no smile (conservative on premium), no gap-risk realism, fixed-cost haircut scenario. Window spent on completion; any confirmatory claim needs real option marks (gexarchive as it matures).

## §4 Prohibitions

No sleeve re-selection or weight fitting (book); no strike/tenor/moneyness search (VRP); no reading the book's prospective lane as evidence before its condition holds (the retrospective block may be read freely — it is context, not evidence). Any deviation is a NEW hypothesis.
