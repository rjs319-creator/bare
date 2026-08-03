# Data Foundation Upgrade — panel-v3.1 (2026-08-02/03)

Goal: close the remaining point-in-time, identity, corporate-action and
validation gaps in the research foundation (grade-B baseline) so the swing-
ranking evidence stands on defensible data. **No alpha is claimed anywhere in
this document.** Nothing was promoted; research stays isolated from live
ranking (enforced by test/research-isolation.test.js).

## Verified defects (all reproduced before fixing)

| # | Defect | Evidence |
|---|--------|----------|
| 1 | `dataCutoff: 2026-04-01` declared while the grid ran to 2026-05 and 2026-04-30 decisions carried 1,662 "mature" 21-session labels consuming May/June bars | direct panel scan |
| 2 | 27 duplicate `(listingId, decisionTs)` keys — CDAY/DAY ×7, RDUS/SCHN ×16, MCG/SHCO ×1, AMSWA/LGTY ×3 (renamed tickers share a CUSIP lid; both cache files emitted rows) | direct panel scan |
| 3 | Price caches carry `close` only — vendor-split-adjusted (verified: CELH 3:1, GME 4:1 show no discontinuity), NOT dividend-adjusted, zero provenance | cache inspection + split cross-check |
| 4 | Extreme raw jumps unaudited (233 >100% one-session moves in a 200-file sample) | cache scan |
| 5 | harness-v3 folds trained on `decisionTs < test start` with NO purge/embargo — 21/63/126-session label windows overlap the boundary | code |
| 6 | `costNetPositive !== false` let a NULL cost estimate satisfy PASS-PROVISIONAL | code |
| 7 | Universe contained funds/SPACs/preferred/notes (e.g. mutual-fund share classes, "…Notes due 2028") with no type policy | classification scan |

## What was built

**Phase 1 — `research/lib/manifest.js` (snapshot-manifest-v1).**
DataSnapshotManifest with normalized-payload SHA-256 (`normalizedPanelHash`:
rows sorted by (lid, dt), keys sorted; metadata excluded), explicit
`featureAvailabilityCutoff` / `lastDecisionTimestamp` / `labelObservationCutoff`,
per-horizon `lastFullyMatureDecisionDate`, source provenance, counts,
missingness, exclusion reason codes, known limitations, `supersedes` chain.
`verifySnapshotManifest` re-derives every claim from the actual rows; an
inconsistency writes `panel-v3.INVALID.json` and exits nonzero — the panel is
not published.

**Phase 2 — `research/lib/identity-v3.js`.**
listingId is the research identity. Alias intervals reconstructed from observed
trading spans (vendor `/symbol-change` is only ~3 months deep — provenance
labeled `reconstructed-from-observed-spans`), `canonicalTickerAt(lid, date)`,
overlap-consistency verification before any merge, quarantine on live
collisions or disagreeing bars. Real-data result: **8 rename chains** resolved
(CDAY→DAY, SGMS→LNW, RLGY→HOUS, MCG→SHCO, SCHN→RDUS, PFMT→PHLT, AMSWA→LGTY,
CINR→SIRE) with historically correct interval dates; CMPOV/CMPO correctly
quarantined (`multiple-live-members-share-listingId`). The builder iterates
GROUPS (one canonical series per lid), so duplicates are structurally
impossible; a residual duplicate hard-fails the build.

**Phase 3 — `research/lib/corpactions.js` + `research/54-corpactions-fetch.js`.**
Splits + dividends cached per symbol (4,217 symbols, resumable, empty-array =
legitimate observation, failure = visibly missing → fail closed).
`verifySplitAdjustment` proves the vendor basis instead of assuming it;
`withTotalReturn` builds a TR index (adjDividend reinvested) — raw closes
preserved for cap/ADV/execution; `extremeReturnAudit` classifies every
beyond-threshold move (explained-split-error / explained-dividend /
legitimate-persistent / spike-revert / ambiguous / tail-truncated) and POISONS
unresolved dates: entry rows on poisoned bars are skipped, labels whose window
touches one are withheld. Never winsorized into data.

**Phase 4 — PIT availability + universe.**
`pit.sharesSeries` availability order corrected to acceptedDate > filingDate >
period+45d. Instrument-type policy with reason codes (etf, fund,
mutual-fund-ticker-shape, adr, non-common-name-pattern, suffix heuristics);
measured vendor-flag caveat: FMP marks exchange-listed equity REITs
isFund=true, so a counted override rescues them (9 names: FRT, VNO, KRG, AKR,
WSR, ILPT, UHT, BDN, SVC). Monthly universe funnel
(candidates→priced→band→feature→emitted) written to
`universe-coverage-v3.json`. Sector stays current-vendor and is disclosed as
non-PIT in the manifest.

**Phase 5 — harness-v3.1 purge/embargo.**
Exact-labelEndDate purge against the decision-date axis with an embargo
(default 3 bars): a training row may be used only when its label FULLY closed
before the embargo boundary; a row that cannot prove when its label closed
never trains. Purged counts, embargo interval and boundaries recorded per fold
and in `leakageControls`. Panel rows carry `le{h}` so maturity is verifiable
forever.

