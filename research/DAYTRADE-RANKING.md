# Day Trade screener — more picks, relative scoring, best-of (evidence)

Goal: surface more picks, rank/score them relatively, highlight the day's best.

## Backtest of the ranker (PIT ~2y, before building the highlight)

Applying the coil lesson (never trust an unvalidated ranker), I backtested whether the
scan's `rankScore` (or its components) predicts forward return **among the names that pass
the scan**.

**`momentum_liquid` (large-cap movers) — the ranker WORKS (weakly, positively):**
- The scan itself has a positive tilt: picks average **+1.51% over 3 sessions** (next-day
  close +0.47%).
- `rankScore` is weakly positive-predictive: OOS Spearman **+0.08**, top-quintile 3-day
  **+4.4%** vs bottom **+2.2%** (spread +2.25%), consistent across 1/3-day horizons.
- Drivers: `pctChange` (topQ +6.5% vs botQ +0.9%) and `relVol`. The intraday (next-day
  open→close) edge is ~zero — the edge is a few-day continuation, not same-session.

**`explosive_small` (small-cap movers) — the ranker is INVERTED:**
- Base 3-day +1.98% but **next-day open→close −0.99%** (they mean-revert intraday).
- Ranking by strength is inverted: `pctChange` Spearman **−0.10**, `gapPct` −0.12,
  `excessPct` −0.10. The MORE explosive → the WORSE the forward return (blow-off / fade).

## What shipped

- **More picks:** relaxed **B-tier** (`SCANS.momentum_building`: RVOL≥1.2, ≥+3%, same
  liquidity) surfaced in the same scan pass and tagged `tier:'B'`; display caps raised
  (Momentum&Liquid 20→40, Explosive 20→30, Runs 20→30). B-tier is display-only — the
  tracked ledger still logs strict A-tier only (history stays comparable).
- **Relative score:** every pick gets `relScore` 0–100 = percentile of a z-blend of
  relVol + pctChange + excess-vs-SPY across the day's picks. Descriptive strength, not a
  predicted return.
- **Best Opportunities:** a ranked `bestOpportunities` list drawn **only** from the
  positive-edge scans (Momentum&Liquid A-tier + multi-day runs), green-today only.
  Explosive small-caps are **excluded** because their ranking backtested inverted.

Honest framing is in the UI (relScore is descriptive; best-of is from the validated scans;
explosive small-caps fade next day). Tests: `test/daytrade-rank.test.js` (6), suite 220 pass.
