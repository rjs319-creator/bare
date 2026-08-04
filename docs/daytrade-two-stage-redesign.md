# Day Trade Two-Stage Redesign (v3) — discovery health, episode-stable alerts, honest models

Implemented 2026-08-03 on top of the predictive-discovery base (`daytrade-early-runner-v2`,
PRs #180/#201/#212 and the schema-v2/lanes/PIT-dataset work). This document is the operating
manual: architecture, behavior changes, flags/env, migration/rollback, and the evaluation
protocol. **No new predictive edge is claimed anywhere in this work** — every learned-model
surface remains fail-closed behind the pre-registered promotion gates.

## 1. Root causes this closes

1. **Alert flapping was structural.** Only FAILED had a cooldown; STALLING/TOO_EXTENDED/
   EXPIRED re-qualified on a single evaluation against the *identical* thresholds that
   admitted them (zero hysteresis), and *every* revival minted a new `setupId` — which is the
   alert-dedup key — so one noisy name could emit an entry/retire alert pair every couple of
   minutes, each with fresh levels.
2. **The first bullish notification was late.** SCOUT→PRIMED→IGNITION→EARLY_CONFIRMED were
   board annotations only; nothing alerted before `ACTIONABLE_NOW`.
3. **Stale daily values steered live validation.** Stage-2 priority z-scored prior-session
   `pctChange`/`relVol`/`excessPct` (the once-daily candle cache) in the same pool as live
   discovery values; budget rejections were response-only (never persisted, unmeasurable).
4. **Health was partly dishonest and invisible.** Off-session no-op scans stamped
   `lastSuccessAt`; only 3 health states existed; zero candidates was indistinguishable from
   a dead scanner; the UI never read `op=daytradescanhealth`; page-driven scans bypassed
   health entirely.
5. **The board only ran with a viewer.** The GH Actions scheduler ran discovery, but Stage-2 /
   lifecycle / alerts ran only on page traffic — so "background alerts" could not exist.
6. **Sector residual was dead code** (`sectorTodayBars` never passed). **No Web Push** (the
   sw.js `push` listener was unreachable). Notifications re-fired every 60s and ignored
   preferences. `hasEntryAlert` was never set in production (post-entry lock unreachable).

## 2. Architecture of the discovery-to-alert flow

```
GitHub Actions (*/5 min, 08:00–21:55 UTC, wd)          Browser (60s while page open)
  op=daytradescan  ──► lease+idempotency ─► Stage-A scan   op=discover (rate-limited)
     │                    (CUSUM over ≤2,500 liquid names,     │
     │                     premarket/RTH thresholds,           │
     │                     session-boundary state resets)      │
     │                    ─► PIT dataset capture (write-once)  │
     │                    ─► scan-health doc + per-scan        │
     │                       history (source: scheduler/page) ◄┘
     │
  op=daytrade (board tick — NEW; also every browser refresh)
     ├─ discovery merge (never discard known-ticker anomalies)
     ├─ Stage-2 lane selection: management(12) / revalidation(4) / discovery(6) / anomaly(2)
     │    + stale-daily-input decay (×0.25) + rejection log w/ occupying candidate
     ├─ Stage-2 deep validation: 5-min bars + live quote + SPY bars + SECTOR ETF bars (NEW)
     ├─ lifecycle advance (persisted records = live state):
     │    cooldown on ALL soft retirements · hysteresis re-entry band ·
     │    2-consecutive-eval revival confirmation · material-change-gated setupId minting
     ├─ alerts (two classes):
     │    A. EARLY WATCH — upward early-state progression ≥ PRIMED, watch-only language,
     │       what-changed/missing-confirmation/invalidation/freshness/evidence-label
     │    B. CONFIRMED TRIGGER — only from the execution gate (fresh bar+quote, trigger,
     │       VWAP, residual, R:R, extension); plan + risks + why-now
     │    retire/caution suppressed unless the episode was previously alerted;
     │    per-ticker/day (6) + per-cycle (10) budgets; suppressions counted, never silent
     ├─ alert marks stamped onto records (durable "already alerted") → ONE save
     ├─ transition snapshots (+ shadow-model outputs when a champion exists) → grading
     └─ notify feed → in-app notifications (pref-filtered) + Web Push (if VAPID configured)
```

Post-close (23:00 UTC): `op=daytradecapture` (miss taxonomy / lead time) + bounded
`op=datasetgrade` passes (strictly-after labels).

## 3. Behavior changes visible to users

- A **discovery-health strip** on the Day Trade page ("Live discovery is healthy" /
  "coverage is degraded; some movers may be missed" / "stale — scheduler may not be
  running"), with expert diagnostics expandable underneath.
- **Early Watch notifications** (opt-in, default OFF) for PRIMED/IGNITION/EARLY_CONFIRMED
  progressions — explicitly labeled watch-only, with what changed, what confirmation is
  missing, and what invalidates. Never carries entry/stop/target.
- **Confirmed-trigger notifications** unchanged in trigger conditions but no longer able to
  repeat for the same underlying setup; retirements of setups you were never told about no
  longer notify; alert volume is budgeted.
- **Alert settings panel**: per-class toggles, sound, browser notifications, quiet hours,
  per-hour/day caps, and (when the server is configured) background Web Push.
- Notifications no longer re-fire every 60 seconds.
- A **daily retrospective panel** (accrues after the post-close capture run).
- Alerts and lifecycle now advance every ~5 minutes **without the page open** (board tick).

## 4. Feature flags & environment variables

| Var | Default | Effect |
|---|---|---|
| `DAYTRADE_RETIRE_COOLDOWN_MIN` | 20 (clamped 15–30) | Cooldown after STALLING/TOO_EXTENDED/EXPIRED |
| `DAYTRADE_STALE_WEIGHT` | 0.25 | Decay on prior-session inputs in live Stage-2 priority (1 = legacy behavior, 0 = ignore stale inputs) |
| `DAYTRADE_STAGE2_MAX` | 30 | Stage-2 budget (warns at load if below the 24 summed lane reserves) |
| `DAYTRADE_SCAN_INTERVAL_MS` | 300000 | Health-target cadence for staleness math |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | unset | Web Push master switch — unset ⇒ push is a documented no-op, in-app feed remains the delivery path |
| `MICROSTRUCTURE_PROVIDER` | unset | Microstructure adapter provider key; unset/unknown ⇒ null provider (explicit missingness) |
| `CRON_SECRET` | set in prod | Gates op=daytradescan/datasetgrade (+ GH repo secret of the same name) |
| `BLOB_READ_WRITE_TOKEN` | set in prod | All persistence; absent ⇒ documented degraded mode |

Client-side prefs (localStorage `dtAlertPrefs`): earlyWatch (OFF), confirmedTrigger (ON),
retirement (ON), sound, browserNotifications, quietHours, maxPerHour/maxPerDay.

Web Push enablement (one-time): `npx web-push generate-vapid-keys`, add the three VAPID vars
to Vercel Production (mark private key sensitive), redeploy. No code change needed —
`lib/push-notify.isConfigured()` flips on. `op=pushstatus` reports the state honestly.

## 5. Migration & rollback

**Storage migrations — all backward-compatible, no backfill required.**
- Lifecycle records gain `reviveStreak`, `earlyState`, `earlyStateAt`, `alertState`,
  `entryAlertEmittedAt`. Old records lacking them behave as before (`?? 0` / `?? null`
  semantics; `setupId` backfill already existed).
- New Blob docs: `lifecycle/daytrade/rejections/<date>.json`,
  `lifecycle/daytrade/scan-health/<date>.json`, `lifecycle/daytrade/models/*`,
  `notify/push-subscriptions.json`. All additive.
- Alert log gains `suppressed`; feed items gain `kind`. Old readers ignore both.
- `entryAlertEmittedAt` (notification emitted) is deliberately distinct from
  `entryAlertAt` (position entered → MANAGING). A notification never flips position state.

**Rollback:** each layer reverts independently — set `DAYTRADE_STALE_WEIGHT=1` to restore
legacy priority; remove the VAPID vars to kill push; remove the workflow's "Board tick" step
to restore viewer-only evaluation; `git revert` of the lifecycle/alert changes restores the
old engine (new record fields are ignored by old code). Model rollback:
`model-registry.rollback()` restores the prior champion pointer; with no pointer the
deterministic baseline is the champion by construction.

## 6. Evaluation protocol (Stages A–D) — how the changes get judged

- **Stage A (pipeline validation, ~10–20 sessions):** `op=daytradescanhealth?full=1` per day
  — expect ≥95% of expected scans present (`history.scans` vs session length ÷ cadence), no
  `provider-outage`/`no-baselines` streaks, `ok`+`ok-zero-anomalies` dominating; alert log
  shows zero duplicate bullish ids per (setupId) — verified structurally by
  `test/daytrade-flap-guard.test.js` and measurable live from `lifecycle/daytrade/alerts/`.
- **Stage B (discovery recall, ~20–30 sessions):** post-close `op=daytradecapture` miss
  taxonomy + the `remainingFractionOfDayMove` label (detected before 25/50/75% of the move
  is directly derivable from it) + the NEW rejections log (budget misses now measured, not
  inferred) + false-watch rate from the alert log (early_watch count vs later confirmation).
- **Stage C (purged walk-forward):** `op=datasetsurvival` — now reports ROC-AUC, PR-AUC,
  top-decile lift, Brier, ECE/reliability, precision@k, per-fold table, abstention report,
  session-bucket and liquidity-tier slices, vs cusum/relVol/dayPct baselines, with truthful
  episode counts (distinct date×ticker). Fail-closed until ≥21 graded dates.
- **Stage D (prospective shadow):** promote a candidate with `model-registry.promote`
  (requires the promotion-gate result); shadow outputs then accrue in transition snapshots
  beside deterministic scores. Live promotion (`promoteLive`) additionally requires
  `passed-gates` on the model card. Champion/rollback/history are pointer operations.

**Current evidence level, honestly stated:** runner/dud scores = deterministic, uncalibrated,
labeled as such everywhere. Learned models = no trained artifact exists; the dataset is
accruing prospectively (there is no historical intraday data on free feeds — nothing to
train on yet). Early states = pre-registered thresholds being measured for lead time. Regime
suppression = still evidence-gated off. **"No verified edge" is the current, correct status.**

## 7. Known limitations / degraded modes

- GitHub cron is best-effort (~5–15 min real cadence, disabled after 60 days repo
  inactivity) — the health surface reports actual gaps rather than pretending.
- The board tick shares the public CDN-coalesced op; two ticks inside 30s coalesce (fine).
- Blob has no CAS: rare concurrent read-modify-write races on the alert log/feed remain
  possible; layered dedup (transition-only + episode identity + persisted ids + budgets)
  bounds the damage to at most one duplicate under a lost write, and the board tick +
  30s CDN coalescing make concurrent writers rare.
- Spread/halt data: still `unknown ≠ favorable`; microstructure adapter returns explicit
  missingness until a provider is ever configured. Float/dilution/halt-history remain
  unavailable on current data sources.
- Web Push on iOS requires the PWA to be installed (Add to Home Screen) — existing UX copy
  covers this.
