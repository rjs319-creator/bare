# Quant System Audit

Principal-researcher audit of the stock-selection research + production pipeline in
`market-news-app`. Every material finding carries a `file:line` reference. Findings are classified
**P0** (invalidates results / can cause wrong live decisions), **P1** (materially weakens
prediction or validation), **P2** (useful improvement), **P3** (speculative).

Baseline at audit time: `node --test` = **1136 pass / 0 fail**. Repo on `main`, clean tree.

> **Headline.** This is a mature codebase in which the *machinery* for honest research already
> largely exists (execution policy, triple-barrier labels, purged walk-forward, uniqueness
> weighting, deflated Sharpe, a PIT security-master schema, a provenance spine). The dominant
> problems are (1) the primary backtest **bypasses** that machinery and replays present-day
> universe lists (survivorship-unsafe), (2) the PIT security-master is a **schema with almost no
> real historical data**, and (3) several correctness/statistics gaps (tie-blind AUC, calendar-day
> purge approximation, portfolio fill-day P&L, in-sample calibration error, effective-N summed
> across correlated specialists). None of the fitted/shadow scores are wired into the live rank —
> the live rank is a **heuristic composite**, honestly labeled as a rank, not a probability.

---

## 1. Pipeline map (data → decision → feedback)

```
data source (Yahoo EOD daily candles; Finnhub fundamentals; EDGAR insiders; LLM web-search)
  → availability: after each session close; fundamentals/insiders lagged; LLM at request time
  → universe: STATIC present-day lists  LARGE/SMALL_CAPS/MICRO_CAPS/BIOTECH  (lib/universe.js:143)
              + live NASDAQ directory expansion (lib/universe-expand.js)         ← survivorship-unsafe
  → features: lib/screener.js evalSetupAt (flags), lib/signal.js (RSI/ATR/…)      ← boolean/heuristic
  → candidate generation: per-screener scanners (~30 scorers, see §3)
  → model/heuristic: lib/decision.js compositeScore (multiplicative heuristic)     ← LIVE RANK
                     EVOLVE ensemble / OMEGA / omega-swing / failure-model         ← SHADOW/standalone
  → calibration: lib/calibration.js / recalibrate.js used ONLY by Apex + op=calibration, NOT live rank
  → rank: lib/decision.js rankSignals (op=today)                                    ← what users see
  → portfolio: lib/decision-portfolio.js (constraints); api/backtest.js portfolioMode (sim)
  → execution: lib/execution-policy.js planFill (next-open + slippage)              ← honest, shared by backfills
  → outcome resolution: lib/outcome.js resolveTrade (live ledger) ; lib/evolve-labels.js (triple-barrier)
  → feedback/retraining: Scoreboard track record tilts compositeScore (expectancyTilt);
                         EVOLVE specialist perf recomputed from resolved ledger
```

### Live entry points and what controls each rank (all heuristic; none calibrated to probabilities)

| Surface | Route / file:line | Sort key | Nature |
|---|---|---|---|
| **op=today** (default landing) | `lib/decision-routes.js:76` → `lib/decision.js:559` | `compositeScore = confidence × regimeFit × execution × expectancyTilt × evidenceMult × costPenalty × remainingMult` (`lib/decision.js:343`) | multiplicative heuristic; one empirical input (`expectancyTilt`, shrunk Scoreboard tilt, `lib/decision.js:277`) |
| Breakout / Ghost | `api/screener.js:398`, `:486` | fixed-weight percentile composite `DEFAULT_WEIGHTS` (`api/screener.js:75`) | hand-set weights |
| Picks | `api/picks.js:147` | `techScore + overallRating` / LLM rating (`api/picks.js:118,356`) | LLM + heuristic |
| Momentum | `api/momentum.js:135` | live technical confidence | heuristic |

Scores are **honestly labeled as ranks, not probabilities** (`lib/decision.js:394`,
`lib/omega-ensemble.js:138`). The live rank paths do **not** call `lib/calibration.js` /
`lib/recalibrate.js` (those serve only the Apex model ledger + `op=calibration`).

