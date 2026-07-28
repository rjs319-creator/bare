# Relative Leadership Transition (RLT)

Shadow-first system for discovering stocks that are **beginning** to outperform
(1) the broad market, (2) their sector, and (3) comparable peers inside their
sector — before the move is obviously extended. Strategy id `rlt`, registered
**shadow / weight-0**. `RLT_MODE=off|shadow|enforce`, default `shadow`;
`enforce` fails closed without a valid, current, version-matched artifact.
Configuration alone can never promote the model.

Relative strength alone is **never** presented as a buy signal.

---

## 1. Confirmed current-code findings (Phase 1 audit)

Code-evidenced findings that shaped the design (file refs verified at build time):

- **Fragmentation.** ~20 independent relative-strength implementations, 6+
  sector→ETF map copies, 4 different RS-acceleration formulas, inconsistent
  horizon sets (`[1,3,5,10,20,63]` vs `[1,3,5,10,21,63]` vs `[5,10,21]`…).
  `lib/atlasx-residual.js` is the only implementation with fitted, shrunk,
  PIT-sliced betas — RLT reuses it rather than adding a 21st formula.
- **DEFECT (fixed): sector residualization was dead in the live ATLAS-X path.**
  `lib/atlasx-routes.js` lowercased the sector name before probing the
  TitleCase-keyed `SECTOR_ETF` map, so `etfForSector(...)` returned null for
  every sector → no sector ETF was ever fetched → every "sector residual" was
  silently market-only. Fixed with a case-insensitive index; `benchFor` in
  `lib/readthrough.js` additionally accepts provider aliases
  ('Healthcare', 'Financial Services', …). Regression:
  `test/sector-etf-resolution.test.js`.
- **DEFECT (fixed): premove states collapsed to PRIMED/ARMED.**
  `lib/premove-inventory.js` read `episode.assessment.lifecycle`, but real
  supervisor assessments carry `lifecycleState` — every real episode fell
  through the switch. Fixed (reads `lifecycleState ?? lifecycle`); RLT's own
  state derivation reads the correct key.
- **SPY and sector ETFs are NOT in the candle cache** (the cache writer
  persists only the equity universes). Anything needing benchmarks must fetch
  them (`fetchDailyHistory`) — RLT's routes do, bounded and cache-first.
- **No persisted sector-leadership time series existed anywhere.**
  `api/sectors.js` computes rotation on every request and stores nothing.
  RLT's `rlt/sector-state.json` (rolling 120 sessions) is the first durable
  record of sector leadership in the app.
- **Sector metadata is present-day and static** (`lib/universe.js SECTOR_OF`;
  the security master has no `validFrom`/`validTo`). All research output is
  therefore stamped survivorship/reclassification-unsafe — a recorded
  limitation, not a fabricated capability. The `expanded` universe has **no**
  sector data at all → those names become labeled market-only observations.
- **Pseudo-independence is endemic**: e.g. `omega-swing` sums `rsSpy5 + rsSpy10
  + rsSec10` as if independent; Ghost's "RS (Mansfield)" pillar is actually raw
  6-month momentum with no benchmark. RLT keeps absolute return, market
  residual, sector residual, peer rank and rank change as **separate features**
  and declares router correlation against firstPullback / breakout /
  compression so leadership+momentum+trend are never counted as three
  confirmations.

## 2. Reused architecture (nothing duplicated)

| Need | Reused module |
|---|---|
| Residualization (fitted shrunk β, sector loading, PIT slicing) | `lib/atlasx-residual.js` |
| Episode identity/retention/cooldown/union monitoring | `lib/swing-supervisor.js` + `swing-*` (adapter: `lib/rlt-episodes.js`, own `rlt/*` namespace) |
| Competing-risk Stage-A labels | `lib/premove-stage-a.stageALabel` → `lib/leadtime2` |
| Objective trigger + acceptance + utility waterfall + barrier probabilities | `lib/premove-stage-b.js` (+ `lib/coil-executable.js`) via `lib/rlt-stage-b.js` |
| Execution realism (next-open, gap-through, no-fill, same-bar→stop) | `lib/execution-policy.js` (exec-v1), `lib/swing-evaluate.js` |
| Costs | `lib/costs.js` (cost-v2 tiers) |
| Walk-forward, exact purge, embargo, uniqueness, bootstrap CI | `lib/research/harness.js` + `label-purge.js` |
| Triple-barrier outcome labels | `lib/evolve-labels.js` |
| Probability display chokepoint (band unless calibrated) | `lib/atlasx-contracts.displayNumber` / `bandForScore` |
| Governance (maturity/gate/eligibility fail-closed) | `strategy-registry` / `strategy-gate` / `eligibility` / `maturity` |
| Alerts template (transition-only, dedup-before-feed) | `lib/daytrade-alerts.js` pattern → `lib/rlt-alerts.js` |
| Hash-chained ledger, Blob store | `lib/immutable-ledger.js`, `lib/store.js` |

