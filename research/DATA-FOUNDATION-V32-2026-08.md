# Data Foundation v3.2 — Cohort Maturity, Decision-Time Cleaning, Full Provenance (2026-08-02)

Corrects the two research-validity defects found in the panel-v3.1 audit and rebuilds the
evidence on fully observed cohorts only. **Conclusion up front: still no promotable edge.**

## Defect 1 — partially matured cohorts (CONFIRMED, fixed)

`lastFullyMatureDecisionDate` meant "latest date with ANY finite outcome". Early delistings
resolve labels before the horizon elapses, so May-2026's 21-session cohort — 3 delisted
names (FFIC, KALV, MASI) label-ready, **1,704 active names pending** — was declared mature
and its 3-name "cross-section" produced an official IC of **−0.50** that polluted the
benchmark mean.

Fix (new modules, all pure):
- `research/lib/calendar.js` — market-session calendar (`us-sessions-v1`) built from the
  benchmark bar series, content-hashed.
- `research/lib/cohort.js` — per-(decisionDate, horizon) cohort ledger: entry/required-exit
  session, elapsed flag, mature/delisted/pending/unresolved/noFill/numeric-label counts,
  coverage fraction. **Eligible ⇔ window elapsed ∧ pendingRows = 0 ∧ coverage ≥ 95 %** (policy
  documented; unresolved rows disclosed). Pending rows stay stored; exclusion happens at the
  experiment boundary.
- `research/lib/manifest.js` v2 — `lastFullyObservedCohortDateByHorizon`,
  `cohortEligibilityByHorizon`, `cohortCoveragePolicy`, `ineligibleCohortCounts`, plus the
  honestly renamed `lastLabelReadyDecisionDateByHorizon`. Verification **recomputes** the
  ledger from rows + calendar and rejects partial-cohort claims, pending rows in eligible
  cohorts, dates later than the calendar permits, and missing coverage stats.
- `lib/research/harness-v3.js` v3.2 — `runExperimentV3` **refuses to run** without an
  eligible-cohort map; `perDateICv3` excludes ineligible dates; experiments report eligible/
  excluded dates, per-date coverage, min/median names, latest evaluated decision date.

Fully observed boundaries (recomputed, matching the prior diagnostic):
| horizon | v3.1 "mature" | v3.2 fully observed |
|---|---|---|
| 21s | 2026-05-31 | **2026-04-30** |
| 63s | 2026-05-31 | **2026-02-28** |
| 126s | 2026-05-31 | **2025-11-30** |

## Defect 2 — future-path data cleaning (CONFIRMED, fixed)

`extremeReturnAudit` looked at ~5 future bars and poisoned spike-revert/ambiguous moves —
whether an observation stayed trainable depended on what the market did afterwards.

Fix (`research/lib/corpactions.js` v2): decision-time validation (unadjusted splits,
duplicate bars, OHLC inconsistency, non-positive prices) is the ONLY poisoning layer; an
unexplained extreme is an observed market move, retained regardless of its future path and
flagged `x{h}` for the two symmetric sensitivity views (include-all vs exclude-all).
Persistence classification survives only as `postEventPersistenceDiagnostics`
(`diagnosticOnly: true`). Append-invariance proven by test: identical history + divergent
futures ⇒ identical class/poison/flag.

Panel effect: 78 future-path-poisoned labels → **21 structural** poisons; 1,642 unconfirmed
extremes retained (1,085 later persistent / 305 reverted / 251 ambiguous — now diagnostics);
1,581 labels sensitivity-flagged.

## Provenance, survivorship, execution, gates

- **Manifest v2 source hashes** (content, never versions/counts): full security-master and
  universe payloads, Merkle roots over corp-action and price partitions, calendar hash,
  cohort-ledger hash. Build block: commit, dirty flag + diff hash, command, deterministic
  params, retrieval ranges, per-source schema versions. Reproducibility class is **derived**
  (`confirmatory-reproducible` / `exploratory-diff-recorded` / `exploratory-non-reproducible`).
- **Survivorship** (`lib/research/survivorship.js`): measured contract
  (`proven-safe | survivorship-reduced | unknown`); the panel is **survivorship-reduced**
  (present-day symbols payload; 636 delistings included; monthly membership unmeasured) and
  that status blocks promotion.
