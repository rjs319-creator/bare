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
