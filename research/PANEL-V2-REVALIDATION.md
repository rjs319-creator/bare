# Panel-v2 findings requiring revalidation (fwd-outcome-v3 supersession)

**Date:** 2026-08-02 · **Trigger:** verified defect in `research/lib/pit.js`
`forwardOutcome` (fwd-outcome-v2): a cached price series whose last bar was
≥30 days before the fixed data cutoff was labeled **`delisted`** and given the
Shumway −30% haircut **without consulting any authoritative delisting record**.
A stale free-feed tail, a vendor outage, an acquisition, a rename and a
bankruptcy were indistinguishable under that rule.

Panel-v2 (`research/data/panel-features.json`) and every research result
computed from its `f*/d*/s*` labels therefore contain **inferred delistings**.
The direction of the bias is not knowable per-name without the authoritative
master: acquisitions (usually positive/neutral terminal outcomes) were haircut
like bankruptcies, while any name whose feed simply went stale was removed from
the pending pool and pushed into the delisted-labeled training set.

## What is and is not affected

- **NOT affected:** `mature` rows (full horizon observed) — the bulk of the
  panel. Findings driven by mature-only cross-sections stand as reported.
- **AFFECTED (requires revalidation before being cited again):** any statistic
  that uses `d{h} = 1` rows or the delisting-adjusted `f{h}` of non-mature
  rows. Known dependents:
  - `research/28-mlrank` rerun on panel-v2 (commit a862e83; GBM-vs-Ridge,
    hypothesis `nonlinear-ml-panel`) — delisting-adjusted labels enter the fit.
  - `pead-sue` clean-panel rerun (`research/data/sue.json`, panel-v2 labels).
  - Any panel-v2 quintile/decile tail statistics that include haircut rows.
  - `research/lib/secmaster.js` (`pit-secmaster-v1`) `delisted`/`delistDate`
    fields — same last-bar-vs-cutoff inference, same defect. Its "2,573
    delisted" count is an upper bound mixing true delistings with stale tails.

None of these were promoted (all verdicts were no-edge/provisional), so no live
behavior changes; but their **numbers should not be quoted** until re-run.

> **STATUS 2026-08-02 (later the same day): UNBLOCKED.** `secmaster-v3.json`
> was built from the pitdata-v3 export merged with an FMP+SEC-EDGAR historical
> reconstruction (890 confirmed delistings, reasons evidence-joined; see
> `research/DATA-FOUNDATION-V3-BUILD-2026-08.md`), and `panel-features-v3.json`
> now exists (778 dead names included). The `nonlinear-ml-panel` and `pead-sue`
> reruns are recorded in `research/data/evidence/` — neither verdict flipped.

## How to revalidate

1. Build the authoritative master: `node research/16-secmaster-v3.js`
   (direct FMP pull with `FMP_API_KEY`, or `--from <pitdata-v3 export>`).
2. Build panel-v3 beside panel-v2: `node research/15-panel-features-v3.js`
   (`panel-features-v3.json`; labels are `fwd-outcome-v3`: only `mature` and
   `confirmed_delisted` train; acquisitions/renames are never haircut; stale
   tails are `unresolved` with null labels).
3. Re-run the affected studies on panel-v3 through
   `lib/research/harness-v3.js` (HAC + moving-block bootstrap + BH-bound
   verdicts) and append the outcome to `lib/research/evidence-log.js` records.

Historical reports are **not rewritten**: panel-v2 and its findings remain on
disk as the record of what was measured then, with this file as the caveat.

## Revalidation outcomes (2026-08-02, panel-v3 / fwd-outcome-v3)

Panel-v3 built same day: 76,338 name-months, labels m=214,728 / c=80 /
p=13,635 / u=2,830. **v2 carried 3,297 stale-tail-inferred delisting labels
(all haircut −30%); only 80 survive authoritative confirmation (97.6%
unconfirmable).** Mature labels are identical across vintages. Evidence
records: `research/data/evidence/` (append-only, keyed by dataset/period/
horizon/code/manifest).

- **`pead-sue` — NOT-CONFIRMED again (negative is label-robust).**
  v3 labels: pooled IC 0.0041, monthly t 1.49, decile spread 0.11%,
  composite delta **−0.0112** vs +0.005 bar; only 2021 positive.
  (v2 rerun was IC 0.006 / t 1.76 / delta −0.009.) Graveyard status stands.
- **`nonlinear-ml-panel` — NOT-CONFIRMED; v2 significance was partly label
  artifact.** Same CPCV code on both vintages: GBM−Ridge IC delta falls
  +0.0198 (t 4.92, PBO 18%) → **+0.0118 (t 2.63, p 0.014, PBO 43%)** on
  honest labels — ~40% of the delta came from the fabricated delisting
  haircuts. BH q at the swing-ranking family level ≈ 0.098 (marginal), and
  the pre-declared promotion bar (walk-forward DSR ≥ 0.95) still fails
  hard: WF DSR 0.50 (v2: 0.51). GBM absolute OOS IC ≈ 0 (−0.005 mean);
  "beats Ridge" means less-bad than an ill-conditioned linear fit, not
  positive edge. No live ML — unchanged, now on cleaner grounds.
- **Panel-v2 tail statistics** (delisting-labeled rows) remain unquotable;
  any future citation should use panel-v3.
- **`pit-secmaster-v1` counts**: superseded by secmaster-v3; note the FMP
  Premium plan gate caps confirmed delistings at the ~100 most recent
  (25 clean after reuse-conflict fail-closed), so v3 confirmed-delisting
  coverage grows prospectively rather than by backfill.
