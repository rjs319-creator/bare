# Options Intelligence Engine v2 — "Options Activity Radar — Delayed Chain Anomalies"

The v2 revamp of the Unusual Options section. It replaces "big absolute volume =
unusual" with a ticker-relative anomaly engine, separates **unusualness** from
**direction** from **actionability**, and prospectively evaluates whether options
evidence adds anything beyond the app's own price setups.

## What the page detects — and what it cannot

**Detects:** options activity that is abnormal *for that specific name* — volume,
notional, volume/OI, strike concentration, IV/skew shifts, persistence — measured
against the ticker's own point-in-time history with robust statistics (median,
MAD, winsorized midrank percentiles, minimum sample sizes). A second admission
door lets exceptionally LARGE absolute activity in (with quality controls) while a
name's baseline is still maturing.

**Cannot infer from delayed chains:** buyer vs seller, opening vs closing, hedges
vs bets, linked spread legs, intraday tape. Therefore:

- **Unusualness ≠ direction.** `anomalyScore` (0–100) is *never* a probability or
  a directional read. Calls are not bullish; puts are not bearish.
- **Direction ≠ trade signal.** Direction is at best `*_PROVISIONAL` with
  confidence hard-capped at 55/100 on delayed data, and is commonly `UNKNOWN` —
  an acceptable, useful state that stays fully visible in Discovery.
- **Activity ≠ actionable.** Only an INDEPENDENT chart-math stock setup whose
  price trigger has actually been reached earns `PRICE_CONFIRMED`.

## The two classifications on every event

- **ACTIVITY_STATUS**: `NORMAL · UNUSUAL · HIGHLY_UNUSUAL · EXCEPTIONAL ·
  UNUSUAL_LOW_QUALITY` (data quality is a separate gate, never mixed into the
  score).
- **TRADE_STATUS**: `NO_DIRECTION · ACTIVITY_ONLY · POSSIBLE_HEDGE ·
  POSSIBLE_SPREAD · MIXED · WATCH_FOR_PRICE_TRIGGER · READY · PRICE_CONFIRMED ·
  CONTRADICTS_SETUP · AVOID_EVENT_RISK · INVALIDATED · STALE`.

## Data-source modes

`lib/options-provider-v2.js` resolves the active mode and attaches a capability
disclosure to every payload:

- `DELAYED_CHAIN` (**active**) — free Yahoo chain snapshots. No paid feed is
  required for the app to function.
- `REALTIME_TRADE_QUOTE` — enabled by `OPTIONS_REALTIME_PROVIDER=<adapterId>`
  once an adapter is registered in `REALTIME_ADAPTERS`. Adds synchronized-NBBO
  aggressor evidence and raises the direction-confidence cap.
- `COMPLEX_ORDER` — enabled by `OPTIONS_COMPLEX_PROVIDER=<adapterId>` once an
  adapter is registered. Interprets linked legs as packages.

Nothing fabricates evidence a mode doesn't provide; a misconfigured provider id
falls back to delayed chains and says so in the payload.

**Adding a real OPRA-authorized feed later:** implement an adapter object in
`REALTIME_ADAPTERS`/`COMPLEX_ADAPTERS` (fetch + capabilities), set the env var,
and extend `interpretTicker` for the non-delayed branch (the confidence cap and
sourceMode plumbing already exist). No schema migration is needed — observations
carry `sourceMode` per record.

## Modules

