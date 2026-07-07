# Opening-Range Gate vs Naive Prior-Day-High Trigger — 2026-07-06 — **NO-SHIP**

Tests a real leak in the LIVE code: `lib/timing.js` `triggerScore(price, trigger)` flashes
the GREEN "fresh break — prime" light as soon as `price >= trigger*0.99`, and for Day-Trade
picks `trigger` = `lib/daytrade` `orbLevels()` = the **prior session's high**. On a gap-up
open above the prior-day high, the light greens at 09:30 ≈ green-lighting **buying the gap at
the open** — which the project's intraday research calls the leak. Proposed fix: wait ~30 min
for the opening range, then enter only on a break of the OR-high.

Reproduce: `node research/41-orb-gate-validation.js` (no network — local intra5 + daily caches).
Data: `research/data/orb-gate-validation.json` (374 events + summary).

## Method (pre-registered in the script header before looking at outcomes)

374 events (one intra5 file = one name × gap-day of regular-session 5-min bars; 26 skipped
for missing/short data). Prior-day HIGH (the live trigger) + ATR(14) taken from the daily
cache as-of the **prior** bar — exactly what `orbLevels()` saw when the pick fired EOD. Risk
unit = 2.5×ATR(daily) = the shipped ORB stop; stop = entry−risk, target = entry+2×risk (1:2),
realized on the day's remaining 5-min bars (stop-first-if-both, else exit at the last bar).

- **A_open** — enter at the bar-1 open (coordinator's literal "gap chase"), every event.
- **A_trig** — FAITHFUL to live `triggerScore`: enter at the first 5-min bar that reaches the
  prior-day-high trigger (open if it gaps above, else the trigger level intraday); no trade if
  price never reaches it. **This is the current live behavior the change would replace.**
- **B** — OR gate (the proposed fix): ORhigh = max high of bars 1–6; effective trigger =
  max(prior-day high, ORhigh); enter the first bar ≥7 breaking effTrig; no trade if it never breaks.

**Pass bar (pre-registered):** SHIP only if B beats the current live rule **A_trig** on realized
R **AND** PF **AND** lower MAE, with adequate n. Fewer-trades/same-per-trade still passes iff it
avoids losers. **Single-window caveat: intra5 is ~2024–2025 only — validates the MECHANISM, not
multi-regime robustness.**

## Results

Only **111/374** events actually gap-open above the prior-day high (green at 09:30). A_trig
trades 205 (reaches the trigger intraday), B trades 150.

### (1) Head-to-head, on events where Rule B triggers (n=150)

| Rule | meanR | winRate | PF | mean entry→close | meanMAE (R) | stop-out |
|---|---|---|---|---|---|---|
| A_open | **+0.325** | .833 | 6.62 | +6.94% | 0.295 | 3.3% |
| A_trig (live) | +0.236 | .740 | 4.60 | +4.34% | 0.330 | 2.7% |
| **B (OR gate)** | **+0.049** | .553 | 1.52 | +1.35% | **0.225** | 2.7% |

Monotone: the **earlier/lower** you enter, the **more** you capture. B buys highest (at
max(trigger, ORhigh)) and latest, so it books the least of the move. The leak's fix costs net R here.

### (2) Across ALL events (no-trade = 0R / no exposure, n=374)

| Rule | meanR | winRate | PF | meanMAE (R) | stop-out |
|---|---|---|---|---|---|
| A_open | +0.015 | .497 | 1.09 | 0.328 | 4.0% |
| **A_trig (current live)** | **+0.049** | .321 | **1.67** | 0.198 | 2.4% |
| **B (OR gate)** | +0.020 | .222 | 1.52 | **0.090** | 1.1% |

**Rule B does NOT beat the current live rule on R (0.020 < 0.049) or PF (1.52 < 1.67).** Its
only win is MAE — it **halves** adverse excursion (0.090 vs 0.198) and **halves** the stop-out
rate (1.1% vs 2.4%). The fade-avoidance mechanism works exactly as designed; it just doesn't
pay on this sample.

### Fader vs runner (B-triggered subset)

- **Runners** (n=127): A_trig meanR +0.317 / PF 14.2 vs B +0.105 / PF 3.1 — chasing the confirmed
  runner earlier wins big; the sample is 85% runners.
- **Faders** (n=23): both lose (A_trig −0.209, B −0.258), but B's MAE is far lower (0.55 vs 1.34)
  — the OR gate does protect against the morning fade, there just aren't many faders here.

## Verdict: **NO-SHIP**

Pre-registered bar (B beats current-live A_trig on **R AND PF AND MAE**): beatsR=false,
beatsPF=false, lowerMAE=true → **fails**. The OR gate improves fade avoidance (½ the MAE, ½ the
stop-outs) but sacrifices net expectancy and profit factor, because forcing a later break above
max(prior-high, OR-high) means buying **higher** and capturing less of the up-move.

**Why the leak hypothesis looks wrong here — and the honest caveat.** The premise (a morning fade
after the gap open) is real and shows up cleanly in MAE/stop-out. It just doesn't dominate net
outcome on this **single-window, runner-heavy** sample: intra5 is ~2024–2025 and is a curated
day-trade *event* set (selected notable movers), so it is enriched for up days where entering
early pays. In a chop/risk-off regime with more faders, the OR gate's MAE advantage could flip the
net-R balance — this window cannot test that. So this is a NO-SHIP on **current evidence**, not a
permanent rejection of the OR gate; it stays a FUTURE candidate pending a fade-heavier sample.

No integration spec is provided (pass-gated; it did not pass). The one defensible immediate change
is narrower and honest: the live `triggerScore` should NOT show a full "🟢 fresh break — prime"
light while the name is **below VWAP / red on the day** at the open (the actual fade cases) — but
that is a VWAP/trend gate, already partially handled by `scoreTiming`'s below-VWAP cap, not the
OR-high replacement tested here.
