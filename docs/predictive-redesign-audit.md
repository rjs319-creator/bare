# Predictive-Power Redesign — Audit Record (2026-07-31)

Scope: intraday/day-trade, swing, and momentum recommendation paths. Sixteen suspected
defects were verified against source before any edit. **All sixteen were CONFIRMED** (several
with additional related defects found during verification). This file records the evidence
and the disposition of each. Baseline before changes: `npm test` 2,719 pass / 0 fail;
`npm run check` clean.

Legend: ✅ fixed in this pass · 🔬 new shadow/research capability · 📝 documented, not changed.

## Findings

| # | Suspected defect | Verdict | Evidence (pre-fix) | Disposition |
|---|---|---|---|---|
| 1 | `lib/intraday-dataset.js` captures full-universe rows but `lib/survival-eval.js` still trains from lifecycle first-entry episodes and never consumes the dataset | **CONFIRMED** | `loadDatasetDay`/`loadDatasetGrades` had zero non-test consumers; `survival-eval.js:119-121` loads `loadAllGrades('daytrade')` → `type==='entry'` records only (first-ACTIONABLE_NOW, `lifecycle-capture.js:75-77`) | ✅🔬 `lib/intraday-training.js`: canonical loader joins dataset rows ⋈ grades ⋈ sampleProb ⋈ deep Stage-2 features; includes selected/rejected/sampled candidates; `op=datasetsurvival` two-stage utility harness |
| 2 | `sampleProb` stored but never used as an inverse-probability weight | **CONFIRMED** | every occurrence was a write (`intraday-dataset.js:69,71,90,152`); `trainLogistic` took no weights; all metrics unweighted | ✅ weighted loss in `survival-model.js` (`weighted:true`, `WEIGHT_CAP` 50), weighted Brier/ECE/reliability/base-rate/precision@k/top-k in `survival-metrics.js`; weighted AND unweighted reported |
| 3 | Full-universe rows lack the canonical Stage-2 deep features | **CONFIRMED** | dataset row fields vs `MODEL_FEATURES` (`intraday-schema.js:66-69`): overlap **zero**; deep features only computed for the ≤30-name Stage-2 pool | ✅🔬 two-tier schema: `BROAD_FIELDS`/`datasetRowFeatures` (every row) + deep `MODEL_FEATURES` joined from same-bucket Stage-2 evaluations (±5 min tolerance); missingness indicators throughout; `featureTier` tracked |
| 4 | 400-row cap sorts only by the `atRisk` boolean → drops strong anomalies by input order | **CONFIRMED** | `intraday-dataset.js:95-96`: single-boolean comparator; stable sort preserved candle-cache key order; a cusum-9 name late in key order could be dropped for a cusum-1.0 name early | ✅ deterministic severity priority (`severityOf`: sum of ratios to at-risk floors) + ticker tiebreak; `droppedByReason` (at-risk vs ordinary counts) persisted |
| 5 | Buckets are write-once — a thin early capture permanently blocks a richer one | **CONFIRMED** | `intraday-dataset.js:100-105`: any `existing.rows` → skip; warming scans (near-empty universes) could poison a 5-min bucket | ✅ upgrade allowed only when ≥25% more complete AND strictly more rows (`shouldUpgradeBucket`), replaced capture summarized in a `superseded` audit trail; thinner captures can never clobber richer ones |
| 6 | Post-close grading bounded to 6×40 tickers, never retries prior dates | **CONFIRMED** | workflow passed no `date=` (defaults to today, `api/tracker.js:191`); lexicographic `.sort().slice(0,limit)` restarts at the alphabet head; failed fetches retried forever; rows failing `last>0 && atr>0` were excluded from `remaining` (day claimed complete with unlabeled rows) | ✅ `lib/intraday-backlog.js`: per-date backlog index, oldest-incomplete-first, retention expiry (~5d bar availability), per-ticker fetch-fail rotation + terminal ceiling (`MAX_FETCH_ATTEMPTS`), honest `ungradeable`/`terminalTickers`/`incompatibleRows` accounting; `op=datasetgrade` (no date) = backlog mode |
| 7 | Scanner health assumes 60 s target vs the 5-min GitHub scheduler | **CONFIRMED** | `daytrade-scan-runner.js:25` `TARGET_INTERVAL_MS = 60*1000` vs cron `*/5 8-21 * * 1-5`; `floor(300s/60s)−1 = 4` phantom misses per healthy tick; wall-clock gap counting fabricated ~604 misses/night and ~3,484/weekend; counter never reset; missing `CRON_SECRET` froze health silently (job green, 401 server-side, `note:null`) | ✅ config-driven `targetIntervalMs()` (env `DAYTRADE_SCAN_INTERVAL_MS`, default 5 min = deployed cadence); session-aware `scannableMsBetween` (EST/EDT-safe, premarket-aware) — nights/weekends contribute zero; per-ET-date reset; `healthStatus()` reports `stale`/`never-succeeded` with the CRON_SECRET failure mode named; `runner-capture` sparse threshold now shares the same interval |
| 8 | Today's Scoreboard lookup falls back to `1m`/`5d` → objective mismatch | **CONFIRMED** | `decision.js:242-243` fallback chain; bonus defect: `horizonKey` reported the *requested* key, not the one read | ✅ exact-horizon only; missing evidence → `known:false, buildingEvidence:true` (neutral tilt, "BUILDING EVIDENCE" display), honest `horizonKey` |
| 9 | Today builds one global top-10 across incompatible horizons | **CONFIRMED** | `decision.js:565-570` one pool; `decision-routes.js:139` `active.slice(0,10)`; UI renders it as THE shortlist | ✅ `topByHorizon` (≤5 per horizon, ranked within its own contract); global `top` removed from payload, frontend renders per-horizon shortlists; no cross-horizon "best overall" exists |
| 10 | `rawConfidence` mixes heterogeneous heuristics as if comparable | **CONFIRMED** | 11 normalizer assignments on 11 different scales (hard-coded 55, decile×4+40, LLM `virality`, percentile, \|score\| remap…), used as the 4th sort tiebreaker | ✅ (partial) sources are treated as ranks in display language (Phase 8); full per-source outcome calibration is **future work** — it requires per-source exact-contract graded samples that are still accruing. Documented in `docs/validation-protocol.md`. |
| 11 | Normalizers don't propagate `detectedAt`/`ageBars` → lifecycle frozen at "newly detected" | **CONFIRMED** | 0 of 11 normalizers carried either field; `'expired'`/`'ready'`/`'early'` unreachable; bonus defect: daytrade's `lifecycleState` silently dropped by `makeSignal` | ✅ lifecycle age now derived from the **immutable origin snapshots** (`today/origins.json`: `firstDate` immutable, `bars` advanced once per session) inside `rankSignals`; `detectedAt` falls back to origin first-date; `makeSignal` accepts `lifecycleState` as a state hint; aged un-triggered picks now genuinely expire and land in the expired lane with age + detection date |
| 12 | Central eligibility defaults to annotate; shadow sources can affect the displayed ranking | **CONFIRMED** | `eligibility.js:40` `DEFAULT_MODE='annotate'`; 7 shadow sources ranked live incl. `coremo` owning the portfolio horizon; `daytrade` pinned | ✅ (deliberately NOT auto-flipped to enforce, per instructions) every card now carries `evidenceClass: 'ACTIONABLE' | 'RESEARCH'`; the annotate-mode `shadowComparison` (current vs enforced board) already ships in the payload; enforcement remains an explicit operator flip of `DECISION_ELIGIBILITY_MODE` after reviewing it. Day Trade pin untouched. |
| 13 | Unknown liquidity → neutral execution + cheapest cost tier | **CONFIRMED** | `decision-costs.js:57` unknown → `'liquid'` (cheapest); `decision.js:207-211` unknown → no penalty; most board rows had no `dollarVol`; the sizing control that would catch it is annotate-only | ✅ unknown → conservative `'small'` tier (`assumed:true`, labeled); Day Trade cards now propagate measured `avgDollarVol` (scanner value, else avgVol×last) so live daytrade liquidity is measured, not assumed; `sizingEligible:false` (weight 0) for unknown liquidity retained and tested |
| 14 | Momentum universe = StockTwits trending (≤14 names evaluated) | **CONFIRMED** | `api/momentum.js:72-81` trending API, `:97` `slice(0,14)` | ✅ universe = Day Trade full-universe discovery anomalies (severity-first) + cached screener cross-sections; StockTwits demoted to an orthogonal annotation (`attentionRank`/`social`, weight 0, can't originate or tie-break); no universe → honestly empty degraded board, never social-only |
| 15 | Momentum mixes 5-min detection, daily swing levels, and a `position` registry horizon | **CONFIRMED** | 5m indicators (`signal.js:453-472`), daily `tradeLevels` overwrite (`api/momentum.js:146-153`), registry `horizon:'position'`, contract `metric:'1m'`, `stopPolicy:'none'` contradicting the rendered stop | ✅ contract corrected to `intraday`/`1d` (`momentum-v2`); daily swing levels labeled display context; registry maturity reset to **shadow** (v1 evidence was earned under a mismatched contract and does not transfer); Scoreboard episodes stamp `momentum-v2` |
| 16 | Current OMEGA/momentum evidence is negative/null while older docs claim positive results | **CONFIRMED** | authoritative: `research/OMEGA-SURVIVORSHIP-FREE-2026-07.md` (verdict `no-edge`, rank-IC −0.027 below the +0.029 momentum baseline), `research/MOMENTUM-SURVIVORSHIP-FREE-2026-07.md` (rank-IC ≈ 0 both universes), `OMEGA-PHASE0.md` ("risk-off veto is the alpha"); contradicted by `CORE-MOMENTUM.md` ("forward IR ≈ 0.8–1.2", win 0.62/PF 1.4) and `research/ALPHA-RESEARCH-2026-07.md` (mom_12_1 IC 0.035, t=2.16) | 📝 authority order recorded below; contradiction notes added to the stale docs |

## Which evidence is authoritative

Where documents conflict, **the survivorship-complete July 2026 research pass wins**:

1. `research/MOMENTUM-SURVIVORSHIP-FREE-2026-07.md` and `research/OMEGA-SURVIVORSHIP-FREE-2026-07.md`
   (PIT security master incl. 2,573 delisted names) — momentum rank-IC ≈ 0, OMEGA `no-edge`.
2. `OMEGA-PHASE0.md` — earlier but consistent: no durable positive selection edge; the
   risk-off veto is the validated lever.
3. `research/ALPHA-RESEARCH-2026-07.md` (Jul 2) — its mom_12_1 IC 0.035 claim predates the
   full PIT master and is **superseded** by (1). Its regime-avoidance conclusion stands.
4. `CORE-MOMENTUM.md` — the "forward IR ≈ 0.8–1.2" expectation and the "forward screeners can
   ignore survivorship" argument are **stale**; `coremo` is correctly registered shadow and
   stays weight-0.

Consequence enforced in code: nothing in this redesign promotes OMEGA, RLT, ATLAS-X,
Pre-Move, or any momentum sleeve. All remain weight-0 shadow entries in the strategy
registry; the router and Today cannot consume them for actionable ranking under enforcement.

## Additional defects found during verification (all fixed)

- `expectancyFor` returned the requested horizon key as provenance even when a fallback
  horizon had actually been read (misleading audit trail).
- `makeSignal` read only `stateHint`, silently discarding the daytrade normalizer's
  `lifecycleState` — Day Trade's real lifecycle never reached the board.
- `gradeDatasetDay` reported `remaining: 0` while rows without a valid price/ATR stayed
  permanently unlabeled and invisible.
- `missedScanEstimate` was a monotonically growing lifetime counter (never reset).
- Scan-runner health reported `note: null` (healthy-looking) forever after a single
  historical success, even mid-session with a dead scheduler or rejected CRON_SECRET.

## What deliberately did NOT change

- **Day Trade pinned behavior** — `eligibility.js PINNED_SOURCES` untouched; the frozen
  golden baseline was regenerated exactly once for the two documented deterministic
  corrections (#11 lifecycleState propagation, #13 conservative unknown-liquidity tier) and
  the freeze test documents both (`test/today-golden.test.js`).
- **Gap & Go** — contract, scorer and tests untouched (suite green).
- **Eligibility enforcement** — still `annotate` by default. Flipping to `enforce` is an
  explicit operator action after reviewing `governanceGate.shadowComparison`; the audit
  found the actionable list would otherwise depend on governance freshness that has to be
  produced first (see docs/validation-protocol.md).
- **No model was promoted.** The new dataset-survival harness reports `insufficient-data`
  and its promotion gate fails closed until real prospective data accrues.