| Module | Responsibility |
|---|---|
| `lib/options-config-v2.js` | Versioned config: model/gate versions, status vocabularies, anomaly weights (**hypotheses**), challenger weight-sets, budgets |
| `lib/options-flags-v2.js` | `OPTIONS_V2_MODE` resolver (`on` default / `off` rollback) |
| `lib/options-provider-v2.js` | Provider adapter + capability disclosure + telemetry-wrapped chain fetch |
| `lib/options-universe-v2.js` | Dynamic tiered universe (core ∪ screener candidates ∪ broad cap-proxy) with deterministic rotating shards; per-DTE-bucket expiry planning |
| `lib/options-observe-v2.js` | Immutable per-session point-in-time observations (aggregates by side×DTE bucket + bounded contract rows + fetch telemetry) |
| `lib/options-anomaly-v2.js` | Robust baselines, feature set, anomalyScore/dataQuality/liquidityQuality, activity status, per-ticker contract retention (ranking fairness) |
| `lib/options-interpret-v2.js` | Cautious direction/structure states; wide-spread/stale-print rejection; spread/hedge footprints |
| `lib/options-trade-gate-v2.js` | Independent price-confirmation gate (versioned), stock plan, honest option-contract selection |
| `lib/options-lifecycle-v2.js` | Event identity, immutable first-seen snapshots, transitions, alert dedup/cooldowns, OI attribution to the ORIGINAL event |
| `lib/options-health-v2.js` | Coverage/freshness/provider diagnostics — failure never reads as "no activity" |
| `lib/options-evaluate-v2.js` | Detection quality; directional value (multi-horizon, SPY+sector-relative, cost-aware, MFE/MAE, target-before-stop); incremental price-only vs price+options; champion/challenger walk-forward |
| `lib/optionsflow-v2-routes.js` | The only storage-owning layer; all five ops |

## Routes

| Op | Auth | What it does |
|---|---|---|
| `op=optionsscan2` | PRIVILEGED (CRON_SECRET) | The scheduled scan. Idempotent per decision session; weekend/holiday invocations whose session is already captured write nothing. Time-boxed (150s); unattempted names recorded as `budget-exhausted` failures. |
| `op=optionsresolve2` | PRIVILEGED | Grades matured events + the price-only control cohort; writes the evidence report. |
| `op=optionsradar` | public read | The current radar doc. Never scans, never mutates. |
| `op=optionsevidence2` | public read | The prospective evidence report. |
| `op=optionshealth2` | public read | Coverage/freshness/provider diagnostics. |

Cron: new `optionsv2` root chain in `lib/warm-chains.js`
(`op=optionsscan2 → op=optionsresolve2`), fired by the daily 22:00 UTC
`/api/warm`. Both writers are idempotent and safe under retries/concurrency
(session-keyed snapshot replacement + transitionId-deduped alerts + scanId-keyed
health folding).

## Storage schema (all new keys — legacy `optionsflow/*` untouched and still served)

| Key | Contents |
|---|---|
| `optionsflow-v2/obs/<session>.json` | Immutable per-session observations for every scanned ticker + universe/telemetry. Baseline raw material. One canonical (latest, most complete) snapshot per session. |
| `optionsflow-v2/events.json` | Lifecycle ledger: immutable `firstSeen` snapshots, history, transitions, OI confirmations, `emittedAlertIds` (bounded 500 events). |
| `optionsflow-v2/controls.json` | Price-only control episodes (same-session valid setups with NO unusual options) — the comparison arm for incremental value. |
| `optionsflow-v2/radar.json` | The published radar the UI reads. |
| `optionsflow-v2/health.json` | Rolling scan health (bounded 30 scans). |
| `optionsflow-v2/evidence.json` | The evaluation report. |

No destructive migration: v1 keys (`optionsflow/<date>.json`, `ledger.json`,
`episodes.json`, …) are neither rewritten nor deleted, and every v1 op keeps
serving.

## Baselines

Per ticker × side × DTE-bucket + ticker-level series (volume, notional, vol/OI,
options-vs-underlying dollar volume, ATM IV, skew, term slope, active strikes),
built from **strictly prior** session docs (`beforeSession` exclusion — the
scored session can never leak into its own baseline). Scoring requires
`minBaselineSessions` (6); full maturity at 12. Until then a name is admitted
only through the absolute-size door and carries an explicit "baseline immature"
warning. Intraday snapshots are session-fraction-adjusted before comparison with
full-session baselines.

## Scoring configuration

