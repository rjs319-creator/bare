# Market Pulse v2 — Market Intelligence Center

Market Pulse v2 replaces the four-hour editorial attention digest with a three-speed
system: a deterministic **live market state**, **event/narrative intelligence** with
claim-level provenance, and **swing/investor context** — with separate freshness clocks,
direction-aware price confirmation, event-fingerprinted episodes, and per-horizon
prospective grading. The legacy v1 pipeline (`op=pulse`/`op=pulserefine`/…) remains
intact and is the automatic fallback.

## Architecture

| Speed | What | Op | Cadence (actual) |
|---|---|---|---|
| A. Live market state | Deterministic snapshot: SPY/QQQ/IWM/DIA/RSP, VIX, 11 SPDR sectors, breadth (RLT aggregate), macro, market mode, playbook inputs. **No LLM.** | `pulse2statetick` | **~hourly RTH** via GitHub Actions (requested every 5 min; GitHub throttles — see Scheduling reality) + nightly warm chain |
| B. Event & narrative intelligence | One bounded Haiku web-search call → claim-level provenance (real-URL validation, syndication lineage) → event fingerprint fold → reaction/matrix/views/alerts. Fable adds crowding/contrarian (judgment only). | `pulse2collect`, `pulse2refine` | **nightly warm chain in practice** — the intraday gate almost never opens (see Scheduling reality) |
| C. Evaluation | Per-horizon (1/3/5/10/21/63 trading sessions) appendable outcomes, SPY- and sector-relative, cluster-aware uncertainty, setup-vs-setup+Pulse comparison. | `pulse2grade` | nightly warm chain |

Public reads (`pulse2`, `pulse2health`, `pulse2evidence`) are strictly read-only: they
cannot start an LLM call, hit a market-data provider, or write storage (test-locked).

## Modules

- `lib/pulse2-clocks.js` — separate narrative vs market-data freshness clocks, plus
  `nextNarrativeRefreshAt` (the known regen schedule) and `cacheMeta` (honest
  HIT/MISS/REFRESHED/STALE reporting for `op=pulse2&refresh=1`).
- `lib/pulse2-freshness.js` — story-freshness core. Timestamp provenance per source
  (`publishedAt/updatedAt/discoveredAt/dateConfidence`, extraction order JSON-LD →
  article/OG meta + `<time>` → provider timestamp → URL date → unknown; discovery
  time is NEVER publication time), canonical URLs (tracking params stripped),
  wrong-year + evergreen reference screening, event timestamps
  (`eventOccurredAt/firstPublishedAt/firstSeenAt/lastSeenAt/lastCorroboratedAt`),
  freshness reasons (`NEW_PUBLICATION/NEW_MATERIAL_UPDATE/NEW_CORROBORATION/
  REDISCOVERED/SYNDICATED_COPY/ONGOING_EVENT/UNKNOWN`), horizon age gates
  (Day placement = decision relevance: event ≤24h OR publication ≤18h OR material
  update — unverified-publication items surface with visible date confidence;
  Swing ≤7d; Investor age-exposed only; Fresh-verified = the strict verification
  bar, ≤6h KNOWN publication + ≤12h event — env-overridable via `PULSE2_<KEY>`),
  and recency-aware ranking (exponential decay + age/duplicate/unknown penalties,
  deterministic timestamp/id tie-breaks).
- `lib/pulse2-provenance.js` — source index, stable source IDs, syndication lineage,
  claim statuses (`VERIFIED/SUPPORTED/SINGLE_SOURCE/CONFLICTED/UNVERIFIED/STALE`).
- `lib/pulse2-direction.js` — direction-aware reaction states + catalyst reaction matrix.
- `lib/pulse2-events.js` — event fingerprint identity (`entity|family|claim|date|direction`),
  immutable first-seen, measured narrative lifecycle incl. cooling/resolution/expiry,
  direction-flip transitions.
- `lib/pulse2-market-state.js` — deterministic market state + market mode + playbook.
- `lib/pulse2-views.js` — Day/Swing/Investor policies, trade states, actionability contract.
- `lib/pulse2-alerts.js` — transition-only alerts, dedup by transition id, cooldowns.
- `lib/pulse2-grade.js` — appendable per-horizon outcomes, awareness repair, cluster-aware
  summary, incremental-value comparison.
- `lib/pulse2-store.js` — versioned Blob keys under `pulse/v2/*` (one writer per artifact).
- `lib/pulse2-ticks.js` — the four privileged writers.
- `lib/pulse2-routes.js` — the three public read routes + feature flag.
- `public/js/pulse2-render.js` — pure render module (novice/expert, basis chips, honest
  empty states); wired in `public/js/app.js` (`runPulse2UI`, falls back to v1).

Reused (not duplicated): `lib/market-session.js` (session/freshness authority),
`lib/intraday-features.js` (VWAP, opening range, **same-time-of-day relative volume**),
`lib/intraday-data.js` (bars), `lib/swing-sessions.js` (trading-session age),
`lib/stock-setup.js` (daily structure), `lib/macro.js`, RLT sector state, `lib/screener.js`
daily history, `lib/universe.js` + `lib/readthrough.js` (ticker → sector → SPDR ETF).

## Storage (Vercel Blob)

