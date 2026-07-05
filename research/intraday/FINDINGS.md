# Intraday Day-Trade Validation — Findings

Validating (and trying to improve) the app's live Day Trade screener using real
intraday execution. Five experiments, all survivorship-free on FMP intraday bars,
51-name universe, 2022-01 → 2025-06 (multi-regime), conservative costs (5 bps
slippage/fill + 2 bps commission/leg), no lookahead (select on T close, act on T+1).

## The arc (each result is OOS expectancy unless noted)

| Experiment | Finding |
|---|---|
| 01 selection (as shipped) | Daily-bar proxy was flattering; real intrabar execution = negative. |
| 01-wide window | Aggregate +0.18%/trade is an **early-window artifact** — carried by 2022–23, **inverts** OOS (2024 −0.64%, 2025 −1.09%). |
| 02 exit A/B | Tight stop is **worst** OOS; loosening halves the bleed — but no exit alone is durable. |
| 03 regime gate | Macro/small-cap regime gating does **not** transfer to short-term picks (best gate still OOS-negative). Regime is a *cross-sectional* lever, not an intraday one. |
| 04 entry timing | **Buying the gap (next-open) was the leak.** Opening-range-breakout entry: OOS −0.589 → **−0.124**. |
| 05 stacked | Stacking the levers turns it **OOS-positive** (+1.56%/trade OOS). |
| 06 deflation | **The gate fails.** After penalising for the 24-variant search, DSR **0.59** (<0.95) and the walk-forward-selected variant ≠ the chosen one and dies OOS (Sharpe −0.007). The magnitude is search luck. |
| 11 meta-label | **No lift.** A purged-walk-forward logistic meta-filter on entry-time features does not beat ranking by gap size, doesn't clear significance, and *raises* lumpiness. The shipped edge already captures what's capturable. |

## Experiment 11 — meta-labeling the Gap & Go edge (the "does the López de Prado upgrade help?" test)

Motivated by an external "trading-platform constitution" whose headline proposed upgrade was
**triple-barrier + meta-labeling**. exp08's gap-up ORB edge is lumpy and low-hit-rate — the
textbook case for a precision filter — so we tested the claim head-on with the machinery
`metalabel.py` was built for (`experiments/11_metalabel.py`, `data/metalabel.json`).

Setup: 750 unscheduled gap-up (≥4%, non-earnings, liquid) ORB trades, 2022–2025H1. Meta-label =
did the trade end profitably. Meta-model = **logistic regression** (not XGBoost — a few hundred
trades can't support a tree) on entry-time features {gap, atr%, log$ADV, opening-range width,
prior-day return, gap/atr, regime, day-of-week}, trained **purged walk-forward** (7-day embargo,
half-year folds). Keep the top 60% of each fold. Three rankers vs the unfiltered baseline, judged
on the SAME pooled OOS trades (n=658) by expectancy, PF, lumpiness, and a date-clustered bootstrap.

| ranker (top 60%/fold) | n | win% | expR% | PF | top-5 share | boot Δ>0 p | rank-IC |
|---|---|---|---|---|---|---|---|
| **all trades** | 658 | 49.5 | 1.56 | 1.40 | 0.09 | — | — |
| gap size (validated rank) | 392 | 52.6 | 2.35 | 1.60 | 0.13 | 0.77 | 0.032 |
| continuation_score (shipped) | 392 | 51.0 | 2.45 | 1.61 | 0.13 | 0.75 | −0.025 |
| lr_meta (walk-forward ML) | 392 | 50.8 | 2.01 | 1.52 | 0.15 | 0.65 | 0.007 |

**Verdict: ❌ NO LIFT.** Three honest reads:
1. The learned meta-filter (rank-IC **0.007** ≈ zero) does **not** beat ranking by gap size
   (2.35% vs 2.01% expR). The ML adds nothing over the one factor exp08 already validated.
2. **No ranker clears significance** — bootstrap P(Δ>0) tops out at 0.77, well under 0.95.
3. Filtering **worsens** the thing it was meant to fix: top-5 P&L share rises 0.09 → 0.13–0.15.
   Dropping trades *concentrates* the right-skew rather than taming it.

**What this settles about the constitution:** its flagship upgrade (meta-labeling) empirically
does **not** improve the app's one real edge on free/Starter data — consistent with the whole
investigation. Ranking gap-ups by gap magnitude is already as good as a learned filter. The
useful residue (triple-barrier-style vol-scaled exits, Kelly sizing) the app had already built.
This is a lead-rejecting result — but the only true OOS test is live, so it is now **forward-tracked** (not gated on).

### Shipped as a forward-track (deployed + verified 2026-07-05)