### Shadow / standalone (do NOT affect the live rank)
- **EVOLVE** (`lib/evolve.js`, op=evolve) — own tab; not merged into op=today.
- **OMEGA ensemble** (`lib/omega-ensemble.js`) — a *projection* of op=today, scores nothing (`:4-12`).
- **omega-swing** (`lib/omega-swing.js`, op=omega) — own tab, own utility score, not fed to op=today.
- **failure-model** (`lib/failure-model.js`) — `shadow:true` (`:103`), attached after ranking, "does NOT touch the rank" (`lib/decision-routes.js:78`), UI says so (`public/js/today.js:183`).

---

## 2. Per-prediction-system credibility table

| System | Live entry | Research/backtest entry | Label | Validation | Execution assumption | Affects live rank? | Kind | Hist == live scoring? | Credible? |
|---|---|---|---|---|---|---|---|---|---|
| Screener composite | `api/screener.js` | `api/backtest.js` | ATR stop/target (`lib/outcome.js`) | single 60/40 split, ≤12mo (`api/backtest.js:127,186`) | next-open+slip (`:28`) | **yes** (Breakout tab) | heuristic weights | **partial** — narrative/BONUS not reconstructed | weak (survivorship + thin split) |
| Decision composite (op=today) | `lib/decision.js` | none (live-ledger Scoreboard only) | `lib/outcome.js` | live OOS only (thin, un-purged) | next-open | **yes** (default) | heuristic | n/a | provisional |
| EVOLVE ensemble | `lib/evolve.js` | `lib/evolve-walkforward.js` (purged) | triple-barrier (`lib/evolve-labels.js`) | purged+embargoed WF, DSR | next-open (`lib/evolve-backfill.js:133`) | no (shadow) | fitted (empirical-Bayes) | mostly (price-only) | best-validated, but not live |
| omega-swing | `lib/omega-swing.js` | op=omegawf | sector-residual 5/10d | purged WF | next-open | no | interpretable formula | yes | provisional (IC ~0.01 ns) |
| failure-model | `lib/failure-model.js` | `lib/failure-model-eval.js` | stop-hit | replay | n/a | no (shadow) | heuristic | candle-subset only | held shadow (honest) |

---

## 3. Bias / leakage investigation