## 3. New architecture

```
lib/rlt-config.js       versions, RLT_MODE gate (fail-closed), peer policy, hurdles, rlt/* store keys
lib/rlt-universe.js     PIT peer universe: sector × liquidity band, labeled fallbacks, fail-closed eligibility
lib/rlt-residual.js     daily residual series (as-of β held constant, labeled), rolling sums, tie-aware percentiles
lib/rlt-leadership.js   cross-sectional peer ranking: percentile history, rank velocity/acceleration, persistence,
                        separate evidence axes, peer-collapse guard
lib/rlt-features.js     path quality, turnover-conditioned momentum (interactions), absorption OHLCV proxies
                        (labeled experimental), setup/extension, catalyst masks (missing stays missing)
lib/rlt-sector-state.js continuous sector vector + LEADING/IMPROVING/NEUTRAL/WEAKENING/RISK_OFF/INSUFFICIENT_DATA
lib/rlt-states.js       DISCOVERED → EMERGING_LEADER → PRIMED → ARMED (cross-section) and TRIGGERED → ACCEPTED →
                        WEAKENING/INVALIDATED/EXPIRED/COMPLETED (derived from supervisor lifecycleState);
                        transition records; explicit DROPPED transitions (nothing vanishes silently)
lib/rlt-stage-a.js      42-key ordered feature vector, deterministic ridge logistic, mandatory simple baselines,
                        rank/band-only output until calibrated
lib/rlt-stage-b.js      trigger FAMILIES over the shared trigger/acceptance/waterfall engine
lib/rlt-utility.js      abstention-first actionability; separate named outputs, never one confidence number
lib/rlt-scan.js         the pure cross-sectional pipeline + compact leadership snapshot for ATLAS-X injection
lib/rlt-episodes.js     supervisor adapter (PRIMED/ARMED/TRIGGERED/ACCEPTED with pivot structure become episodes)
lib/rlt-governance.js   REGISTRATION (hypothesis, bars, limitations), modelHealth, promotionView, assertShadow
lib/rlt-store.js        rlt/* persistence; WRITE-ONCE daily cross-sections; sector-state history; ledger stream
lib/rlt-alerts.js       transition-only deduplicated alerts incl. SECTOR ROLLOVER / ENTRY TOO EXTENDED
lib/rlt-routes.js       op=rlt (read), op=rltlog (cron write), op=rltresolve (grade), op=rltwalkforward (research)
lib/rlt-research.js     harness events (fold-local PIT residualization by construction) + baseline ladder comparison
public/js/rlt-lab.js    Research Lab panel (state buckets, abstention reasons, calibration status, sector strip)
```

Integration edits: `atlasx-contracts` (EXPERTS + `relativeLeadershipTransition`),
`atlasx-experts` (the expert; abstains without the injected cross-section),
`atlasx-engine` (ticker into expert ctx), `atlasx-routes` (loads
`rlt/latest.json → leadershipSnapshot` into ctx), `atlasx-router` (correlation
pairs 0.5/0.45/0.35), `atlasx-survival` (geometry), `atlasx-config`
(experts/router v2, RLT expert params), `strategy-registry` (+`rlt`),
`strategy-contracts` (+contract, +`Rlt` section), `api/tracker.js` (ops,
privileged, expensive), `warm-chains` (own root `rlt`), `pulse-routes`
(+`sectorLeadership` cheap read), `app.js`/`index.html` (Lab tab + Pulse strip).

## 4. Peer grouping

Primary group `sector × liquidity/cap band` (bands from median 20-day dollar
volume: ≥$100M large, ≥$20M mid, ≥$2M small, else micro). Fallback hierarchy,
**every step labeled on the row**: sector-band → sector → market-wide. Minimum
peer size 8 (versioned in `PEER_POLICY`); smaller groups fall back rather than
emit a false-precision percentile. Missing sector ⇒ market-only shadow
observation with `missing:['sector']` — never excluded, never fabricated.
Eligibility fails closed on: <40 bars, >2 stale sessions, price <$1, dollar
volume <$2M, unresolved single-day |move| ≥75% (split/bad-bar), non-tradable.

