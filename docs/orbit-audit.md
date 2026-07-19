# ORBIT — Phase 1 Audit

**ORBIT** = *Orthogonal Residual Bayesian Idiosyncratic Trend*.
Goal: rank stocks by the **calibrated probability of rising over 5 / 21 / 63 trading
sessions**, driven by *company-specific* (idiosyncratic) upward pressure that survives
after broad-market, sector, size, volatility, and common-momentum effects are removed —
and that stays positive across bullish / neutral / bearish / high-vol scenarios.

Version tags introduced by this work: `orbit-features-v1`, `orbit-factor-v1`,
`orbit-state-v1`, `orbit-labels-v1`, `orbit-scenario-v1`, `orbit-model-v1`,
`orbit-calib-v1`, `orbit-wf-v1`, `orbit-decision-v1`.

Status at audit time: repo `main`, HEAD `4371198`, working tree clean except an untracked
`.agents/` dir. Tests run with `node --test` (`package.json`). Deployment is Vercel Hobby,
capped at 12 Serverless Functions — which is why every read/write op is multiplexed through
`api/tracker.js`.

---

## 1. How ORBIT differs from every existing algorithm

The differentiator is the **input transform**, not the packaging. No existing engine
computes a *multi-factor regression residual* (market + sector + size + vol + momentum
jointly removed via rolling regression), and none runs a *Bayesian latent state-space
drift* estimate on that residual, and none emits a *scenario-worst calibrated P(rise)*.

| Engine | File:line | Predicts | Core signal | Family | Overlap risk with ORBIT |
|---|---|---|---|---|---|
| Breakout screener | `lib/screener.js:185,173` | breakout-readiness (0–80 score) | SMA structure, RS-line new-high, base tightness, vol surge | breakout / accumulation | low (ORBIT ignores base/breakout geometry, which research killed) |
| Ghost (GAI) | `lib/ghost.js:150,79` | quiet-accumulation score/tier | 6 regime-weighted pillars incl. insider | accumulation, momentum-tilt | medium (both re-rank; ORBIT removes momentum, GAI keeps it) |
| Ignition | `lib/ignition.js:133,109` | earliest accelerating momentum | price velocity+acceleration, vol expansion | momentum (2nd-deriv) | low–medium (ORBIT neutralises common momentum) |
| Stable Core | `lib/stablecore.js:110` | held quintile, 63d | sector-neutral 12-1 momentum | momentum (classic) | **high on 63d** (ORBIT residual retains a momentum remnant) |
| PEAD | `lib/pead.js:99,211` | drift after earnings | EPS-surprise buckets × SPY-excess | event | low (ORBIT is event-agnostic) |
| Anomaly (Stealth) | `lib/anomaly.js:243,105` | quiet up-move + AI verdict | relVol, no-news, dollar-vol | accumulation / event-absence | low |
| EVOLVE | `lib/evolve.js:253,355` | calibrated P(upper barrier) per specialist | meta-ensemble of the 7 archetypes | **meta-layer** | ORBIT is an *input* to EVOLVE, not a competitor |
| OMEGA-Swing | `lib/omega-swing.js:309,450` | 5–10d continuation + P(resid>0) | MA align, relVol, accel; **2-factor fixed-weight residual label** | momentum continuation | **highest** — nearest neighbour (see §note) |
| Long-term | `lib/longterm.js:33,145` | ±10 daily-trend | signed SMA/RS/slope factors | trend | low–medium |
| Coil | `lib/coil.js:102,152` | P(abnormal break ≥2.5×vol), 10d | BandWidth/vol/range compression | compression | low (orthogonal by design) |
| Failure model | `lib/failure-model.js:98,39` | P(setup *fails*) | overextension/climax/illiquid | adversarial overlay | complementary (a veto, not a ranker) |

