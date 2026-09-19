# Preregistration — External-event family (2026-09-19)

**Registered:** 2026-09-19, BEFORE any event was pulled or any outcome computed. The seal is the commit that adds this file. **Family id:** `external-events-2026-09` (four hypotheses, ONE exploratory pass each, FDR across every cell attempted). **Mode:** exploratory — the ceiling for any result here is `provisional`; nothing here can promote a live weight.

## §0 Why these four

Every prior pass tested price/volume structure, PEAD/SUE, congress, analyst revision breadth, COT, short interest, VCP/FVG/chart patterns, news composites, index events, dilution supply, and insider clusters — all not confirmed or at best provisional. The four hypotheses below are the documented event anomalies the program has **never** touched and for which multi-year, multi-regime, point-in-time data is reachable today without a new vendor:

| id | event | source | literature prior |
|---|---|---|---|
| `activist-13d-initial` | initial Schedule 13D (activist ≥5% stake; NOT amendments) | SEC EDGAR full-text search (`efts.sec.gov`), form `SC 13D` | Brav-Jiang-Partnoy-Thomas 2008: +5-7% abnormal around filing, drift after |
| `buyback-authorization-8k` | 8-K announcing a share-repurchase program | EDGAR full-text search, form `8-K`, phrase match | Ikenberry-Lakonishok-Vermaelen 1995: long-run drift after open-market repurchase announcements |
| `dividend-initiation` | first cash dividend after ≥3 years without one | FMP `dividends` history already cached in `research/data/corpactions/` (4,217 names, declaration dates) | Michaely-Thaler-Womack 1995: initiations drift positive for a year |
| `analyst-upgrade-cluster` | ≥2 distinct brokers upgrade the same name within 3 sessions | FMP `grades` per symbol (history to 2012) | Womack 1996 / Jegadeesh et al. 2004: upgrades carry short drift; clustering = stronger consensus shift |

None of these is a subgroup of an earlier study; each is a NEW hypothesis family entry in `lib/research/hypothesis-registry.js`.

## §1 Shared frozen design (identical for all four)

- **Prices:** the research cache `research/data/cache/*.json` (FMP EOD, ~10,146 symbols incl. delisted names whose bars end; 2021-06 → 2026-06/07). Loaded through `research/lib/experiment-kit.loadUniverse({ minAdv: 2e6, maxNames: 12000 })`. Kit honesty limits apply: `survivorshipProvenSafe = false`.
- **Decision date:** the last cached SPY session **≤ the event's calendar date** (a filing/declaration dated on a session is decided that session; weekend/holiday events roll back to the prior session so the entry is the next open after the information exists). EDGAR dates filings accepted after 5:30 pm ET on the next business day, so `file_date` is never earlier than public availability.
- **Entry / exit:** NEXT-session open → close at +H sessions, H ∈ {5, 21, 63} (`experiment-kit.forwardFromNextOpen`; extreme |1-day| > 50% moves excluded and counted).
- **Eligibility at decision:** ≥60 prior bars, close ≥ $2, as-of 60-bar ADV ≥ $2M. Ineligible events are counted, not silently dropped.
- **Cooldown:** one event per name per 63 sessions (keep the first).
- **Cost:** ONE tiered round trip from the app's own cost model (`experiment-kit.costFractions` on as-of ADV: liquid 16 bps / small 60 bps / micro 150 bps) charged to the event leg. Doubled cost reported.
- **Outcome per event:** `NETX_H = (event next-open→+H close − base round-trip) − SPY next-open→+H close`, in percent.
- **Cell statistic:** equal-weight per-decision-date mean of NETX_H → `experiment-kit.summarizeByDate` (HAC Newey-West SE with lags = H, effective N, 4-block stability, seeded moving-block bootstrap); p from `pValueOf`.
- **Placebo:** the same events shifted −126 sessions (same names, no event) at the same H, reported for every primary cell. A "signal" that survives its own placebo is a name effect, not an event effect.
- **Sealed split by decision date:** DEVELOPMENT = 2021-08-02 … 2024-12-31. HOLDOUT = 2025-01-02 … 2026-03-31 (the last date that still has 63 observable sessions in the cache). Holdout cells are computed by the same code in the same run but are **read once**; the script prints the development table first and the verdict rule below is mechanical, so no reading of the holdout can change any parameter.
- **Family FDR:** Benjamini-Hochberg at q ≤ 0.10 across **all 21 development cells** listed in §2 (`experiment-kit.fdr`). Placebo cells and descriptive cohorts are not tested and cannot become claims.