## 5. Residualization

Canonical per-horizon residual: `atlasx-residual.residualize` at horizons
`[1,3,5,10,21,63]` (1-session kept only as a transition feature) — 60-session
OLS β vs SPY with shrinkage toward 1.0 below 20 obs and clamps [-1, 3.5];
sector loading regressed on the sector ETF's market-residual returns, shrunk
toward 0.6, clamped [-1, 2]; missing legs are labeled `partial`, never zeroed.
The daily residual series for rank history/path features holds the as-of-fitted
betas constant across the trailing window (`betaBasis:
'asOf-fit-held-constant'` — a labeled approximation; betas never see forward
data). Research folds recompute all features at each decision date from data ≤
that date, so residualization is fold-local by construction. A fixed
`fixed-transition` baseline (no fitting at all) ships alongside; the fitted
model must beat it out of sample.

## 6. Sector state

Continuous vector per sector (ETF vs SPY at 5/21 sessions, fitted ETF market
residual, breadth above 20/50/200-day MAs, breadth acceleration, % positive
5/21-session residuals, 63-day new-high/low ratio, return and residual
dispersion, leadership concentration (HHI), top-decile entrants, improving
leaders, turnover change, distance from sector high, trend stability, coverage)
plus a display label. The vector is always preserved. **Weak sector is a
caution, not a veto** — an exceptional stock in a weak sector remains a shadow
candidate with `SECTOR_HEADWIND` raised. The per-session vector is persisted to
`rlt/sector-state.json` (rolling 120 sessions).

## 7. State machine

`DISCOVERED / EMERGING_LEADER / PRIMED / ARMED` derive from the cross-section
(rank change is the discovery feature, not level; extension/consumption block
PRIMED/ARMED; `leaderOnPeerWeaknessOnly` — rank rose while the stock itself went
nowhere — blocks leadership states). `TRIGGERED / ACCEPTED / WEAKENING /
INVALIDATED / EXPIRED / COMPLETED` derive from the Swing Episode Supervisor
lifecycle (`assessment.lifecycleState`); ACCEPTED additionally requires a
positive Stage-B expected-net-utility waterfall. Transitions carry timestamp,
session, prev/new state, reason codes, evidence changes, price, residual rank,
sector state, trigger/fill state, model+feature versions, freshness. A name
that stops qualifying emits an explicit `DROPPED` transition — published
candidates never silently disappear (supervisor union monitoring covers
episodes; the diff covers the inventory).

## 8. Stage A and Stage B targets

**Stage A** — P(upside trigger before downside invalidation or timeout) at
5/10/21 sessions, competing-risk labels reused from lead-time v2 (`up`, `down`,
`timeout`, `censored`; censored rows are excluded from training, never
negatives). Baselines: sector-relative rank, rank acceleration, residual
momentum, fixed-transition; plus Coil/Ghost/ATLAS-X at the research layer.
Fitted challenger: deterministic ridge logistic (no RNG, byte-identical
refits, masked missing values). GAM/CatBoost/LightGBM/Bayesian-hazard
challengers are **externally blocked** by the dependency-free runtime —
recorded, not faked. No deep nets. Output before calibration:
`transitionRank`, `transitionPercentile`, evidence band,
`calibrationStatus: unavailable|collecting|calibrating` — never a number.

**Stage B** — P(target before stop | verified executable fill), per trigger
family (`breakout-acceptance`, `first-pullback`, `pivot-reclaim`,
`tight-range-continuation` — outcomes never pooled without family controls).
Trigger evaluation, executable/gap-through separation, barrier probabilities
(labeled `model-estimate`) and the 7-row expected-utility waterfall are the
shared premove/coil engines. Events kept separate end-to-end: trigger,
executable-fill, no-fill, gap-through-rejection, target-before-stop,
stop-before-target, timeout.

## 9. Execution assumptions

exec-v1 (`lib/execution-policy.js`): entry no earlier than the next session;
gap-through fills at the worse open; a gap beyond 5% of the trigger is refused
(no-fill, honest); no fabricated fill prices; same-bar target/stop ambiguity
resolves to the **stop** (pessimistic). Costs cost-v2 tier priors;
`fillVerified: false` everywhere — never pretended.

## 10. Probability policy

