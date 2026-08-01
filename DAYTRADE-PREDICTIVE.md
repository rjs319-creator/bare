# Day Trade — Predictive Discovery Redesign

The Day Trade system previously answered: *which stocks are already moving, have confirmed
their structure, and have not yet failed?* This redesign adds the missing layer — *at this
point in time, which eligible stocks have the highest chance of a large REMAINING same-day
upside move?* — while preserving the trigger display, lifecycle tracking, failure detection,
freshness controls and honest research safeguards unchanged.

**Honesty first**: nothing here claims a validated predictive edge. The deterministic
defects below were real and are fixed; the learning layer is scaffolding that must accrue
point-in-time data prospectively and pass the pre-registered promotion gate before any
output may use probability language. Until then every new state/score is labeled a research
annotation, and the system remains willing to show an empty actionable list.

## Root causes found (all verified in code before fixing)

1. **Schema drift silently zeroed model features.** The survival model expected
   `residual15`; capture stored `residualVsSpy` — in *percent*, not fraction. `?? 0`
   imputation turned every missing/renamed feature into a fake genuine zero.
2. **`momAccel` was computed and then dropped** before the deterministic score, the
   canonical card and the immutable snapshot.
3. **Discovery observations were discarded** when the ticker already appeared in any daily
   scan (`filter(!known.has)`), so Stage-A CUSUM/shock/freshness evidence never reached
   Stage-2 for exactly the names most likely to be igniting.
4. **Stage-2 selection ignored discovery evidence entirely** (z-blend of relVol/pctChange/
   excessPct only) and gave any tracked lifecycle name a **×1000 boost** — tracked names
   could consume the whole 30-name deep-validation budget and crowd out every new discovery.
5. **Remaining R:R was mechanically 2.** The live plan re-anchored entry to the current
   quote and re-derived the target as entry+2×risk every cycle, then "measured"
   (target−last)/(last−stop) — a constant the runner score rewarded with +10.
6. **One-refresh discovery delay**: the board only read the *persisted* result of a prior
   `op=discover` call.
7. **Discovery was RTH-only** and premarket data had no session-safe normalization path.
8. **Training data had terminal selection bias**: the survival stack learned only from
   first-`ACTIONABLE_NOW` episodes — the system's own selections — so false negatives
   (runners it rejected or never saw) could never enter the sample.
9. No independent measurement of the actual objective (runner capture, lead time, remaining
   move at detection, reason-coded misses).

## What changed

### Deterministic fixes (production behavior)
- **`lib/intraday-schema.js` (new)** — versioned canonical feature registry
  (`intraday-features-v2`), `MODEL_FEATURES`, null-preserving `toModelRow` with the one
  documented legacy alias (residualVsSpy % → residual15 fraction), missingness flags, and
  `validateFeaturePresence` so a renamed/dropped feature is a test failure.
- **`lib/intraday-features.js`** — added mom10, momJerk, sector residual (capability-gated),
  volume/dollar-volume acceleration, range expansion, VWAP slope/distance, and shadow entry
  archetype states (ORB-5/15/30, VWAP reclaim, first pullback, compression release;
  premarket-high break capability-gated null). mom1/mom2 are explicit nulls on 5-min bars.
- **`lib/lifecycle-eval.js`** — `intradayEv` metrics now carry the full canonical surface
  (every model feature an own property; snapshots capture it); added `sessionBucketOf`
  (premarket/open5/open30/midday/power).
- **`lib/runner-dud.js` v2** — momAccel and volAccel now actually reach the scorer.
- **`lib/survival-model.js`** — per-feature missingness indicators with their own learned
  coefficients; present-only standardization; missing ≠ zero, ever.
- **`lib/survival-eval.js`** — features = the schema list; legacy rows aliased at training
  time; added single-signal comparator baselines (momentum-alone, relVol-alone, cusum-alone).
- **`lib/daytrade-actionability.js`** — lane-budgeted Stage-2 selection
  (management/revalidation protected, **discovery guaranteed 6 slots + 2 anomaly reserve**,
  unused reservation flows back; ×1000 boost removed) with full selection diagnostics
  (selected/rejected + lane + reason); **frozen live plan** (`activePlan` persisted on the
  record per setupId; later cycles keep the same stop/target and only remaining R:R moves);
  early-state annotation wiring.
