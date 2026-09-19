# Insider Cluster Buys, Matched-Residual — Result (2026-09-09)

Hypothesis `insider-cluster-residual` (family alt-signals, exploratory, ONE pass). Design sealed at commit
`053afa6` (`PREREGISTRATION-INSIDER-CLUSTER-RESIDUAL-2026-09.md`), run once, 13 s, artifact
`research/data/insider-cluster-residual/`, ledger row `insider-cluster-residual-2026-09` in
`research/experiments/registry.json`.

## Data
SEC Form 345 bulk, 21 quarters (2021q2→2026q2): 194,396 open-market buys / 5,789 tickers, 257 impossible-price
rows removed (§2a), 10,133 raw clusters (study-69 definition, unchanged), 3,134 event names with price history,
control pool 5,387 names. Events with a decision bar in window 3,396; **primary cohort 2,369** (small+micro ADV
tier, non-10b5-1) over **832 decision dates**, 99.9% matched to 20 same-date / same-tier / same-momentum-quintile
controls. Attrition counted: no price 4,009 · liquid tier 987 · illiquid 784 · before/after window 931 · cooled
543 · no decision bar 267 · <126 bars 145 · extreme-move guard 151 · truncated history 66 · sub-$1 58 · 10b5-1 62.

## Frozen gates → `research-promising`
| cell | events | dates | mean (cost-net, vs matched) | CI95 | HAC t | BH q | blocks |
|---|---|---|---|---|---|---|---|
| RES_5 | 2,361 | 833 | +0.64% | [0.20, 1.09] | 2.88 | 0.013 | 4/4 |
| **RES_21 (primary)** | 2,350 | 832 | **+1.36%** | [0.25, 2.58] | 2.41 | 0.016 | 3/4 |
| RES_63 | 2,317 | 827 | +1.85% | [0.35, 3.59] | 2.41 | 0.016 | 4/4 |
| placebo RES_21 (−126 sessions) | 1,963 | 723 | −0.21% | [−1.09, 0.68] | −0.47 | — | 2/4 |

Matched-only cohort identical (RES_21 +1.35%). All three cells survive BH at q ≤ 0.10; placebo is null.

## Honest read (pre-declared descriptives that were NOT gates)
- **The mean is carried by a handful of multi-baggers.** Date-level median +0.19%, hit rate 51.1%, 10%-trimmed
  mean +0.23%. **Excluding the top 1% of events (≈24 clusters) the date-level mean is +0.01%.** Event-level median
  is −0.55% (48.3% win). 32 events returned >+50% (NEGG +226%, SOUN +184%, THRX +131% …); 5 lost >50%.
  Leave-one-date-out max shift 0.27 pts (dominantFrac 0.20).
- **Versus SPY the event names are flat after costs:** +0.54% n.s. at 21s, **0.00%** at 63s. The residual exists
  because the matched small/micro control basket *lagged SPY* by −0.82%/21s and −1.85%/63s cost-net. A long-only
  holder of these names earned roughly the index, not more; the edge is relative to comparable small caps.
- **Lumpy by year:** 2022 +0.17 · 2023 +2.71 · 2024 −0.38 · 2025 +3.37 · 2026 −1.25.
- Descriptive cohorts (not claims): officer/director-only +1.66% t 3.0 (n 1,473) · drawdown +2.19% t 2.6 (n 1,075)
  · ≥3 owners +1.24% t 2.0 · ≥$250k +1.16% t 1.9 · single buyers +0.99% t 1.97 (n 4,944) · liquid tier +0.06%
  (n 965, nothing — consistent with limits-to-arbitrage) · micro +1.06% t 2.1 / small +1.18% t 1.5 · legacy
  2026-08 universe +2.43% t 0.95 / ex-legacy +1.28% t 2.23.

## Post-hoc diagnostic (2026-09-09, after the pass; not a gate, not a re-cut)
The bulk build emits one row per reporting owner on an accession, so a **joint filing** (a fund, its GP and its
managing member on one Form 4) counted as several "distinct insiders". Checked on the primary events: 252 of
2,349 (10.7%) were clusters made of a single accession; they behaved like the rest (event-level mean +1.24% vs
+0.83%, medians −0.68% vs −0.52%), so this artefact did not drive the result. The prospective ledger collapses a
joint filing to ONE insider (`lib/insider-cluster.js dedupeJointFilings`) — a tightening, declared here.

## What this earns, per the sealed protocol
The frozen gates passed, so the hypothesis is `provisional` and earns exactly a **weight-0 shadow prospective
ledger** — nothing user-facing, no weight, no promotion. It is a *relative-to-peers, lottery-skewed* effect, not
an absolute long-only edge; a book that must hold the winners through a −0.55% median event to catch the 1%
multi-baggers is a different proposition from "buy what insiders buy". The 2022-2026 window is now spent for
this hypothesis.

## Required for any prospective follow-up (new preregistration)
1. A robust-location gate this pass lacked and would not have met: date-level median > 0 or 10%-trimmed mean > 0.
2. A dominant-event cap (share of the mean attributable to the top 1% of events < 50%).
3. Absolute cost-net excess vs SPY as a co-primary, since the relative effect came from the controls' lag.
4. Prospective feed: SEC EDGAR daily Form 4 → the frozen cluster constructor → `insidercluster/<date>.json`,
   graded at 21 sessions on the standard contract (≥50 episodes / ≥20 dates / CI clear / fill verification).