**Note on the nearest neighbour (OMEGA-Swing).** `omega-swing.js:450 residualForward`
computes a residual as `fwd − (0.6·SPY + 0.4·sectorETF)` — **two factors, fixed weights,
no regression, no size/vol/momentum leg, and only as a *label*, never as the live ranking
feature**. ORBIT's residual is a *rolling regularised regression* over market + sector +
size + vol (+ optional momentum) estimated **per-name from past data only**, used as the
*feature* the model predicts from. This is a categorical difference, but OMEGA is where
ORBIT's return-correlation will be highest — §12 measures it with `lib/redundancy.js`.

**Where residualisation already exists (and why none suffices):**
- `omega-swing.js:450` — 2-factor fixed-weight, label-only (above).
- `evolve-labels.js:178-179` `spyRelReturn`/`sectorRelReturn` — plain subtraction, one benchmark at a time.
- `screener-routes.js:67` `excB = fwd − beta·sret` — single-factor (market beta only), reporting op only, not in any live score.
- `pead.js:130` — SPY-excess with beta assumed 1.
- `longshort.js` — beta cancels at the *portfolio* spread level; no per-name residual.

Conclusion: ORBIT's *orthogonal multi-factor residual + Bayesian drift + scenario-worst
calibrated probability* is not duplicated anywhere. It is materially different.

---

## 2. Modules ORBIT reuses (do not re-implement)

| Need | Reused module | Exact API |
|---|---|---|
| Daily bars (split-adjusted OHLCV + adjClose + corp actions) | `lib/screener.js:48` | `fetchDailyHistory(ticker, range)` → `{candles:[{date,open,high,low,close,volume,adjClose}], corporateActions, priceBasis}` |
| Universe + sector map | `lib/universe.js:143` | `LARGE, SMALL_CAPS, MICRO_CAPS, SECTOR_OF, SECTOR_LIST` |
| Next-open execution + slippage | `lib/execution-policy.js:72` | `planFill(candles, signalDate, {policy,side,tier,slippagePct})` → fill record; `POLICIES`, `EXECUTION_POLICY_VERSION='exec-v1'` |
| Transaction costs | `lib/costs.js:32,39,51` | `roundTripCostPct(tier)`, `tierForPick(p)`, `netReturn(gross,tier)`, `TIERS`, `COST_MODEL_VERSION='cost-v1'` |
| Single stop/target resolution | `lib/outcome.js:21` | `resolveTrade(candles,fromDate,entry,stop,target,maxHold,short)` → `{outcome,r,hold,exitDate}` |
| Triple-barrier scaling reference | `lib/evolve-labels.js:57` | `barriersFor(horizon,{atrPct,volAdjust})` (pattern; ORBIT keeps its own long-only labels) |
| **Probability calibration** (isotonic/PAV + Brier) | `lib/evolve.js:322,338` | `fitCalibrator(resolved=[{p,won}],{bins,minN})`→`{edges,table,n,error}` or null; `applyCalibrator(cal,p)` |
| Rank-IC / quantile / monotonic / reliability | `lib/rankquality.js:98` | `analyzeRankQuality(items,{minN})`; `informationCoefficient`, `calibration` |
| Deflated / probabilistic Sharpe | `lib/evolve-dsr.js:53,69` | `probabilisticSharpe`, `deflatedSharpe`, `expectedMaxSharpe` (multiple-testing) |
| Signal redundancy / incremental credit | `lib/redundancy.js:131,260` | `buildRedundancyModel(rows,opts)`, `creditFor(model,a,b)` |
| Scenario / macro state (PIT) | `lib/macro.js:64,78` | `fetchMacro()`, `buildMacroLookup(range).at(date)` → `{macroRisk,regime,riskOff,riskOn,vix,credit}` |
| Purge + embargo walk-forward reference | `lib/evolve-walkforward.js` | mirror its purge-by-label-close + embargo + leaky-vs-purged dual report |
| Blob storage | `lib/store.js:316,331` | `readJSON`, `writeJSON(path,obj,cacheMaxAge=0)`, `hasStore()` + a new `orbit/` prefix block mirroring `shadow/` (`:967-989`) |
| Immutable hash-chained ledger | `lib/immutable-ledger.js:134` | `append('orbit', payload, {recordedAt})` |
| Run manifest (deploy SHA + output hashes) | `lib/run-manifest.js:43,92` | `buildManifest(...)`, `commitRun`, `codeVersion`, `hashContent` |
| PIT security master / delisting | `lib/security-master.js:86,146` | `resolveAsOf(record,asOf)`, `universeAt(date)` (see defect §4/§6) |
| Data-quality validation | `lib/market-data.js:26,81` | `validateSeries`, `totalReturnSeries` |
| Strategy registry / grading | `lib/strategy-registry.js`, `lib/maturity.js:113` | add `core:false` entry; grade via Scoreboard section |
| Shadow decision template | `lib/challenger-decision.js`, `lib/challenger-routes.js` | copy the paper/weight-0 shadow pattern verbatim |

