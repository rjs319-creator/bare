# Preregistration — Insider Cluster Buys, Matched-Residual (2026-09)

**Registered:** 2026-09-09 · **Hypothesis id:** `insider-cluster-residual` (family `alt-signals`) · **Mode:** exploratory, ONE pass.
**Status at registration:** OPEN — the SEC Form 345 bulk build (`research/97-form345-build.js`) is running; no cluster event on this universe has been constructed or inspected. The seal is this document's commit hash.

## §0 What is already known (declared so it cannot be mistaken for a fresh prior)

`insider-cluster-drawdown` (registered 2026-08-05, evaluated the same day, status `no-edge`) tested cluster buys **conditioned on a ≥30% drawdown** on ~184 present-day small/micro names via per-ticker EDGAR crawling: 63 primary events, 63-session SPY-excess +10.3% but t 1.23, 21-session mean negative. Its comparison cohorts (unconditional clusters n=26 negative; single buyers n=235 21s +2.2% t 1.96) are known to the author. That window is spent *for that hypothesis*. This registration is a **different hypothesis** (no drawdown condition, matched-control residual instead of SPY-excess, cost-net, next-open entry) on a **different dataset** (SEC bulk Form 345, ~10,000 price-cached names with the v3 security master's delistings, ≈40× the prior universe). The ~130 prior events are a subset of this sample; the result is reported with and without them.

## §1 Hypothesis and mechanism

Open-market cluster purchases by ≥2 distinct insiders in small/micro-cap names carry positive **21-session cost-net forward return in excess of matched non-event controls** (same decision date, same liquidity tier, same 6-1 momentum quintile). Mechanism: independent insiders committing capital is an information-bearing, costly signal; matching removes the two explanations that made the earlier IN-pillar signal "real but redundant" — momentum co-movement and size/liquidity exposure.

## §2 Fixed design (frozen before the build finished; the registry entry and `research/98-insider-cluster-residual.js` FROZEN constants are the authority)

- **Data:** SEC "Insider Transactions Data Sets" quarterly bulk files 2021q2 → 2026q2, NONDERIV_TRANS code `P`, acquired `A`, Form 4 (amendments flagged), shares > 0, price > 0. Ticker = issuer trading symbol (CIK-resolved when blank).
- **Cluster event:** the FROZEN `clusterEvents` of study 69, unchanged: ≥2 distinct owners, transaction dates within 14 calendar days, combined value ≥ $50,000; **event date = LATEST FILING date** of the cluster's members (PIT: the cluster is knowable only when its last member files).
- **Exclusions from the primary cohort (each reported as its own descriptive cohort, never a gate):** any member filed under a 10b5-1 plan (`AFF10B5ONE`); decision bar liquidity tier `liquid` (as-of 60-session ADV ≥ $20M); as-of ADV < $0.5M; decision close < $1; < 126 bars of history at decision (momentum unknowable); per-name cooldown 21 sessions between events.
- **Universe / control pool:** every name in the research price cache (`research/data/cache`, ≈10k symbols, 2021-06 → 2026-06, delistings retained) — event names ∪ a seeded random 3,000-name pool (seed 20260909) as control candidates.
- **Decision date:** the last cache bar on or before the filing date (filing date itself when it is a session). **Entry:** next session OPEN. **Exit:** close at entry + H − 1 sessions (`experiment-kit.forwardFromNextOpen`, extreme-move guard 50%/day). **Window:** decision dates 2022-01-03 → 2026-03-20.
- **Costs:** one tiered round trip from the app's cost model (`experiment-kit.costFractions` on as-of ADV), subtracted from event AND control legs.
- **Control (the residual):** for each event, up to 20 seeded-random names from the pool that have a bar on the decision date, the same as-of ADV tier, the same 6-1 momentum quintile (close[i−5]/close[i−126] − 1; quintile edges from that day's tier-eligible pool), close ≥ $1, and no cluster event of their own within ±21 sessions. Outcome = event cost-net return − mean control cost-net return. Fewer than 5 controls ⇒ SPY-excess fallback, counted and flagged; the primary is ALSO reported on matched-only events.
- **Horizons:** 5 / 21 / 63 sessions. **Primary cell:** `RES_21`. `RES_5`, `RES_63` secondary.
- **Inference:** one equal-weight observation per decision date (`experiment-kit.summarizeByDate` → lib/evidence-stats: Newey-West HAC, effective N, seeded block bootstrap, 4 chronological blocks). Benjamini-Hochberg across the 3 cells at q ≤ 0.10.
- **Placebo:** the same events with the decision index shifted −126 sessions, matched identically; must not show a residual of comparable size (|placebo mean| < ½ |event mean| and its CI spans zero).
- **Comparison cohorts (descriptive only):** single-buyer events (≥ $25k, not inside any cluster window — study 69's frozen definition), 10b5-1 clusters, liquid-tier clusters, officer/director-only clusters, ≥3-owner clusters, ≥ $250k clusters, drawdown (≤ 0.70 × trailing-252 max) vs not, by ADV tier, by year, with vs without the 2026-08 universe names.
- **Verdict (frozen):** `insufficient-data` if primary events < 200 or distinct decision dates < 60 — no claim either way. `research-promising` iff RES_21 mean > 0 AND BH q ≤ 0.10 AND ≥ 3/4 chronological blocks positive AND the placebo condition holds. Otherwise `not-confirmed`. A promising verdict earns only a **shadow prospective ledger** (registry `shadow`, weight 0); promotion follows the standard contract (≥50 episodes / ≥20 dates / CI clear / fill verification) on FUTURE filings.

## §2a Data-quality amendment (declared 2026-09-09 after the bulk build's consistency check, BEFORE any event was constructed or any outcome computed)

The bulk build reported 140 of 194,396 buy rows with absurd per-share prices (filers keyed transaction totals into the price field: REEMF, ASTI, GOBI…). Rows with price ≥ $100,000/share or value ≥ $1B are excluded as data errors and counted (`insaneRows`). This is a sanity filter on impossible inputs, not a parameter; it was fixed at these two round numbers without looking at any event or outcome.

## §3 Prohibitions

No threshold tuning (window, owner count, dollar floors, tiers, momentum lookback, control count, cooldown, horizons, shift are frozen above). No subgroup becomes a claim. No added horizons or alternative benchmarks after reading results. One pass; the 2022-2026 window is then spent for this hypothesis; any confirmatory claim requires a NEW preregistration on future filings.

## §4 Analysis code

`research/98-insider-cluster-residual.js` (pure helpers locked by `test/insider-cluster-residual-prereg.test.js`); data from `research/97-form345-build.js` → `research/data/form345-buys/`; result appended to `research/experiments/registry.json` via `experiment-kit.recordExperiment` and the artifact written to `research/data/insider-cluster-residual/`.
