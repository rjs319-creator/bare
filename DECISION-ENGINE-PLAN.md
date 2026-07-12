# Unified Decision Engine — Prioritized Plan

> Response to the 12-point review. Method: read the live architecture, then map each ask to
> **what already exists** vs **what is genuinely new**, so we consolidate/validate rather than
> rebuild. Guiding constraint from the app's own research: this is a **momentum/regime dashboard**,
> not an alpha engine — the honest lever is regime avoidance + ranking discipline, not new edges.

---

## What already exists (do NOT rebuild)

| Ask | Already in the codebase |
|-----|--------------------------|
| #3 Independent evidence families | `lib/confluence.js` (`family-v1`): trend vs mean-reversion families, within-family correlation discount (`CORR_DISCOUNT=0.3`). **But scoped to ONE screener's 5 strategies** — not applied across the app's evidence families. |
| #4 Scoreboard | `api/tracker.js`→`lib/apex-routes.js runScoreboard`: per `section:tier` realized 1d/5d/10d/20d/1m/3m returns, win rate, expectancy, **excess vs SPY + sector**, cost-adjusted (`cost-v1`), next-open entry (`entry-v1`), target-first/stop-first + profit factor (strategy efficacy). Persisted O(1) to `scoreboard/summary.json`. |
| #7 Execution realism | Liquidity floor via `factors.dollarVol` (price×avgVol50); short-side liquidity gates in `screener-routes.js`; cost model `lib/costs.js`. **Partial + inconsistent across screeners.** |
| #8 Event awareness | `fundamentals.earningsInDays`; CERN forced-flow event ledger; earnings U-gate. **Not attached uniformly to every signal.** |
| #9 AI restriction | "both, gated" pattern already: mechanical first, LLM annotates, A/B-tracked, Wilson-gated promotion; output validated (parse/clamp/allowlist). **Well-established.** |
| #10 Today command center | `opportunities.js` (`loadOpportunities`) already ranks breakout pool + 5 AI screeners, reads Scoreboard for reliability, tilts by model health. **~70% of a "Today" view — but only 2 source families, no horizon split, no lifecycle.** |
| #11 Engineering reliability | 4 shipped hardening batches (`ARCHITECTURE-IMPROVEMENT-PLAN.md`): schema guards, cron resilience, fetch timeouts, cache-bust, `signalVersion` stamps. Frontend slice (H11/H12) + Apex unify (H13) still pending. |

## What is genuinely new (the real work)

The review's center of gravity is **#1 Unified Decision Engine**, which subsumes #2 (horizons),
#3 (cross-app evidence families), #6 (lifecycle), #7 (execution realism), #10 (Today), #11 (canonical
schema), #12 (consolidation). None of these exist as a single spanning layer today — every screener
has its own pick shape and its own list. That fragmentation is the #1 product problem.

---

## Priority ordering (value ÷ risk)

### P0 — Canonical Signal schema + unified ranker (the backbone)  ← *start here*
A pure, tested `lib/decision.js`:
- **Canonical `Signal`** every screener normalizes into: `{id, ticker, horizon, setup, detectedAt,
  ageBars, entry, stop, target, rr, regimeFit, sectorStrength, catalyst, liquidity, expectancy,
  sampleSize, confidence, state, evidenceFamilies[], screenerCount, source, scoringVersion}`.
- **Cross-app evidence-family taxonomy** (the 9 families in #3): priceTrend, volumeAccum,
  fundamentalsRevisions, insider, catalystForcedFlow, sentimentAttention, optionsPositioning,
  sectorRegime, crossAsset. Independent-family count ≠ screener count (reuses the `confluence.js`
  correlation-discount idea, generalized).
- **Lifecycle state machine** (#6): `detected→early→ready→triggered→extended→failed/expired/resolved`,
  driven by first-detection price/time + current price vs entry/stop/target + signal age.
- **Execution-realism penalty** (#7): dollar-volume, spread proxy, slippage, halt/event-gap risk →
  a multiplier that keeps untradeable theoretical setups from out-ranking liquid ones.
- **Composite rank** (#1): `expectancy × confidence × regimeFit × execution × independentEvidence`
  — NOT a sum of screener scores. Expectancy comes from the live `scoreboard/summary.json`.

Pure functions, no network → fully unit-testable, zero risk to the running app.

### P1 — `op=today` route + source adapters (#1, #2, #12)
`lib/decision-normalizers.js` (per-source `toSignal()` adapters) + `lib/decision-routes.js`
(`op=today`) folded into an existing `api/*.js` (no new function — respects the 12-fn cap).
Ingest the already-flowing high-value sources first: breakout/Opportunities pool, Gap & Go,
Day Trade, Coil, Ghost, the 5 AI screeners. Bucket by horizon.

### P2 — "Today" command center tab (#10)
One consistent stock-card; horizon-bucketed top-3; new/upgraded/downgraded/failed/expired lanes;
regime + leading/weakening sectors header; upcoming risk events; data-freshness/health banner.
Move explanations into expandable sections. Reuses `oppCardInner` card design.

### P3 — Scoreboard validation upgrade (#4, #5)
Add to the existing Scoreboard: median, profit factor, CI, max drawdown, MFE/MAE, slippage-adjusted,
by-regime/horizon/liquidity/cap/**score-decile**, distribution + outlier-trimmed. Then **ranking-
quality validation** (#5): decile monotonicity, calibration curve, Brier, information coefficient,
top-5 precision, lift-over-baseline; auto-demote features with no incremental value after controlling
for momentum/regime/sector/liquidity (the `predict-routes.js` self-tuning loop already scaffolds this).

### P4 — Consolidation + engineering slice (#11, #12)
Merge overlapping tabs into the 7 review buckets behind the unified table; finish the pending
frontend hardening slice (central fetch client, error≠empty states); fix any visible raw-template
render bug; unify the Apex server↔client scorer (H13).

---

## Sequencing note
P0 is unambiguously correct and low-risk regardless of downstream choices, so it starts now.
Everything after P0 has a real fork (how broad to ingest, ship UI + deploy this session or validate
backend first) — confirmed with the user before building each slice.
</content>
</invoke>