ORBIT adds one new shared numeric core, `lib/orbit-math.js` (ridge solve, MAD, robust-z,
fit/apply winsorization, Brier/logloss, sigmoid) — the repo has no ridge/MAD/winsorize
primitive today (`stats.js` = wilson/spearman; `rankquality.js` = IC/reliability only).

---

## 3. Which existing defects could invalidate ORBIT

**D1 — Survivorship bias in every candle backtest (CRITICAL).**
`lib/ghost-backtest.js:149` (and the apex/research replays) draw the historical universe
from the present-day survivor lists `LARGE/SMALL_CAPS/MICRO_CAPS` in `lib/universe.js`.
The PIT security master (`lib/security-master.js universeAt`) is referenced **only** by
`security-master.js` and `lib/provenance-routes.js` — **no backtest calls it**. Delisted
names are therefore absent from every historical cross-section. Any ORBIT backtest built on
these lists inherits the bias: it replays today's winners backward. → ORBIT must set
`researchValidity.survivorshipSafe=false` and block production-grade claims (Phase 11).

**D2 — Single-window regime trap (HIGH).** The project's own multi-session edge hunt
(memory + `lib/exits.js`, `lib/pead.js` reaction-proxy) repeatedly found that promising
in-sample results were **risk-on-window artifacts** that died out-of-sample over 2022. Any
ORBIT result from a 1-year window is one regime and must be treated as `in-sample only`.

**D3 — Sector map is present-day, not PIT (MEDIUM).** `SECTOR_OF` (`universe.js:114-131`)
is a static current classification. Using it historically re-assigns names to sectors they
were not in at the time. ORBIT's factor model must treat sector membership as an
approximation and flag it (`featureVersion` carries `sectorBasis:'current-approx'`).

**D4 — Fundamental PIT depends on report-lag guard (MEDIUM).** `lib/earnings.js pitFundamentals`
applies a 45-day report lag; if ORBIT ever uses fundamentals it must inherit that guard.
The vertical slice is **price/volume only**, so this is deferred, not triggered.

**D5 — `resolveTrade` same-bar ambiguity resolves to STOP (LOW, correct).**
`outcome.js` treats a bar that touches both stop and target as a stop (conservative). ORBIT
labels adopt the same convention explicitly.

**D6 — Yahoo quote is split-adjusted but not dividend-adjusted.** `fetchDailyHistory`
returns split-adjusted OHLC + a separate `adjClose`. ORBIT uses raw close for execution
truth (matching the app) and can opt into `totalReturnSeries` for return labels; it must not
mix the two silently.

---

## 4. Are historical universes point-in-time?

**No.** Backtests enumerate present-day survivor lists (`ghost-backtest.js:149`). A PIT
universe API exists (`security-master.js:146 universeAt(date)` + `constituents.js
fetchRemovedConstituents` returning `[{ticker,removedDate}]`) but the master is unpopulated
by default and unused by any harness. ORBIT's backfill will *accept* a PIT universe if one is
supplied and will otherwise **degrade explicitly** to the survivor list with
`survivorshipSafe:false`.

## 5. Are delisted securities represented?

**No, not in the live universe lists.** `constituents.js` can supply S&P *removed* names with
removal dates (≈55, 3-year), and `security-master resolveAsOf` exposes `active/removedDate`,
but the default backtest cross-section omits delisted names entirely. This biases returns
upward (survivors only).

## 6. Are sector & fundamental data point-in-time?

