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
