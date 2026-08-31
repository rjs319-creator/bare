# CFR — Cross-Sectional Forecast & Ranking

A research and decision-support system that predicts and ranks **market- and sector-neutralized
residual returns** over **1, 3, 5 and 10 trading sessions**.

> **It does not trade.** Nothing in `lib/forecast/*`, `research/88-forecast-walkforward.js` or the
> `op=forecast*` routes places an order, alters a portfolio, writes a production ledger, deploys
> anything, or promotes a strategy. Every route is read-only.

---

## 1. What is being predicted

**Not price.** The primary target is the residual return that remains after the market and the
name's sector have been stripped out, because that is the part a cross-sectional ranker can
plausibly add value on.

### 1.1 Target equation (`residual-mkt-sector-v1`, the default)

All betas are estimated from **trailing data available at the decision date `t` only**, and are
orthogonalized so market exposure is not charged twice:

```
b_m(i,t)   = OLS slope of  r_i   on r_m           over the trailing window ending at t
b_sm(s,t)  = OLS slope of  r_s   on r_m           (the sector proxy's own market beta)
e_s        =              r_s - b_sm * r_m        (the sector's market-residual series, ⊥ r_m)
b_s(i,t)   = OLS slope of (r_i - b_m*r_m) on e_s

residual(i,t,h) = fwd_i - b_m * fwd_m - b_s * (fwd_s - b_sm * fwd_m)
```

Because `e_s ⊥ r_m` by construction, this sequential fit reproduces the two-factor multivariate
OLS while making the no-double-counting property visible. A test pins it
(`test/forecast-targets.test.js`, *"neutralize does not double-count market exposure"*).

Betas are **shrunk toward their economic prior** (market → 1.0, sector → 0.0, `betaShrink`
default 0.25) and **clamped** (market `[0,3]`, sector `[-1.5,2.5]`). A 60-observation OLS slope on
a thin name is mostly noise, and an unclamped beta manufactures residual return out of estimation
error.

### 1.2 Supported alternative definitions

`raw-v1`, `market-relative-v1`, `sector-relative-v1`, `beta-market-residual-v1`. Set
`target.definition`. An unknown definition fails closed to `null` — it never silently becomes raw
return.

### 1.3 Derived labels

| Label | Definition |
|---|---|
| `classes['0']` | residual return > 0% |
| `classes['0.03']` | residual return > 3% |
| `classes['0.05']` | residual return > 5% |
| `classes.drawdown` | peak-to-trough drawdown of the **raw held path** > 5% |
| `realizedVol` | annualized sd of daily returns inside the holding window |

Thresholds are configurable (`returnThresholds`, `drawdownThreshold`). **Class prevalence is
reported by horizon** in every benchmark artifact — the 5% threshold is genuinely rare at 1 session
(~2%) and common at 10 (~17%), and the system says so rather than hiding it.

The drawdown label includes the current bar's high in the running peak before measuring that bar's
low against it. Daily bars do not order high vs low; this is the conservative reading for a long,
so the label never understates the risk a stop would have seen.

---

## 2. Prediction and execution timing

One convention, shared with the rest of this repository (`lib/execution-policy.js`
`POLICIES.NEXT_OPEN`) so research, backtest and serving cannot disagree:

```
decision session t   features computed from bars at or before t's CLOSE
entry                the OPEN of session t+1        -> labelStart / tradableAt
exit                 the CLOSE of session t+h       -> labelEnd
```

`h = 1` therefore means *buy tomorrow's open, sell tomorrow's close*. A close-to-close signal can
never execute at the same close, and a test asserts the fill session is strictly after the
decision session.

---

## 3. Point-in-time guarantees

Every feature row is reproducible as of its prediction timestamp, and carries the stamps that let
an audit prove it:

| Stamp | Meaning |
|---|---|
| `pit.asOf` | decision session |
| `pit.tradableAt` | first executable session |
| `pit.labelStart` / `pit.labelEnd` | the label interval — the purge axis |
| `pit.maxSourceTs` | the latest datum the row touched |
| `pit.marketTimezone` / `pit.session` | `America/New_York`, `regular` |

**Never used:** future bars, centered rolling windows, backward fills from future observations,
revised values before release, event outcomes before publication, today's universe membership in
historical periods, or globally fitted transformations spanning evaluation data.

`lib/forecast/leakage.js` **fails closed**: a check that could not run counts as a failure, and an
audit with any failing check fails the fold.

### 3.1 Known PIT limitations (stated, not hidden)

- **Sector classification is the CURRENT vendor mapping** (`lib/universe.js SECTOR_OF`), not
  point-in-time. The repository has no historical sector series. Every row carries
  `quality.sectorBasisPointInTime = false` and every sector-conditioned result inherits it.
- **Survivorship is reduced, not proven safe.** The local price cache was assembled from a
  present-day symbol list. Per-date staleness and liquidity gates remove names once their bars
  stop, which reduces the bias but cannot eliminate it. `survivorshipSafe` is hard-coded `false`
  and nothing may claim otherwise.
- **No fundamentals, macro, options, news or event features are wired in.** They are P2 and were
  deliberately left out rather than added without trustworthy release/effective timestamps. See
  §12.