- **Survivorship (current-universe replay).** **P0.** `api/backtest.js:128,240` select `MICRO_CAPS / SMALL_CAPS / LARGE` — static present-day arrays (`lib/universe.js:143`; header admits "constituents drift", `:2`). History is replayed over *today's survivors*. The PIT security-master (`lib/security-master.js`) that could correct this has **zero callers in any backtest** — it is used only by its own build/read routes.
- **Missing delisted securities / PIT constituents.** **P0.** `lib/security-master.js` corrects *delisting* survivorship only, from a **5-year Wikipedia S&P-500 scrape** (`lib/constituents.js:10`), and is honestly silent on late listings (no IPO feed, `:84`). `firstSeen` is "first seen in our ledger", not a listing date (`:13,70`). No stored historical constituents exist in-repo. **A backtest cannot reconstruct the 2022-06-01 tradeable universe from real PIT data.**
- **Symbol changes / reused tickers.** Partially addressed by design: `securityId == Yahoo symbol` (`lib/security-master.js:42`) — no CUSIP/FIGI, so a reused ticker still merges two securities. Documented honestly.
- **Split/dividend treatment.** Prior work established Yahoo quote is already split-adjusted; additive corporate-action metadata exists (`lib/market-data.js`). Not a live-rank risk.
- **PIT sector classification.** Live sector from mutable `SECTOR_OF`; secmaster attaches a static sector, not time-varying. **P2.**
- **PIT fundamentals / filing dates.** Backtest loaders ARE point-in-time: `lib/earnings.js:60` admits a quarter only when `period + 45d <= asOf`; `lib/edgar.js:121` filters by `filingDate`. Caveat: a **fixed 45-day lag** approximates the real filing date. **P2.** Live `lib/fundamentals.js:38` uses latest/restated TTM (correct for "now").
- **LLM access to post-decision info.** **P1.** LLM narrative (BONUS pillar, `lib/ghost.js:94`) is a live feature pinned to `null` in the historical reconstruction (`lib/ghost-backtest.js:250`) — the walk-forward validates a **price-only subset**. AI-derived screeners are not historically reconstructable at all.
- **Historical/live feature skew.** **P1.** The price features in `api/backtest.js featVec` reuse the live `evalSetupAt` (no skew there), but narrative/BONUS/IN pillars are only partially reconstructed (above).
- **Overlapping outcomes / repeated tickers / same-date dependence.** **P1.** `api/backtest.js` STEP=5 with MAX_HOLD=20 (`:11,14`) → heavily overlapping windows, no uniqueness weighting in the *basic* backtest. EVOLVE's WF **does** apply López-de-Prado uniqueness (`lib/evolve-uniqueness.js`) and same-date grouping.
- **Calendar-day purge / holidays.** **P1.** `lib/evolve-walkforward.js:31,45` purges by `(window+embargo)×1.4` **calendar** days, not exact label-end/trading days → leaks or over-purges near holidays. (Fixed by `lib/research/label-purge.js`, this slice.)
- **Multiple testing / thresholds chosen after inspection.** **P1/P3.** EVOLVE reports a grid deflated Sharpe (`lib/evolve-dsr.js`), but app-wide feature/threshold search across dozens of screeners is not globally deflated. No manifest counts total experiments attempted (added this slice).
- **Calibration leakage.** **P1.** `lib/evolve.js:322` fits the calibrator bin table on `rows` and reports its Brier over **those same rows** — in-sample, optimistic. The purged WF itself applies **no** in-fold calibrator (honest, `lib/evolve-walkforward.js:20`).
- **Unrealistic fills / gap-through / same-bar ambiguity / delisting losses.** Largely correct: `lib/execution-policy.js` models next-open, gap-through-trigger, per-side slippage, no-fill; `lib/outcome.js` and `lib/evolve-labels.js` resolve same-bar stop/target **conservatively to the loss**. Delisting *losses* are not simulated (no delist-return data).
- **Portfolio accounting.** **P1.** `api/backtest.js portfolioMode` holds a name only when `entryDate < D` (`:287`) and marks to **close** prices — so the **fill-day open→close P&L is omitted** and barrier exits are realized at the day's close, not the modeled stop/target price. No trade↔portfolio reconciliation test.
- **Scores presented as probabilities.** Refuted — honestly labeled as ranks (`lib/decision.js:394`).
- **Correlated screeners counted as independent / effective N.** **P1.** `lib/evolve.js:148` sums `effN += c.effN` with no cross-specialist redundancy discount, feeding the TRADE gate `effN >= minEffSample` (`:206`). Prior work proved ghost×screener ≈0.96 correlated — two such specialists inflate effective sample.

---

## 4. Part XVIII — confirm / refute (evidence · consequence · fix · test)

