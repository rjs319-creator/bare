# CFR Prospective Shadow Ledger (`forecast-shadow-v1`)

Weight-0 prospective evidence lane for the cross-sectional forecast & ranking system
(PR #405, `docs/FORECAST-RANKING-SYSTEM.md`). It is the "publish a board projection on
the nightly cron" step §17.1 named and deliberately left out of scope — built as a
write-once ledger with a frozen, prespecified gate rather than a display feature.

## What question it answers

The walk-forward benchmark (`cfr-walkforward-2026-08`, data cutoff **2026-07-06**, FMP
research snapshot, survivorship **not** proven safe) found:

* a small, statistically distinguishable rank IC in the `ridge` residual-return point
  forecast (best: +0.0192 at h=5, 90% CI [0.0057, 0.0308], NW t=2.49; controls ~0);
* **no** after-cost profitable strategy (long-only net Sharpe is beta-dominated; the
  best market-neutral result is ~break-even, roughly 1%/yr short).

This lane accrues **live, survivorship-free** evidence on whether that signal is real.
Prospective data cannot rescue an edge this small — it can only tell us **sooner and
more honestly** whether it survives. Making the strategy net-positive is a separate
problem (cost levers, new signal families), not this lane's job.

## The two arms — kept apart on purpose

| arm | ordering | evidence status |
|---|---|---|
| `ridge-point` (primary) | `expectedResidualReturn` desc | CONFIRMS the benchmarked `ridge` arm |
| `ridge-xs` (secondary) | served `rankerScore` rank at tier 5 | **none** — never executed in the benchmark; FIRST evidence |

Production has no Python sidecar, so `detectCapabilities` lands on tier 5 and
`runInference`'s served ranking is `ridge-xs` — a second ridge on the meta-feature set
that the benchmark never measured (LightGBM was always available there). Gating the
lane on the served ranking would accumulate evidence about an arm with no historical
lineage, so the primary board is ordered by the ridge point instead, and the served
ordering is recorded alongside as its own separately-declared family. Every shard
records `provenance.orderingField` so no reader has to infer this from a tier label.

## Mechanics

* **Tick** (`op=forecastshadowtick`, nightly chain `forecastshadow`): fetch SPY + 11
  SPDR sector ETFs + `lib/universe.js LARGE` (3y, live Yahoo via
  `lib/screener fetchDailyHistory`) → `makePanel` → `runInference` (research/88 fold
  geometry; trainSessions 500, stride 5) → write-once day shard
  `forecastshadow/v1/prospective/<date>.json` with, per horizon: both rankings,
  **frozen** `betaMarket`/`betaSector`/`betaSectorMarket`/`sectorEtf` per name, the
  carried top-20 book (no-trade band 2.0, cost `0.5·Σ|Δw|·roundTrip`), and full
  provenance (tier, metaBackend, ordering field, provider, config/manifest hashes,
  fetch failures). All four horizons or nothing. Trading days only. ~35–50s measured.
* **Resolve** (`op=forecastshadowresolve`): one matured day per night (≥16 calendar
  days). Outcomes = `targets.forwardWindow` raw leg neutralized by
  `targets.neutralize('residual-mkt-sector-v1')` **with the shard's frozen betas** —
  recomputing betas at resolution time would leak post-decision data into the ledger,
  which is why the resolver has a test pinning `trailingBetas` out of it. Per date and
  horizon it records both arms' Spearman rank ICs plus the descriptive book outcome.
  Maturity is judged on the benchmark's own session axis; fetch failures postpone
  (bounded), and a day unobservable past 40 days closes out recorded.
* **Read** (`op=forecastshadow`, public): frozen spec, ledger progress, running mean
  ICs (labeled explicitly NOT the gate), latest board top-10s.

## The gate (frozen before the first outcome — registry `cfr-prospective-2026-09`)

Per arm family: ≥80 resolved dates per horizon; FDR α=0.1 across the 4 horizons within
the family; CI = widest of Newey-West t and seeded moving-block bootstrap, clear of
zero; ≥3/4 positive blocks. Promotion is a manual reviewed registry change and starts
as an **annotation, never selection**. Power: at ~510 names/date the per-date IC
sampling s.e. is ~0.044, so 80 dates put the mean's s.e. near 0.01 — sized for the
~0.02 effect the benchmark measured.

## Declared limitations

* **Provider split**: the confirming evidence ran on the FMP research snapshot (cutoff
  2026-07-06); this ledger runs on live Yahoo bars. A real data-source change,
  recorded in every shard and in the registry entry.
* **Sector basis** is the current vendor mapping, not point-in-time (same as the
  benchmark).
* The book channel is descriptive only. The benchmark already showed after-cost
  long-only performance is beta-dominated; a P&L gate at this effect size would read
  NOT_CONFIRMED forever and teach nothing (the rank-IC gate is the informative one).

## Serving-mode fix that ships with this lane

`universe.eligibilityAt` demanded the next session's open bar unconditionally — correct
for training/evaluation (labels need an entry fill), impossible at serving time (the
entry bar is tomorrow's), so the latest session admitted zero names and
`op=forecastrank` could never score the current date. `requireEntryBar:false` is now
passed by `dataset.buildDate` exactly when `requireLabel:false`; training keeps the
rule byte-identically.
