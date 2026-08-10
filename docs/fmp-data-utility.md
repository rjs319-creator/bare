# FMP Data Utility — inventory, provider, capability audit, vintages

_Last updated: 2026-08-09_

## Why this exists

The app's FMP subscription was consumed through ~20 independent call sites, each
hand-building URLs with its own (usually absent) retry policy, while the plan's
actual limits lived in scattered comments ("estimates are plan-gated",
"batch-quote is 402", "vintage history unverified") that were never established
empirically. The 22:00 UTC cron burst has already cost archive days to
uncoordinated 429s. This work adds the mechanism layer: one provider, one
empirical capability report, and the first estimate-vintage archive stream.

## Current-state endpoint inventory (audited 2026-08-09)

**In production use (all `/stable`, key = `FMP_API_KEY`, always query-string):**

| Family | Endpoints | Call sites |
|---|---|---|
| Quotes | `batch-quote(-short)`, `quote(-short)` — **402 on this plan**, probe-only | `lib/quote-provider.js` (skips), `lib/lowfloat-routes.js` (op=quoteprobe) |
| Screener/universe | `company-screener` (10k row cap/exchange) | `lib/stablecore.js`, `lib/tradable-universe.js` |
| Reference | `profile`, `shares-float`, `stock-list`, `delisted-companies`, `symbol-change`, `sector-pe-snapshot` | `lib/float-data.js`, `lib/pitdata/**`, `api/picks.js` |
| Calendars | `earnings-calendar` (30-day chunks), `ipos-calendar` | `lib/alpha-archive-routes.js`, `lib/pead.js`, `lib/ipo.js` |
| Earnings | `earnings`, `earning-call-transcript` (+1 dead v3 fallback in `lib/earnings-tone.js`) | `lib/pead.js`, `lib/earnings-tone.js` |
| News | `news/stock` | `lib/fundamentals.js` |
| Analyst events | `grades-latest-news`, `price-target-latest-news` (**limit capped at 100, page capped at 0** — frequency IS the coverage), `grades-historical` | `lib/alpha-archive-routes.js`, `lib/downgrades.js`, `lib/revisions.js` |
| Congress | `senate-trades`, `house-trades` | `lib/congress.js` |
| Prices | `historical-price-eod/full`, `historical-chart/{1min,5min}` | `lib/stablecore.js`, `lib/gapgo-verify.js`, research |

**Unused families** (probed by `fmp:audit`): analyst estimates, price-target
summary/consensus, grades consensus, press releases, SEC filing feeds, insider
trading (insiders come from EDGAR via `lib/edgar.js`), institutional/13F,
`all-shares-float`, bulk/batch delivery.

Known duplicate-ish calls (candidates for consolidation, NOT migrated yet —
behavior-preserving migrations only): `company-screener` is pulled by both
`stablecore` and `tradable-universe` with different caching; `grades-latest-news`
is pulled by both `revarchive` and `downgrades`; earnings are pulled per-symbol
and per-calendar in `pead`.

## The mechanism layer (this change)

1. **`lib/fmp-client.js`** — central server-only provider: deterministic error
   categories (400 invalid / 401-402-403 plan-gated / 404 not-found / 429
   rate-limited / 5xx upstream / network / invalid-json), bounded retry with
   full-jitter backoff **only** on retryable categories, `Retry-After` honored
   (capped 15s), per-attempt timeouts, call/retry/bandwidth accounting
   (`getFmpUsage()`), and redaction by construction (no error string ever
   carries a URL or key). **All new FMP code must go through `fmpRequest()`.**
   Existing call sites migrate opportunistically when touched.
2. **`op=fmpaudit`** (privileged) / **`npm run fmp:audit`** (local, key in
   `.env.local`) — probes ~25 representative endpoints across 11 families and
   classifies each `AVAILABLE / EMPTY_BUT_ACCESSIBLE / PLAN_GATED /
   INVALID_OR_LEGACY / TEMPORARILY_FAILED`, with row caps, observed date ranges
   and field lists. The report persists to Blob (`fmp/capability-audit.json` +
   dated vintage under `fmp/audit/`). **Capability is established empirically —
   never assumed from comments.**
