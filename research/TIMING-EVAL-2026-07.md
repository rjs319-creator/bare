# Entry-timing light — evaluation, accountability & self-improvement (2026-07-02)

Goal: evaluate the 1-10 "green light" entry-timing grade (`lib/timing.js`), make it
self-accountable on performance, and let it self-improve.

## 1. Evaluation (`research/34-timing-eval.js`)
Replayed the EXACT shipped `scoreTiming` over 23,319 historical 5-min intraday moments
(momentum_liquid day-trade signals, 2024–2025), grading each moment and measuring the
forward ~1h return from it.

- **The grade IS weakly predictive**: grade→forward rank-IC **+0.055**. Top grades genuinely
  mark better entries — **grade 9 +0.46%, grade 8 +0.31%** forward vs mid-grades negative
  (grade 5 −0.80%, grade 4 −0.25%).
- **But not monotone**: the red/avoid bucket (1–3) *bounced* +0.38% — short-term mean
  reversion. The reality gates (below-VWAP cap, below-stop→2) penalize beaten-down names
  that bounce intraday.

## 2. Where the signal is (`research/35-timing-tune.js`)
Fitting weights by each factor's own validated IC:
- **Factor composite OOS IC = +0.111**, but the **gated 1-10 grade only +0.031** → the reality
  gates cost ~2/3 of the raw predictiveness (they trade short-term IC for swing-risk
  avoidance — defensible for a multi-day hold, and the LIVE ledger resolves on that horizon).
- Per-factor IC: **trend +0.063** (strongest), rvol +0.042, rr +0.026 help; **extension −0.035,
  trigger −0.069** are slightly counterproductive at 1h (chasing/extended continues short-term).
- **Re-weighting does NOT beat the shipped hand-weights** (fitted +0.101 < shipped +0.111) —
  they're already near-optimal. So the improvement lever is not a static re-weight; it's
  accountability + a *dormant* adaptive tuner that acts only if the live edges drift.

## 3. Self-accountability (shipped)
- `op=timinglog` (warm cron): grades today's day-trade picks with a live snapshot (using the
  active weights) → `timing/<date>.json` (grade + factor values + entry price).
- `op=timingbook`: resolves each to a forward **3-session excess-vs-SPY** return, split by
  grade bucket (🟢/🟡/🔴 → n / avg excess / beat-rate) with a one-number **grade→outcome IC**.
- UI: a "🟢 Timing-light accountability" scorecard on the Day Trade tab (green should beat
  amber should beat red; "building…" until ~20 resolve).

## 4. Self-improvement (shipped)
- `lib/timing-adapt.js` `championChallenger`: fits challenger weights (each factor ∝ its
  validated forward-return IC, shrunk 50/50 toward the champion), and **promotes only if the
  challenger beats the active weights out-of-sample by ≥0.01 IC on ≥120 resolved picks**, with
  a bounded 25% step — else keeps the champion. Idiomatic to the app's recalibrate/fade-engine.
- `op=timingtune` (warm cron) runs it; `scoreTiming` now takes configurable weights and
  `runTiming`/`op=timinglog` load the active (possibly promoted) weights from
  `timing/weights.json` (versioned). **Dormant until the ledger matures** — verified on the
  23k eval rows it correctly KEEPS the shipped weights (challenger 0.114 vs champion 0.111,
  below the margin — no churn on noise).

Net: the green light is now honest about itself — it measures whether greener actually
preceded a better entry, and re-weights its own factors only when the evidence says so.
Reproduce: `node --env-file=research/.env research/34-timing-eval.js` then `node research/35-timing-tune.js`.
