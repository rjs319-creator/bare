# Phase 3 — short-side day-trade edge (2026-07-10)

Down-Day Mode Phase 3 asked: is there a dedicated *short* setup worth shipping? Method:
2y PIT replay, liquid universe (price ≥ $5, 20d $-vol ≥ $25M), keyless Yahoo daily bars,
entry at the **tradeable next-day open**, forward return as **SHORT excess vs SPY**
(= −(nameRet − spyRet); positive = the name underperformed = the short paid).
Scripts: `research/44-shortside-continuation.js`, `research/45-gapdown-rigor.js`.

## H1 — Gap-down continuation: VALIDATED (the mirror of Gap & Go)

An unscheduled overnight **gap-DOWN** (open ≤ −G% vs prior close) continues lower — clean
monotone dose-response, the symmetric twin of the validated Gap & Go long:

| gap-down | h=3 short excess | win |
|---|---|---|
| ≤ −3% | +0.53% | 54% |
| ≤ −5% | +1.01% | 55% |
| ≤ −7% | +1.50% | 57% |

Positive all three years (2024 +0.85, 2025 +0.98, 2026 +1.11 @ ≤−5% h3).

**Tape nuance (important):** the edge is **stronger on NON-red days** (gap ≤ −5% non-red h3
+1.26%, red +0.60% and *negative* at h1). It's an **idiosyncratic-weakness** signal (a name
gaps down on its own bad news → keeps falling), NOT a broad-market-down tool. On red days many
gap-downs bounce with the market (matches the Phase-1 reversion finding). → belongs in its own
lane, available any tape, **not** inside red-tape-gated Down-Day Mode.

### Rigor (research/45, gap ≤ −5%, h=3)
- **Liquidity tilt:** decreasing but positive at every tier — $25–50M +2.10% / $50–150M +1.03%
  / **$150M+ +0.35% (win 53%)**. Survives in liquid, borrowable names (better than Gap & Go,
  whose liquid half went OOS-flat).
- **Slippage + borrow:** net of round-trip cost — 0% → +1.01%, **0.4% → +0.61%**, 0.8% → +0.21%.
  Real but THIN after realistic short frictions; the biggest gross edge ($25–50M) is exactly
  where borrow is hardest/most expensive.
- **Lumpiness:** top-5 trades = **5.4%** of total P&L (Gap & Go long was 35%); median +0.76%,
  winsorized +1.23%. Broad-based, not outlier-carried — the most robust distribution in the
  whole project.

## H2 — Breakdown (20d-low break + 1.5× vol + below 50-SMA): REJECTED

~zero overall (h3 +0.08%), negative on red days, and decays to negative by 2026 (2024 +0.56 →
2026 −0.30). No durable edge — consistent with the app's long "breakout/breakdown structure is
dead" history.

## Recommendation

Ship H1 as a **validated lead** in a dedicated **🐻 Gap-Down Continuation** short lane (a short
Gap & Go), mirroring the gapgo architecture. Honest caveats to bake into the UI:
1. **Short frictions** eat 0.4–0.8% → net edge +0.2–0.6%; the biggest-gross tier is the hardest
   to borrow. Prefer the liquid/mid tier where you can actually short.
2. **Earnings-skip untested** here — apply Gap & Go's live `isEarningsAdjacent` filter at scan
   time (earnings gap-downs may be one-time repricing that doesn't continue) and forward-track
   the unscheduled subset.
3. Daily-close proxy, not intraday ORB fills — ideally confirm with an opening-range-**low**
   breakdown entry, like Gap & Go's ORB.
