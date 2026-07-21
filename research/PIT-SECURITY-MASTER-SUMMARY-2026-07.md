# PIT Security Master — Summary & Close-Out (2026-07)

This closes the point-in-time security-master arc: build the mechanism that removes the survivorship
caveat from the NSL edge tests, then use it to answer the two questions that caveat left open —

> **Was the "no edge" verdict a survivorship artifact? And what does survivorship actually cost —
> the edge, or just the returns?**

The answer, from two independent consumers of the master: **survivorship shifts the return LEVEL
(+0.40%/63d), not the cross-sectional edge.** The no-edge verdict holds once the dead names are put
back — but survivor-only point estimates are not reliable at face value. Momentum moves returns; it
does not sort this universe; there is no orthogonal edge to trust — survivorship-free or not.

## The three pieces

| # | PR | What | Result |
|---|---|---|---|
| build | #163 | `research/lib/secmaster.js` — PIT security master over the survivorship-complete FMP cache | 2,573 delisted names with retained history; **25.3%** of the mid-2022 universe has since delisted |
| #7 | #164 | Survivorship-free re-run of the **E8 twin** edge test (bounded, O(N²)) | no-edge **holds**; IC point estimate shifted **0.030** |
| #8 | #165 | Survivorship-free **momentum baseline** at full breadth + Shumway penalty | return bias **+0.10%/21d, +0.40%/63d**; rank-IC unchanged |

## What the master is

`research/lib/secmaster.js` (`pit-secmaster-v1`) turns the research rig's survivorship-complete FMP
cache (~10k US symbols whose price + income FMP **retains to the last trading day**, including SIVB /
FRC) into a per-symbol **listing record**, a **`universeAt(asOf)`** that returns the cross-section
tradeable *then* (delisted names included up to their last bar, excluded after, with the same PIT
cap-band + liquidity filter as the panel), and a **`candlesFor`** bridge to the shape the NSL
harnesses consume. Built from 10,096 cached symbols → 9,985 with history, 7,412 active, **2,573
delisted**. The survivorship hole it exposes: as of 2022-06-30, **25.3%** of listed names have since
delisted (19.9% @2023, 14.3% @2024) — exactly the rows a current-survivor backtest silently drops.

Distinct from the app's `lib/security-master.js`, which is populated from ~55 Wikipedia S&P removals
(`survivorshipSafe = false`, no delisted price history). This is the real, survivorship-complete
population, built offline — nothing deployed.

## What the two re-runs found

**#7 — the edge test (E8 twins), same survivor set both sides.** Bounded to 300 names (twins are
O(N²)), 25 dates over the delisting-dense 2022–2024 window.

| | Survivor-only | Survivorship-free |
|---|---|---|
| Twin ⟂ momentum IC | −0.017 (t −0.99) | +0.012 (t 0.86) |
| Verdict | no-edge | inconclusive |

Neither IC is significant → **no-edge holds; #5 was not a survivorship artifact.** But the point
estimate shifted **0.030** — larger than the IC itself — a concrete caution that a survivor-only IC is
not reliable at face value even when the headline is unchanged.

**#8 — the momentum baseline, full breadth (2,213 names, 41,997 name-months), Shumway −30% penalty.**

| Horizon | rank-IC (free) | rank-IC (survivor) | mean fwd (free) | mean fwd (survivor) | **return bias** |
|---|---|---|---|---|---|
| 21d | −0.008 | −0.004 | 1.06% | 1.15% | **+0.10%** |
| 63d | −0.005 | +0.006 | 2.15% | 2.55% | **+0.40%** |

Momentum's rank-IC is ≈0 on **both** universes → **survivorship shifts the return LEVEL, not the
ordering.** The +0.40%/63d bias is lower than research/04's +1.1%, and reconciles: #04 IP-weighted its
delisted sample ×6 to the whole non-survivor population; #8 measures the natural in-band frequency
(~18% of name-months). #04 is the IP-scaled upper bound; #8 is the as-is in-band figure.

## What this settles

1. **The survivorship caveat that qualified every NSL verdict (#3–#6) is now discharged for the
   baseline case.** The no-edge finding survives a survivorship-free re-run; it was a real property of
   the data, not an artifact of a survivor-only list.
2. **Survivorship is a returns problem, not an edge problem — here.** It biases the *level* of realized
   returns (+0.4%/63d) but not momentum's cross-sectional *ordering* (rank-IC ≈ 0 either way). A
   backtest that reports absolute returns is materially flattered; a rank-IC / long-short edge study is
   largely insulated in this universe/window.
3. **Survivor-only point estimates are still not to be trusted at face value.** Even where the verdict
   is unchanged, the twin IC moved 0.030 — so any future signal that *did* look promising on a
   survivor-only universe must be re-checked survivorship-free before it earns weight.

## Honest limits (unchanged across the arc)

- **Delisting date ≈ last traded bar** — no reason code; the Shumway −30% is a blanket penalty that
  pools mergers (often positive) with bankruptcies (near-total loss).
- **`securityId == symbol`** — no CUSIP/FIGI feed, so ticker-reuse (a symbol reassigned after a
  delisting) is not yet split; a hazard for very long windows.
- **Coverage is the ~10k-symbol FMP cache, 2021–2026**, one delisting-dense window; older or non-US
  names are out of scope on the free/Starter tier.
- **The twin re-run (#7) is bounded** (300 of ~1,830 in-band) for tractability — direction robust,
  magnitude a lower bound. The momentum re-run (#8) is full-breadth.

## Reproducibility

All offline, nothing deployed:

- Master + build: `research/lib/secmaster.js`, `research/50-secmaster-build.js`, tests
  `test/secmaster-pit.test.js` (invariant: a delisted name is a member before its last bar, absent after).
- Consumers: `research/51-twin-survivorship-free.js`, `research/52-momentum-survivorship-free.js`.
- Verdict docs: `PIT-SECURITY-MASTER`, `TWIN-SURVIVORSHIP-FREE`, `MOMENTUM-SURVIVORSHIP-FREE`, and this
  summary — all 2026-07.

## Bottom line

The infrastructure to run any signal survivorship-free now exists and is reusable. Applied to the two
things that mattered, it converts "no edge, but survivorship-caveated" into "**no edge, confirmed
survivorship-free** — and survivorship costs return level, not cross-sectional edge." The next real
step up remains data, not method: a licensed feed (borrow-fee for E1, alt-data for E4/E5) or a
CUSIP/FIGI identity feed to split ticker-reuse — not another free-data signal on the same inputs.