`ANOMALY_CONFIG` (id `anomaly-v2-champion`, `hypothesis: true`): 30% time-adjusted
volume percentile · 20% relative notional (incl. options-vs-underlying) · 15%
vol/OI percentile · 15% concentration · 10% IV/skew/term change · 10%
persistence+acceleration, renormalized over available components. Two challenger
weight-sets score in shadow on every event and are walk-forward compared in the
evidence report. **These weights are initial hypotheses — the UI says so.**

## Feature flags / env vars

| Var | Default | Effect |
|---|---|---|
| `OPTIONS_V2_MODE` | `on` | `off` = v2 scan/radar disabled; UI falls back to the legacy tab (rollback lever) |
| `OPTIONS_REALTIME_PROVIDER` | unset | Future realtime adapter id (must be registered; else safe fallback) |
| `OPTIONS_COMPLEX_PROVIDER` | unset | Future complex-order adapter id (same) |

Registry: `optionsflow-v2` (maturity `shadow`, scoringVersion `optionsflow-v2`).
Discovery VISIBILITY is not gated by maturity; live-pick influence is — the layer
cannot originate or boost a Today's Pick until a deliberate registry flip after
the evidence gate clears.

## Monitoring & failure behavior

- Every scan writes a health record: attempted/succeeded/failed (+reasons),
  expiries requested vs returned, contracts inspected, latency p50/p90,
  rate-limit suspicion, per-source coverage, universe shard, last successful
  session, model version.
- Total provider failure → `ok:false` + "PROVIDER FAILURE — … NOT 'no unusual
  activity'", surfaced on the radar banner and the Data Health view.
- Weekend/holiday: `sessionContext()` keys snapshots to the last COMPLETED
  regular session; an already-captured closed-market session is skipped (no
  stale re-keying — this also fixes the v1 UTC-date-key defect for v2 data).

## Evaluation (op=optionsresolve2 → Evidence view)

Three separate questions, never mixed, all prospective (no backfill), clustered
by decision session:

1. **Detection quality** — persistence, later-OI confirmation, spread/hedge
   share, unknown-direction share.
2. **Directional value** — next-open entry, 1/3/5/10/21-session horizons, SPY-
   and sector-ETF-relative, cost-netted, MFE/MAE, target-before-stop, split by
   direction confidence.
3. **Incremental value** — identical-session valid setups WITH options support
   vs WITHOUT (the control cohort). Only a significant positive gap could ever
   justify options evidence modifying live ranking, and promotion remains a
   deliberate governance act.

Probabilities are never displayed: there is no OOS-calibrated model, and the
governance calibration gate is hard-off (inherited convention).

## Interpreting the evaluation results

- `incremental.ready:false` → the question is OPEN; nothing may be claimed.
- `verdict: no-significant-difference` → options evidence has not shown value
  beyond price; the layer stays a discovery/context tool.
- Challenger walk-forward: a challenger with more OOS-positive blocks than the
  champion is a candidate for a config bump (new `configId` + version), never an
  automatic swap.

## Rollback

1. Set `OPTIONS_V2_MODE=off` in Vercel env + redeploy → v2 scan/radar stop; the
   UI falls back to the legacy tab automatically (verified path).
2. Optionally remove `optionsv2` from `ROOT_CHAINS`. v2 blob keys can be left in
   place (they are inert) — do not delete them; ledgers are append-only history.
3. Legacy v1 pipeline is untouched throughout and keeps running either way.

## Tests

`test/options-v2-{anomaly,interpret,gate,lifecycle,universe-health,radar,evaluate}.test.js`
(63 tests) cover the required guarantees: calls/puts never auto-directional,
wide-spread/stale-quote direction rejection, relative-vs-absolute admission,
ranking fairness, DTE-bucket coverage incl. missing expirations, provider-failure
diagnostics, weekend session correctness, spread-footprint honesty, OI
attribution to the original event, unknown-direction visibility, independent
price-trigger requirement, no-deletion staleness, alert dedup, no-future-info
immutability, PIT baselines, and stress fixtures (100× vol/OI small-premium,
multimillion weak-relative, 100% spread, paired-volume no-linkage, crowding
ticker, partial/total provider failure, conflicting call/put, complete-plan
confirmation).
