# OMEGA — Phase 0 (Inventory · Overlap Map · Feasibility · Optimized Spec)

**Status:** Phase-0 complete + **all three rigor gaps SHIPPED & prod-verified** (2026-07-13). Ground-truthed against the live repo (not memory). Gap 1 (purged+embargoed walk-forward), Gap 2 (uniqueness weighting), and Gap 3 (deflated-Sharpe / multiple-testing gate) are all live on `main`. Verdict across all three: **no durable positive edge; the risk-off veto is the alpha** (see the Phase-A Results box and §4).
**Verdict:** Do **not** build OMEGA standalone. Build it as **`evolve-omega-v2`** — a hardening milestone of the existing EVOLVE engine, reusing the Scoreboard as its evaluation spine. The entire genuine delta is **three rigor additions**; everything else in the original OMEGA spec is already shipped and running in prod.

> **⚑ Phase-A Results (SHIPPED, PR #95 + #96, merged `0a88f80`, deployed, prod-verified).** Built `lib/evolve-walkforward.js` — a purged **+ embargoed** walk-forward over EVOLVE's triple-barrier labels, `op=evolveomegawf` (read-only, rate-limited; no new function). Run against real 5-year multi-regime data (3,873 labels; risk-off ~19%):
> - **Ungated swing IC is negative over a full cycle** (−0.046/−0.064/−0.037 at folds 4/6/8). The earlier 2-year "+0.09 swing edge" was a **risk-on-window artifact** — the same trap the app hit with exits (PF 1.06→0.77) and PEAD (t −3.3→dead OOS).
> - **Risk-off swing IC is robustly negative in every block** (−0.10 to −0.14) → momentum/accumulation ranking **inverts in risk-off**, now confirmed by EVOLVE's own OOS harness.
> - **Avoiding risk-off is defensive, not generative**: it removes the drag (negative → ~flat) but does **not** create a durable positive edge (blocks still sign-flip).
> - **Vol-adjusted (ATR-scaled) barriers** sharpen swing *magnitude* (~0.09–0.13 IC) but **not durability**.
>
> **Net:** no durable positive selection edge at any horizon. EVOLVE's shipped **risk-off long-veto → ABSTAIN** is **vindicated by its own rigorous walk-forward — the regime veto *is* the alpha.** Phase A is now a reusable rigor gate any future EVOLVE change must clear. Prototypes also demonstrated live *why* Gap 3 matters (multiple-testing: 3 horizons × 2 barrier modes × 3 fold-counts surfaced one "pass" that evaporated) — and simultaneously showed Gaps 2 & 3 are now **low-value**, since they would only sharpen significance accounting on a signal already shown to have no durable positive edge.

> **The honesty wall (read this first).** The app's multi-session edge hunt — reconfirmed in code, not just notes — found **no durable, regime-robust, statistically-significant standalone selection edge** on this data. `lib/longshort.js` (t-stat ≈ 0.53, "a momentum tilt, not stock-picking skill"), `lib/exits.js` (composite predicts direction but PF < 1; stops are the leak), and EVOLVE's own 672-label backfill (hit rates 0.063/0.116/0.188 **below** the barrier breakevens, negative SPY-relative → **0 trades live, correct abstention**) all say the same thing. The one durable lever is **regime avoidance** (`lib/apex.js:84-90`, `lib/macro.js:3-6`). OMEGA inherits this wall. Its job is to be the most rigorous possible *arbiter* of that reality — not to conjure an edge that the data does not contain. **Do not claim OMEGA beats the champion until frozen purged walk-forward evidence supports it. "OMEGA correctly abstains" is a valid, shippable outcome.**

---

## 1. Recommendation

| Option | Verdict |
|---|---|
| **Standalone OMEGA** | ❌ Re-implements ~30 engines, the 13-dim regime vector, calibration/abstention, and the entire Scoreboard for zero benefit. Would consume the last free serverless slot (11/12 used) and create a second scorer to keep in sync — you already carry the `apex.js` server/client duplicate as a standing hazard. |
| **`evolve-omega-v2` (build on EVOLVE)** | ✅ EVOLVE already implements ~90% of the OMEGA spec. Add only the three real rigor gaps (§4). No new function, no parallel system, no duplicate scorer. Held to the same champion/challenger bar via `lib/governance.js`. |

**Ship rule:** `evolve-omega-v2` promotes over `evolve-core-v1` only if it beats the incumbent on **frozen purged walk-forward** across all three horizons (5/21/63d) on benchmark-relative, cost-net, calibration, and drawdown. Otherwise it does not promote — and that is reported honestly.

---

## 2. Algorithm / Engine Inventory (ground-truthed)

The app is **not** a handful of momentum screeners — it is ~30 engines, most already tracked by the Scoreboard. OMEGA-as-meta-layer inherits all of them as specialists; standalone would have to re-inventory them.

### Screeners / signal engines
| Engine | Scorer | Scores | Tiers / thresholds | Client dup? |
|---|---|---|---|---|
| Breakout Screener | `lib/screener.js:161` `screenTicker` | 4 filters: base-contraction, vol-surge, RS-vs-SPY, >50/200 SMA | `passesAll4` (`:336`); **relaxed** default drops DEAD vol/base gates, keeps RS+SMA (`:346`) | No |
| Apex Runner | `lib/apex.js` (SSOT) | 4 pillars: Momentum/RS, Technical, Fundamental accel, Supply | `apex≥72`, `loaded≥58`, `watch≥45` (`:91`); `REGIME_WEIGHTS` (`:21`) | ⚠️ **Yes** — `public/js/app.js:2673` (keep in sync) |
| Ghost Accumulation (GAI v3) | `lib/ghost.js` | 6 pillars RM/AF/AV/SF/BONUS/IN | `GHOST≥80&3strong`, `STALKING≥65&2`, `WATCH≥50` (`:140`); AV starved, IN = insider lever | No (server-only) |
| Gap & Go | `lib/gapgo.js:174` | non-earnings ≥5% gap + ORB continuation | GAP_STRONG 5%/MOD 3%, $10M min (`:26`); **validated, DSR 0.99** | No |
| Gap-Down (short) | `lib/gapdown.js:60` | −5%/−3% gap continuation short | STRONG/MODERATE (`:70`); validated short edge | No |
| Day Trade | `lib/daytrade.js:220` | momentum-liquid + explosive small-cap | A/B tiers | No |
| Coil Radar | `lib/coil.js:102` | compression → abnormal (vol-normalized) break | decile band (`:139`) | No |
| Biotech Radar | `lib/biotech.js:197` | catalyst-aware, XBI-benchmarked | Hot≥75/Emerging≥60/Watch (`:213`) | No |
| Momentum | `api/momentum.js` | StrongBuy/StrongSell, excludes extended | `SMA20_MAX_EXT_PCT=8` (`:9`) | — |
| Momentum Ignition | `lib/ignition.js` | acceleration (not distance) | IGNITION≥70/WATCH≥55 (`:195`); EOD-only | No |
| Down-Day Mode | `lib/downday.js:103` | oversold bounce longs on red tapes | WATCH/EMERGING/CONFIRMED | No |
| Options Flow | `lib/optionsflow.js:57` | block/sweep from vol/OI/skew | no paid tape feed | No |
| Market Pulse | `lib/pulse-routes.js` | Haiku search → Fable re-rank | LLM, not a quant scorer | No |
| Trade Alerts | `lib/alerts.js` | social ranker (dedup/coordination/direction) | Wilson edge harness, refuses verdict <50 graded | No |
| **5 AI screeners** | `readthrough.js`, `anomaly.js`, `secondwave.js:106`, `crossasset.js`, `toneshift.js` | 2nd-order / stealth / reflexive / cross-asset / tone-shift; Fable/Haiku judge | Fresh/Moved, Accum/Explained/Noise, PRIMED/EARLY/FADED, LEAD/INLINE/WEAK, BRIGHTENING/STABLE/DARKENING | No |

### Meta / composition / research engines (not in the original OMEGA spec's imagination — all reusable)
Confluence (`lib/confluence.js`), Aligned/Dual-Confirmed (`lib/aligned.js`, `lib/dualread-*`), V-Reversal + Fade inverted-V short (`lib/vreversal.js`, `lib/fade-engine.js`), Trend Rider (`lib/trend.js`), StableCore 12-1 sector-neutral (`lib/stablecore.js`), CERN forced-flow event network (`lib/cern.js`), Attention (`lib/attention.js`), Put-Selling (`lib/putsell.js`), Predict/Crowd/PredMarkets (`lib/predict*.js`), **EVOLVE calibrated ensemble** (`lib/evolve.js`), **Unified Decision Engine / "Today"** (`lib/decision.js`), Why-Now composer (`lib/whynow.js`).

### Regime logic (SSOT)
`lib/macro.js` `stateAt` (`:33`): VIX percentile + `vixRising` + credit (HYG/LQD vs 50-DMA) → `macroRisk = 0.6·vixPctile + 0.4·creditStress` (`:49`). `riskOff = macroRisk≥55 OR vix≥28 OR (vixPctile≥90 & rising)`; `riskOn = !riskOff & macroRisk≤28 & vix<19` (`:52`). Magnitude thresholds serve as hysteresis. Point-in-time via `buildMacroLookup().at(date)` (`:78`) — used by both Scoreboard and harness.

### Backtest / validation harnesses
- `api/backtest.js` — 3 modes: ATR stop/target sim, portfolio (Sharpe/CAGR/maxDD vs SPY), walk-forward (delegates to `runGhostBacktest`). 60/40 IS→OOS, robust flag needs isLift>0 & oosLift>0 & oosN≥30 (`:176`).
- `lib/ghost-backtest.js` — **purged sequential OOS blocks** `purgedBlocks(folds:4, purgeDates:1)` (`:254`); per-pillar rank-IC, sector/size-neutral IC, marginal ablation, Wilson intervals; **ship criterion** MARGIN 0.02 + ≥3 OOS blocks all positive + meanOOS>margin (`:362`).
- `lib/recalibrate.js` — rolling re-optimization on **rank-IC**, **purged expanding-window k-fold** `purgedWalkForward` (`:99`), adopts a re-fit only on **unanimous** OOS-fold agreement (`:133`); IC_MARGIN 0.04, MIN_IC_N 10.
- `lib/research.js` / `exits.js` / `longshort.js` / `pead.js` — edge-discovery + the honesty-wall verdicts cited above.

---

## 3. Overlap Map — OMEGA spec → what already exists (verified file:line)

| OMEGA module (original spec) | Already built? | Artifact |
|---|---|---|
| 1. Point-in-time candidate ledger | ✅ | `evolve/<date>.json` — feature snapshots + preds + regime + all versions (`lib/store.js:908`); `lib/evolve-labels.js:62` `sliceForward` (strictly `date > afterDate`) PIT guard |
| 2. Target construction (5/21/63d, MAE/MFE, benchmark-rel, tail) | ✅ | `lib/evolve-labels.js` triple-barrier FAST +8/−4·5d, SWING +15/−7·21d, POSITION +25/−10·63d (`:32`); SPY-rel + sector-rel + slippage. **Plus** Scoreboard `summarizeReturns` (`apex-routes.js:272`) = MFE/MAE, excess-vs-SPY, sector-rel, `cost-v1` net, median/CI, big10/big20 |
| 3. Algorithm inventory + registry | ✅ | 7 specialists + `SOURCE_SPECIALIST` (`lib/evolve.js:34,49`); `lib/governance.js` registry; `lib/maturity.js` grades |
| 4. Independent signal families | ✅ | `lib/decision.js` **9 EVIDENCE_FAMILIES** + `independentEvidence()` (`:127`), `CORR_DISCOUNT=0.3` (`:90`) |
| 5. Continuous regime model | ✅ | `lib/evolve-regime.js` **13-dim soft vector** (`:26`), Gaussian `regimeSimilarity` (`:154`), recency `similarityWeights` (`:175`), `known:false` for unmeasurable axes |
| 6. Algorithm reliability (hierarchical Bayes) | ✅ | `pooledRate` empirical-Bayes shrinkage (`lib/evolve.js:100`, priorP 0.4/strength 20), `metaWeights` = trust × IC × drift penalty (`:122`) |
| 7. Prediction + calibration | ✅ (partial) | `ensembleProbability` (`:144`) + binned Platt/PAV `fitCalibrator` (`:312`, minN 40, Brier); baseline/GBT stack N/A (no ML lib — deliberate, features die OOS) |
| 8. LLM = text→structured features only | ✅ | Fable (parametric, `maxRetries:0`) / Haiku (search <60s) already constrained this way across AI screeners |
| 9. Economic-utility rank | ✅ | `expectedPayoff` − costs (`:159`), `breakevenProb` (`:90`), `adaptiveThreshold` (`:187`), `evolveScore` (`:222`) |
| 10. Entry timing | ⚠️ EOD-only | `lib/timing.js`, `lib/signal.js` VWAP/ORB — but on **prior-session** 5-min bars, not live. Relabel as "next-open positioning," not "entry timing" |
| 11. Risk / crowding / abstention | ✅ | `decideState` TRADE/WATCH/PROBE/ABSTAIN (`:201`); risk-off veto; guardrails minEffSample 12, watchMinEffN 5, maxProbeShare 0.20, maxProbeCount 9 (`:74`) |
| 12. Walk-forward evaluation | ✅ (partial) | `op=evolvewalkforward` (OOS-on-live-ledger) + `lib/rankquality.js` rank-IC/Brier/lift/monotonicity + the **whole Scoreboard** (regime × liquidity × sector splits, first-appearance dedup, target-before-stop efficacy) |
| 13. Champion/challenger promotion | ✅ | `lib/governance.js` production→reduced→probation→paper→disabled→retired (`:20`); **version guard** drops live models to probation on scoring-version change, prior track record NOT merged (`:65`) |
| 14. API + frontend | ✅ | `op=today` (`lib/decision-routes.js`) + `op=whynow` + 🧬 EVOLVE tab (`public/js/evolve.js`) |
| 15. Monitoring / drift / retraining | ✅ | `op=evolvehealth`; `recomputePerf` BROKEN if Wilson-hi < globalHit−0.15, DEGRADING if recentHit < globalHit−0.08 (n≥15) |

**Net: 13 of 15 modules fully exist; 2 are partial. OMEGA standalone would rebuild all of it.**

---

## 4. The three real gaps (this is all OMEGA actually adds)

Each has existing machinery to borrow — none needs a new engine or function.

### Gap 1 — Purged + embargoed CV wired *into* EVOLVE — ✅ DONE (shipped)
- **Was:** the purged harness existed (`ghost-backtest.js purgedBlocks`, `recalibrate.js purgedWalkForward`) but **EVOLVE's own** walk-forward was OOS-on-live-ledger only; `grep embargo` → zero matches.
- **Delivered:** `lib/evolve-walkforward.js` — trains specialist perf on the strict past, **purges + embargoes** the boundary (calendar-day distance vs each label's forward window, so a 63-day label can't leak into the test block), scores test events via the live path (`specialistProb → metaWeights → ensembleProbability`), reports per-horizon + pooled rank-IC + Brier + a deliberately-leaky comparison (`leakageInflation`). Ship criterion mirrors `ghost-backtest.js` (≥3 OOS blocks, all positive, mean > 0.02). `op=evolveomegawf` (read-only, rate-limited). Opt-in levers `?volAdjust`, `?regime=favorable|riskon`, `?range=1y|2y|5y` — all default-off, production `op=evolvebackfill` untouched. 8 tests; suite green; prod-verified.

### Gap 2 — Overlapping-label uniqueness weighting — ✅ DONE (built)
- **Was:** `grep uniqueness` → zero matches; overlap mitigated only by cohort *spacing*.
- **Delivered:** `lib/evolve-uniqueness.js` — López de Prado average-uniqueness weights (each label weighted by the average, over the days it is open, of 1 / concurrent labels), computed per (ticker, horizon) series. Wired opt-in into the walk-forward perf fit (`fitPerf({weighted})` → honest, de-duplicated `pooledRate` effN), surfaced always as an `uniqueness` summary, exposed via `?uniqueness=1`. 5 tests.
- **Live finding (5y):** the discount is real and horizon-scaled — fast ratio **1.00** (no overlap), swing **0.87**, **position 0.62** (63-day labels only ~62% independent; 38% was double-counting). Applying the weights softens the negatives slightly (pooled −0.045 → −0.030) but the verdict is **unchanged: no-edge** — so the "no durable edge" conclusion is *robust to the overcounting correction*, not an artifact of it. Weighting correctly does **not** manufacture an edge.
- **Live flip — ✅ DONE:** `recomputePerf` now uniqueness-weights the live `pooledRate`/`metaWeights` effN by default (`{weighted:true}`), so production shrinkage reflects the honest, de-duplicated sample (lower effN → more shrinkage → more abstention). Opt-out via `{weighted:false}`.

### Gap 3 — Live deflated-Sharpe / multiple-testing gate — ✅ DONE (built)
- **Was:** deflated Sharpe only as static comment annotations (`gapgo.js:7`); `grep bonferroni|fdr` → zero matches.
- **Delivered:** `lib/evolve-dsr.js` — Bailey & López de Prado Probabilistic + **Deflated** Sharpe (own normal CDF / inverse-CDF), and `gridDeflatedSharpe()` over the specialist × regime × horizon grid: each cell's SPY-relative per-trade Sharpe is judged against the **expected maximum under the null across N trials**, so a cell that looks good only because many were tried does not pass. Uses Gap-B uniqueness-weighted `effN`. Surfaced in the walk-forward output **and** live `op=evolvehealth` (`deflatedSharpe`); reports the trial count explicitly.
- **Live finding (5y):** 18 cells tried, trial-Sharpe dispersion → **E[max Sharpe | null] = 0.32**, while the *best actual cell is SR 0.016* — below what chance alone would produce. **DSR = 0 for every cell; 0 survive; verdict "no cell survives multiple-testing."** The strongest form of the no-edge result: the best cell doesn't even clear the bar random selection would clear. This gate would have killed the "swing vol-adjusted folds=4 passed" mirage on sight — exactly the guard the prototypes proved was needed.
- **Live flip — ✅ DONE:** `recomputePerf` stores the surviving-cell list in the perf ledger; the live `decideState` now applies a **`dsrVeto`** — a candidate is only TRADE-eligible if one of its firing specialists' `specialist×regime×horizon` cell survived the gate. A non-surviving cell is capped at WATCH/PROBE (paper), never a live TRADE — so EVOLVE can never auto-trade on selection-biased evidence. `null` survivors ⇒ gate inactive (backward-safe); with today's ledger (0 survivors) it hard-guarantees no TRADE until a cell earns it.

---

## 5. Data-Feasibility Ledger (gates every module)

**Overall:** this is a **daily / end-of-day dashboard**, not real-time. Stated in `lib/provenance.js:5-7`; every `SOURCE_META` entry is `realtime:false`. **One cron/day** (`vercel.json`: `/api/warm` at `0 13 * * *`, Hobby once/day cap), `maxDuration 60s`, **11/12 serverless functions used**.

| Feature | Available? | Source | Latency / cadence | EOD or intraday |
|---|---|---|---|---|
| Spread / transaction cost | ⚠️ Modeled, not measured | `lib/costs.js` per-tier bps (liquid 3+5, small 15+15, micro 40+35) | static | Heuristic — **no real bid/ask feed** |
| Realized volatility | ✅ | Yahoo daily candles → ATR/stdev | daily | EOD |
| Intraday reversal tendency | ⚠️ Accruing | 5-min bars captured EOD for **prior** session (`intraday-capture.js`) | next-day | Intraday bars, EOD compute |
| Gap-continuation rate | ✅ Validated | `lib/gapgo.js` daily-bar gap% + ORB | daily | EOD |
| Entry-state (VWAP / opening range) | ⚠️ | `lib/signal.js` VWAP/ORB from 5-min bars | prior session | Intraday bars, EOD compute — **NOT live** |
| Options (IV / put-call / OI) | ✅ | Yahoo options v7 (cookie+crumb gated) → atmIV, pcVolRatio, OI | once/day snapshot | EOD; **unrecoverable if a run is missed** |
| Insider (EDGAR Form 4) | ✅ | SEC EDGAR off-box builder → `apex/insider.json` + Finnhub | daily ingest | EOD / point-in-time |
| Fundamentals / earnings actuals | ✅ | Finnhub `stock/metric` + actuals → `apex/fundamentals.json` | daily | EOD |
| Earnings estimates / calendar | ✅ (paid) | **FMP Starter** `/stable/earnings-calendar` (free tier can't) | daily, ~270/min throttle | EOD |
| Catalyst / news | ✅ | NewsAPI (100/day, 2h cache), FMP news, Finnhub, Claude search | ~2h cache | EOD/delayed |
| Regime (VIX / credit / breadth) | ⚠️ **Proxied** | `lib/evolve-regime.js` 13-dim; volTerm/correlation/style = proxy; VIX not ingested as a series | daily | EOD; axes honestly `proxy:true` / `known:false` when unmeasurable |

**Feasibility rulings for OMEGA:**
1. **No live entry timing.** Any "entry-timing model" must be labeled **next-open positioning** and scored via the Scoreboard's `nextOpenReturn` (`entry-v1`) entry-drag — not sold as intraday execution.
2. **No real spread/liquidity feed.** Cost is the `costs.js` per-tier heuristic. Do not imply measured microstructure.
3. **VIX term structure / credit / style are proxies** — keep the `known:false` discipline; never fabricate an axis.
4. **PEAD/surprise history is data-starved** even on FMP Starter (`pead.js:111`) — do not build a surprise-drift feature that needs thousands of events.
5. **Options + social snapshots are unrecoverable** if a cron run is missed — the ledger, not a re-fetch, is the source of truth.

---

## 6. Optimized OMEGA spec (rewritten to target only the gaps)

> Paste this to the build agent. It assumes EVOLVE + the Scoreboard exist and targets only §4.

**You are extending the existing EVOLVE engine (`lib/evolve*.js`) into `evolve-omega-v2`. Do NOT create a new engine, a new serverless function, or a duplicate scorer. Reuse `lib/evolve.js`, `lib/evolve-labels.js`, `lib/evolve-regime.js`, `lib/decision.js`, `lib/rankquality.js`, `lib/governance.js`, `lib/ghost-backtest.js`, and the Scoreboard (`api/tracker.js` → `lib/apex-routes.js summarizeReturns`).**

**Phase A — Purged/embargoed walk-forward for EVOLVE.** Add `lib/evolve-walkforward.js` that replays specialist firings on point-in-time slices (reuse the `backfill.js`/`ghost-backtest.js` slice pattern), labels each with `evolve-labels.js` triple-barrier outcomes, and evaluates the EVOLVE ensemble under **purged + embargoed** blocks: purge gap between train/test (existing `purgedBlocks`), plus an embargo dropping any training label whose forward window overlaps the test window. Report per-horizon rank-IC, calibration (Brier), and the `ghost-backtest.js` ship criterion (MARGIN 0.02, ≥3 OOS blocks all positive). Wire as `op=evolveomegawf` (public read).

**Phase B — Overlapping-label uniqueness weighting.** In `lib/evolve.js` (or a new `lib/evolve-uniqueness.js`), weight each resolved label by average uniqueness (inverse concurrency over its return window) and feed those weights into `pooledRate` and `metaWeights`. Unit-test that a cluster of overlapping 63-day labels contributes < N independent samples.

**Phase C — Live deflated-Sharpe / multiple-testing gate.** Add `lib/evolve-dsr.js`: compute a deflated Sharpe and a multiple-testing-adjusted significance over the specialist × regime × horizon grid, reporting the trial count. A specialist/cell may not be promoted to a TRADE-eligible weight unless it clears the adjusted bar. Surface in `op=evolvehealth`.

**Phase D — Promotion gate.** `evolve-omega-v2` promotes over `evolve-core-v1` via `lib/governance.js` **only if** Phase A shows it beats the incumbent on all three horizons (benchmark-relative, cost-net, calibration, drawdown). Pre-register the criterion (effect size, min resolved count, adjusted α) **before** looking at OOS results. If it fails, keep `evolve-core-v1` as champion and report honestly.

**Constraints:** immutable patterns; small focused files; no hardcoded thresholds (use the existing config/guardrail constants); tests to ≥80% with purged CV in the suite; headless-DOM render check before "done" (not just backend curl); stay at ≤12 serverless functions. **ABSTAIN and "does not beat champion" are valid, shippable outcomes — report them plainly with the numbers.**

---

## 7. Acceptance criteria

- [x] No new serverless function (still ≤12) — folded into `api/tracker.js` as `op=evolveomegawf`.
- [x] No duplicate scorer — extends EVOLVE; scores via the live `specialistProb → metaWeights → ensembleProbability` path.
- [x] Purged **and embargoed** CV runs over EVOLVE labels (`grep embargo` now non-zero).
- [x] Overlapping-label uniqueness weights applied (`grep uniqueness` now non-zero); tested — Gap 2 built (`lib/evolve-uniqueness.js`, opt-in `?uniqueness=1`); position labels ~62% independent; verdict robust.
- [x] Live deflated-Sharpe / multiple-testing gate over the grid; trial count reported — Gap 3 built (`lib/evolve-dsr.js`, in the harness + `op=evolvehealth`); 18 cells tried, 0 survive (best SR 0.016 < E[max|null] 0.32).
- [x] Pre-registered ship criterion frozen before OOS inspection — MARGIN 0.02, ≥3 blocks all positive, mean > margin (mirrors `ghost-backtest.js`).
- [x] Champion/challenger decision honest — Phase A returns `no-edge`/`inconclusive`; **no TRADE-model promotion justified**, incumbent `evolve-core-v1` retained.
- [x] Honest verdict rendered — the harness returns `no-edge`/`inconclusive`/`insufficient` and refuses to pass a non-durable signal.