- **Sector:** No — `SECTOR_OF` is current (defect D3). Approximation, flagged.
- **Fundamentals:** Partially — `earnings.js pitFundamentals` reconstructs YoY growth/accel
  with a 45-day report-lag guard (PIT-safe *for the fields it covers*); `pead.js` documents
  the FMP 12-month estimate cap. ORBIT's slice does not consume fundamentals, so no PIT
  fundamental claim is made.

## 7. Can live features be reconstructed historically?

**Yes, for ORBIT's price/volume feature set.** Every ORBIT feature is a pure function of a
trailing daily-bar window (returns, residuals, demand-pressure, drift-state inputs) plus the
PIT macro closure (`macro.js buildMacroLookup`). The same `orbit-features.js` code path runs
live (last bar) and historically (as-of bar *i*) — Phase 3 ships a test proving that
appending future candles does **not** change an earlier snapshot (causal invariance). Features
that cannot be PIT-reconstructed (current sector, narrative) are excluded from the slice or
flagged.

## 8. Is next-open execution used consistently?

**Mostly, and ORBIT enforces it.** `lib/execution-policy.js` (`exec-v1`,
`DEFAULT_POLICY = NEXT_OPEN_PLUS_SLIPPAGE`) is the canonical entry model, already wired into
`evolve-backfill`, ghost-backtest, and challenger-resolve. The *live* ledger elsewhere is
close-based; ORBIT uses `planFill` for **both** its backtest labels and prospective
resolution so entry timing is identical train/serve. A prediction from a completed daily bar
fills no earlier than the **next** tradable session.

## 9. Is outcome overlap correctly purged?

**Yes, in the good harness — ORBIT mirrors it.** `lib/evolve-walkforward.js` purges training
events whose label window + embargo has not fully closed before a test block, reports the
purged **and** deliberately-leaky reads side by side, and applies uniqueness weighting
(`evolve-uniqueness.js`). ORBIT's `orbit-walkforward.js` reproduces this: purge by **actual
label-end date** (from `orbit-labels.js`), embargo overlapping outcomes, group candidates by
decision date, temporal-uniqueness weight repeated tickers.

## 10. Which integrations are production-active vs shadow-only?

- **Production-active (ORBIT must NOT touch):** `decision-routes.js:51 buildToday` /
  `rankSignals` (the live `op=today` board), `api/warm.js`, `maturity.js`.
- **Shadow / additive (ORBIT plugs in here):** a new `orbit/` storage prefix
  (mirror `store.js:967-989`), immutable-ledger stream `'orbit'`, a `core:false` registry
  entry (`strategy-registry.js`), new `op=orbit*` handlers in `api/tracker.js`
  (`PRIVILEGED_OPS`/`EXPENSIVE_OPS` gating at `:51,81,113,116`), and warm-chain hooks
  (`warm-chains.js` `reprime`/`ticks3`). The Challenger system
  (`challenger-decision.js` + `challenger-routes.js`, dispatched `tracker.js:288-290`) is the
  end-to-end template: `shadow:true`, `deploymentWeight:0`, `governanceStatus:'paper'`,
  own prefix, never in `buildToday`.

**ORBIT's initial live state: `{ shadow:true, affectsLiveRank:false }`. It is graded
`experimental` and carries weight 0 until it passes strict nested outer-OOS *and* prospective
shadow validation. Grade A is never awarded from historical backfill alone.**

---

## 11. Audit conclusion → build plan

The infrastructure to build ORBIT correctly already exists; the binding risk is **data
provenance** (survivorship + single-regime), not method. ORBIT is therefore built to:
(1) reuse execution/costs/outcome/calibration/rank-quality/DSR/redundancy/macro/ledger
verbatim; (2) add only the genuinely-new pieces (multi-factor residual, Bayesian drift,
scenario-worst probability, ORBIT labels/features/model/walk-forward/monitor); (3) run
shadow-only with `affectsLiveRank:false`; (4) refuse production-grade claims while
`survivorshipSafe:false`, and report the honest, weaker, purged result whenever corrected
execution or purging lowers it.
