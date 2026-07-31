# GRIDLOCK — Data Sources

All adapters live in `lib/gridlock-sources.js`, run server-side only, go through `lib/http.js fetchWithTimeout` (12s timeout, 1 retry with full-jitter backoff on 429/5xx/timeouts), and **fail soft**: a missing key or dead endpoint returns `{ ok:false, reason }` and the region state marks those fields missing. No adapter fabricates a value. Every fetch produces a `sourceManifest` record (id, family, publisher, url, retrievedAt, primary/secondary, parserVersion, ok/reason) stored with the snapshot.

## Connected in slice 1 (PJM)

| Source | Endpoint(s) | Auth | Refresh | Known latency / caveats |
|---|---|---|---|---|
| **PJM Data Miner 2** | `inst_load`, `load_frcstd_7_day`, `gen_outages_by_type` | `PJM_API_KEY` header (`Ocp-Apim-Subscription-Key`; free registration at dataminer2.pjm.com) | nightly cron | Instantaneous load ~5-min lag; outage feed is daily. LMP (`da_hrl_lmps`/`rt_hrl_lmps`) NOT wired yet → congestion/spark components report missing. Installed capacity is not in these feeds → a disclosed 180 GW assumption (labeled `assumed`). |
| **EIA v2** | `electricity/rto/region-data` (D/NG/TI), `electricity/rto/fuel-type-data`, respondent=PJM | `EIA_API_KEY` (free) | nightly | Hourly series lag 1–2h; used as load fallback + fuel mix. |
| **NWS** | `api.weather.gov/alerts/active?area=<PJM states>` | none (User-Agent etiquette, reuses `SEC_USER_AGENT`) | nightly | Verified working live. Alert count is a demand-risk proxy, not a forecast. |
| **NewsAPI** (existing trusted feed) | `/v2/everything`, one bounded power/grid query, pageSize 20 | `NEWS_API_KEY` (already used by `api/news.js`) | nightly | 100 req/day free tier — one query/day. Headlines+descriptions only; deterministic classification first, ≤2 LLM extractions/tick. |
| **Curated seeds** | `lib/gridlock-seed.js` | — | code change (PR-reviewable) | 4 documented PJM events (Crane PPA 2024-09-20, Talen/AWS 2024-03-04, PJM BRA 2024-07-30, Homer City 2025-04). Deliberately stale → never actionable; they seed the pipeline model. |
| **Anthropic (Haiku)** | bounded `submit_physical_event` tool call | `ANTHROPIC_API_KEY` | ≤2 calls/tick | Proposals are grounded against source text; can only classify/point, never invent numbers/dates/regions. |

## Available for later slices (already in the repo)

- **SEC EDGAR** (`lib/edgar.js`) — filing evidence for exposure verification and event lifecycle transitions.
- **Company IR / market data** — `lib/fundamentals.js` (FMP Premium/Finnhub), `lib/screener.js` candles (used already for tape/timing/resolution).

## Not yet implemented (documented, not faked)

ERCOT public market data, CAISO OASIS, NERC reliability assessments, PJM LMP/congestion feeds, gas hub prices (the `gas` input is currently null → fuel component reports missing).

## Env vars

`PJM_API_KEY` (optional), `EIA_API_KEY` (optional), `NEWS_API_KEY` (existing), `ANTHROPIC_API_KEY` (existing), `SEC_USER_AGENT` (existing), `GRIDLOCK_MODE` (`off|shadow`, default shadow), plus the platform's `BLOB_READ_WRITE_TOKEN` / `CRON_SECRET`. All server-side; nothing reaches client bundles (the frontend only calls `/api/tracker`).

## Operational profile

Bounded per tick: ≤8 candle fetches, ≤6 OMEGA evaluations, ≤2 LLM extractions, one news query, 3 parallel region adapters. Resolve caps at 40 pending candidates/run (rest next tick). Cron: the `gridlock` root chain (`op=gridlocktick` → `op=gridlockresolve`) inside the single daily `/api/warm` (22:00 UTC). Writers require the CRON_SECRET bearer; the read is a public cached snapshot (`s-maxage=600`).

## How to add another ISO region

1. Add a `REGION_NORMS` entry (`lib/gridlock-region.js`) with that market's seasonal anchors — never reuse PJM's.
2. Add an ISO adapter in `gridlock-sources.js` returning the same input shape, and extend `fetchRegionInputs`.
3. Extend `STATE_ISO` (`gridlock-events.js`) with the footprint states.
4. Add region-scoped rows to the exposure graph (cited, effective-dated).
5. The scorer, causal matrix, lifecycle, UI and tracking need **no** changes.

## How to add another constraint domain (semis, transformers, cooling…)

The event envelope, dedup, lifecycle, exposure-role graph, causal-matrix shape, decomposed scoring, gates and prospective tracking are domain-agnostic. A new domain adds: event types + `CONSTRAINT_OF_EVENT` entries, a domain "region/market" notion with its own norms, adapter(s), exposure roles/rows, and causal-matrix rules — as a new `RULES` group, not edits to the electricity rules.
