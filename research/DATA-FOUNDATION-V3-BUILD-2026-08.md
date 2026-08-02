# Data-Foundation v3 — first authoritative build (2026-08-02)

The v3 stack (secmaster-v3 → fwd-outcome-v3 → panel-v3) was code-complete but
data-blocked on `secmaster-v3.json`. This session unblocked it with real
authoritative inputs, upgraded the contracts, and produced the artifacts. All
outputs live under `research/data/` (gitignored build artifacts); this report
is the committed record.

## What was built

### secmaster-v3.json — 38,653 symbols, two authoritative sources merged

- **PATH A (prospective):** the pitdata-v3 listing export
  (`pitdata-v3-listings.json`, produced by the deployed collector via
  `op=pitdata&view=v3export`). Strong going forward; only **25** confirmed
  delistings after one day of collection. Its `active` intervals derive from
  the FMP stock-list, which contains long-dead names — so a bare shard
  `active` claim is membership, not trading (see merge policy in
  `research/16-secmaster-v3.js`).
- **PATH B (historical reconstruction):** FMP `/stable` feeds + **SEC EDGAR**.
  Endpoint semantics were probe-validated first:
  - `/stock-list` includes long-delisted names (DWA, JOY) — it is NOT an
    active list; `/actively-trading-list` (26,465 rows) is.
  - `/delisted-companies` is **plan-gated to page 0** (~100 most-recent rows;
    page ≥ 1 → HTTP 402). Recorded as a coverage limitation, not papered over.
  - The gap is closed with EDGAR: Form 25/25-NSE (delisting notification,
    effective +10d per Rule 12d2-2), Form 15 (deregistration), 8-K item 1.03
    (bankruptcy) and 2.01 (acquisition completion) — regulatory provenance,
    zero price inference. Validated against ATVI (acquisition, correct date)
    and FRC (bank registrant → correctly NOT confirmable via EDGAR).
- **Result:** 26,378 active · **890 confirmed delistings** (834 via Form 25,
  31 via Form 15, 25 via FMP recent) · reasons: 535 acquisition, 14
  bankruptcy, 6 rename, 341 explicitly unverified · 11,385 explicit `unknown`
  (fail closed) · 79 relisted/recycled flagged · 150 alias conflicts kept
  fail-closed. Delisting years cluster 2022–2026 (815 in the panel era).
- Identity: per-symbol profiles for all 4,219 universe names (CIK/CUSIP/ISIN,
  exchange, listing date); listingId anchors on CUSIP, never merges share
  classes on CIK alone; recycled tickers never inherit the current holder's
  identity.
- Build is cached one-file-per-call under `secmaster-v3-cache/` (resumable,
  rate-limited, deterministic given the cache; the API key never touches any
  output). Fixtures cover all nine required cases
  (`test/secmaster-v3-compose.test.js`, `test/edgar-delist.test.js`).

### Coverage limitations (recorded in the master's meta — cite them)

1. FMP historical delisted feed plan-gated (page 0 only).
2. 48 inactive universe symbols have no CIK → EDGAR lookup impossible.
3. Bank registrants (FDIC-supervised, e.g. FRC) don't file Form 25 with EDGAR
   → their delistings stay unconfirmed/unknown.
4. Rename history is shallow (~3 months of `/symbol-change`).
5. 341 delistings have unverified reasons → their labels are withheld
   (fail closed), not guessed.

vs v1 (`pit-secmaster-v1`): its "2,573 delisted" mixed true delistings with
stale tails (the defect). v3's 890 are individually confirmed; everything else
is an explicit unknown.

## fwd-outcome-v3 contract upgrades (research/lib/outcome-v3.js)

- **Truncation-explanation guard:** a confirmed delisting > 45 days beyond the
  last bar no longer labels the stale partial return
  (`series-ends-before-delisting-data-gap`).
- **Cutoff guard:** a delisting confirmed after the data cutoff treats the
  security as active in-era (no label from a vendor-gap tail).
- **Unknown-reason policy:** default `exclude` — confirmed delisting, label
  withheld. `haircut`/`carry` are explicit disclosed sensitivity overrides.
- **Documented proceeds:** `delisting.terminalValue` (per-share) overrides the
  generic treatment (`proceeds:<category>`).
- **`assertTrainable`:** throwing training-boundary guard; wired into the
  panel's label writer.
- **Append-invariance is now tested** (`test/outcome-v3-invariance.test.js`):
  appending future bars never changes a mature label; contradictions withdraw
  labels (fail closed), never alter them.

## panel-features-v3.json

78,597 name-months · 48 months (2022-06..2026-05) · 3,746 names scanned ·
**778 confirmed-delisted names included**. Label states (per horizon-label):
212,406 mature · 2,571 confirmed-delisted · 17,179 pending · 3,635 unresolved ·
106 delisting labels withheld (unverified reason). Non-labelable rows are KEPT
with null labels and status chars — dropping dead names was the survivorship
trap. Header carries decision timestamps, universe rule, feature timestamping,
`sectorBasis` (current-vendor classification — documented limitation), and the
master's coverage limitations.

## First Foundry runs on the clean panel

- `momentum-12-1-swing` benchmark (research/40-foundry-benchmark.js): mean IC
  0.0076, HAC t 0.77, MBB CI90 [−0.006, +0.031], control ≈ 0. The yardstick,
  recorded as `inconclusive` by design.
- `nonlinear-ml-panel` and `pead-sue` reruns (concurrent session, evidence
  log): the GBM-vs-Ridge delta shrinks ~40% on honest labels; SUE stays dead.
  No verdict flipped.

## What this does NOT change

No strategy was promoted. No live ranking reads any of these artifacts
(`test/research-isolation.test.js` enforces it). Gap & Go is relabeled a
FORWARD-TRACKED CHALLENGER (frozen params, prospective ledger gates) — see
`docs/alpha-foundry.md`.

## Rebuild / resume

```
node --env-file=research/.env research/16-secmaster-v3.js   # cached+resumable
node research/15-panel-features-v3.js
node research/40-foundry-benchmark.js
```