---

## 4. Universe construction

Per decision date, from bars at or before that date only (`lib/forecast/universe.js`):

minimum price · minimum trailing average dollar volume · minimum history · configurable sector
exclusions · staleness gate in real sessions · suspected-unadjusted-corporate-action gate
(any |1-day| move > 50% in the lookback) · tradability (a next-session open must exist).

Every admitted **and** rejected name carries a reason from a closed vocabulary
(`universe.REASONS`), and the snapshot reports the exclusion histogram.

---

## 5. Features

`lib/forecast/features.js` computes **41 trailing columns**; `lib/forecast/xsection.js` adds a
within-date percentile rank for each of the 33 continuous ones plus 5 date-context columns, for
**79 columns on the row**. Of those, **71 reach the model** — see *Date-constant columns* below.
The meta-ranker then sees those 71 plus 6 summaries per base model and 6 cross-model columns:
**83 inputs** with the baseline alone, **95** with all three base models. Every column reads bars
at or before the decision index. Groups: trailing returns and
momentum, short-term reversal, residual momentum, realized/downside/vol-of-vol, ATR, trend slope,
distance from SMA50/SMA200, drawdown, range, gap, dollar volume, abnormal volume, Amihud
illiquidity, a daily-bar spread proxy, market/sector betas and correlations, calendar terms, and
explicit data-quality columns.

Two leakage rules are structural, not stylistic:

- **Within-date transforms** (percentile rank, robust z, breadth, dispersion, sector aggregates)
  are computed from one decision date's cross-section, all of it observable at that date's close,
  so they need no train fit.
- **Train-fitted transforms** (winsorization limits, standardization, median imputation) are
  fitted on training rows only via `xsection.fitScaler`, which records `fittedThroughDate` so
  `leakage.auditScalerFitWindow` can prove no evaluation row contributed.

A feature that cannot be computed is `null` **and** listed in `missing`. Nothing is imputed at
source, nothing is back-filled, no window is centered.

### 5.1 Date-constant columns are excluded from the model matrix

Calendar terms (`dowSin/dowCos/monthSin/monthCos/turnOfMonth`) and date-level aggregates
(`ctxBreadthUp5`, `ctxDispersion21`, `ctxNames`) take the **same value for every name on a
decision date**. For a within-date ranking they carry no ordering information by construction — a
linear model just shifts the whole cross-section by a constant — but a **tree can split on them to
fit date-specific means**, which is an overfitting channel and nothing else.

This is measured, not theoretical: five of the six highest-gain features in the first LightGBM
meta-ranker were date-constant, its in-sample rank IC was **0.31** against **0.035** on an inner
held-out block, and its out-of-sample rank IC was reliably **negative** at every horizon.

`xsection.modelFeatureKeys()` therefore drops them by default. They remain on the row (they are
legitimate context for a reader and for any future regime-conditional model) and
`features.includeDateConstant: true` restores them. The context columns that genuinely *vary*
within a date — `ctxSectorRet21`, `ctxRelToSector21` — are kept.

### 5.3 Scope of the within-date rank: market or sector

`features.crossSectionScope` chooses what a feature's within-date percentile rank is measured
against:

- `'market'` — every name on the date (the default, and the already-measured behaviour).
- `'sector'` — the names in its **own sector**.

The argument for `'sector'`: the *target* is market- and sector-neutralized, so the part of a
feature's market-wide rank that merely says *"this is an energy name"* describes a dimension the
target has already removed. Ranking within sector makes the features and the target consistent.

The argument against: the neutralization uses **estimated** betas and is therefore imperfect, so
some genuine cross-sector information survives in the residual that within-sector ranking would
discard. Which effect dominates is an empirical question, so both scopes are supported, neither is
assumed, and the default does not move without evidence.

A sector too thin to rank within falls back to the market-wide rank for those rows rather than
emitting nulls — a thin sector is a coverage problem, not a reason to blank a name — and the split
is reported in the date context as `scopeCounts`.

### 5.2 Pre-declared additions

`dist52wHigh` (close ÷ 252-day high − 1) and `residMomVolAdj21` (residual momentum per unit of
realized volatility) were **declared before the run**, on the strength of the published
cross-sectional literature, not selected by searching this data. `dist52wHigh` is `null` without a
full year of bars rather than being proxied from a shorter window.

---

## 6. Models

### 6.1 Ridge / AR baseline — PERMANENT

`lib/forecast/ridge.js`. Closed-form ridge (normal equations + Cholesky), one model per horizon,
deterministic, no optional dependency. The trailing own-return lags (`ret1/ret3/ret5/ret10/ret21`)
are in the feature vector, so this is a ridge-regularized **AR-X** model, not a bare cross-section.

Uncertainty and probabilities come from the **empirical distribution of training residuals**,
bucketed by predicted volatility — a documented mapping (`probabilityStatus:
'uncalibrated-empirical-residual'`), not a Gaussian assumption smuggled in.

This model **stays available even when something beats it**, appears in every scoreboard, and is
the minimum operational fallback.

### 6.2 Chronos-2 — primary foundation forecaster (OPTIONAL)

