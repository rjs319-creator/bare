# Day Trade — Early Runner & Dud Engine

> **2026-07 predictive-discovery redesign**: see `DAYTRADE-PREDICTIVE.md` for the added
> layer — canonical feature schema, discovery merge + lane-budgeted Stage-2, frozen live
> plans (mechanical R:R fix), premarket discovery, early research states
> (SCOUT/PRIMED/IGNITION/EARLY_CONFIRMED), PIT cross-sectional dataset + same-day labels,
> runner-capture/miss-taxonomy reporting, and the external-scheduler scan runner
> (`op=daytradescan` / `daytradescanhealth` / `daytradecapture` / `datasetgrade`).

The Day Trade section is a **persistent intraday opportunity system**, not a daily-mover
watchlist. One coherent server-authoritative pipeline:

```
liquid intraday universe
  → cheap broad-market anomaly scan          (op=discover — Stage A, CUSUM change detection)
  → deep live analysis of top anomalies      (Stage 2 — globally ranked, budgeted)
  → continuation / failure research scores   (lib/runner-dud — deterministic, uncalibrated)
  → execution-quality gate                   (fresh bar AND quote, live plan, R:R, no breach)
  → persistent lifecycle                     (lifecycle/daytrade/<date>.json — authoritative)
  → transition alerts                        (op=daytradealerts + shared 🔔 notify feed)
  → immutable snapshots                      (lifecycle/daytrade/snapshots/<date>.json)
  → post-decision grading                    (op=lifecyclegrade — triple barrier, 30/60/120m)
  → champion/challenger research loop        (op=survival — walk-forward, promotion gate)
```

## What each output IS (honesty contract)

| Output | Status |
|---|---|
| Lifecycle states, transitions, retirement reasons | **Deterministic rules** (pre-registered thresholds, not fitted) |
| runnerScore / dudScore | **Research scores** — deterministic evidence blends, 0–100, **NOT probabilities** |
| pcarry "carry odds" | Calibrated on historical data but ~coin-flip tradeable; a **fade-avoidance flag** |
| Survival model (op=survival) | **Shadow research** — walk-forward only, promotion gate `insufficient-data` until ≥400 episodes |
| Any "validated production signal" | **None exists.** The repo's own research found no confirmed tradeable intraday edge after overfitting controls. The system's value is earlier discovery, faster failure detection, honest bookkeeping. |

## Key modules

- `lib/daytrade-config.js` — every policy knob: freshness tolerances (quote ≤120 s AND bar
  ≤10 min, future-skew ≤90 s), Stage-2 budget (`DAYTRADE_STAGE2_MAX`, default 30), live-plan
  parameters, CUSUM/discovery gates, regime policy (`HARD_SUPPRESS:false` until the
  pre-registered evidence gate passes).
- `lib/quote-provider.js` — bulk-quote interface: FMP `/stable/batch-quote` (chunks of 200)
  → Yahoo spark fallback (price-only; coverage/capability reported per scan, never assumed).
- `lib/intraday-discovery.js` — Stage A: per-name EWMA-vol-standardized interval returns +
  one-sided CUSUM (`S ← max(0, S + z − k)`, alarm at `S ≥ h`) over the ~liquid universe
  (curated cap-band lists ∪ expanded cache, price ≥ $3, avg $vol ≥ $2 M). No day-% floor —
  this is how a name surfaces before the +2% Building threshold.
- `lib/daytrade-actionability.js` — Stage 2 + classification: global cross-sectional
  deep-pool selection (active lifecycle names revalidated first — no family-ordering
  starvation), 5-min features + chart-meta quote, `computeLivePlan` (entry = live price,
  stop = tighter of OR-low pad / 1.5×ATR, target 1:2, explicit expiry), persistent
  `classifyPool(priorRecords)`, `collectTransitions`.
- `lib/opportunity-lifecycle.js` — the deterministic state machine (13 states) + setup
  identity: a REVIVED/RECLAIM transition mints a new `setupId`; the failed original setup
  can never re-present under its old identity or plan.
- `lib/daytrade-alerts.js` — transition-only alerts, deduped per `(setupId, toState)` in the
  durable day log before the shared `notify/feed.json` write.
- `lib/runner-dud.js` — independent continuation & failure research scores + drivers;
  `activeModel()` reports the deterministic baseline until a learned challenger passes
  `lib/promotion-gate` on out-of-sample graded episodes.
- `lib/outcome-grade.js` — leakage-safe triple barrier (+0.50/−0.35 ATR pre-registered;
  same-bar straddle resolves conservatively to FAILURE) + `gradeHorizons` (30/60/120 min).

## How to run the workflows

- **Live board**: `GET /api/tracker?op=daytrade` — loads the day's persisted lifecycle,
  advances it against fresh evidence, persists it back, emits alerts + transition snapshots.
  The page triggers this every 60 s (CDN 30 s).
- **Broad discovery**: `GET /api/tracker?op=discover` — one Stage-A scan (the page fires it
  on the same 60 s cadence; CDN 45 s coalesces viewers). Regular hours + premarket
  (session-specific thresholds; interval state resets on session change). The board also
  runs one inline scan per cycle when no fresh persisted result exists (same-cycle
  consumption — no one-refresh delay).
- **Alert log**: `GET /api/tracker?op=daytradealerts[&date=YYYY-MM-DD]`.
- **Grading**: `GET /api/tracker?op=lifecyclegrade[&date=…]` — now also on the daily warm
  cron (`capture` chain), so each session's transition snapshots grade automatically
  post-close, including 30/60/120-minute horizon labels, false retirements and alert latency.
- **Research/champion-challenger**: `GET /api/tracker?op=survival` — embargoed date-grouped
  walk-forward over ALL accrued graded episodes; refuses a verdict below the pre-registered
  bar (≥400 episodes, ≥150 test, ≥3 folds, precision@k lift ≥0.05, net lift after costs,
  ECE ≤0.10). Nothing is promoted from research to display language until it passes.
- **Shadow board (legacy)**: `op=lifecycle` still exists; the live route is now equally
  authoritative because both persist to the same store.

## Honest infrastructure limitations (stated, not hidden)

- **No intraday cron** (Vercel Hobby: one daily cron at 22:00 UTC). Intraday cadence is
  request-driven: while any user has the Day Trade page open, the board re-validates every
  ~60 s and discovery scans every ~45–60 s. With the app closed, nothing scans; alerts
  accrue at the next evaluation and deliver on next open.
- **No server-side Web Push.** Browser notifications fire only while the site is open
  (existing service-worker conventions). The durable alert log + unread badge are the
  reliable delivery path.
- **Spread / halt / order-book data unavailable** on the free feeds — exposed as
  `unknown`, never treated as favorable.
- **Quote provider**: FMP batch quotes (paid key) with Yahoo-spark price-only fallback;
  each scan reports the provider used, names covered, and whether volume was available.

## The most important remaining experiment

Let the pipeline accrue graded first-entry episodes across live sessions (it now does so
automatically: live traffic advances + captures, the cron grades), then run `op=survival`.
The single question that matters: **does the learned continuation model beat the
deterministic gate's precision@k on out-of-sample episodes after costs?** Until that gate
passes, every score stays labeled a research score — by design.