The only path to a displayed percentage: valid artifact matching
`LIVE_VERSIONS` field-for-field with `status:'validated'` → `rltGate(...)
.showProbabilities`. `mayAffectLive` additionally requires `RLT_MODE=enforce`.
No artifact exists — **deliberately**: one must be produced by the offline
training/calibration pipeline and pass review. Until then every surface shows
rank + band + calibration state, via the same `displayNumber` chokepoint
ATLAS-X uses. Sample floors: 30 for bands, 200 for percentages
(`CALIBRATION`).

## 11. Storage artifacts

`rlt/latest.json` (board + leadership snapshot + sector summary),
`rlt/episodes.json`, `rlt/resolved.json` (grader-owned, dedup),
`rlt/predictions.json` (immutable forward log, dedup by predictionId),
`rlt/capture.json` (rolling 90 days of the FULL funnel: selected /
eligible-not-selected / excluded with reasons), `rlt/cross-section/<date>.json`
(**write-once** — an existing date is never overwritten),
`rlt/sector-state.json`, `rlt/alerts/<date>.json`, ledger stream `ledger/rlt/*`
(hash-chained). One authoritative writer per artifact (`op=rltlog`); reads
serve last-known-good on failure.

## 12. Validation protocol

`lib/rlt-research.js` over the shared harness: chronological expanding folds,
grouping by decision date, **exact label-end purge**, 3-trading-day embargo,
uniqueness weighting (effective N), strictly-OOF scoring, date-clustered
block-bootstrap CIs, deterministic LCG seed. Outcome graded on
**sector-relative** terminal return where the sector leg exists (labeled
`outcomeBasis`). The fitted model "wins" only by beating **every** simple
baseline's OOS mean IC; otherwise it is recorded as recreating momentum/rank —
a rejected hypothesis that stays recorded. `op=rltwalkforward` runs the same
comparison over cached real candles server-side (survivorship-unsafe, stamped).
OOF calibration, permutation controls (`lib/orbit-controls.js` battery),
deflated statistics and PBO remain to be wired into the promotion artifact
pipeline — promotion is impossible until they are (fail closed).

## 13. Current evidence — honest classification

- **Deterministic fixture run** (synthetic market, planted ramp-then-persist
  leadership bursts, 2,352 events / 28 dates / effective N 826):
  - `control-random` meanIC −0.004 (not significant) — **leakage-clean**.
  - `rank-level` +0.123 (t 6.96), `residual-momentum` +0.112 (t 6.09),
    `fixed-transition` +0.108 (t 4.32), `rank-acceleration` +0.070 (t 2.59) —
    the machinery detects a planted transition effect. **Experimental**
    (synthetic data proves the measurement works, not that markets pay).
  - `rlt-ridge` +0.023 (not significant) — the fitted model did **not** beat
    the simple baselines on these folds. Honest negative, recorded.
- **Real-market incremental edge: NOT demonstrated.** No real-data
  walk-forward has produced evidence, no calibration artifact exists, no
  prospective episodes have accrued. Classification: **Unavailable due to
  data** (and the available data is survivorship-unsafe by construction).
- Absorption features: **Experimental** OHLCV proxies, explicitly not
  institutional-flow measurement.
- Sector-state classification: **Experimental** (measured breadth, no
  predictive claim).

**No claim of improved predictive power is made.** The system is a measurement
and governance scaffold that can now earn (or refute) that claim prospectively.

## 14. Limitations

1. Sector metadata is present-day (no PIT reclassification history) —
   backtests are survivorship/reclassification-unsafe; every research verdict
   is stamped `productionEligible:false`.
2. `expanded`-universe names have no sector → market-only observations.
3. SPY/sector-ETF candles are fetched live (not cached) — 12 bounded fetches
   per build.
4. Candle cache holds ~300 bars ≈ 14 months — 63-session features + history
   are near the ceiling; long-horizon (12-month momentum) features are out of
   reach without a deeper store.
5. Cross-sectional scan capped at the 600 most liquid names per invocation
   (disclosed in `coverage.note`, never silent).
6. GBM/GAM/Bayesian challengers blocked by the dependency-free runtime; the
   ridge baseline stands in until an offline Python pipeline exports a
   versioned JSON artifact.
7. Percentile history uses as-of-fitted betas held constant over the trailing
   window (labeled approximation).

## 15. Shadow / production status