`lib/forecast/chronos-adapter.js` + `tools/forecast-sidecar/chronos2.py`. Forecasts a
**residual-return** sequence, never a raw price. Records model id, revision, package version,
device, dtype, context length and inference parameters on every output.

**Version discipline:** `chronos-forecasting` 1.x is Chronos-1/Bolt — a *different model family*.
The sidecar and `capabilities.js` report it as `incompatible-version` and **refuse to substitute
it**. A test pins that.

### 6.3 Moirai-2 — challenger (OPTIONAL)

`lib/forecast/moirai-adapter.js` + `tools/forecast-sidecar/moirai2.py`, targeting the documented
`uni2ts.model.moirai2` path. Challenger status is the default: it must earn ensemble weight from
realized OOS performance. Its supported input mode is univariate, so — unlike Chronos-2 — this
adapter passes **no** covariates and records that reduced capability rather than hiding it. Only a
uni2ts release exposing the `moirai2` module counts; Moirai-1 is `incompatible-version`.

#### Horizon aggregation (an approximation, and it says so)

Both models forecast a **path** of `h` steps. The horizon-`h` cumulative residual return is that
path's sum:

```
point  = sum of the per-step median (or mean)
spread = sqrt(sum of squared per-step offsets from the median path)
q_p    = point + sign(net offset) * spread
```

For `h > 1` this assumes step independence, so every such record carries the note
`horizon-aggregated-under-step-independence`. For `h = 1` it is exact and the note is omitted.

### 6.5 `ridge-rank` — a second, pre-declared linear arm

The permanent `ridge` baseline fits the **raw** residual return. `ridge-rank` fits the same model
on the **within-date z-scored** residual. Rationale: the evaluation metric is a within-date rank
IC, but a raw-return target is dominated by high-volatility names — a squared-error fit spends its
capacity on the few names that move most, which is not what ranking a cross-section rewards.

It is a **ranking arm, not a base model**: its output is a z-score, not an expected return, so it
is flagged `rankingOnly` and never averaged into an ensemble point or read as a magnitude. The
permanent baseline is untouched.

### 6.4 LightGBM cross-sectional meta-ranker

`lib/forecast/meta-ranker.js` + `tools/forecast-sidecar/lightgbm_rank.py`. Design matrices cross
the Node↔Python boundary as raw little-endian float32 files, not JSON.

**Ranking groups are decision dates.** Rows are grouped by decision date, so the model is never
asked to compare a name on one date with a name on another. Rows are sorted by date before
grouping and the adapter **throws** if that ordering is violated.

**Objective: `regression` on the within-date z-scored residual, by default.** The evaluation
metric is a *full-cross-section* Spearman IC. `lambdarank` optimizes NDCG@k — only the head of
each date — and measurably does not fit the rest: on a real fold its own **in-sample**
full-cross-section rank IC was **0.003**, and the features it actually learned were `vol63`,
`atrPct14`, `logDollarVol20`, `amihud21`. It had learned to **rank by volatility**, because
volatile names populate the extreme relevance bucket; through the low-volatility anomaly that made
it reliably **anti-predictive** out of sample. `regression` is the loss the metric actually is.
`lambdarank` is retained as a configured alternative with its truncation level raised to cover the
whole group.

**Tuning goes through chronological inner validation, never the test block.** The cross-fitted
frames are split chronologically and purged by exact label end; the number of boosting rounds is
chosen by **early stopping** on that inner validation block, and `objective: 'auto'` (the default)
**selects** between the two objectives on the same block before refitting on the full cross-fitted
history. Across every fold measured, inner validation scored `lambdarank` negative and chose
`regression` — the selection is doing real work, not rubber-stamping a default.

**Rounds are chosen by rank IC, not by LightGBM's loss.** LightGBM early-stops on L2 (or NDCG).
Neither is the metric this system reports, and they diverge: a regression fit kept improving its
validation L2 to 200 rounds while its validation rank IC was already falling — which is how an
in-sample IC of 0.35 landed on a *negative* out-of-sample one. The sidecar therefore sweeps
iteration counts on the validation block and returns the one maximizing mean per-group Spearman.
Selection uses all inner blocks; the round count comes from the **last** block, whose training size
is closest to the final refit's.

**Three inner blocks, not one.** A single trailing block of ~20 decision dates gives a rank-IC
estimate whose standard error is comparable to the effect being measured — with one block it chose
`lambdarank` in two folds and both generalized badly. Three expanding-window blocks are the same
idea as the outer walk-forward, one level down.

**ABSTENTION GATE — the meta-ranker must beat the permanent baseline to be allowed to rank.**
Being merely positive is not enough: the baseline is already positive. On each inner block the
baseline's rank IC is computed from the same rows (free — the cross-fitted frames already carry its
out-of-fold prediction), and the candidate must clear it by `minInnerEdgeOverBaseline`. If it does
not, `fitAndScore` returns `{ ok: false, abstained: true }` with the numbers, and the fold is
ranked by the dynamic ensemble — the fallback that already exists. Measured: ungated, the model
beat the baseline at h=5 and lost to it at h=1, so the honest behaviour is to run where it earns
its place and stand down where it does not. Abstention is recorded as a **decision**, distinct
both from a failure and from a silent pass-through.