3. **`op=estarchive`** — daily analyst-estimate vintage snapshots (see below).
4. **Redaction hardening** — `op=quoteprobe` vendor error text,
   `tradable-universe` and `quote-provider` diagnostics now pass through
   `redactSecrets`/`redactedMessage` before reaching any response.

## Analyst-estimate vintages (`estarchive/<date>.json`)

Consensus estimates are mutable at the vendor; revision features are impossible
without our own point-in-time snapshots. `op=estarchive` (privileged, scheduled
22:30 UTC weekdays from `evidence-tick.yml`, sequential after `revarchive` so
FMP sweeps never race) captures ≤120 symbols/run × 2 periods (annual+quarter,
≤240 calls, 150ms spacing, 230s self-deadline with truncation recorded):

- Priority: names with earnings inside 21 days (from the latest `calarchive`
  snapshot), then the liquid `LARGE` list.
- Write-once date shards, same-day merge (fresher pull wins per symbol), no
  read-modify-write races — the alpha-archive conventions.
- Plan-gated ⇒ HTTP 200 with `gated:true`, nothing written, nothing fabricated.
  Total transient failure ⇒ HTTP 503 so the scheduler sees the missed day.
- Telemetry: `op=archivehealth` gained an `estarchive` section (counts only —
  the prereg-safe pattern).

**PIT contract:** a training row may only use a snapshot whose `collectedAt` ≤
the row's decision time. If no vintage exists for a date, the feature is
unavailable — never backfill current estimates into old dates. Revision features
stay RESEARCH/SHADOW until vintages accrue (≥60 snapshot days before any
walk-forward claim, matching the alpha-archive preregistration discipline) and a
promotion rule is declared **before** evaluation.

## Call & bandwidth budget

Plan limit ~300 calls/min (research fetchers throttle to ~260/min). Daily
scheduled FMP load after this change:

| When (UTC) | What | Calls |
|---|---|---|
| 22:00 burst | warm chains (altprobes ~450, calarchive 3, core, …) | ~500 |
| 22:30 | evidencetick news (~14), revarchive (2–8), **estarchive (≤240 @ 150ms)** | ~260 |
| 13:30 | evidencetick + revarchive (pre-open pull) | ~20 |
| ad hoc | op=fmpaudit (~25, serial 250ms) | 25 |

Rule: never two FMP sweeps concurrently from one trigger (the altprobes
burst-429 lesson). New sweeps go sequential in the 22:30 workflow or get their
own quiet window.

## Licensing / security checklist (confirm with the FMP subscription terms)

- [ ] Persistent raw-data storage & historical archiving permitted
- [ ] Model training and derived-data use permitted
- [ ] Public display: only derived explanations + counts are public
      (`op=archivehealth` is counts-only; raw payload blobs are unlisted)
- [ ] Key handling: env-only (`FMP_API_KEY`), never in client code; all error
      paths that echo provider text pass through `lib/redact.js`

## Next highest-value actions

1. Read the first `op=fmpaudit` report; if estimates are AVAILABLE the vintage
   stream is already accruing — schedule nothing new until ≥60 days.
2. If press releases / SEC filing feeds / insider search are AVAILABLE, add
   collectors following the same estarchive pattern (write-once shards, gate
   recording, quiet-window scheduling).
3. Migrate `lib/pead.js` / `lib/congress.js` / `lib/revisions.js` raw fetches to
   `fmpRequest()` (behavior-preserving, mostly retry-policy upgrades).
4. Build as-of revision features (`lib/research/estimates-adapter.js` already
   defines the fail-closed PIT contract) once vintages exist — shadow only.