Everything is shadow. `op=today`, Day Trade, and all live ranking read nothing
from `rlt/*`. The ATLAS-X expert affects only the ATLAS-X **shadow** board
(itself weight-0). Enforcement is triple-locked: registry `maturity:'shadow'`
(strategy-gate fail-closed), `rltGate` artifact requirement, and
`decideRlt`'s SHADOW abstain reason. `assertShadow()` throws if the registry
ever says production. Automatic demotion signals exist (`modelHealth`);
automatic promotion does not.

## 16. Files changed

Fixed defects: `lib/atlasx-routes.js`, `lib/premove-inventory.js`,
`lib/readthrough.js`.
New: 16 `lib/rlt-*.js` modules, `public/js/rlt-lab.js`, 8 `test/rlt-*.test.js`
+ `test/sector-etf-resolution.test.js`, this document.
Integration: `lib/atlasx-{contracts,config,experts,engine,router,survival}.js`,
`lib/strategy-{registry,contracts}.js`, `api/tracker.js`, `lib/warm-chains.js`,
`lib/pulse-routes.js`, `public/js/app.js`, `public/index.html`.

## 17. Tests run

`npm run check` (clean), `git diff --check` (clean), full `node --test`:
**2,536 pass / 0 fail** (baseline before this work: 2,489). New coverage:
leakage/time-travel guard (byte-identical features when future bars are
appended), PIT beta, peer grouping + labeled fallbacks + min-peer-size,
percentile ties + small-group uncertainty, fail-closed eligibility (each named
condition), missing-sector market-only observation, state ladder incl.
extension block + peer-collapse guard + weak-sector caution, lifecycleState
regression, no-trigger-no-trade, shadow/enforce fail-closed, no-model-no-
probability, insufficient-data refuses to fit, DROPPED transitions, trigger
touch-vs-acceptance, gap-through no-fill, family classification, waterfall
row-sum integrity, next-session execution, scan determinism, full-funnel
capture, expert abstain/fire/stale-discount, research fixture (null control,
planted effect, determinism, fail-closed verdict), Day Trade byte-identical
under all RLT_MODE values + pinned eligibility + frozen contract.

## 18. Exact future training / activation steps

1. **Accrue**: the `rlt` warm-chain root runs `op=rltlog` + `op=rltresolve`
   daily post-close (already wired). Nothing else to do; artifacts accrue.
2. **Real-data walk-forward**: `GET /api/tracker?op=rltwalkforward`
   (privileged/expensive) — compares the ladder on cached real candles.
3. **Stage-A training** (when ≥60 independent decision dates of cross-sections
   exist in `rlt/cross-section/`): build labeled rows by joining cross-sections
   to lead-time v2 labels, then `fitStageA(rows)`; fit strictly on dates ≤
   trainedThrough.
4. **Calibration artifact**: produce OOF predictions, isotonic/Platt calibrate
   OOF-only, verify Brier improvement, then write
   `rlt/calibration.json` with ALL `REQUIRED_ARTIFACT_FIELDS` matching
   `LIVE_VERSIONS` and `status:'validated'`. Until reviewed, keep status
   anything else — the gate stays closed.
5. **Promotion** (never automatic): satisfy every `PROMOTION_GATE` criterion in
   `lib/rlt-governance.js`, then a human flips registry maturity in an explicit
   reviewed commit.

## 19. External data blockers

- PIT sector membership history (GICS changes with validFrom/validTo) — needed
  for survivorship-safe sector-relative backtests. No free provider identified.
- Survivorship-safe price universe (delisted names) — exists app-side only as
  the research security master; candle cache remains present-day.
- Verified fills / borrow data — `fillVerified:false` stands until an
  execution feed exists.
- Python ML runtime for GBM/GAM/Bayesian challengers — offline pipeline +
  JSON artifact export is the designed path.

## 20. Highest-value next three experiments

1. **Real-data ladder on cached history** (`op=rltwalkforward`, then weekly):
   does ANY leadership-transition feature beat `rank-level` and
   `residual-momentum` cost-net on real candles? If not at ~30 dates, the
   mechanism-as-measured is weak — record and stop.
2. **False-early-rate study**: of names entering EMERGING_LEADER, what fraction
   reach PRIMED/ARMED vs WEAKENING/DROPPED, and what is the median lead time to
   trigger? This measures the system's stated purpose (earliness) directly from
   the immutable cross-sections — no model needed.
3. **Redundancy audit vs ATLAS-X/Coil/Ghost**: rank-correlation of
   `transitionRank` against each existing score on identical dates; if ρ > 0.8
   anywhere, RLT is a re-labeling, not a new signal — apply the discount or
   retire the overlap.