Each fold reports `metaFit`: the objective chosen, the rounds early stopping kept, whether it
abstained, and the rank IC **in-sample vs out-of-sample**, so overfitting is something the
scoreboard shows rather than something a reader has to infer.

Inputs: the full feature vector, per-base-model point/interval-width/tails/sigma/availability,
cross-model disagreement and spread, the dynamically weighted ensemble point and its within-date
rank, and trailing reliability known at the as-of date.

If LightGBM is unavailable the ranker **falls back to a ridge cross-sectional ranker** and the
response says `backend: 'ridge-xs'` with `degradedFrom` and `degradeReason`.

---

## 7. Cross-fitting — the central leakage control

`lib/forecast/crossfit.js`. For every outer training window:

1. split the outer training history into chronological **inner folds**;
2. train each base model only on data strictly **before** an inner validation segment;
3. predict that later segment;
4. purge overlapping labels and apply the inner embargo at every inner boundary;
5. concatenate the chronological out-of-fold predictions;
6. hand **only** those to the meta-ranker and the calibrators;
7. refit the base models on the permitted outer training history;
8. predict the outer **test** period with those refits;
9. apply the already-fitted meta-ranker and calibrators to the outer test period.

Every frame is stamped `evaluationType` and `producedByModelTrainedThrough`.
`assertNoInSampleStacking` rejects any frame whose base model's training window reaches the
frame's own decision date, any frame explicitly marked in-sample, and any frame with no recorded
cutoff. **`meta-ranker.fitAndScore` refuses to train** when that assertion fails — it returns
`ok:false` with the violations, it does not warn and continue.

A zero-shot foundation model (`requiresFit:false`) cannot leak through its own parameters, and
that fact is recorded — but it is still cross-fitted, because everything stacked on top must never
see test-period outcomes through preprocessing, selection, weighting or calibration.

---

## 8. Purged walk-forward validation

`lib/forecast/folds.js`, `lib/forecast/walkforward.js`. **There are no random splits anywhere.**

```
|<-------- train -------->|<- embargo ->|<-- test -->|      fold k
|<------------ train ------------>|<- embargo ->|<-- test -->|   fold k+1
```

- **Purge rule.** A training row may be used for a test block opening at session `T` only when its
  label fully closed at least `embargo` sessions before `T`:
  `labelEndOrdinal <= ordinal(T) - 1 - embargo`. The comparison is on **label intervals**, not row
  dates. A row without a provable `labelEnd` is **dropped**, never assumed closed. The predicate is
  `lib/research/label-purge.js` — the repository's existing implementation, reused rather than
  duplicated.
- **Embargo.** Defaults to `max(horizon) + 2` trading sessions; the benchmark pins it to the
  longest horizon in the whole study so all four horizons share one fold geometry.
- **Strided calendars.** Folds are built on the decision-date axis, which may sample the trading
  calendar. The embargo converts to decision-date units by **rounding up** (over-purge, never
  under), while the exact label-end purge still runs on the full session axis where it is precise.
- **Schemes.** `expanding` (default) and `rolling`.
- **Final holdout.** The last `holdoutFraction` (default 20%) of decision dates is carved off,
  **never** used for tuning, calibration, weighting or selection, and scored exactly once by
  `runHoldout`. Training for the holdout stops a full embargo earlier, so the last development
  labels cannot straddle the boundary. Holdout rows are stamped `final-holdout` and
  `productionEligibleInputs` will not return them.

---

## 9. Quantiles, probabilities and calibration

- **Monotonicity repair** — Pool-Adjacent-Violators (isotonic projection). Repairs are *recorded*,
  so the scoreboard can report how often a model emits invalid quantiles.
- **Probabilities from quantiles** — the CDF is piecewise-linear in value between quantile knots
  and **exponentially extrapolated** outside the outermost levels, so a threshold beyond the top
  quantile decays smoothly instead of snapping to 0 or 1. Status is `cdf-interpolated`: this is a
  documented interpolation, never "exact probabilities from quantiles".
- **Calibration** (`lib/forecast/calibration.js`) — isotonic (default) or Platt, both pure JS and
  deterministic. Fitted **only** on cross-fitted or separate chronological validation predictions,
  recording `fittedThroughDate` and `sourceEvaluationType`. Below `minSamples` / `minPositives` /
  `minNegatives` the status becomes `insufficient-data` or `degenerate-single-class` and an
  explicit pass-through is returned — the system says *uncalibrated* rather than implying a
  probability it cannot support. No oversampling or rebalancing is performed anywhere, so
  prevalence is never distorted.
- **Reported** — Brier, log loss, ECE/MCE, reliability bins, class prevalence, tail
  precision/recall, quantile coverage and pinball loss.

---

## 10. Dynamic ensemble weighting

`lib/forecast/ensemble.js`. Weights come from **previously realized, matured** OOS performance and
nothing else.

- **Maturity gate.** An observation informs weights for date `d` only when `labelEnd < d`
  (strictly). `computeWeights` **throws** without an `asOf` cutoff.
