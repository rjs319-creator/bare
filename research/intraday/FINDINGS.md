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
| 05 stacked | Stacking the levers turns it **OOS-positive**. |

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
- The honest gate before trusting the magnitude is **forward / live confirmation + formal deflation (Deflated-Sharpe/PBO)** — *not* more in-sample tuning (which would overfit).

## What this means for the app

The live Day Trade screener is a sound *watchlist*, but its implied "buy at the close,
tight 1:2" plan is the weak part. The evidence-based upgrade (pending forward
confirmation): **rank-filter to top-half momentum_liquid, surface an opening-range-
breakout entry instead of buy-at-close, and widen the stop to ~2.5×ATR.** That changes
the screener from "here are today's movers" to "here's a disciplined way to trade them"
— the first configuration in this whole investigation that survives real OOS intraday
execution.
