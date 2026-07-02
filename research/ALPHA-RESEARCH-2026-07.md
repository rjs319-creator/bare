# Alpha Research — Fable 5 proposals + empirical validation (2026-07-01)

Goal: new techniques to gain edge/alpha across all algos; present highest-yield
options. A Fable 5 agent proposed 8 novel techniques; every testable one was then
run on data — **the survivorship-corrected offline rig** (4217 survivor+delisted
names, PIT monthly cross-sections, 63d forward, cohort-excess) wherever possible,
because that is the honest venue.

## Headline: the ceiling held. No durable NEW standalone alpha found.
Independent fresh tests re-confirmed the multi-session prior conclusion. Details below.

## Empirical verdicts

| Technique (Fable #) | Test venue | Result | Verdict |
|---|---|---|---|
| **Momentum + short-term-reversal composite** (my own thread) | biased current-universe panel | Passed OOS all-blocks (IC ~0.05); BUT pure reversal = **−0.013 (dead)** on the survivorship-CORRECTED rig | ❌ **Survivorship artifact.** Do not ship. |
| Overnight/intraday decomposition (#1) | corrected rig | overnight IC −0.008; intraday IC 0.045 (t=3.02) but Q5−Q1 only **0.15%** (empty) + inverts 2025 | ❌ Statistically sig, economically empty. |
| MAX / lottery exclusion (#2) | corrected rig | negated-IC 0.015 (t≈0.7, not sig); Q5−Q1 **−4.4%** monotone; **inverted in 2025** | 🟡 Directionally real, regime-fragile. Soft exclusion only. |
| Dispersion-conditioned timing (#4) | corrected rig | momentum IC: LOW-disp **0.054 (t=2.17)** > HIGH-disp 0.022 — OPPOSITE of hypothesis; redundant w/ VIX gate | ❌ Wrong-signed + redundant. |
| Momentum × accumulation interaction (#7) | biased panel | min/product ≈ momentum alone (~−0.02 delta) | ❌ Collinear, no lift. |
| Baseline mom_12_1 (control) | corrected rig | IC **0.035 (t=2.16)**, all blocks positive | ✅ The one robustly-significant factor (as always). |

Key methodological catch: short-term reversal looks positive on the app's CURRENT
universe (recent losers that recovered are present; those that delisted are gone),
but is **dead/negative** on the delisted-inclusive panel. This is the exact trap the
research rig exists to prevent, and it invalidated the most promising-looking thread.

## Highest-yield options (ranked; honest expected yield)

The realistic wins are NOT new alpha — they are "extract more from what already
works" and "don't lose to costs/bias." Ranked:

1. **Meta-labeling Gap & Go** (Fable #3) — a secondary take/skip + size model on the
   ONE validated event edge (PF 1.47). Precision, not new alpha; evaluated with the
   same event-backtest discipline that killed the bad rankers. Est: PF 1.47 → ~1.7+
   on the filtered subset. Effort 1–2 days. **Highest durable yield.** (Not yet tested
   — needs the intraday rig; pre-register ≤5 features.)
2. **Fractional-Kelly / vol-target sizing on Gap & Go** (Fable #6) — mechanical, no
   IC claim; higher geometric return + lower drawdown on the validated edge. The only
   "free" win; can't invert. Effort ~1 day.
3. **MAX/lottery SOFT exclusion** (Fable #2) — the only new factor with a real
   economic tail (−4%/3mo top-vs-bottom, monotone). Not significant alone and inverted
   in the 2025 junk-bounce, so use as a down-weight/flag on top-MAX-quintile names
   (esp. small-cap, where it plausibly explains the historical ranker inversions), NOT
   a hard gate. Effort ~½ day. Low-confidence, low-risk.
4. **Widen the daily options/StockTwits archive NOW** (passive, unrecoverable data) —
   from ~30 trending names to the full Coil/Day-Trade candidate list, so the IV/RV
   coil-ranker (#5) and crowding-fade become testable in ~2–3 months. Near-zero cost;
   every un-archived day is lost forever. **Do this today regardless.**
5. **Coil × IV/RV forward test** (Fable #5) — the only untried orthogonal information
   channel (options positioning on price-quiet names). Log IVRV into the coil ledger
   now; evaluate at ≥150 matured picks. Patience, not effort.

## Do NOT pursue (tested dead or artifact)
Momentum+reversal (survivorship), overnight/intraday decomposition, dispersion gating,
momentum×accum interaction, and everything in the prior graveyard (residual momentum,
sector rotation, pure reversal, PEAD reaction-proxy, momentum-acceleration, inverse-vol
weighting, volSurge/base/VCP).

## Reproduce
Scratchpad scripts (session): `build-panel.js` (biased panel), `factor-lab.js`/
`battery-*.js` (fast factor screening), `research-fable.js` (overnight/intraday + MAX
on corrected rig), `research-dispersion.js` (dispersion terciles). Corrected-rig steps:
`research/05,12,17`. Bottom line: the durable lever remains momentum + regime avoidance.

---

# Round 2 — three FREE new-input experiments (2026-07-02)

The second Fable round said the free-data factor space is exhausted, so it proposed
NEW inputs. The top three that cost $0 were tested on the corrected rig. Nothing was
shipped — verdicts only.

| Exp | Test | Result | Verdict |
|---|---|---|---|
| **#1 Time-series SUE** (Foster/Bernard-Thomas PEAD from quarterly EPS actuals) | corrected rig, 80,497 name-months, `research/24-sue.js` | F1 pooled IC **0.0043**, monthly-mean 0.0108 **t=1.55** (<2), decile D10−D1 **0.15%** (empty); F2 small +0.009/large −0.002; F3 persistence hypothesis **false** (same-sign 0.002 < flipped 0.009); **composite-delta −0.0112** (fails the +0.005 bar, HURTS mom+fund); per-year: all signal from **2021 (+0.118)**, dead-to-neg 2022-2025; netIncome robustness 0.005 | ❌ **Dead / redundant.** The secretly-the-reaction-proxy failure mode. Do not ship. |
| **#2 FINRA short interest** (free consolidated SI, 60 month-end settlements, survivorship-safe) | corrected rig, 81,902 name-months, `research/25-si-fetch.js` + `26-si.js` | **(a)** SI%shares fwd63 monthly-mean IC **−0.0606, t=−3.76** (SIGNIFICANT negative); survives MAX control (corr 0.32, residual-on-MAX IC **−0.0477**); robust neg 2021-2024, **flips +0.057 in 2025** junk-bounce. Rank-IC neg but mean-decile +1.75% (rare-squeeze right-skew). **(b)** DTC squeeze-fuel for gap meta-label: cont rank-IC +0.020, mean Q5−Q1 −1.06% | 🟡 **(a) real but SHORT-SIDE** — an avoid/exclusion flag for a long-only book (like MAX), regime-fragile, not a long factor. **(b) fails.** |
| **#3 Gap-cause tagging** (FMP news, `research/27-gapcause.js`) | recent window only (FMP Starter news → ~2025-10 = single risk-on regime) | PILOT, 900 gap-ups: only **32% had news** (68% newsless = coverage bias); tagged subset (tiny n 24-36/class): FADE offering **−0.42%**, MA **−5.69%** (buyout target-pop), vs FDA +12.1%/GUIDE +7.6%/CONTRACT +4.9%; CONTINUE +5.00% vs baseline +3.58% | 🟡 **Directionally supportive, NOT confirmed.** Cause DOES de-lump the edge (offerings + M&A fade) but low coverage + tiny n + single regime. Live-forward pilot needed; don't hard-wire. |

**Round-2 headline: the ceiling still held.** SUE = another dead PEAD variant. Short
interest is the only statistically-significant *new* signal found in the whole multi-
session hunt (t=−3.76) — but it is a **negative/short-side** predictor, so in a long-only
app its only use is as a high-SI **avoidance flag** (and it inverted in 2025). Gap-cause
is a promising *directional* pilot but data-depth-blocked from confirmation.

Lowest-risk actions surfaced (none taken — need review): (1) high-SI% **soft-exclusion
flag** on long screens, sibling to MAX; (2) **log gap-cause forward** + opt-in offering-
skip in `gapTake`, accumulate ≥150/class across regimes; (3) both new pulls are cached
and repeatable (`research/data/short-interest.json`, `research/data/gapnews/`).

---

# Round 3 — cutting-edge METHODS frontier (2026-07-02)

The prior hunt was almost entirely *linear, univariate* factor IC. Round 3 attacks the
**methods** blind spot: nonlinear ML with proper overfitting control, learned regime
detection, and intraday microstructure on the one validated edge. Nothing shipped.

| Exp | Method | Result | Verdict |
|---|---|---|---|
| **N1 Nonlinear ML ranker** (`28-mlrank.py`) | HistGradientBoosting over existing factors + regime interactions vs Ridge on identical features; **Combinatorial Purged CV** (28 paths, purge ±1mo) + purged walk-forward + Deflated Sharpe | OOS rank-IC: **GBM −0.013, Ridge −0.019, raw mom +0.018** (79% pos paths). GBM−Ridge delta +0.005 **p=0.11 (ns)**. Walk-forward LS Sharpe GBM 0.16 (**DSR 0.28**), Ridge 0.03, mom −0.02. Multi-factor combo *degrades* OOS vs raw momentum. | ❌ **No nonlinear/conditional alpha.** The linear verdict survives a proper nonlinear+CPCV test. |
| **N2 Learned regime** (`29-regime.py`) | 3-state Gaussian **HMM** on {VIX, VIX-chg, SPY rvol, SPY ret, credit}, fit on ≤2020, **causal Viterbi filtering** on 2021-26, vs the threshold gate | HMM-gate TEST Sharpe 0.82 / **maxDD −25.4% (no protection)** / ret +89.6% vs threshold-gate 0.78 / **−19.6%** / +54.3% vs buy&hold 0.85 / −25.4%. HMM's "risk-off" state is either capitulation (fwd **+7.65%**, wrong way) or a low-vol grind with zero DD protection. | ❌ **HMM doesn't beat the threshold gate.** Its Sharpe edge is just staying invested more in the bull, not better risk timing. (Caveat: ~1-2 stress events in test.) |
| **N3 Intraday microstructure** (`intraday/experiments/10_microstructure.py`) | Microstructure meta-label (OR width, opening/breakout volume, VWAP dist, time-to-break, gap) on the validated unscheduled-gap ORB edge; OOS split + **deflation (PSR/DSR/PBO)** | take-ALL ORB +1.91%/trade PF 1.48 (n=449). Combined meta-label OOS **+6.32%** (n=12, 3/4 yrs) — but **DSR 0.799 < 0.95**, n=23 total. Best single feature = **breakout-bar volume thrust** (+2.17% OOS edge, intuitive). | 🟡 **LEAD, not shippable.** Improves OOS + year-consistent but fails deflation on a tiny sample — same trap as rig exp05/06 (stacked intraday gates = search luck). |

**Round-3 headline: the ceiling held even at the methods frontier.** Proper nonlinear
ML + CPCV found no conditional alpha the linear tests missed; a learned HMM didn't
out-time the crude threshold gate; the only positive is an *unconfirmed* intraday
microstructure LEAD (breakout-volume confirmation) that fails deflation. Net across all
three rounds this session: **no new shippable alpha** — momentum + regime avoidance
remain the only durable levers, now confirmed under materially stronger methodology.

Only defensible follow-up (instrumentation, not a bet): **forward-log the Gap & Go
breakout-bar volume / microstructure features on the live ledger** so the N3 lead can be
validated out-of-sample without sizing on it. Reproduce: `research/28-mlrank.py`,
`29-regime.py`, `research/intraday/experiments/10_microstructure.py` (all in the
`research/intraday/.venv` which now has scikit-learn + hmmlearn).

---

# Round 4 — realized-edge levers (portfolio construction, 2026-07-02)

Reframe: after 3 rounds proved there's no new *signal* to find, the goal ("higher
edge/alpha") is reachable only through **realized-return** levers on the edges that
already work. Two tests:

**S1 — single-sleeve sizing overlays (`30-sizing.py`) = ❌ no free win.** Long top-decile
small/mid momentum book, 48mo. Fixed Sharpe 0.55 / maxDD −31.5%. Regime-gating a *held*
book HURTS (Sharpe →0.00: the VIX/SMA gate fires near bottoms and misses the rebound —
regime avoidance is for not *entering* new breakouts, not de-risking a held book). Vol-
targeting halves drawdown (−31%→−17%) but cuts Sharpe (0.55→0.37) because this book's
returns concentrate in high-vol periods, so it de-levers exactly when paying.

**S2 — cross-sleeve DIVERSIFICATION (`31-multisleeve.py`) = ✅ THE ONE WIN.** Combining
two low-correlation edges — MOM (top-decile momentum, monthly) and GAP (unscheduled-gap
ORB event sleeve, in cash between signals):

| Book (37mo overlap) | Sharpe | maxDD | Calmar | OOS Sharpe | OOS maxDD |
|---|---|---|---|---|---|
| MOM only | 0.35 | −31.5% | 0.19 | 0.12 | −31.5% |
| GAP only | 1.18 | −12.1% | 1.98 | 1.36 | −10.2% |
| 50/50 equal | 1.14 | −9.1% | 1.82 | 0.98 | −7.3% |
| **inverse-vol (risk parity)** | **1.19** | −11.6% | 1.49 | **1.42** | **−6.3%** |

Sleeve correlation **−0.26**. The inverse-vol combined book **beats the best single
sleeve on Sharpe both in-sample (1.19>1.18) and OOS (1.42>1.36)** with the shallowest
drawdown (−6.3% OOS). This is real diversification (negative correlation) plus the event
sleeve simply being the better edge.

**Honest caveats:** (1) the win leans heavily on GAP ≫ MOM (Sharpe 1.2 vs 0.35) — it's
"add the better edge + diversify," and momentum barely contributes OOS. (2) The GAP
monthly return = mean of that month's ORB trades — a proxy that ignores capacity/overlap
and flatters the event sleeve's Sharpe via within-month averaging; the *direction* is
robust, the magnitude (Sharpe ~1.4) is optimistic. (3) 37mo / 19mo OOS is modest.

**S3 — HARDENING (`32-hardened.py`) TEMPERS S2.** Rebuilt GAP as a real capital-aware book
(K parallel equal-capital slots, capacity-capped — a signal is SKIPPED when all K are
busy given each trade's actual hold — compounding, no within-month averaging) + momentum
turnover cost. Result: the "combined **beats** the best single sleeve" claim **does NOT
survive** — combined-minus-best-single Sharpe is ~0 to slightly negative across K∈{3,5,10}
× cost∈{0,15,30}bps, and a moving-block bootstrap of the joint series gives that delta a
**90% CI of [−0.89, +0.51]** (straddles zero). The naive S2 Sharpe-lift was largely the
within-month-averaging flattery.

What **does** survive: the combined book matches the GAP sleeve's Sharpe (~1.08) at
**~half the volatility and a shallower drawdown** (vol 30%→17%, maxDD −20%→−16% IS; OOS
combined Sharpe 1.96 / vol 10% / maxDD −2.4%). And the real takeaway — the **Gap & Go
event sleeve IS the edge** (Sharpe ~1.1–1.4 even after capacity + costs), while momentum
is weak (Sharpe ~0.3, ~0 OOS) and mostly a smoother.

**Corrected actionable conclusion:** blending sleeves is a genuine **risk/drawdown
reducer at equal Sharpe**, not a Sharpe booster (with only 2 sleeves, one dominant). The
highest-yield realized-edge move is to **lean into the Gap & Go event sleeve** (the best
risk-adjusted edge in the app) and optionally blend momentum in for a smoother ride. A
true Sharpe lift from diversification would need a 3rd genuinely-uncorrelated sleeve.
Caveats: GAP's Sharpe is still somewhat optimistic (simple capacity model, hard intraday
execution, sub-50% hit rate, 37mo).