- **Formula** (recorded verbatim in every weight record):
  `quality = max(0, meanRankIC) · (0.5 + 0.5·rankICStability) · (1 − failurePenalty·failureRate) ·
  (1 − min(0.5, |meanCoverageError|))`, normalized, shrunk toward equal (`shrinkToEqual`), then
  **projected** onto `{w ∈ [min,max], Σw = 1}`.
- The projection is a genuine Euclidean projection (`w_i = clamp(v_i + θ, lo, hi)` with `θ` solved
  by bisection), *not* clamp-then-renormalize — the latter pushes a clipped weight straight back
  through the cap.
- **Fallbacks, always named:** last-valid weights → static equal → baseline-only.
- The dynamically weighted forecast is an interpretable comparison arm, an input feature to
  LightGBM, and the ranker of last resort. It does **not** replace LightGBM when LightGBM runs.

Only `scoreboard.productionEligibleInputs` — matured `walk-forward-oos` rows — feeds it.

---

## 11. Opportunity score (0–100)

`lib/forecast/score.js`. A deterministic **relative** score. It is **not a probability** and is
never labelled as one.

Components, each mapped into `[0,1]`: within-date rank of the final ranker · calibrated P(residual
> 0) · bounded expected residual scaled by the date's dispersion · calibrated P(drawdown > 5%),
negative · 80% interval width, negative · cross-model agreement · trailing OOS reliability known
at the as-of date · estimated round-trip cost, negative · feature coverage and staleness.

Missing components are **dropped and the remaining weights renormalized**, so an absent probability
head shifts the mix rather than scoring zero; `scoreCoverage` reports how much was available.

| `scoreStatus` | Meaning | Bucket |
|---|---|---|
| `calibrated` | mapped through a chronologically fitted distribution of past composites — 78 means the same thing on two different days | 1 point |
| `uncalibrated-percentile` | within-date percentile only — comparable across names on ONE day, not across days | **5 points**, to avoid false precision |
| `insufficient-inputs` | no usable components; `opportunityScore` is `null` | — |

Returned per row: symbol, as-of and tradable timestamps, horizon, score + status, expected
residual return, quantiles, P(>0%/3%/5%), P(drawdown>5%), uncertainty, component availability,
model weights, agreement/disagreement, market and sector betas, estimated cost, data-freshness and
missing-data flags, eligibility/exclusion reason, key explanatory components, and full lineage.

---

## 12. Costs and backtesting

`lib/forecast/backtest.js`. **After-cost results are the primary ones**; gross is shown only so the
size of the friction is visible.

- Costs come from `lib/costs.js` — the app's single model — tiered by dollar volume with the same
  thresholds `research/lib/experiment-kit.js` uses (`≥$20M liquid`, `≥$5M small`, else `micro`),
  charged as one round trip per name per sleeve, at stress multipliers ×1/×2/×3.
- Long-only by default. A long-short book is only simulated when `portfolio.longOnly` is false
  **and** a borrow cost is supplied; otherwise the short leg would be free money. The
  top-minus-bottom spread is reported as a **ranking diagnostic**, clearly not a book.
- Position cap, sector cap, equal or score weighting, turnover, exposure and concentration.

### 12.1 Cost is charged on what is TRADED, not on the whole book

The first implementation charged a full round trip on 100% of the book at every rebalance, even
for a name that was simply held. That overstates friction whenever anything is carried forward
and — worse — it made turnover reduction **invisible**, because the cost did not depend on what
was traded.

`roundTripCostPct` is a full buy-and-sell, so each rebalance now pays **half a round trip per unit
of weight moved**:

```
cost = 0.5 * SUM_i | w_new(i) - w_old(i) | * roundTripCost(i)
```

A name bought and later sold accumulates exactly one round trip across the two events; a book that
turns over completely moves SUM|Δw| = 2 and pays one full round trip — reducing exactly to the old
model in that case. Entering from cash is a half round trip, not a whole one.

This required restructuring the backtest so **tranches are primary and are built sequentially**: a
sleeve can now see what the previous sleeve of its own tranche held. A portfolio has memory, and
pretending every rebalance starts from cash is what made friction look like an unavoidable constant.

### 12.2 The no-trade band

With `portfolio.noTradeBand > 1`, a held name is **kept** while it stays inside rank
`topK × noTradeBand`, and only names inside the top `topK` are **bought**. Without it, a name
oscillating around rank K is sold and re-bought every rebalance, paying a round trip each time for
no change in exposure — pure friction carrying no information.

For a strategy whose gross edge is small relative to its friction, this is the single most direct
lever on the net result, and unlike a modelling change it needs no new signal. `noTradeBand: 1`
disables it and reproduces the sell-and-rebuy behaviour.

`costs` reports `meanTurnover`, `meanTradedWeight`, `annualizedCostDrag` and the band in force, so
the friction is a number you can read rather than infer.
- **Overlapping holding periods are handled explicitly.** A horizon-`h` strategy rebalanced every
  `stride` sessions holds `ceil(h/stride)` overlapping sleeves. The backtest builds that many
  **non-overlapping tranches**, compounds each into its own equity curve, and reports the
  distribution of tranche statistics. Pooled statistics are flagged
  `overlapping: true, volatilityUnderstated: true` — quote the tranche view.