**Phase 6 — three-tier verdicts.**
`NOT_CONFIRMED` → `STATISTICAL_SIGNAL_CANDIDATE` →
`ECONOMICALLY_VIABLE_CANDIDATE` → `PROSPECTIVE_PROMOTION_ELIGIBLE`.
Economic tier requires MEASURED `{net, doubledCostNet, stressedLiquidityNet}`,
all positive — missing evidence fails, never null-passes. Promotion tier
additionally requires verified prospective agreement + a named human-review
artifact; the harness can never grant it alone.

**Phase 9 — `npm run audit:research`** (`scripts/audit-research-data.js`).
Manifest invariants, duplicate/identity checks, numeric-labels-on-
non-trainable-states, provenance artifacts, deterministic recompute spot-check
(features must re-derive from bars), superseded-evidence detection, source
staleness, coverage collapse. JSON + human report; exit 1 on critical; SKIPs
cleanly where research data is not materialized (CI-safe; wired into ci.yml).

## Rebuilt panel (panel-v3.1)

- datasetHash `3743829cfe12fdc6…` (supersedes `942b52cff721d8f7…`)
- 77,784 rows / 48 months / 2,547 listingIds / 636 confirmed-delisted names
- cutoffs: featureAvailability 2026-06-24 · lastDecision 2026-05-31 ·
  labelObservation 2026-06-24 (derived from data, enforced by manifest)
- duplicates: **0** (was 27)
- label states (per horizon-label): m 209,659 · c 2,758 · p 16,678 · u 4,257
- extreme events: 1,648 classified (1,085 legitimate-persistent, 305
  spike-revert, 251 ambiguous, 5 dividend, 1 split-error, 1 tail) → 78 labels
  withheld, 1 entry skipped; 2 symbols excluded for split-adjustment conflicts
- exclusions (symbols): 374 non-common-name, 199 etf/fund-flagged (incl. 131
  mutual-fund tickers), 23 adr, 10 identity-quarantined, 114 too-few-bars,
  23 no-shares, 2 no-corpaction-provenance
- audit gate: **PASS** (warnings: 3 pre-repair evidence records now marked
  superseded; single-provider limitation)

## Frozen-model reruns (no new variants, params frozen)

| Model | Pre-repair (panel-v3) | Post-repair (panel-v3.1) | Verdict |
|---|---|---|---|
| momentum 12-1 (harness-v3.1, 21d, purged folds) | meanIC +0.0076, HAC t 0.77 | meanIC −0.0062, HAC t −0.30, ESS 33 | no edge (unchanged conclusion) |
| SUE / PEAD (63d) | pooled IC 0.0041, t 1.49, composite delta −0.0112 | pooled IC 0.0041, t 1.56, delta −0.0113 | not-confirmed; repair-robust negative |
| GBM vs Ridge (CPCV, 21d) | delta +0.0118, t 2.63, PBO 43% | delta +0.0196, t 4.90, PBO 11% | relative delta unstable across vintages |
| GBM walk-forward (binding gate) | DSR 0.50 vs 0.95 bar | **DSR 0.16 vs 0.95 bar** (WF Sharpe −0.08) | **no live ML promotion** |

The result remains **no-edge**: no swing ranker is eligible for promotion.
Evidence records appended (append-only) for all three hypotheses against the
new dataset hash; pre-repair records remain immutable and are surfaced as
superseded by the audit gate.

## Remaining limitations (recorded, fail-closed where applicable)

- Sector classification is current-vendor, NOT point-in-time — sector-
  conditioned results are advisory (manifest-disclosed).
- Single price provider (FMP) — no cross-provider disagreement checks.
- FMP delisted-companies feed is plan-gated (~100 recent rows); historical
  delistings come from EDGAR Form 25/8-K reconstruction (890 confirmed).
  Unknown-status symbols fail closed.
- Alias intervals are reconstructed from observed spans, not vendor-confirmed
  rename dates (approximate to the last bar under the prior symbol).
- Analyst estimates remain shadow-only, `PIT_UNPROVEN` (fail-closed adapter);
  a licensed multi-observation revision sample is the external dependency.
- Shares outstanding are weighted-average-diluted approximations; restatement
  vintages indistinguishable on this plan.
- `vendor-split-adjusted-unverifiable` basis for names with no in-window
  splits (nothing to verify against; dividends still applied).

## Grade

**A.** All engineering acceptance gates are demonstrated on the generated
artifacts (zero duplicate keys, explicit enforced cutoffs, verified adjustment
provenance for trainable returns, unresolved extremes excluded, purged+
embargoed folds with passing leakage tests, measured universe coverage,
fail-closed identity/delistings, mandatory cost-net for economic passes,
evidence pinned to the current hash, isolation intact, suite 3,106 pass /
0 fail, audit gate PASS). Withheld from A+ because disclosed coverage gaps
remain external to the code: non-PIT sectors, single-provider prices,
plan-gated delisting feed depth, reconstructed (not vendor-confirmed) alias
dates, and estimates PIT status unproven. Those are data-procurement gaps, not
correctness defects; closing them (PIT sector history, second price source,
vendor rename history, audited estimates sample) is the path to A+.