- **Execution engine** (`lib/research/execution.js`, `exec-engine-v1`): next-session-open
  entry, gap-through, ADV-tier spread/slippage, participation cap, commissions, no-fill,
  gross/net + base/doubled/stressed — emitted as content-hashed, self-verifying artifacts.
  `costEvidenceCheck` accepts ONLY verified engine artifacts; signal-close entries and bare
  numbers are rejected.
- **Promotion gate**: 13 explicit checks (stat, econ, cohorts, ESS, current dataset hash,
  non-superseded model, proven-safe survivorship, timestamped prospective sample ≥ 30,
  calibration, hash-verified human-review artifact) — a nonempty review string no longer
  counts; registry approval still required; harness has no path to production ranks.
- **`npm run audit:research` v2** detects: partial cohort declared eligible, pending rows in
  eligible cohorts, coverage below policy, future-path quality classes, incomplete source
  hashes, null commit / unrecorded dirty diff, current-hash evidence beyond the fully
  observed boundary, unverified cost evidence, unmeasured survivorship claims — and triages
  evidence three ways (expected history / needs-rerun / current-invalid) instead of a
  permanent generic warning.

## Rebuild + frozen reruns (no features, thresholds or params changed)

Panel-v3.2: 77,782 rows / 48 months / 636 dead names; hash **b361e861486d810f** supersedes
3743829cfe12fdc6; audit **PASS** (warnings: dirty-tree exploratory build, single provider).

| study | v3.1 official | v3.2 (fully observed cohorts) | verdict |
|---|---|---|---|
| momentum 12-1, 21s | meanIC **−0.0062**, t −0.30 | meanIC **+0.0040**, HAC t 0.37, ESS 34, dates 36 | no edge (control 0.0029) |
| — sensitivity (excl. extremes) | — | +0.0038, t 0.35 | agrees |
| GBM−Ridge CPCV | Δ +0.0196, t 4.90, PBO 11 % | Δ +0.0177, t 4.25, PBO 18 % | relative only |
| GBM walk-forward | Sharpe −0.08, **DSR 0.16** | Sharpe +0.04, **DSR 0.22** vs bar 0.95 | **no live ML** |
| SUE 63s | IC 0.0041, t 1.56, Δcomposite −0.0113 | identical (inputs untouched by repairs) | not confirmed |

The v3.1 negative momentum print was partial-cohort contamination; the clean value is
statistically zero. Momentum cost evidence measured through the engine (7,406 next-open
fills): gross +1.24 %, net +0.92 %, doubled +0.60 %, stressed +0.11 % per 21s — but the
statistical gate fails, so no tier is reached. Evidence appended (superseding, immutable):
momentum `ea578bd75c822bcc`, GBM `aab9605d89552276`, SUE `2d8f533383add2fa`. All records
from this build are **exploratory-diff-recorded** (dirty worktree, diff hash recorded).

## Longer-horizon diagnostic (EXPLORATORY — not evidence)

`research/56-momentum-horizons.js` (artifact `momentum-horizons-diagnostic.json`):
21s pooled IC 0.014 (t 1.30, ESS 47); 63s **0.0316** (t 5.48, **ESS 24 < 30**);
126s **0.0451** (t 7.09, **ESS 18 < 30**). Reproduces the pre-repair diagnostic; both long
horizons fail the minimum effective sample. Confirmatory use requires one preregistered
fixed study, ESS ≥ 30, cost-net portfolio results through the execution engine, and
prospective confirmation. Nothing tuned; no live weights moved.

## Historical expansion (2010→): path built, panel extension BLOCKED

`research/55-history-expand.js`: resumable, explicit from/to, content-addressed
per-(symbol, year) partitions (never silently overwritten), splits/dividends, monthly
coverage report. Probe verified FMP serves full 2010–2021 history (AAPL/GE/XOM, 3,021 bars
each). **BLOCKED artifact** (`history-expansion.BLOCKED.json`): the missing dataset is an
authoritative monthly historical listing universe with delisting reasons (candidates: CRSP,
exchange list archives, commercial security masters). Today's symbol list is NOT the 2010
universe; no service purchased automatically.

## Verdict

No strategy is promotion-eligible. Momentum at 21s is statistically zero on clean cohorts;
GBM fails its pre-declared walk-forward DSR gate; SUE remains not confirmed. Longer-horizon
momentum is an interesting exploratory lead that current data cannot confirm. Suite: 3,137
pass / 0 fail / 2 skipped. No live strategy was promoted or reweighted.