- Annualization uses the true session spacing (`trancheStep × stride`), and `capitalDutyCycle`
  reports when a coarse sampling stride leaves the book uninvested part of the time.

---

## 13. Negative controls

Run on **identical rows** in every fold:

| Arm | What it proves |
|---|---|
| `control-random` | a deterministic information-free order must score ≈ 0 |
| `control-shuffled-label` | the meta-ranker trained on labels shuffled **within each date**. A persistent edge here means leakage, not skill |
| `control-delayed-signal` | the ranker's score carried forward one decision date. Surviving a delay it should not survive means a backtest error |
| `meta-no-foundation` | the meta-ranker **without** foundation-model features — answers "did Chronos/Moirai add anything?" (runs only when a foundation model is present) |
| `ridge-rank` | the baseline refitted on the within-date z-scored target — isolates how much of any gain is just target alignment |
| `static-ensemble` / `dynamic-ensemble` | equal vs matured-OOS weighting |
| cost stress ×1/×2/×3 | sensitivity of every conclusion to friction |

---

## 14. Model scoreboard

`lib/forecast/scoreboard.js`. Keyed by model × horizon × fold × **evaluation type**, with the
identity that makes a row reproducible (universe, feature version, target version, checkpoint
revision, config hash, data cutoff).

| Evaluation type | May it influence anything? |
|---|---|
| `in-sample` | **No** — diagnostics only |
| `cross-fitted` | Only as meta-ranker / calibrator training input |
| `validation` | Inner-fold validation |
| `walk-forward-oos` | **The only tier** that may inform eligibility, selection, score calibration or dynamic weighting |
| `final-holdout` | **No** — read once, reported separately |

Metrics: Pearson IC, rank IC, IC information ratio, positive-IC rate, directional accuracy, gross
and net Sharpe / annualized return / max drawdown, turnover, top-minus-bottom spread, Brier, log
loss, ECE/MCE, tail precision/recall, quantile coverage and pinball loss, coverage, latency and
failure rate.

Metrics are computed **within a decision date and then aggregated across dates**, because
overlapping daily cross-sections are not independent observations. A constant score vector yields
`null`, never `0` — a constant score has no ordering.

### 14.1 Dependence-aware uncertainty

Each scoreboard row keeps its **per-date rank-IC series** (`icPerDate`), so folds are **pooled by
concatenation** rather than by averaging fold means — averaging would throw away the within-fold
variation the interval is built from. `scoreboard.pooledIcUncertainty` then reports:

- a **seeded moving-block bootstrap 90% CI** (block length matched to the horizon), and
- a **Newey-West HAC t-statistic** with horizon-appropriate lags,

both from `lib/research/stats-v3.js` — the repository's existing implementation, reused. The
interval is labelled 90%, not relabelled 95% to look different from what it is.

### 14.2 Breakdowns

Walk-forward rows also carry `breakdowns` by **sector**, **liquidity bucket** (the same thresholds
the cost model charges) and **calendar year**. A bucket with fewer than 10 usable dates is
returned **with its size and a null estimate plus a note** — thin buckets are visible, not
silently dropped or silently averaged. Regime-conditional breakdowns are not produced: the study
spans too few folds for a regime split to mean anything here.

---

## 15. Optional dependencies and the fallback hierarchy

| Tier | Composition |
|---|---|
| 1 | Chronos-2 + Moirai-2 + Ridge + LightGBM |
| 2 | Chronos-2 + Ridge + LightGBM |
| 3 | Moirai-2 + Ridge + LightGBM |
| 4 | Ridge + LightGBM |
| 5 | Ridge + ridge-xs cross-sectional ranker |
| 6 | Ridge only |

Rules the code keeps:

- Application startup triggers **no** model download and **no** capability probe — `lib/forecast`
  is required lazily by the routes.
- Unit tests need **no** network, GPU, credentials or checkpoints; the foundation adapters are
  exercised through deterministic fixtures stamped `fixture:<model>` and
  `SYNTHETIC FIXTURE OUTPUT`, so a fixture can never be mistaken for a benchmark.
- An unavailable component returns a **reason for every row** and **no numbers** — never zeros.
  Availability distinguishes `package-missing`, `checkpoint-missing`, `incompatible-version`,
  `resource-exhausted`, `inference-failed`, `insufficient-history` and `disabled`.
- An unexpected Python traceback comes back verbatim in `stderr` rather than being swallowed.

### Installing the optional tiers

```bash
python3 -m venv tools/forecast-sidecar/.venv
tools/forecast-sidecar/.venv/bin/pip install -r tools/forecast-sidecar/requirements-optional.txt
```

That gets you **tier 4** (LightGBM; ~3 MB, no checkpoint, works on Python 3.9+).

Tiers 1–3 need **Python ≥ 3.10**, `torch`, and `chronos-forecasting>=2.0` / `uni2ts` with the
`moirai2` module, plus checkpoint downloads on the order of **1–3 GB**. Those lines are commented
out in `requirements-optional.txt` on purpose. Point `FORECAST_PYTHON` at a suitable interpreter:

