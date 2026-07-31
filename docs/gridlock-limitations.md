# GRIDLOCK — Limitations, Assumptions & Failure Modes

Read this before trusting anything on the GRIDLOCK tab. Every item here is deliberate disclosure, not an apology.

## Data limitations

- **PJM/EIA feeds are keyed and optional.** Without `PJM_API_KEY`/`EIA_API_KEY` the region state is mostly `missing`, `dataQuality: 'poor'`, and the action gate blocks on `DATA_INSUFFICIENT`. The module does not pretend to see the grid it cannot see.
- **No LMP/congestion feed yet** → the congestion and spark-spread components usually report missing; the CPS renormalizes and says so.
- **No gas-price feed yet** → fuel component missing (the scenario engine uses a user-editable gas assumption instead).
- **Installed capacity is an assumption** (180 GW PJM planning figure, labeled `assumed`) — the instantaneous reserve-margin proxy is exactly that, a proxy, and is NOT the ISO's planning reserve margin.
- **News ingestion is headline-deep** (NewsAPI descriptions), one query/day, English only. Events not covered by that query, or disclosed only in filings, are invisible until an EDGAR enrichment slice lands.
- **NWS alert count is a crude weather proxy** — it measures alert issuance, not degree-days or load forecasts.

## Model assumptions (all versioned, all disclosed in-code)

- CPS weights and seasonal anchors are **priors chosen by hand**, not fitted — `gridlock-cps-v1` is a hypothesis.
- Opportunity-score weights and every penalty magnitude are priors — `gridlock-score-v1`.
- The causal ROLE×CONSTRAINT matrix encodes textbook power-market mechanisms; real-world exceptions (hedged merchants, contracted fleets, regulatory interventions) will violate it. The `MIXED_EFFECT`/`TOO_INDIRECT` defaults are the safety net.
- The scenario engine is back-of-envelope reserve-margin arithmetic with a linear scarcity multiplier — NOT a production-cost model, NOT a price forecast (stated on every output).
- `expectedMovePct` inside the not-yet-repriced score (how much a direct/high-materiality link "should" move) is a disclosed heuristic.
- Exposure strengths/materialities in the graph are hand-estimated ordinal judgments with citations, not measured revenue shares.

## Known failure modes

- **Canonical dedup can under- or over-merge**: two different projects with similar normalized names in one region would merge (evidence conflicts would flag it); one project renamed across articles may split. `fieldConflicts` and hand review of the ledger are the mitigations.
- **The exposure graph is small (~20 relationships) and PJM-slanted.** Coverage honesty: most of the market is invisible to it BY DESIGN until rows are added with evidence. It is not, and must not become, a thematic ticker basket.
- **Seed-event dates**: curated seeds carry the documented announcement dates; `datePrecision` marks any month-level uncertainty. Seeds are stale by construction and can never generate actionable candidates.
- **LLM extraction can miss** (regex classification is conservative; grounding drops uncertain values) — the bias is toward missing events rather than inventing them. That is the chosen side of the error.
- **Blob read-modify-write**: the events/state docs are single-writer (nightly cron) with cache-busted reads; a concurrent manual tick could still race a cron tick. Don't run manual ticks during the warm window.
- **60s function wall**: heavy days budget-skip work (bounded fan-outs, resolve cap 40); the cumulative ledger self-heals next run.
- **Regime gate uses the app's macro read** (`lib/macro.js`); if VIX/HYG/LQD feeds fail, regime is null and the gate does not block on it (disclosed in the candidate's gate reason chain).

## What GRIDLOCK does NOT do

- Does not place, size, boost or suppress any live trade (weight 0, `portfolioEligible: false`, registry `maturity: 'shadow'`, isolation asserted by test).
- Does not output win probabilities or claimed win rates — nothing is calibrated.
- Does not backtest itself into credibility — no historical performance is claimed anywhere; the ledger accrues forward only.
- Does not recommend shorts (relative-value comparisons are research framing with an explicit no-short note).
- Does not let an LLM compute materiality, scores, probabilities, scenarios, regions, or company links.

## Auditing a candidate's complete evidence trail

1. `op=gridlock` → find the candidate; note `eventId`, `score.components`, `score.penalties`, `gate`.
2. Event: `gridlock/events.json` → the canonical record → `sourceEvidence[]` (publisher, url/stableRef, retrievedAt, hash), `fieldConflicts`, `unresolvedFields`, `lifecycleHistory`.
3. Exposure: `lib/gridlock-exposure.js` → the row's `evidence` citation, `verifiedOrInferred`, `validFrom`.
4. Classification: `causalChain` on the candidate (mechanism, confirming/invalidating evidence) — reproducible via `classifyExposure` in `lib/gridlock-causal.js`.
5. Region: the snapshot's `region.state.sourceManifest` + `staleFields` show exactly which feeds contributed.
6. Outcome: `gridlock/day/<date>.json` (PIT row + feature snapshot) → `gridlock/resolved.json` (entry basis, per-horizon returns, MFE/MAE) → Scoreboard section Gridlock.
7. Run-level: the `gridlock` immutable-ledger stream records each tick's counts hash-chained.