- **`lib/intraday-discovery.js`** — `mergeDiscoveryEvidence` (merge, never discard),
  `loadOrRunDiscovery` (same-cycle inline scan under a time budget), premarket scanning with
  separate thresholds, session-reset interval state (premarket CUSUM never seeds RTH),
  first-alarm timestamps (`discoveredAt`/`discoveryAgeMin` — the lead-time anchor), and PIT
  dataset capture per scan.
- **`lib/screener-routes.js`** — merge + same-cycle wiring; response now includes
  `stage2Selection` diagnostics and discovery `ranInline`/`mergedIntoScans`.

### New research/shadow layer (no buy language, no probabilities)
- **`lib/daytrade-early-state.js`** — SCOUT → PRIMED → IGNITION → EARLY_CONFIRMED research
  states from pre-registered thresholds (`daytrade-config.EARLY`); extension-disqualified;
  rendered as watch badges with "why now"; measured (not trusted) via the capture pipeline.
- **`lib/intraday-dataset.js`** — point-in-time cross-sectional capture of the whole
  scanned universe at ~5-minute decision buckets, with deterministic negative sampling
  (at-risk superset kept at probability 1 — including names the system rejected; ordinary
  negatives kept at 6% by FNV-1a hash with `sampleProb` stored for 1/p weighting).
  Write-once per bucket; no read-modify-write on the hot path.
- **`lib/intraday-labels.js`** — versioned same-day targets from strictly-after bars:
  MFE/MAE at 30/60/120/180 min, the +0.5/1.0/1.5/2.0 ATR vs −0.35/−0.5 ATR barrier grid
  (same-bar straddles = FAILURE), time-to-barrier, net-after-cost, remaining move and
  remaining-fraction-of-day-move. `pcarry` (3-session) is explicitly NOT the intraday label.
- **`lib/runner-capture.js`** — independent pre-registered daily-runner definition
  (primary: high ≥ prevClose + 2×ATR; pct5/pct8/atr3 sensitivity grid), capture rate,
  remaining-move-at-detection, dud list, and a reason-coded miss taxonomy
  (universe hole / liquidity floor / scanner not running / scanner sparse / detector missed /
  Stage-2 never validated).
- **`lib/daytrade-scan-runner.js`** — scheduler-independent scan entry point with a Blob
  lease, idempotency window, health doc (last success, gaps, missed-scan estimate) and an
  honest degraded mode when no scheduler is configured.

### New ops (`/api/tracker?op=…`)
| op | purpose | access |
|---|---|---|
| `daytradescan` | one locked/idempotent scan cycle (external scheduler entry) | privileged (CRON_SECRET bearer) |
| `daytradescanhealth` | read-only scanner health / last success | public |
| `daytradecapture[&date=]` | daily runner-capture + miss-taxonomy report | public |
| `datasetgrade[&date=&limit=]` | attach strictly-after labels to captured dataset rows (bounded per call) | privileged |

## Scheduler deployment (not configured — requires authorization)

This Vercel Hobby deployment has one daily cron and cannot scan intraday on its own. The
degraded mode (request-driven scans while the page is open) remains the default and is
reported honestly. To get continuous coverage, point ANY external scheduler at:

```
GET https://<app>/api/tracker?op=daytradescan
Authorization: Bearer $CRON_SECRET
```

- Cadence: every 1–5 minutes, 08:00–16:05 ET weekdays (premarket from 04:00 if desired).
  Over-scheduling is safe (40s idempotency window + 55s lease).
- Options: cron-job.org / GitHub Actions `schedule` / any VPS cron / Vercel Pro cron.
  None is provisioned here; choosing and paying for one is the user's call.
- After the close, run `op=daytradecapture` once and `op=datasetgrade` a few times
  (each call grades ≤40 tickers) to label the day.
- Verify liveness anytime via `op=daytradescanhealth`.

## Evaluation status (honest)

- **No historical intraday cross-sectional dataset exists in this repo** — free feeds give
  only ~5 trailing days of 5-minute bars. The PIT dataset therefore accrues
  **prospectively** from live scans; there is nothing to train on yet, and no historical
  walk-forward result is claimed for the new layer.
- The champion remains the deterministic runner/dud score. The challenger path
  (logistic + missingness indicators, walk-forward, embargo, calibration, comparator
  baselines including cusum-alone/momentum-alone/relVol-alone) runs via `op=survival` and
  reports `insufficient-data` + a fail-closed promotion gate until ≥400 graded episodes /
  ≥150 test episodes / ≥3 folds / precision-and-net-lift / ECE ≤ 0.10 are all met.
- Early states (SCOUT/PRIMED/IGNITION/EARLY_CONFIRMED) are pre-registered rules whose lead
  time and post-state outcomes the capture pipeline now measures. They gate nothing.