```bash
FORECAST_PYTHON=/path/to/py311/bin/python node -e \
  "const F=require('./lib/forecast');console.log(F.capabilities.detectCapabilities(F.config.resolveConfig()))"
```

The sidecar venv is gitignored. No checkpoints, datasets, secrets or large artifacts are committed.

---

## 16. Commands

```bash
# What can this machine run, and why not more?
node -e "const F=require('./lib/forecast'); const c=F.config.resolveConfig(); \
  const k=F.capabilities.detectCapabilities(c); console.log(k.tier, k.tierLabel); \
  k.degraded.forEach(d=>console.log(' -',d)); F.capabilities.setupHints(k).forEach(h=>console.log(' hint:',h))"

# Raw sidecar probe
node -e "console.log(JSON.stringify(require('./lib/forecast/sidecar').probe(),null,1))"

# Full purged walk-forward benchmark (needs the local research cache)
node --max-old-space-size=14336 research/88-forecast-walkforward.js

# …with explicit knobs (all recorded in the artifact)
FORECAST_STRIDE=3 FORECAST_MAX_NAMES=1500 FORECAST_MIN_ADV=20000000 \
FORECAST_HORIZONS=1,3,5,10 FORECAST_MIN_TRAIN_SESSIONS=80 FORECAST_TEST_SESSIONS=20 \
  node --max-old-space-size=14336 research/88-forecast-walkforward.js

# Tests
node --test test/forecast-*.test.js

# API (read-only)
curl 'localhost:3000/api/tracker?op=forecastcaps'
curl 'localhost:3000/api/tracker?op=forecastboard&horizon=5'
curl 'localhost:3000/api/tracker?op=forecastrank&horizon=5&limit=25'
```

### Reproduction

A run is reproducible from `manifest.manifestHash`, which hashes config hash, seed, horizons,
quantiles, feature version, target version + definition, execution convention, universe policy,
fold definitions, data cutoff, code versions, capability tier and cost assumptions. Package
versions, Node version, platform and the sidecar interpreter are recorded in `manifest.runtime`.
Everything is seeded (`cfg.seed`, `metaRanker.seed`), LightGBM runs with `deterministic:true` and
`force_row_wise:true`, and `test/forecast-pipeline.test.js` asserts two identical runs produce
identical scoreboard numbers.

`registry.checkCompatibility` refuses to reuse an artifact whose feature-schema hash, target
definition/version, horizon, config hash or model revision differs, or whose `trainCutoff` is later
than the consumer's `dataCutoff`.

---

## 17. Artifact and data locations

| What | Where |
|---|---|
| Price cache (gitignored, ~9 GB) | `research/data/cache/*.json` |
| Benchmark artifact | `research/data/forecast/walkforward-result.json` |
| Experiment registry (committed) | `research/experiments/registry.json` |
| Optional sidecar venv (gitignored) | `tools/forecast-sidecar/.venv/` |

### Research-data isolation

`test/research-isolation.test.js` is an existing repository invariant: nothing under `lib/`
(outside `lib/research/` and `lib/pitdata/`) or `api/` may read a research data artifact. The CFR
system **honours that invariant rather than exempting itself**:

- `lib/forecast/panel.js` is **pure** — series in, panel out, no filesystem at all.
- the loader that reads `research/data/cache/` lives on the research side, at
  `research/lib/forecast-panel.js`.
- the single live→research coupling is one lazy, guarded `require` inside `op=forecastrank`, and
  it is the branch that fails with an explanation when the cache is absent.

`test/forecast-pipeline.test.js` asserts that no file under `lib/forecast/` requires anything from
the repo-root `research/` tree, so the separation cannot rot silently.

No model checkpoint is stored in an application database.

---

## 17.1 Integration with the existing application

Three **read-only** ops on the existing `api/tracker.js` router, following the repo's
`lib/*-routes.js` convention:

| Op | What it does | Cost |
|---|---|---|
| `op=forecastcaps` | capability tier, per-component reason, actionable setup hints | cheap (a sidecar probe) |
| `op=forecastboard` | the persisted walk-forward scoreboard, with evaluation types kept apart | cheap (a file read) |
| `op=forecastrank` | live ranking for a decision date | **heavy** — throttled via `EXPENSIVE_OPS` |

None of them writes state, places an order or promotes anything. `lib/forecast` is required
**lazily** inside the handlers, so importing the route module never pulls the system (or a Python
probe) into an unrelated request path.

### Why there is no new UI tab

The panel is built from `research/data/`, which is **gitignored and not deployed**. In production
`op=forecastrank` would answer `available:false` on every call and `op=forecastboard` would find no
artifact — so a dashboard tab would render "unavailable" forever. Rather than ship a surface that
cannot work where it is deployed, the system is exposed through the API and the research runner,
and this limitation is stated instead of papered over. Publishing a compact board projection to
Blob on the nightly cron is the obvious next integration step, and it is deliberately **not** done
here: it would be a state-changing write into the existing cron chain, which is outside the scope
of a research build.

### Migrations

None. This application has no relational database; artifacts are JSON files under
`research/data/forecast/` and the append-only experiment registry at
`research/experiments/registry.json`. No schema change was required and none was applied anywhere.

