# 🧬 Coil Radar — pre-explosion detector (evidence + method)

**Goal:** flag stocks *before* they explode (explicitly **not** names already running up) and
attach an honest, calibrated probability of an upside break.

## What the research actually found (point-in-time, ~2y small+large universe)

Study replays strictly PIT features (only `candles[0..t]`) and measures forward outcomes
cross-sectionally per date (regime-neutral). See `lib/coil.js`, `test/coil.test.js`, and the
scratch harnesses that produced these numbers.

### 1. The naive thesis fails on a loose definition of "explosion"
With `explosion = forward 5–42d max gain ≥ X%` (raw %, MFE), **every classic pre-breakout
signal has ~zero or negative lift**: VCP ≈1.0, pocket pivot ≈1.0, accumulation ≈0.97, tight
range/Bollinger squeeze **0.2–0.7 (anti-predictive)**. The only positive-lift factor is recent
**momentum** (already-run-up) — the very thing the goal says to avoid. Reason: a raw-% target
mechanically rewards high-volatility names that hit any threshold by noise (volatility
clustering), penalizing quiet names.

### 2. The thesis holds on the CORRECT definition — an *abnormal* break
Define `explosion = forward 10d max gain ≥ 2.5× the name's own trailing daily volatility`
(a genuine regime break, vol-normalized). Now the signals **flip to positive lift**:

| Signal (small-cap, >2.5σ break, base 6.5%) | lift |
|---|---|
| Tight 20d range (LO) | 1.24 |
| Bollinger squeeze (LO) | 1.23 |
| ATR contraction 10/50 (LO) | 1.14 |
| Volume dry-up (LO) | ~0.95–1.1 |
| **Recent momentum ret20 (HI)** | **0.86 (does NOT predict abnormal breaks)** |

Large-cap same shape (ATR contraction 1.26, vol dry-up 1.13). **Compression predicts abnormal
breaks and is orthogonal to momentum** — exactly "before, not already running."

### 3. Eleven-variant bake-off → winner: Bollinger-Squeeze-Rank
Eleven expert scoring variants were backtested out-of-sample (walk-forward, 3 expanding folds,
denser step, both 2.5σ/3σ break thresholds), ranked by **mean cross-sectional Spearman IC** vs
the continuous forward-abnormal magnitude, confirmed by top-decile break-rate lift + decile
monotonicity. Variants tried: baseline, pure-compression, TTM-squeeze, Wyckoff-accumulation,
not-extended, Crabel NR7/inside-day, **BB-squeeze-rank**, ATR×volume interaction, trend-filtered,
lift-weighted (data-fit), rank-sum.

Result (small IC / large IC): **V9 lift-weighted 0.132 / 0.110** and **V6 BB-squeeze-rank
0.115 / 0.108** were far ahead of the rest and statistically tied with each other; all others
≤0.093. V9's *fitted weights independently concentrated on V6's exact features* (BandWidth-
percentile, realized-vol-percentile, range tightness; accumulation/ATR/vdu ≈ 0).

**Winner = V6 BB-squeeze-rank** — chosen over V9 for parsimony/robustness (tied IC, better
top-decile lift + monotonicity, and a **fixed parameter-free formula** with no per-scope weight
fitting / look-ahead surface). The insight: score how compressed a name is **vs its OWN
history** (time-series volatility percentiles), not cross-sectionally.

```
coilScore = −1.2·z(bbWidthPctile_126) − 1.0·z(realizedVolPctile_252) − 0.5·z(rangeTight_20)
```

Re-baked isotonic calibration (decile → empirical P(break/10d)):

| coil decile | small-cap P(break/10d) | large-cap |
|---|---|---|
| weakest (D1) | 2.6% | 1.4% |
| strongest (D10) | **12.6% (lift 1.97)** | **7.6% (lift 2.05)** |

Top-decile coils break **~2× as often** as the least-coiled (and ~5× the bottom decile),
cleanly monotone and OOS-stable. This is the number `explodeProbPct` reports — honest
single-digit-to-low-teens odds, **never a fabricated "80%".**

## Social-media / mainstream research (goal directive)
- **VCP / volatility-contraction** (Minervini et al.) IS the mainstream "before-the-breakout"
  method — this build validated it quantitatively *and* correctly sized its modest,
  catalyst-dependent edge. Literature agrees the trigger is exogenous ("a catalyst arrives and
  volatility expands sharply").
- **Social sentiment:** studies find raw sentiment has only *weak* correlation with returns;
  WallStreetBets bullishness is a **contrarian** signal (more positive → underperformance). The
  one useful piece is **attention/message-VOLUME spikes** (coincident catalyst proxy, not a
  leading edge). ⇒ Folding raw social *sentiment* into the score would hurt it. Consistent with
  this project's prior decision to decline hype-based confluence.

## Event-driven backtest of the BREAKOUT TRADE SYSTEM (not just the signal)

Beyond "does it break," we simulated the actual trade plan point-in-time (~2y): enter on a
buy-stop above the 10-day coil ceiling (must trigger within 10 sessions), stop below the
coil / entry−1.5×ATR, target = the calibrated 2.5σ level, managed 15 sessions, **conservative
stop-first fills** (a bar spanning both counts as a stop).

- **Trigger rate ~48–53%** (about half the coils actually break out in-window).
- Of entered: **win ~14–20%, stop ~61–65%** — a low-win, high-R:R breakout profile.
- **Realized avg R/entered (OOS): small/micro ≈ +0.12R, large ≈ +0.03R** (roughly break-even).
  A few ~3R winners carry the low win rate on small-caps; large-caps are a watchlist, not a
  standalone system.

**The ranking result (important, and it changed the product):** we tested whether any score
predicts realized trade R. **Every "conviction" ranker is INVERTED** — OOS Spearman vs realized
R: Expected-R −0.40/−0.37, R:R −0.43/−0.34, break-prob −0.29/−0.29, coil-score −0.39/−0.39;
only **wider stop / higher risk% is +0.35**. Interpretation: the tightest, highest-R:R coils
have the tightest stops, which get **whipsawed** → worst realized trades. So an Expected-R /
R:R ranking (initially shipped) was **removed** — it sorted picks worst-to-best. Picks are now
ranked by **coil strength** (validated for break *likelihood*), with the levels shown as a plan
and the backtested system stats shown honestly in the UI. There is no validated way to rank
*which coil will trade best*, so we don't pretend to.

## Honest limitations
- Modest edge (~1.2–1.3× lift). A coil says a name is *primed*, not that it *will* pop.
- Timing/direction of the eventual break is usually an **exogenous catalyst** (news/earnings)
  a price-only model can't see. Paper-track before sizing.

## Future levers (data-gated)
1. **Attention-volume spike** on a coiled name (message-volume surge, not sentiment) as a
   coincident "catalyst arriving" trigger — needs a social-volume feed (not in the free budget).
2. Earnings-date proximity as a scheduled-catalyst tag on coils (feasible on current data).

## Where it lives
- `lib/coil.js` — `coilFeatures`, `scoreCohort`, `explodeProbability`, `rankCoil`, baked `CALIBRATION`.
- `lib/screener-routes.js` — `runCoil` (`GET /api/tracker?op=coil&scope=small|large|micro`).
- `public/index.html` + `public/js/app.js` — 🧬 Coil Radar subtab (Screeners group).
- `test/coil.test.js` — 10 unit tests.