## §2 Cells (21 development cells, each with a paired sealed holdout cell)

| hypothesis | variants | horizons | primary cell |
|---|---|---|---|
| `activist-13d-initial` | A = all initial SC 13D on cached names; B = subject in small/micro as-of tier (ADV < $20M) | 5/21/63 | A @ 21 |
| `buyback-authorization-8k` | A = every 8-K whose text matches `"share repurchase program" OR "stock repurchase program"`; B = A restricted to filings whose items include 8.01 and exclude 2.02 (stand-alone announcement, not an earnings release) | 5/21/63 | B @ 21 |
| `dividend-initiation` | single variant: declaration of a cash dividend > 0 with no dividend in the prior 1,095 calendar days (or no prior dividend at all); declarationDate must exist and be ≤ ex-date | 5/21/63 | @ 63 |
| `analyst-upgrade-cluster` | A = ≥2 distinct `gradingCompany` with `action = upgrade` within 3 sessions (event date = the 2nd upgrade); B = ≥3 within 3 sessions | 5/21/63 | A @ 5 |

Event identity: EDGAR hits are de-duplicated by accession number (`adsh`); the subject/filer is `display_names[0]`, ticker parsed from its `(TICKER)` token; hits without a ticker or without a cached series are counted as attrition. Form must be exactly `SC 13D` (amendments `SC 13D/A` excluded — they are follow-ups, not the activist's initial disclosure). Buyback text hits are collected month by month via the efts date filter (≤10 requests/s, declared UA).

## §3 Verdict rule (mechanical, fixed before data)

A hypothesis is **`provisional`** only if its PRIMARY cell (a) survives the development FDR (q ≤ 0.10, mean > 0, ≥ 3 of 4 blocks positive) AND (b) on the sealed holdout, ALL of: HAC t ≥ 2.0 with mean > 0; ≥ 50 events on ≥ 20 distinct decision dates; per-event median > 0; the top 1% of events contribute < 50% of the mean (`trimmedTop1Mean / mean > 0.5`); doubled-cost mean > 0; placebo at the same cell is not significant in the same direction (t < 2). Anything else is **`no-edge`** for that hypothesis, and an `inconclusive` label is used only if the primary cell has < 50 development events (data wall), per `test/inconclusive-not-no-edge.test.js` semantics.

Non-primary cells that survive FDR are recorded as observations; they cannot be promoted to a claim by this pass. A follow-up would need a new preregistration on **future** events.

## §4 Prohibitions

No horizon, window, threshold, phrase, cooldown or split change after the first pull. No sector/size/regime subgroup becomes a claim. No re-run under the same id (the registry versions re-runs as `.r2`). If a source proves too shallow (< 50 development events for a primary cell), the hypothesis is marked `inconclusive` with the count, never patched with a different source in the same pass.

## §5 Even a pass is not promotion

A `provisional` result here yields weight-0 shadow-ledger eligibility only (prospective events, next-open entry, graded on the Scoreboard like `InsiderCluster`); the survivorship contract, cost verification and the governance ladder still apply.

## §6 Analysis code

`research/99-external-events-pull.js` (resumable pulls to `research/data/external-events/`, no outcomes) and `research/100-external-events-study.js` (the one pass; registers `external-events-2026-09` cells in `research/experiments/registry.json` and writes `research/data/evidence/external-events/`).