- `op=daytradecapture` is the daily scorecard for the questions that matter: which runners
  were caught, how early, with how much move remaining, and why the rest were missed.

## Rejected ideas (and why)

- **Gradient-boosted / LightGBM challengers now** — no dataset yet (above), and the repo is
  dependency-light pure JS; premature until the interpretable baseline is beaten OOS.
- **LLM as price predictor** — prohibited by design; LLM use stays limited to catalyst
  extraction elsewhere in the app.
- **Hard risk-off suppression for Day Trade** — still unvalidated intraday (the forward
  book's worst regime was risk-ON); regime remains context/model input
  (`REGIME.HARD_SUPPRESS:false` until its pre-registered evidence gate passes).
- **Re-anchoring plan entry to the OR-high trigger** — would break the documented
  "entry = live price at confirmation" contract and its tests; the freeze achieves the R:R
  fix without changing confirmation semantics.
- **Premarket-high-break archetype as a live signal** — no premarket bars on the free feed;
  capability-gated null rather than fabricated.
- **Treating 1–2-minute returns as available** — 5-minute bars can't honestly provide them;
  explicit nulls + capability flag instead.

## Validation run

- `npm test` — **2,649 pass, 0 fail** (2,613 pre-existing + 36 new; lifecycle, retirement,
  freshness and alert-dedup suites all untouched and green).
- `npm run check` (server syntax) and `node --input-type=module --check < public/js/app.js`
  (frontend module parse) — clean.
- New suites: `test/daytrade-predictive.test.js`, `test/intraday-schema.test.js`,
  `test/intraday-dataset-labels.test.js` — covering the 17 required areas (merge, lanes,
  reserves, frozen R:R, same-cycle discovery, schema presence, missingness, session
  separation, strictly-after labels, conservative same-bar, deterministic sampling with
  preserved positives, fail-closed promotion, hidden probability language).

## Addendum — learning loop completed (2026-07-31, predictive-redesign)

The missing dataset→model connection is now implemented (see
`docs/predictive-redesign-audit.md` for the audited defects):

- **`lib/intraday-training.js`** — canonical dataset→model adapter: joins
  `loadDatasetDay` ⋈ `loadDatasetGrades` ⋈ `sampleProb` ⋈ deep Stage-2 features
  (nearest same-bucket lifecycle evaluation, ±5 min), including selected, REJECTED and
  sampled ordinary candidates; dedup by ticker|decision-time; version fail-closed.
  Two-stage shadow baseline (pTarget/pStop logistics + train-fold timeout return) with
  **expected cost-net utility** as the primary target. `op=datasetsurvival`.
- **IPW everywhere** — `weight = min(1/sampleProb, 50)` in training loss
  (`survival-model.js weighted:true`), Brier/ECE/reliability/base-rate/precision@k/top-k
  (`survival-metrics.js`); weighted AND unweighted reported.
- **Two-tier features** — `BROAD_FIELDS`/`datasetRowFeatures` for every captured row;
  deep `MODEL_FEATURES` joined when a Stage-2 evaluation exists (`featureTier` marks it).
  Missingness indicators throughout; missing is never zero.
- **Capture integrity** — the 400-row cap now uses deterministic anomaly-severity priority
  (input order can never decide survival; `droppedByReason` persisted); a bucket may be
  upgraded only by a ≥25%-more-complete capture with a `superseded` audit trail.
- **Grading backlog** — `lib/intraday-backlog.js`: per-date cursor, oldest-incomplete-first
  retries until remaining=0 / terminal / past the ~5-day bar-retention window; per-ticker
  fetch-fail rotation with a terminal attempt ceiling; `ungradeable`/`incompatibleRows`
  visibly reported (a day can no longer claim complete with unlabeled rows).
  `op=datasetgrade` without a date runs backlog mode (the workflow already calls it so).
- **Scheduler honesty** — target cadence is config-driven (`DAYTRADE_SCAN_INTERVAL_MS`,
  default = the deployed 5-minute GitHub cadence); misses count only scannable session
  minutes (EST/EDT-safe, premarket-aware), reset per ET date; `op=daytradescanhealth` now
  reports `stale`/`never-succeeded` (naming the silent-CRON_SECRET failure mode) plus the
  grading-backlog summary.

Evaluation status is unchanged and honest: the PIT dataset accrues prospectively; the
harness reports `insufficient-data` and its promotion gate fails closed until the
pre-registered thresholds are met. No probability is displayed anywhere.
