# External-event family — result (2026-09-19)

**Preregistration:** `research/PREREGISTRATION-EXTERNAL-EVENTS-2026-09.md` (sealed b43f45a, before any pull).
**Runner:** `research/100-external-events-study.js` · pulls `research/99-external-events-pull.js` · artifacts `research/data/evidence/external-events/` (gitignored) · registry rows `research/experiments/registry.json` ids `*-2026-09` (r1) and `*-2026-09.r2` (the corrected re-run, append-only).

## Verdict: all four NO-EDGE as long signals. One robust NEGATIVE observation (buybacks).

| hypothesis | primary cell | development (2021-08→2024-12) | sealed holdout (2025-01→2026-03), read once | status |
|---|---|---|---|---|
| activist-13d-initial | A @ 21s | n 324 / 252 dates, **−1.21%** t −1.12, q 0.39, 1/4 blocks | n 173, −3.41% t −2.14 | no-edge |
| buyback-authorization-8k | B @ 21s | n 564 / 386 dates, **−1.61%** t −2.88, **q 0.047 (survives FDR, wrong sign)**, 0/4 blocks | n 225, **−2.31%** t −2.08; doubled cost −2.75%; placebo −0.41% t −0.32 | no-edge (long) |
| dividend-initiation | A @ 63s | n 83 / 74 dates, −2.15% t −1.00, q 0.43 | n 20, −0.32% t −0.06 | no-edge (thin) |
| analyst-upgrade-cluster | A @ 5s | n 260 / 215 dates, −0.27% t −0.58, q 0.61 | n 128, −0.57% t −0.70 | no-edge |

All numbers are per-decision-date equal-weight means of next-open → +H close return, net of one tiered round trip (app cost model), in excess of SPY, with HAC (Newey-West, lags = H) t-stats; FDR is Benjamini-Hochberg across all 21 development cells.

## What the data said, hypothesis by hypothesis

**Initial Schedule 13D.** 26,587 full-text hits over 57 months; 20,800 amendments excluded; 5,787 initial filings; 3,560 with a ticker; 509 scored on the $2M-ADV cached universe (activist targets are mostly smaller/illiquid than the floor). Every horizon is negative in development and in the holdout. The 63-session cell is strongly negative in both windows (dev −5.22% t −3.16 q 0.038; holdout −6.63% t −3.12) **but the same-name placebo 126 sessions earlier is also negative (t −2.3 / −3.0)**: activists target chronic underperformers, so most of the loss is a name effect. Not a buy signal, and not a clean avoid signal either.

**Buyback authorization 8-K.** 16,376 text hits; 12,776 plain 8-Ks with a ticker; 4,994 scored. Variant A (every matching 8-K, most of them earnings releases) is mildly negative everywhere. Variant B (stand-alone item 8.01 filings without an item 2.02 earnings release — the actual announcement) is **consistently negative**: development −1.61%/21s with 0 of 4 chronological blocks positive, and the untouched holdout repeats it at −2.31% t −2.08 with the doubled-cost mean still negative and the placebo flat (t −0.32). By tier the liquid names carry it (dev −1.27% t −2.12, holdout −2.84% t −2.41). This is an **observation**, not a claim: the preregistered direction was positive, so under §3 the hypothesis is no-edge. As an AVOID overlay it has exactly the profile the program has accepted before (extended-gap-avoid, dilution-events): event-specific, both windows, placebo-clean. A follow-up must be a NEW preregistration on future filings with negative-lane semantics.

**Dividend initiation.** 1,540 initiations exist in the 4,217-name dividend cache, but 1,013 were declared before the price cache begins (2021-07) and 982 rows lack a usable declaration date, leaving 108 events (86 development / 22 holdout). Nothing is significant; the holdout is too thin to read. The binding constraint is declaration-date coverage of the cached dividend history, not the mechanism.

**Analyst upgrade cluster.** 3,378 grade histories (9,656 upgrade rows) → 561 cluster sessions → 388 scored. No horizon is positive in development (5s −0.27%, 21s −0.92%, 63s −1.99%); the holdout 5-session primary is −0.57%. ≥3-broker clusters are rare (15 development events). FMP broker names are not canonical ("B. Riley" / "B. Riley FBR"), which can only inflate cluster counts.

## Two implementation defects found on r1 and fixed on r2 (both recorded)

1. **EDGAR renamed the form.** From December 2024 initial 13Ds file as `SCHEDULE 13D` (structured XML); the legacy `SC 13D` query returns zero hits after that, so r1 had **no holdout events at all**. r2 pulls both labels (`INITIAL_13D_FORMS`, pinned by `test/external-events-prereg.test.js`). Development cells moved only marginally (the rename overlaps the last two weeks of development).
2. **Upgrade-cluster collapse.** r1 emitted one candidate row per upgrade and let the 63-session cooldown keep the first (2-broker) row, so variant B (≥3 brokers) was structurally empty. r2 keeps one event per (name, session) with the largest distinct-broker count. Variant A is unchanged.

Neither fix touched a frozen parameter; both are documented in the registry rows and the r1 rows stay in the ledger.

## Data walls hit

- The kit universe's $2M as-of ADV floor removes most 13D subjects (2,554 of 3,560) — activist targets live below it. A micro-universe test would need the app's micro cost tier (150 bps) and the survivorship contract.
- FMP `price-target-news` is capped at 100 rows per symbol (~1 year), so price-target-consensus jumps could not be tested with depth. `grades` is deep (to 2012).
- Dividend declaration dates: 64% of initiations fall outside the price cache or lack a declaration date.

## What a weight-0 shadow ledger would need, IF a follow-up passes

Nothing here passed. For completeness, the buyback observation would be tested prospectively as an AVOID lane: nightly EDGAR full-text query (both phrases, form 8-K, items 8.01 without 2.02) for the previous session, ticker parsed from the display name, joined to the app's universe, logged next-open with the `small` cost tier, graded on the Scoreboard under negative-lane semantics (CI95 high < 0 at 21s), ≥50 events on ≥20 dates before any read — a new preregistration, not this one.