| # | Claim | Verdict | Evidence | Consequence | Fix | Test added |
|---|---|---|---|---|---|---|
| 1 | Backtests replay present-day LARGE/SMALL/MICRO lists | **CONFIRMED (P0), PARTIALLY FIXED** | `api/backtest.js:128,240`; secmaster unused by any backtest | survivorship bias inflates all backtest edges | **`?pit=1` wires `pointInTimeAugment` into the backtest — LARGE-CAP ONLY (see §6)**; still survivorship-unsafe until real PIT data exists | pit gating tests; harness stamps `survivorshipSafe:false` |
| 2 | 12mo max + single 60/40 split inadequate | **CONFIRMED (P1)** | `api/backtest.js:127,186` | one split over one regime, no purge → unstable, optimistic | use nested purged WF (already in `evolve-walkforward`/`harness`) | harness folds test |
| 3 | 5-day sampling, 20-day outcomes → dependent obs | **CONFIRMED (P1)** | `api/backtest.js:11,14` | autocorrelated samples overstate significance | uniqueness weighting + date-clustered stats | `uniquenessSummary` in harness |
| 4 | Logistic target = positive SPY excess, not net utility | **CONFIRMED (P1)** | `api/backtest.js:205` `y: t.excess>0?1:0` | optimizes a gross-excess hit, not net expectancy | target net-of-cost residual return | harness outcome = residual return |
| 5 | AUC mishandles tied predictions | **CONFIRMED (P2)** | `api/backtest.js:117` raw sort-position ranks | ties bias AUC (common with binary-flag models) | **FIXED** — reuse `rankquality.averageRanks` | aucRank tie test |
| 6 | Portfolio omits fill-day open→close / barrier reconciliation | **CONFIRMED (P1), FIXED** | `api/backtest.js` `entryDate<D`, close-based MTM | equity missed fill-day move + realized barriers at close | **FIXED** — `simulatePortfolio`/`positionDailyReturn`: fill-day open→close from the modeled fill price, barrier exits realized at the stop/target price; self-reconciles (each in-window trade's compounded daily path == its realized r), reported as `accounting.reconciliation.maxAbsError` | portfolio-reconciliation tests |
| 7 | EVOLVE label entry inconsistent with next-open | **REFUTED** | `lib/evolve-backfill.js:133` uses `planFill(NEXT_OPEN)`; `labelEvent` is test-only | none — labels enter next-open | — | label entry == fill (research-slice generator) |
| 8 | Profitable timeouts treated as losses | **PARTIALLY CONFIRMED (P2)** | `lib/evolve-labels.js:117` won:false on time; used in win-rate/cal (`evolve-walkforward.js:63,146`); IC uses `terminalReturn` (`:129`) | win-rate/Brier understate up-drifters (legit for triple-barrier) | **ADDED** honest `profitable` field | positive-timeout test |
| 9 | Ensemble discards candidate raw strength | **CONFIRMED (P1), SHADOW FIX** | `lib/evolve.js` specialistProb = pooled base rate | two candidates → identical P regardless of setup strength | **SHADOW** — `candidateStrengthTilt` differentiates equal-context candidates by their own percentile (bounded log-odds tilt); exposed as `strengthAdjustedP`, **NOT** in the decision/rank until OOS-validated (coefficient is asserted, not fit) | strength-tilt tests |
| 10 | Effective N summed across correlated specialists | **CONFIRMED (P1), FIXED** | `lib/evolve.js` `effN += c.effN`; gate `decideState` | inflated effective sample; passed the TRADE gate on ~1 source | **FIXED** — `ensembleProbability` discounts effN by measured effective independence (`redundancy.effectiveEvidence`); model built in `recomputePerf`, cached in perf, wired via ctx; reports `effSampleRaw` + `independenceRatio` | effN-discount + TRADE-gate tests |
| 11 | Calendar-day purge mishandles holidays | **CONFIRMED (P1), FIXED & WIRED** | `lib/evolve-walkforward.js:31,45` `×1.4` | leak/over-purge near holidays + over-purges early-resolving labels | **`labelClearsTestBlockExact` is now the PRIMARY purge in the EVOLVE walk-forward** (real `labelEndDate`); ×1.4 only for the embargo buffer + legacy fallback; `purge.method` reported | exact-purge unit + walkForward tests |
| 12 | Historical models reconstruct feature subset | **CONFIRMED (P1)** | `lib/ghost-backtest.js:250` narrative null vs live `lib/ghost.js:94` | WF validates a price-only subset of the live model | reconstruct or clearly scope BONUS/narrative claims | — (documented) |
| 13 | Fundamentals/insiders not PIT | **REFUTED (caveat)** | `lib/earnings.js:60`, `lib/edgar.js:121` are PIT | — (45-day lag is an approximation) | drive off actual filing dates | — (P2) |
| 14 | AI signals not historically reconstructable | **CONFIRMED (P1)** | narrative null in backtest (`ghost-backtest.js:250`) | LLM features unvalidated historically | treat AI signals as live-only, exclude from historical claims | — (documented) |
| 15 | Multiple specialists re-express one momentum factor | **CONFIRMED (P1)** | prior redundancy work; `lib/evolve.js` family map | correlated "confirmation" double-counts momentum | redundancy-discounted ensemble (links #10) | — (redesign) |
| 16 | Repeated experimentation not deflated | **PARTIALLY CONFIRMED (P2)** | `lib/evolve-dsr.js` deflates a grid, but not app-wide search | optimistic significance across the whole app | manifest records `relatedExperimentsAttempted` | manifest field present |
| 17 | Shadow systems shown near live ranks | **REFUTED/mitigated** | failure-model `shadow:true` + UI label (`today.js:183`); EVOLVE/omega separate tabs | — | keep separation | — |
| 18 | Calibration evaluated without in-fold fit | **CONFIRMED (P1), FIXED** | `lib/evolve.js` `fitCalibrator` in-sample Brier | surfaced calibration/Brier was optimistic | **FIXED** — `fitCalibrator` now also reports k-fold `oofBrier` (calibrated, out-of-fold) + `oofBrierRaw` baseline + `calibrationHelpsOOS`; shared `binnedMap`/`oofCalibratorBrier` | OOF-Brier tests (calibration lowers OOF on overconfident data; no spurious gain when already calibrated) |

---

## 5. What this slice changed vs. what remains

**Shipped (additive, tested, no live-rank change):** canonical schemas, exact label-end purge,
continuous feature interface with parity, date-grouped baseline rankers, purged group-aware
comparison harness + reproducible manifest, `evolve-labels` `labelEndDate`/`profitable`, tie-corrected
`aucRank`. See `docs/quant-redesign.md`.

**Remains (needs data or larger refactor):** real PIT constituents/delisting-returns (external
data), reconstructing/scoping AI-narrative features (#12/#14), and PROMOTING the candidate-strength
tilt (#9 — shipped as a shadow field, needs OOS evidence that within-context strength predicts the
outcome before it may drive the gate). (`universeAt` is now partially wired via `?pit=1` — see §6.
Fixed since the initial audit: exact label-end purge (#11), portfolio fill-day P&L + reconciliation
(#6), redundancy-discounted effective-N (#10), out-of-fold calibrator Brier (#18); candidate-strength
tilt (#9) shipped shadow-only.)

---

## 6. Point-in-time universe (`?pit=1`) — capability and its LARGE-CAP-ONLY limitation

`api/backtest.js` gained an **opt-in** de-survivorship path (`?pit=1`, default off → legacy behavior
byte-identical). `resolvePitUniverse` calls `security-master.pointInTimeAugment`, which adds back the
"survivors that died" — securities active at the window's `asOf` date but delisted since
(`universeAtFrom(asOf) \ universeAtFrom(today)`). It returns a `pit` block with `addedDelisted` and,
critically, `addedWithData`/`addedNoData` so the gap is **quantified, not hidden**. It always stamps
`survivorshipSafe:false`.

**Live prod evidence (`months=54`, `asOf` 2022-01-17), after fixing the delisting scrape (see below):**

| scope | `applied` | universe | delisted added | with data |
|---|---|---|---|---|
| large | `true` | 528 → 579 | 51 (ATVI, CERN, CTXS, ABMD, DISH…) | 27 |
| small | `false` | 163 (static) | — | — |
| micro | `false` | 79 (static) | — | — |

**LIMITATION — de-survivorship is LARGE-CAP ONLY (P1).** The *only* delisting source is the S&P-500
"changes" scrape (`lib/constituents.js`, all large-cap, ≤5yr), and the security master carries **no
cap-tier field**, so a died-since name cannot be attributed to a cap band. An earlier version added
the same 51 large-cap names to *small and micro* universes too — names that were never in those bands
— making those backtests **less** representative. `resolvePitUniverse` now restricts augmentation to
`scope=large`; **small/micro return `applied:false`** with an explicit note that no cap-appropriate
delisting coverage exists (`api/backtest.js` `resolvePitUniverse`; tests in `test/research-slice.test.js`).

**Other standing limits (why it is STILL not survivorship-safe, even for large-cap):**
- **No late-listing/IPO feed** — a name listed after `asOf` is not excluded (`security-master.js:84`).
- **Delisting coverage is shallow** — S&P-500 only, ≤5yr; small/micro delistings (the bulk of
  survivorship risk) are entirely uncovered.
- **`addedNoData` names are untradeable** — ~24/51 delisted names have no free candle data, so they
  cannot be traded in the backtest even though they are correctly *counted*.
- **Prerequisite: the security master must be rebuilt** (`op=secmasterbuild`, cron-gated) after the
  scrape fix, or it holds zero removed records.

**Related fix — the delisting source was silently empty (P0→fixed).** `fetchRemovedConstituents`
parsed the Wikipedia table with a strict `/<tr>/` that matched **zero** rows once Wikipedia emitted
`<tr class="...">`, so the master had **no** removed records and `?pit=1` added nothing regardless of
`asOf`. Fixed to `/<tr[^>]*>/` (extracted pure `parseRemovedConstituents` + regression test); live
scrape now returns 94 removed names (was 0).

**Net:** `?pit=1` on `scope=large` is a real, measured *reduction* of survivorship bias (27 formerly-
invisible delisted large-caps now trade in the backtest), but it **narrows and quantifies** the gap
rather than closing it. Full closure still requires real point-in-time constituents + delisting
returns across all cap bands.