`python experiments/11_metalabel.py export` trains the final LR on all 750 trades (8 live-log-
available features — drops the intraday-only opening-range width) and writes `data/metamodel_serve.json`.
That model is embedded in `lib/gapgo.js` as `META_MODEL`; `metaProbFromVector` is the exact sklearn
forward pass, **pinned to Python by `test/gapgo.test.js` fixtures** (ATR is byte-identical across the
JS/Python ports, so features match; the one acknowledged difference is reg_norm's source — live=macro
VIX/credit vs rig=IWM tape — immaterial at coef≈0.07 on a ~zero-IC model). Each live Gap & Go pick now
carries `metaProb` + `metaTier` (HIGH/LOW at the training median 0.499), logged to the `gap/` ledger;
`op=gapgobook` splits the resolved record `byMeta`. **The live test:** if HIGH ≈ LOW once ~40/class
resolve, the backtest was right and the flag retires; a HIGH>LOW separation would be the (unexpected)
live confirmation. Meta stays out of the pick cards on purpose — a no-lift score shouldn't look actionable.
App suite 365/365.

## Best configuration found (Experiment 05, rung L4)

**ORB entry + wide exit + liquid + conviction:**
- **Selection:** `momentum_liquid` scan only (drop `explosive_small` — it was negative), keep only picks with rank ≥ the median rank.
- **Entry:** opening-range breakout — wait the first 30–45 min, enter only if price breaks the opening-range high (no fill otherwise). *Do not buy the next-open gap.*
- **Exit:** stop 2.5×ATR below entry, 1:2 target (the tight structure stop leaks), 3-session time exit.

**Results (n=232 trades):** expectancy **+0.78%/trade**, PF **1.22**, **out-of-sample +1.56%/trade**, positive in **3 of 4 years** including the 2022 bear (2022 +1.41 / 2023 −0.94 / 2024 +1.94 / 2025 +0.36). ORB length is monotone (20→30→45 min OOS +1.14 → +1.56 → +1.80).

## Honest caveats (do not over-trust)

- **Win-rate Wilson LB is still <50%** — this is a right-skewed, low-hit-rate, positive-*expectancy* profile: a minority of confirmed breakouts carry it (PF 1.22). Psychologically hard; sizing matters.
- **Multiple testing:** ~5 experiments, ~30 variants. The +1.56% OOS magnitude is inflated by selection; the rank cut uses the in-sample distribution. Deflate it mentally.
- **2023 was negative** — not all-weather.

## Experiment 06 — the deflation gate (the verdict)

Ran the formal overfitting control flagged above. Result (`data/deflate.json`):

- **DSR = 0.594** — well below the 0.95 bar. The raw PSR (ignoring selection) is 0.866,
  but the deflation benchmark (E[max Sharpe] across the 24 trials) eats most of that:
  once you account for having *searched* 24 variants, the probability the true Sharpe is
  positive is only ~59%.
- **PBO = 0.286** (≤0.5, acceptable in isolation), but —
- **Walk-forward selection fails:** the variant that was best on the first half was *not*
  the chosen config, and its second-half Sharpe is **−0.007** (dead). In-sample selection
  does not survive forward.

**Verdict: the +1.56% OOS magnitude is selection-inflated and does not clear the gate.**
This is the project's recurring truth, now proven one level deeper: the process is sound
and the rig keeps honestly rejecting, but there is no *confirmed* tradeable intraday edge
on free/Starter data — only a promising lead that would need genuine forward/live
confirmation (out-of-sample in the literal sense) before it could be trusted.

## What this means for the app

The live Day Trade screener is a sound *watchlist*. The stacked config (rank-filtered
top-half `momentum_liquid` + opening-range-breakout entry + ~2.5×ATR stop) is the best
*lead* this investigation produced and a defensible default *if* surfaced honestly — but
**experiment 06 says do not ship it as a proven edge.** The disciplined path: paper/forward
track the config live and only promote it once out-of-sample (not re-searched) results
confirm the magnitude.

### Shipped (commit `2fbed22`, deployed + verified 2026-06-27)

The config is now wired into the live screener **with the honest framing above**, not as a
proven edge:

- **Engine** (`lib/daytrade.js`): `tradeLevels` gained an opt-in `useLowFloor:false` for a
  pure ~2.5×ATR stop (legacy default kept, so the shared Breakout/Confluence callers are
  untouched); new `orbLevels()` surfaces the next-session opening-range-breakout plan
  (break today's high, 2.5×ATR stop, 1:2 target) since EOD data can't see tomorrow's range.
- **Route** (`lib/screener-routes.js`): the Day Trade scan uses the wide stop + ORB plan,
  flags the top-half `momentum_liquid` as `preferred`, and returns an `experimental` config
  block carrying the deflation caveat.
- **UI** (`public/js/app.js`): a 🧪 "experimental upgrade" banner stating it **failed
  deflation (DSR 0.59) — paper-track first**, ORB entry plans replacing "buy at close",
  ⭐ on preferred names, and an "excluded — tested negative OOS" note on Explosive Small-Cap.

**Tracking is unchanged** — picks are still logged daily and resolved as forward
3-session excess vs SPY (`op=daytradetick`/`daytradebook`). That live ledger **is** the
forward-confirmation gate: if the shipped config's preferred-`momentum_liquid` picks beat
SPY out-of-sample over a meaningful sample, promote it from 🧪 experimental to default;
if not, the rig was right and it stays a movers watchlist. Until then it remains framed as
"here's a *disciplined, unproven* way to trade today's movers," never "a proven edge."
