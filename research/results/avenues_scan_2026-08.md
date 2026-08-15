# Avenue scan — 2026-08-15

Three preregistered experiment families run in one pass, testing the "where could alpha
still come from" avenues that are measurable with data on hand. Frozen configs were
declared before outcomes were computed; every family is recorded in
`research/experiments/registry.json`; artifacts live in `research/data/{negative-overlay,
index-events,dilution-events}/`. Scripts: `research/93..95`.

**Headline: one avenue is genuinely promising — 424B5 dilution filings as an AVOID flag.
The other two are cleanly dead.**

## 1. Negative-signal overlays & short inversion — ❌ DEAD (`research/93`)

Question: do the app's reliably-negative findings pay as *subtraction* (exclusion filters
on a top-10 event book) or *inversion* (shorting the forced book)?
Data: catalyst-flow dataset, 1,061 decision dates, 23,869 rows (EXPLORATORY PIT class).
Base book (forced top-10 transparent PEAD): **−59.8 bps/cohort, p≈0** — replicates the
arms study's forced-negative finding on the full sample.

| Test | Result | Read |
|---|---|---|
| Exclude DTC≥7 / gap≥10% / momentum-chase, slots refilled | +0.5 to −0.9 bps, p>0.7 | Replacement names from the same pool are just as bad |
| Same filters, excluded slots → cash | +6 to +15 bps, p as low as 0.002 | **Confounded** — see placebo |
| Placebo: random exclusion of the same count (20 seeded draws) | filter − placebo = **−0.4 to +1.2 bps, p>0.84** | The "improvement" is pure exposure reduction; the filters carry **zero** slot-selection information |
| Within-book flagged−unflagged contrast | null / wrong-signed (p>0.63) | Same conclusion |
| Short the forced top-10 (sector-hedged, borrow 2%/yr) | **−19.3 bps**, p=0.17; worse unwinsorised (−31) and at 8% borrow (−30.8) | The ~60 bps negative drift is real but smaller than 2× round-trip friction + hedge + borrow; squeezes eat the tail |

Verdict: **NO_IMPROVEMENT on all four primaries.** The negative signal's only value is
the one already in production: hold cash instead of the book. It cannot be inverted or
used to pick which slots to cut.

## 2. S&P 500 index forced-flow events — ❌ NO EDGE (`research/94`)

Question: do deletions rebound (and additions drift) after forced index flow clears?
Source: Wikipedia S&P changes table (which **moved to `Historical components of the
S&P 500` on 2026-08-11** — side finding below). Post-effective-date windows only, next-open
entry, net SPY-excess, M&A deletions excluded (27), 2021-08 → 2026-06.

| Cell | n | net bps/event | p |
|---|---:|---:|---:|
| Deletion +5d | 31 | +11.7 | 0.95 |
| Deletion +21d | 26 | −169.2 | 0.43 |
| Deletion +63d | 26 | −216.1 | 0.58 |
| Addition +5d | 34 | +107.3 | 0.19 |
| Addition +21d | 33 | −80.5 | 0.66 |
| Addition +63d | 33 | +29.0 | 0.96 |

Deleted names keep drifting **down**, not rebounding — and this sample is
survivor-tilted optimistic (55 event tickers had no cached series, disproportionately the
collapsed ones). Nothing approaches significance; several cells sit at/below the 30-event
floor. Verdict: **NO_EDGE / borderline INSUFFICIENT_DATA.** Not worth more capital of any
kind at this sample size; the announcement→effective window (uncapturable with EOD data)
is where any residual effect lives.

**Side finding, fixed on this branch:** `lib/constituents.js` still scraped the old
Wikipedia page, so since 2026-08-11 the app's survivorship correction silently returned
**zero removals** (best-effort masking). URL repointed; parser unchanged; 59 removals
parse from the new page.

## 3. 424B5 dilution/offering events — ✅ RESEARCH-PROMISING AVOID FLAG (`research/95`)

Question: do prospectus supplements (follow-ons, ATMs, shelf takedowns) predict negative
forward excess? The one event source here with a **genuinely immutable PIT clock**
(EDGAR filing dates). 13,820 filings fetched (2021-08 → 2026-06) → 1,722 eligible events
(ticker resolved, in bars cache, ADV ≥ $5M, ATM re-filings deduped at 30 sessions).

| Cell | events / dates | net bps | p | BH q | gross bps | vs placebo* | median (gross) | share < 0 | drop-10-worst |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| +5d | 1,693 / 814 | −129.5 | 5e-05 | **0.0002** | −97.2 (p=.002) | −90.5 (p=.049) | −67.2 | 55.9% | −71.1 |
| +21d | 1,656 / 797 | −166.1 | .029 | **0.029** | −133.7 (p=.079) | −253.2 (p=.021) | −203.4 | 58.7% | −90.5 |
| +63d | 1,544 / 759 | −293.4 | .026 | **0.029** | −261.1 (p=.048) | −423.0 (p=.068) | −456.1 | 60.8% | −206.4 |

\* event window minus the same ticker's window 126 sessions earlier — the effect is
**event-anchored**, not "these tickers always drift down" (pre-filing windows actually
drift up: issuers sell after run-ups, which is itself part of the signal).

Robustness: chronological blocks 4/4 negative at 5d (3/4 at 21/63d); medians more negative
than means (not carried by a few collapses); survives dropping the 10 worst events; all
three cells survive BH.

**What it is and is not.** It is an AVOID characteristic: a name that filed a 424B5 in the
last ~1–3 months underperforms SPY by ≈1% in the first week and ≈2–4.5% (median) over the
quarter. It is **not** demonstrated long alpha, and the short side is untested against
borrow reality (these names skew hard-to-borrow). Caveats: form-level classification
(mixed with selling-holder secondaries and debt takedowns — dilutes toward zero, so the
true equity-offering effect is plausibly stronger); SPY-relative, not sector-relative;
2021–2026 window only.

**Recommended next step (not done — needs a decision):** wire a shadow `recent-424B5`
AVOID flag into candidate surfaces (EDGAR daily index poll is free and PIT), accrue the
standard 50-date prospective ledger, and only then consider letting it gate anything.

## Avenues NOT experimentable in this pass

- **Execution-leak repair** — engineering, not an experiment; `swingverify` fill data is
  already accruing (~2–4 months to a verdict).
- **PIT-consensus / signed-options / Sharadar arms** — blocked on data by design; the
  snapshot process needs ~2 quarters, Cboe purchase stays not-recommended.
- **Small-cap explosive-mover refinement** — deliberately skipped: re-slicing an already
  measured dataset without a new preregistered hypothesis is tuning, not testing.
- **Prospective shadow ledgers** (r10-vs-score A/B, graduation league) — only time
  produces that evidence.

Trial-registry impact: +21 recorded configurations across the three families (11 + 6 + 4,
placebo/robustness diagnostics included in the artifacts).
