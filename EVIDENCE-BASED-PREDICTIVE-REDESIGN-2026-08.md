# Evidence-Based Predictive System Redesign — 2026-08

**Status:** implemented in two batches — (1) the fwd-outcome-v2 / cost-net / benchmark batch
(commit `a862e83`, merged as PR #234), and (2) this batch: display-honesty fixes, canonical
decision envelope, hypothesis registry + FDR, consolidated data health, secret redaction, and
the shadow `pit-data-v2` identity foundation.

> **No considerable alpha is currently proven.** Every tested strategy is either no-edge,
> retired, provisional (positive but survivorship-unsafe or sample-thin), or still accruing
> prospective evidence. The one economic lead (unscheduled ≥5% gap-up ORB) remains
> shadow/paper: OOS n≈227, +1.89%/trade net, PF 1.47 under stop-through-trigger fills, with
> date-clustered inference below t=2. Nothing in this redesign promotes a strategy, changes a
> live weight, or claims market-beating performance.

---

## 1. Before / after architecture

| Area | Before | After |
|---|---|---|
| Forward labels | `pit.fwdReturn` v1 conflated "ran out of bars" with delisting; truncated partials leaked into labels; the panel's recent tail was mislabeled delisted | `fwd-outcome-v2` four-state contract (`mature / delisted / pending / unresolved`), fail-closed nulls, Shumway −30% only on vendor-confirmable terminations; panel-v2 regenerated; all consumers migrated (`research/MIGRATION-FWD-OUTCOME-2026-08.md`) |
| Benchmark discipline | Momentum was sometimes a claim, sometimes absent | 12-1 momentum (`mom121`, PIT skip-month, never proxied) is a REQUIRED benchmark auto-appended to every research harness run (`lib/research/harness.js` v2, `REQUIRED_BENCHMARKS`); benchmark ≠ live winner (its own survivorship-free IC ≈ 0) |
| Learning labels | Timing/dualread/calibration loops learned from gross, overlapping, sometimes immature outcomes | Only matured, cost-net, episode-deduped outcomes feed self-learning; `maturity.js` can never grade Validated from a gross-only record |
| Router | Flattering defaults (missing input = perfect 1.0; 3 raw picks = regime evidence) | Fail-closed: unmeasured quality inputs = 0.5, unknown uncertainty = elevated; regime credit needs ≥8 distinct same-regime decision dates; binding stays structurally closed (`bindingReady` false) |
| Probability language | Uncalibrated sigmoids/posteriors/decile tables shown as "win-probability", "confidence %", "calibrated chance" | All relabeled as scores/base rates with lineage disclosure; per-card calibrated claims now branch on model health (`test/probability-language.test.js` locks each fix) |
| Decision rows | `research/decisions/` (full population, write-once) lacked strategy/code identity, provenance, canonical selection state | `research-schema-v2` + `live-bridge-v2`: every row carries `selectionState` (canonical 5-value enum), `strategyId/strategyVersion`, `calibrationVersion` (null — honest), `codeCommit/deployId`, `provenance`, `cohortSize`, `symbolAtDecision` (`lib/decision-envelope.js`) |
| Hypothesis governance | No BH/FDR, no trial counter, no graveyard, no exploratory/confirmatory flag | `lib/research/hypothesis-registry.js`: committed preregistrations + graveyard (18 entries), `benjaminiHochberg()`, family trial counter wired into harness manifests, sealed-holdout ledger, `retired`/`invalid-data` states |
| Data health | Scattered across 6+ ops | `op=datahealth` one consolidated report (universe, security master, ledger completeness incl. selection-bias check, pending outcomes by horizon, key booleans, router freshness) |
| Secrets | No redaction mechanism (convention only) | `lib/redact.js` — env-value + key-param masking used by all new routes; report/tests assert no key value can appear |
| Security identity | Two disconnected masters (`secmaster-v1` ≈ S&P-only Wikipedia removals; research `pit-secmaster-v1` local-disk); ticker = identity; no `knownAt` anywhere | Shadow `pit-data-v2` (`lib/pitdata/*`): bitemporal listings (effective-dated + knownAt), deterministic listingId + identityConfidence, vendor-confirmed delistings, content-addressed raw snapshots, five as-of interfaces, tri-partition universe snapshots, reconciliation gates |

## 2. Data and label contracts (exact)

**fwd-outcome-v2** (`research/lib/pit.js`): `forwardOutcome(series, dateMs, bars, opts)` →
`{status: mature|delisted|pending|unresolved, rawReturn, adjustedReturn, delistingAdjustment,
entryDate, expectedExitDate, actualExitDate, reason, dataCutoff, securityMasterVersion,
outcomePolicyVersion}`. Only `mature` and `delisted` may train/calibrate/grade; `pending`
and `unresolved` are null, fail closed. Purge/embargo on the real trading-date axis
(`lib/research/label-purge.js`).

**Decision envelope** (`lib/decision-envelope.js` + `research-schema-v2`): canonical
`selectionState ∈ {selected, rejected, suppressed, unavailable, error}` with a fail-closed
mapping from all legacy vocabularies (unknown label → `error`); strategy identity resolved
via `strategy-registry`; `codeCommit`/`deployId` from `run-manifest.codeVersion()`;
`provenance ∈ {prospective_live, historical_reconstruction}`. `decisionId`/`predictionId`
remains the deterministic sha16 of `ticker|decisionTs|horizon|modelVersion|side` — retries
idempotent; originals frozen and write-once; outcomes append in separate prefixes.

**pit-data-v2** (`lib/pitdata/schema.js`): a listing is
`{listingId, symbol, exchange, cik, figi, ipoDate, identityConfidence, aliases[], status[],
classification[], actions[], actionsCollected}` where every track is a list of intervals
`{value, effectiveFrom, effectiveTo, knownAt, source, provenance, confirmation}`. Invariants:
ticker is an alias; a current-list observation is effective from its OWN observation date
(current API state can never claim historical knowledge); `delisted` requires the vendor
delisted record as `confirmation`; absent knowledge = `unknown` and fails closed everywhere.
Raw responses are content-addressed (`pitdata/raw/<hash>.json`) with sanitized params and
distinct `effectiveAt/sourcePublishedAt/knownAt/ingestedAt`.

Interfaces (all fail-closed, `knownAt` defaults to `effectiveAt`):
`resolveSymbolAsOf`, `resolveSecurityAsOf`, `universeAt` (selected/rejected/unknown with
reasons), `classificationAt`, `corporateActionsBetween` (`lib/pitdata/resolve.js`).

## 3. Strategy status table (registry, post-redesign)

| Strategy | Registry maturity | Evidence state | Promotion blockers |
|---|---|---|---|
| screener (Breakout) | production (core) | earned grade via Scoreboard | Validated now requires cost-net channel + sector beat |
| ghost (Quiet accumulation) | production tab, but standalone rows are weight-0 shadow by contract | no-edge standalone (all-momentum, 0.96 corr with Breakout) | sealed prospective test as tie-breaker; until then supporting evidence only |
| gapgo (ORB) | production tab; ledger = daily-close PROXY (contract label says so) | provisional — the one economic lead | broad PIT universe, verified intraday fills, prospective paper agreement, HAC t ≥ 2 |
| daytrade | production (pinned, frozen contract) | dataset accruing under IPW/utility loop | promotion-gate.js: 400 episodes, ECE ≤ 0.10, precision lift ≥ 0.05 |
| momentum (v2) | shadow (demoted — v1 evidence earned under mismatched contract) | accruing under intraday contract | fresh evidence under momentum-v2 only |
| coil | production watchlist; % relabeled empirical base rate | provisional (survivorship-unsafe study) | live decile reliability with per-decile n |
| omega / atlasx / premove / rlt / peerlab / orbit / orbit-ml | shadow, weight-0 | no-edge (each has a recorded verdict) | graveyarded in hypothesis registry; would need new preregistered confirmatory pass |
| expgap / target-compare | shadow, open | accruing (reduce-only by construction / INSUFFICIENT_DATA until ~2026-08-09) | ≥20 resolved episodes / matured label rungs |
| fade / gapdown (short side) | shadow | structurally untradeable (no borrow feed) | borrow feed + fail-closed costs |
| nsl engines | shadow diagnostics | retired family | — |

Full inventory: `lib/strategy-registry.js` (40 entries) · gates: `lib/strategy-gate.js`,
`lib/maturity.js`, `lib/promotion-readiness.js`, `lib/rlt-governance.js`, `lib/promotion-gate.js`.

## 4. Migration & rollback

- **Labels:** panel-v2 + regenerated artifacts are committed; v1 numbers carry a contamination
  banner in `research/ALPHA-RESEARCH-2026-07.md` (preserved, not deleted). Rollback = revert
  `a862e83` (not recommended — it restores a label defect).
- **Envelope:** additive only. Old `research/decisions/` days (v1 rows) remain readable; new
  days carry the envelope. Rollback = revert `lib/decision-envelope.js` + the live-bridge diff;
  no data migration in either direction.
- **pit-data-v2:** entirely new `pitdata/` Blob prefix; zero live consumers. Rollback = remove
  the `pitdata` warm root and routes; stored shards/raws are inert. Consumer switch requires
  the reconciliation gates (`lib/pitdata/reconcile.js` — 5,000 listings, 1,000 confirmed
  delistings, ≤2% v1-only symbols, rename feed collected) **and** a human, reviewed change.
- **UI relabelings:** pure display; rollback = revert the frontend diffs (the regression tests
  in `test/probability-language.test.js` would then fail, by design).

## 5. Cron / operational procedure

- New warm root `pitdata` (`lib/warm-chains.js`) runs one bounded, resumable collect step per
  daily cron; the cursor self-heals budget skips; after `done` it is a cheap freshness no-op.
- First-run sequence (privileged, CRON_SECRET): `op=pitdata&view=probe` → repeated
  `op=pitdata&view=collect` (cron does this) → `op=pitdata&view=reconcile` (writes
  `pitdata/reconciliation.json`).
- Ongoing monitoring: `op=datahealth` (consolidated report; `problems[]` non-empty means act),
  `op=hypotheses` (registry + graveyard), `op=pitdata&view=status`.
- Deploys remain MANUAL (`vercel --prod`); nothing here changes crons or env vars.

## 6. Tests

- Baseline before this batch: 2,841 pass / 0 fail. After: see final report (all new suites:
  `test/probability-language.test.js` (9), `test/decision-envelope.test.js` (6),
  `test/hypothesis-registry.test.js` (9), `test/redact.test.js` (4), `test/data-health.test.js`
  (2), `test/pitdata.test.js` (10)).
- Commands: `npm test` · `npm run check` (now includes `lib/pitdata/*.js`) ·
  `node --test test/pitdata.test.js` etc.
- Covered per the spec: ticker rename/reuse, confirmed-vs-unknown delisting, knownAt
  time-travel prevention, capability-failure ≠ empty data, fail-closed
  classification/corporate-actions, idempotent content-addressed ingestion, reconciliation
  gates, score-vs-probability relabelings, selectionState normalization, BH q-values,
  trial-counter floors, secret redaction.

## 7. Remaining API/data limitations (honest)

- FMP `delisted-companies` pagination beyond page 0 was 402-blocked on the Starter tier when
  last probed from research; the tier is now Premium — the capability probe records the
  current truth instead of assuming it. If still blocked, delisting coverage stays thin and
  the reconciliation gates simply keep failing (correct behavior).
- No FIGI/OpenFIGI integration yet: identityConfidence tops out at `medium`; share-class
  ambiguity persists for multi-class issuers.
- Classification and corporate-action collection are not yet wired into the collector loop —
  `classificationAt`/`corporateActionsBetween` fail closed (status `unknown`) rather than
  pretending coverage.
- Gap & Go live capture remains a daily-close proxy: no premarket gap, float, spread,
  halt/LULD, or verified fills (EOD data); the contract label says exactly this, and the
  intraday research rig is the only place those are modeled.
- No sealed holdout era exists yet; the holdout ledger is in place so the first one is
  registered before it is created.
- Realized-vs-modeled slippage divergence is unmeasured (no fill feed).

## 8. Machine-readable artifacts

- `pitdata/reconciliation.json` (dual-read report + gates) — written by `view=reconcile`
- `op=datahealth` JSON (data-health report, `data-health-v1`)
- `op=hypotheses` JSON (registry + graveyard + trial counts)
- `pitdata/state.json`, `pitdata/probe.json`, `pitdata/identity/<A-Z0>.json`, `pitdata/raw/*`

---

*This document records an engineering pass focused on decision quality and evidence honesty.
It does not claim, and must not be read as claiming, that the application beats the market.*
