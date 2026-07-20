# NSL Incremental-Value Series — Summary & Close-Out (2026-07)

This closes the Novel Signal Lab incremental-value arc: four experiments (#3–#6) asking one
disciplined question of every NSL engine that can be ranked cross-sectionally —

> **Does this signal add forward predictive value ORTHOGONAL to price momentum, on real free data?**

The answer, across three engines and two universes: **no durable, significant orthogonal edge
anywhere.** Momentum remains the only thing that ranks these names. This is an honest negative, and
a valuable one — it says where NOT to spend a live weight, and it is consistent with the app's whole
multi-session finding (see `market-news-app` notes: "every edge direction testable on free data
exhausted").

## The shared test (why the verdicts are trustworthy)

Every experiment used the identical decisive test (`lib/nsl/incremental.js` → `evaluateIncremental`):

- **Baseline:** 6–1 price momentum (126-bar lookback, 5-bar skip), point-in-time.
- **Signal:** the engine's reading, masked to what was *knowable* at the decision date.
- **Label:** a real next-open fill held 21 sessions; a date whose label has not fully elapsed is
  **dropped, never truncated** (purge, not peek).
- **Decisive quantity:** the rank-IC of the signal **orthogonalised against the baseline** — its
  marginal contribution *conditional on momentum*, not its standalone look.
- **Multiplicity:** Bonferroni over the specification variants explored (t ≥ 2 to promote).
- **Grouping:** each decision date is one independent, purged cross-section; the t-stat is
  date-clustered. A verdict is only "Demonstrated" with ≥ 12 usable dates.

Each harness is pure and unit-tested for its leakage surfaces (a fact/trade filed after the decision
date is invisible; restatements keep the original vintage; the twin pool holds only resolved
outcomes; a name never twins with itself).

## Results

| # | Engine | Universe | Samples / dates | Baseline-⟂ IC (t) | Verdict |
|---|---|---|---|---|---|
| #3 | E2 insider-conviction (SEC Form 4) | 56 large-cap | 409 / 12 | **+0.027** (t 0.35) | `inconclusive` → observe |
| #4 | E6 accounting-forensics (SEC XBRL) | 56 large-cap | 935 / 17 | **−0.018** (t −0.69) | `no-edge` → reject |
| #5 | E8 historical-twins (price geometry) | 56 large-cap | 669 / 12 | **−0.011** (t −0.22) | `no-edge` → reject |
| #6 | E2 insider | 158 small-cap | 82 / 6 | **−0.056** (t −0.29) | `no-edge` → reject |
| #6 | E6 forensics | 158 small-cap | 2643 / 17 | **+0.009** (t 0.58) | `inconclusive` → observe |
| #6 | E8 twins | 158 small-cap | 1873 / 12 | **+0.001** (t 0.01) | `inconclusive` → observe |

Source docs: `INSIDER-INCREMENTAL-2026-07.md`, `FORENSICS-INCREMENTAL-2026-07.md`,
`TWIN-INCREMENTAL-2026-07.md`, `SMALLCAP-SERIES-2026-07.md`.

## What we learned

1. **The momentum ceiling is real and re-confirmed three ways, on two universes.** Every
   orthogonal IC sits within noise of zero. The largest magnitude is −0.056 (insider on small-caps,
   and on only 6 usable dates); nothing approaches the t ≥ 2 promotion bar.
2. **The "large-caps are too clean to fire" caveat did not survive testing.** Experiment #6 moved to
   a high-dispersion small-cap universe expressly to exercise the transitions these engines hunt.
   Forensics and twins nudged from mildly negative toward ~zero — they *do* fire slightly more in a
   noisier universe — but the improvement is within noise, not an edge. Insider got *worse* (small-cap
   growth is sell-skewed; buy-side conviction is too sparse to rank).
3. **Standalone looks lie; orthogonalisation is the whole game.** E8 twins alone had IC +0.010
   (large-cap) and −0.041 (small-cap) — but its *orthogonal* IC is ~0 both times, because the twins'
   only predictive content is the momentum they are matched on. Any evaluation that skipped the
   orthogonal step would have mis-ranked this.
4. **Small samples fabricate edges.** A 15-name smoke of #6 showed a tempting +0.06 forensics /
   +0.045 twin — pure small-sample noise that washed out entirely at 158 names. The
   ≥12-usable-dates bar exists for exactly this reason.

## Why nothing was promoted (and nothing touched prod)

- Nothing cleared the significance bar, so by the lab's own rule (`adds-incremental-value` requires a
  positive *and* significant orthogonal IC) nothing advances even to prospective shadow logging.
- Every verdict carries the same structural caveat: the universes are **current survivors**. There is
  no point-in-time security master, so delisted names are absent — a bias that is *larger* on
  small-caps, which delist far more. A production verdict cannot be made until this is fixed.
- The entire lab stayed shadow-only (`NSL_DISABLED`, weight 0). No live ranking was ever affected.

## What was NOT tested — and what would actually move the needle

The remaining NSL engines are **not rankable by this harness**, so the arc is genuinely exhausted on
free data — a universe swap will not extend it:

- **E9 invariance** is a cross-environment robustness *meta-check*, not a per-name signal.
- **E1 / E4 / E5** are licensed-data-blocked: securities-lending borrow-fee/utilization (Ortex/S3),
  alt-data panels (Revelio/Similarweb), and issuer bond/CDS/ratings.

Higher-leverage moves, roughly in order:

1. **Build a PIT security master** (delisted names + as-of membership). This removes the survivorship
   caveat that qualifies *every* result above — turning "inconclusive on survivors" into a verdict
   that can actually be trusted. Substantial build, not a shadow experiment.
2. **A genuinely new hypothesis or richer feature space** — the engines above are individually weak
   and mutually correlated with momentum; an *interaction* or *non-price* construction not yet tried
   is the only free-data path left with real optionality.
3. **A paid feed** to unblock E1/E4/E5 (borrow-fee is the most-cited real small-cap edge in the
   literature and is the natural next target if a licence is in budget).

## Reproducibility

All shadow research, nothing imported by `api/` or deployed:

- Harnesses (pure, unit-tested): `lib/nsl/{insider,forensics,twin}-incremental.js`, decisive test
  `lib/nsl/incremental.js`, tests `test/nsl-{insider,forensics,twin}-incremental.test.js`.
- Runners: `research/46-insider-incremental.js`, `47-forensics-incremental.js`,
  `48-twin-incremental.js`, `49-smallcap-series.js`.
- Re-run any single engine, or the whole series on small-caps (`node research/49-smallcap-series.js`).

## Bottom line

Three orthogonal-testable NSL engines × two universes = **no durable momentum-orthogonal edge on the
free/serverless stack.** The app is, honestly, a momentum/regime dashboard; the defensible value is
regime avoidance, not security selection. The next real step up is infrastructure (a PIT security
master) or data (a licensed feed) — not another signal on the same free inputs.