---

## 18. Configuration

Everything lives in `lib/forecast/config.js` and is hashed into `configHash`: enabled models,
model ids and revisions, devices, horizons, quantiles, context/training windows, universe and
liquidity rules, target neutralization, feature groups, fold sizes / purge / embargo,
cross-fitting, calibration, dynamic weights, costs and portfolio constraints, score construction,
artifact locations and seeds.

`.env.example` lists every variable with a comment; all are optional and the system runs with
every one of them blank.

Environment overrides: `FORECAST_SEED`, `FORECAST_ARTIFACT_DIR`, `FORECAST_MODELS`,
`FORECAST_CHRONOS2`, `FORECAST_CHRONOS2_MODEL`, `FORECAST_CHRONOS2_REVISION`, `FORECAST_MOIRAI2`,
`FORECAST_MOIRAI2_MODEL`, `FORECAST_MOIRAI2_REVISION`, `FORECAST_META_BACKEND`,
`FORECAST_TEST_SESSIONS`, `FORECAST_MIN_TRAIN_SESSIONS`, `FORECAST_INNER_FOLDS`,
`FORECAST_MAX_NAMES`, `FORECAST_MIN_ADV`, `FORECAST_PYTHON`, `FORECAST_STRIDE`,
`FORECAST_HORIZONS`, `FORECAST_ARTIFACT_PATH`, `FORECAST_TRAIN_SESSIONS`,
`FORECAST_FIXTURE_MODE`.

No credentials are required and none are read.

---

## 19. Known limitations

1. **Chronos-2 and Moirai-2 have not been run against real checkpoints in this repository.** The
   only Python available is 3.9.6; `chronos-forecasting` resolves at most to 1.5.3 there (which is
   Chronos-1/Bolt and is *refused*), and `uni2ts` has no 3.9-compatible distribution. Both adapters
   are implemented against the documented APIs and exercised with deterministic fixtures, and are
   reported as **unverified integrations**.
2. **Survivorship is reduced, not proven safe.** No result here is survivorship-clean.
3. **Sector basis is not point-in-time.**
4. **No P2 enrichment.** Options/IV, macro, fundamentals, analyst revisions, events, short
   interest, insider activity and news are *not* wired in — no dataset in this repository carried
   trustworthy release/effective timestamps for them at the required per-name-per-date granularity,
   and the spec's own rule is to exclude rather than assume same-day availability.
5. **Decision dates are sampled at a stride** in the benchmark; turnover and Sharpe are
   stride-dependent, and at `h=1` with `stride>1` the book is idle part of the time
   (`capitalDutyCycle < 1`) while still paying a full round trip.
6. **Folds are few.** The local cache spans ~5 years; after the holdout and the minimum training
   window, only a handful of outer folds fit. Treat fold-to-fold variance as large.
7. **Nothing here is prospective.** Every number is a replay of stored history.

---

## 19.1 Design-iteration exposure — stated, not buried

The first build's meta-ranker was reliably **anti-predictive** out of sample. Finding out why
required looking at walk-forward OOS results, and the configuration was then revised. That is
test-adjacent iteration and it has to be declared rather than presented as a clean single-shot
result.

**What was revised after seeing OOS numbers** — all of it justified by *mechanism* or by
*chronological inner validation*, i.e. decidable without the test blocks, but seen during the
process nonetheless:

| Revision | Why it is decidable without the test set |
|---|---|
| objective `lambdarank` → `regression` | NDCG@k optimizes a head; the metric is a full-cross-section Spearman IC. Confirmed on inner validation, where `lambdarank` scored negative in every block. |
| date-constant columns excluded | A column identical for every name on a date cannot change a within-date ordering; a tree can only use it to fit date means. |
| rounds chosen by validation rank IC | Select on the metric you report. |
| one inner block → three | A ~20-date rank-IC estimate has a standard error comparable to the effect. |
| abstention gate vs the baseline | The spec requires every complex system to be compared against the baseline. |

**What was NOT revised against OOS results:** the target definition, the execution convention, the
features (the two additions were pre-declared from published literature), the ridge baseline, and
every negative control.

**Consequence:** treat the `meta-ranker` arm's OOS numbers as **optimistically biased**. The
`ridge` baseline and the controls carry no such exposure. The final holdout has now been read
twice — once before these revisions and once after — which is mild multiple-testing exposure, so
it is reported but not treated as decisive. `designIterationExposure` in the artifact records all
of this in machine-readable form.

---

## 20. Honest statements the system must keep making

- Forecasts are uncertain.
- A high opportunity score is **not** a guarantee, and is not a probability unless
  `scoreStatus === 'calibrated'` — and even then it is a calibrated *relative* score.
- Backtests may be biased or overfit.
- Threshold probabilities are unreliable when the class is rare — the 5% threshold at `h=1` has
  ~2% prevalence.
- After-cost walk-forward results matter more than in-sample fit.
- The Ridge/AR baseline must remain available, and every complex system is compared against it out
  of sample.
- **No alpha claim is justified without robust after-cost out-of-sample evidence.** See
  `research/data/forecast/walkforward-result.json` for what this implementation actually measured.
