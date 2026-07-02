# Gap & Go — meta-label + fractional-Kelly sizing (2026-07-01)

Two refinements on the ONE deflation-surviving edge (unscheduled ≥5% gap + ORB,
exp08 PF 1.47/DSR 0.99). Both backtested on the **survivorship-corrected** rig
(4217 survivor+delisted names, OHLC, earnings-skip, daily-bar ORB = what the live
app can see), 19,326 non-earnings gap events, 2021–2026.

## Tier stats (realized R of the 2.5×ATR / 1:2 ORB trade) → Kelly [#2]

| Tier | n | win | payoff | PF | expR | full-Kelly |
|---|---|---|---|---|---|---|
| STRONG ≥5% | 5,853 | .498 | 1.30 | 1.29 | +0.046 | 0.112 |
| MODERATE 3–5% | 13,473 | .487 | 1.21 | 1.15 | +0.022 | 0.063 |

STRONG by year: 2022 +0.082, 2023 +0.051, 2024 +0.081, 2025 +0.026, 2026 +0.026
(2021 −0.035, n=212). Positive 5/6 years. (Broad daily-bar re-test is more conservative
than the 51-name intraday exp08 headline PF 1.47 — expected; both agree on direction.)

**Sizing = 0.25× fractional Kelly by tier, scaled by the continuation score, ZEROED
in risk-off.** STRONG risk-on ≈ 2.8% of capital/trade; MODERATE ≈ 1%. Fractional-0.25
is the half-edge safety margin (if the true edge is half, you're at ~0.5× Kelly).

## Continuation meta-label (take/skip) [#1]

Univariate expR: **gap** monotone (0.010→0.047), **relVol** monotone (0.014→0.053),
**regime** dominant (risk-on +0.057 / neutral +0.033 / **risk-off −0.009 net-negative**),
extension weak/non-monotone, atrPct flat. So the shipped score is parsimonious:

`continuationScore = 100·(0.42·gapN + 0.28·relVolN + 0.30·regimeN)`, risk-off a hard
down-gate. Validated (the EXACT shipped function, on the 19,326 events):

- TAKE (score ≥45, non-risk-off): expR **+0.065** vs base +0.029 (~2×); not-TAKE +0.025
- top-third +0.059 vs bottom-third **−0.009** (bottom is negative → genuinely skippable)
- **TAKE beats skip in 6/6 years** (2021–2026) — regime-robust OOS

Honest caveat (surfaced in UI): it RANKS/skips a right-skewed edge; it does **not**
raise the ~50% hit rate. It's a selectivity + sizing tool, not a high-probability signal.

## Shipped
- `lib/gapgo.js`: `continuationScore` / `gapTake` / `suggestedRiskPct` + `TIER_STATS`
  (pure, regime passed in). `test/gapgo.test.js` (+7).
- `lib/screener-routes.js` `computeGapLive`: attaches score/take/suggestedRiskPct,
  ranks by the continuation score.
- `public/js/app.js`: 🎯 continuation score + ✅ TAKE badge + 💰 suggested risk on cards,
  risk-off banner, honest framing.

## Repro
Scratchpad: `gap-backtest.js` (events + tier stats), `gap-metalabel.js`/`gap-metalabel2.js`
(feature analysis + validation). Data wall: options/IV history doesn't exist yet — the
IV/RV coil-ranker (#5) waits on the widened archive maturing (~2–3 months).
