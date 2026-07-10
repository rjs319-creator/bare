# Down-Day Mode — research & verdicts (2026-07-10)

Goal: help day/momentum traders find wins on **down days**, where the long-and-momentum
screeners empty out by design. Method for both tests: 2-year point-in-time replay over the
liquid universe (price ≥ $5, 20d $-vol ≥ $25M), keyless Yahoo daily bars, entry at the
**tradeable next-day OPEN** (not the un-tradeable close-to-close leg), forward return as
**excess vs SPY**. "Red day" = SPY same-day ≤ −0.5% (also tested −1.0%).

## 1. "Leading the Tape" (momentum longs) — REJECTED (`research/42-leading-the-tape.js`)

Thesis tested: on a red tape, names holding up **green / positive relative strength** lead
when the tape turns → buy the leaders.

Result: **the opposite is true at the tradeable horizon.**

- Gated "leaders" (green today + above 50/200 + trailing-21d RS>0) next-open excess vs SPY:
  h1 +0.04% (win 50%), **h2 −0.09%, h3 −0.05%** — worse than or equal to the rest of the
  field at every horizon.
- Decile by same-day relative strength → next-open h1 excess is cleanly **INVERTED**:
  weakest-RS-today D0 **+0.51%** … strongest-RS-today D8 **+0.03%** (monotone down).
  The names "holding up" on a red day **mean-revert down** at the next open.

Conclusion: momentum-continuation longs do **not** work on down days — that's *why* they feel
hard. The +4.96%/21d RS finding (mover-audit) is a swing signal; at the 1–3 day day-trade
horizon it flips to reversion. **No "buy the leaders" lane shipped.**

## 2. V-Reversal (oversold bounce) — VALIDATED, red-tape-specific (`research/43-vreversal-validate.js`)

Thesis tested: a capitulation → turn (`analyzeVReversal`) is a down-day reversion long.

Result: **real edge, but ONLY on red days** — a clean regime conditional.

| Tier | RED days (SPY ≤ −0.5%), next-open h=3 | ALL days (control) |
|---|---|---|
| WATCH (fresh oversold turn) | **+0.76%** / win 56% | +0.08% |
| EMERGING | **+0.34%** / win 52% | −0.04% |
| CONFIRMED | +0.10% / win 50% | **−0.10%** |

Two findings:
1. The bounce only pays when the **whole market puked** (positive on red days, flat/negative
   otherwise) → V-Reversal belongs *inside* a red-tape-gated Down-Day Mode, **not** as an
   always-on tab. Positive both years (2025 +0.32, 2026 +0.13 for CONFIRMED+EMERGING h3).
2. The tier ordering is **inverted** — the earlier/less-confirmed the turn, the better the
   red-day bounce (catch it early; a "CONFIRMED" reversal is already spent). Encoded as a
   structural tilt (freshness gate + WATCH/EMERGING bonus in `downScore`).

Magnitudes are modest (0.3–0.8%/3d, win 51–56%) → framed honestly as a "trade the right side /
trade less" tool, not an alpha spigot. Forward-tracked on red tapes via `op=downdaybook`.

## What shipped

`lib/downday.js` routes each name on a red/risk-off tape to its best-fit play — an
**Oversold Bounce** long (V-Reversal, gated for real R:R, a tradeable stop, and a *fresh*
turn) or an **Overheated/Rollover** short (`analyzeInvertedV`, the mirror) — and leads with
the honest reality panel (the two verdicts above). No momentum-long leaders lane. Tab
🪁 Down-Day Mode + a red-tape nudge on the Today home tab. Ledger `downday/<date>.json`
logs bounce longs on red days only, resolved 3-session excess vs SPY.