```
pulse/v2/market-state/latest.json   writer: pulse2statetick
pulse/v2/market-state/prev.json     writer: pulse2statetick
pulse/v2/narratives/latest.json     writer: pulse2collect / pulse2refine
pulse/v2/events.json                writer: pulse2collect
pulse/v2/transitions.json           writer: pulse2collect (rolling 500)
pulse/v2/outcomes.json              writer: pulse2grade
pulse/v2/alerts.json + alert-state.json        writer: pulse2collect
pulse/v2/alerts-market.json         writer: pulse2statetick
pulse/v2/health.json                writer: all ticks (merge)
pulse/v2/snap/<gen>.json            immutable write-once archives
```
The legacy `pulse/*` ledger is untouched.

## Auth

All four writer ticks are in `PRIVILEGED_OPS` (`api/tracker.js`) behind
`requireTrusted` — `Authorization: Bearer $CRON_SECRET`; fail-closed 503 in production
if the secret is unset. **v1 defect fix:** `op=pulse` / `op=pulserefine` no longer run
LLM calls for anonymous callers past the refresh boundary — they serve last-known-good
and only a trusted caller regenerates.

## Env & flags

- `PULSE2_MODE` — `on` (default) / `off`. Off ⇒ `op=pulse2` returns `{disabled:true}`
  and the frontend automatically falls back to the v1 feed. This is the rollback lever.
- Reuses existing `ANTHROPIC_API_KEY` (collection/refine only — absent ⇒ narrative layer
  reports UNAVAILABLE, market state still works), `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`.
  No new secrets.

## Scheduling reality

Vercel Hobby allows one daily cron (22:00 UTC warm). The `pulse2` root chain in
`lib/warm-chains.js` guarantees a daily floor. Intraday cadence comes from
`.github/workflows/pulse2-tick.yml`, which **requests** `*/5 13-21 * * 1-5` (every 5
minutes, 13:00–21:59 UTC weekdays) and gates narrative collect+refine to the first firing
of each hour (`MIN < 10`).

**GitHub does not honor that request, and the gap is large enough to change what this
page is.** Scheduled workflows are best-effort and heavily throttled on a busy runner
pool. Measured over 2026-08-10 → 2026-08-13 (32 successful runs, `gh run list`):

| | requested | actually observed |
|---|---|---|
| market-state firings per RTH day | ~108 | **9** |
| median gap between firings | 5 min | **60 min** (min 41, max 72) |
| firings landing in the `MIN < 10` collect window | ~9/day | **1 of 32 (3%)** |

Two consequences, both real rather than cosmetic:

1. **Market state is an hourly read, not a 5-minute one.** Anything downstream that
   assumes near-real-time state (intraday regime layer, VWAP participation, opening-range
   reads) is working from data up to ~an hour old. The clocks report the true age, so the
   page is honest about it — but the *design* intent of a 5-minute loop is not being met.
2. **The narrative layer is effectively starved intraday.** Because throttled firings land
   at arbitrary minutes, the `MIN < 10` gate opens ~3% of the time. In practice
   `pulse2collect`/`pulse2refine` run on the nightly warm chain, not hourly — narrative
   ages of 24h+ are the normal state, not an incident.

The workflow is `active`; nothing is disabled. This is platform scheduling behavior, and
it is recorded here so the cadence column above is not read as a guarantee.

**If a true intraday cadence is required**, GitHub Actions `schedule` is the wrong
transport — an external pinger (the `~/market-news-pinger` launchd fallback pattern) or a
paid Vercel cron tier would be needed. Widening the collect gate (e.g. `MIN < 40`) would
fix the *narrative* starvation on its own without changing transport.

If the workflow is disabled the page still does NOT pretend otherwise — the two clocks and
`op=pulse2health` report actual ages and states (`STALE_NARRATIVE`, `MARKET_CLOSED`,
`UNAVAILABLE`, …).

## Rollback

1. Set `PULSE2_MODE=off` in Vercel env + redeploy (or `vercel env`): page reverts to v1.
2. Optionally disable `.github/workflows/pulse2-tick.yml` (Actions → disable workflow).
3. Optionally remove `'pulse2'` from `ROOT_CHAINS` in `lib/warm-chains.js`.
4. v2 Blob artifacts are additive under `pulse/v2/` — safe to leave in place.

## Honesty contract (enforced by tests)

- A ≥1h-old narrative is never "current"; narrative and market-data clocks are separate.
- Every verified claim maps to URLs the search provider actually returned; invented URLs
  are dropped and counted; syndicated copies collapse to one evidence lineage.
- Bullish confirmation needs bullish tape, bearish needs bearish; mixed/unknown stay context.
- Same-time-of-day relative volume (never partial-day ÷ full-day).
- Different catalysts for one ticker are different events; first-seen is immutable.
- Day-trade states require fresh regular-session data; a narrative alone can never be
  PRICE_CONFIRMED; extended events are not entries.
- Per-horizon outcomes append only at true trading-session maturity, never relabeled.
- Effective sample = distinct decision dates/clusters; no probability below the floor;
  directional value is never auto-claimed (`directionalValueProven` stays false without
  explicit reviewed governance).
- Provider failures render as UNAVAILABLE with reasons — never neutral.

Tests: `test/pulse2-*.test.js` (104 tests, numbered to the behavior list in the v2 spec).
