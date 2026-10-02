# Lane 7 — Infrastructure, storage, job orchestration, observability, auth

## Lane summary
Screened 50 repos/products via `gh api repos/...` plus Vercel/Upstash/Turso/Neon/Sentry/healthchecks docs, judged against the four concrete pains (Blob lost appends + 10-60s lag, 38-chain nightly burst with OOM/timeouts, un-memoized fan-out, silent cron failure). Headline: **the two worst pains need no new vendor** — `@vercel/blob` **2.4.0 (already installed) supports `ifMatch` ETag conditional writes**, which turns every read-modify-write in `lib/store.js` into a safe compare-and-swap; and a **GitHub Actions matrix workflow** (pattern already used in `.github/workflows/evidence-tick.yml`) can replace the in-process 38-chain dispatcher in `api/warm.js` with 38 independently-timed, retryable, emailed-on-failure jobs. Second tier: Vercel Runtime Cache + `async-cache-dedupe` for fan-out, healthchecks.io dead-man pings, Edge Config for latched regime state. Important correction to the brief: the codebase is **CommonJS** (`require` throughout, no `"type":"module"`), so ESM-only libs (hyparquet, p-limit v7, better-auth, @auth/core) need `await import()`.

## Candidates
| Repo / product | Stars | Last push | License | Lang | What it does | Fit | Verdict |
|---|---|---|---|---|---|---|---|
| vercel/storage (`@vercel/blob` 2.8.0) | 598 | 2026-09-19 | Apache-2.0 | TS | Blob SDK; `ifMatch` CAS writes, `get({useCache:false})` consistent reads (private stores, ≥2.6) | lib/store.js lost appends + lag | **ADOPT** |
| GitHub Actions matrix (existing) | — | — | — | YAML | 38 jobs × `timeout-minutes`, `fail-fast:false`, failure email | api/warm.js chain burst, silent failure | **ADOPT** |
| vercel/vercel (`@vercel/functions` getCache) | 16,336 | 2026-10-01 | Apache-2.0 | TS | Runtime Cache: per-region KV, 2MB items, TTL+tags, framework-agnostic | cross-invocation fetch memo | **ADOPT** |
| mcollina/async-cache-dedupe | 714 | 2026-09-28 | MIT | JS (CJS) | In-flight dedupe + TTL + stale, memory/Redis storage | lib/http.js fan-out | **ADOPT** |
| healthchecks/healthchecks (hosted) | 10,376 | 2026-09-30 | BSD-3 | Py (hosted; ping = curl) | Dead-man switch: /start, /fail pings, 20 free checks | "cron failed 7 nights, UI silent" | **ADOPT** |
| vercel/storage (Edge Config) | 598 | 2026-09-19 | Apache-2.0 | TS | <1ms global reads of small JSON, REST writes | latched regime / kill-switches / health flag | **ADOPT** (S) |
| upstash/redis-js | 974 | 2026-10-01 | MIT | TS (dual) | HTTP Redis; atomic LPUSH/XADD/INCR; 500k cmds/mo free | append ledgers, counters, health | RESEARCH-ONLY |
| Vercel Queues (`@vercel/queue`, beta) | — | docs 2026-09 | — | TS | Durable topics, push to plain function via `vercel.json experimentalTriggers`, retries, 60-min visibility, 1M ops free | native replacement for chain dispatcher | RESEARCH-ONLY |
| inngest/inngest-js | 1,011 | 2026-10-01 | Apache-2.0 (SDK) | TS (dual) | Step functions: memoized `step.run`, per-step retry, concurrency keys; 50k exec/mo free | 38 chains → steps | RESEARCH-ONLY |
| tursodatabase/libsql-client-ts | 577 | 2026-09-02 | MIT | TS (dual) | SQLite over HTTP (hrana); 5GB/500M reads free; embedded replicas | ledgers + research panels in one SQLite format | RESEARCH-ONLY |
| hyparam/hyparquet (+ -writer) | 955 / 66 | 2026-09-27 | MIT | JS (ESM) | 0-dep Parquet read via HTTP range (browser+Node) | research/ panels → columnar slices | RESEARCH-ONLY |
| ghostfolio/ghostfolio | 9,391 | 2026-10-01 | AGPL-3.0 | TS | NestJS+Postgres+Redis portfolio tracker, Yahoo provider, JWT | future paper-portfolio | REFERENCE |
| openbq-org/OpenBB | 73,737 | 2026-10-01 | NOASSERTION | Py | Provider/fetcher standardization, platform backend | data-pipeline shape | REFERENCE |
| clerk/javascript (`@clerk/backend` dual CJS) | 1,761 | 2026-10-02 | MIT | TS | Hosted auth; clerk-js via CDN fits vanilla frontend; 10k MAU free | accounts if ever needed | REFERENCE |
| isaacs/node-lru-cache | 5,918 | 2026-09-18 | BlueOak | JS (dual) | In-process LRU with TTL | per-invocation memo | REFERENCE (dedupe lib covers it) |

## Top proposals (ranked by pain removed)

### 1. CAS writes in `lib/store.js` via Blob `ifMatch` — removes lost appends (S)
- **Build:** `readJSONWithEtag(path)` (use `head()` for etag + fetch body) and `updateJSON(path, mutateFn, {retries:5})`: loop { read → `put(path, body, {ifMatch: etag, allowOverwrite:true})` → on `BlobPreconditionFailedError` re-read with jittered backoff }. Migrate the RMW callers (`writeJSON` after `readJSON` in pulse2-store, insider-cluster, nav-ledger, immutable-ledger, candle-cache sharded appends) to `updateJSON`. Keep `writeJSON` for single-writer snapshots.
- **Lag:** the 10-60s read-back lag is CDN propagation on *public* blobs; cache-bust query params (already done) only partly help. For hot singletons create a **private** store and read with `get(path,{useCache:false})` (bump `@vercel/blob` to ≥2.6 — 2.5 had deprecated it, 2.6 restored). Public store keeps the public feed/picks.
- **Shape:** zero new deps. **Risk:** ifMatch + many writers = retry storms; cap retries, log `casConflicts` into `op=health`. **Measure:** count CAS conflicts/night and rows-lost (compare appended vs expected) — should go to 0.

### 2. GitHub Actions matrix replaces the in-process chain dispatcher — removes OOM burst + silent failure (S→M)
- **Build:** `.github/workflows/nightly-chains.yml` with `strategy: {matrix: {chain: [ROOT_CHAINS...]}, fail-fast:false, max-parallel:4}`, each job `timeout-minutes: 6` calling `/api/warm-chains?chain=<name>` (the existing `warmChainOne` endpoint) with `CRON_SECRET`, `retry` via a 2-attempt loop. `api/warm.js` keeps only the cache-warm (steps 1-2) and the health report; `WC.dispatchDelayMs` staggering becomes unnecessary. Generate the matrix from `lib/warm-chains.js` with a script + test pin so the two never drift.
- **Why:** gives per-chain timeouts, isolated memory (no shared Fluid instance OOM), a run log per chain, automatic failure e-mail, manual re-run of one chain, and `concurrency` to serialize ledger→decision ordering (use `needs:` for the 3 ordered chains). GitHub throttles schedules (observed ~hourly jitter) — fine nightly; private-repo minutes ≈ 38×2 min×22 days ≈ 1,700/mo, inside the 2,000 free (verify plan).
- **Alternatives:** Vercel Queues (beta, native, retries with 60-min visibility, plain-function consumer — RESEARCH as the long-term replacement once GA; needs `@vercel/queue` CJS check); Inngest (richest: memoized steps, but wraps every op in `serve()` + new vendor); QStash (1,000 msgs/day free, only 10 schedules — too few for 38). Vercel Workflow SDK **rejected**: requires Nitro/Next build transform for `'use workflow'`, no plain `api/*.js` path.
- **Measure:** `op=health` reads GH run conclusions via `gh api` or the workflow posts a `chains/<date>.json` summary; target failCount=0, zero OOM, every chain under its own wall.

### 3. Fetch memoization: Runtime Cache + async-cache-dedupe in `lib/http.js` (M)
- **Build:** `memoFetchJSON(url, {ttl, tag})` = L1 `async-cache-dedupe` (in-flight dedupe + 60s TTL, memory storage) → L2 `getCache()` from `@vercel/functions` (per-region, TTL per vendor: candles 12h tagged `candles`, quotes 60s, SEC 24h) → `fetchWithTimeout`. Wire `candle-cache`, FMP/Finnhub/Yahoo helpers, and the swingsearchgrade ~2,800-call path through it; `expireTag('candles')` after the nightly rebuild.
- **Shape:** 2 npm deps (`@vercel/functions` CJS, `async-cache-dedupe` CJS). **Risk:** 2MB item cap (shard big docs), regional cache (fine, single region), cache-poisoning on vendor error (only cache `r.ok`). **Measure:** log fetches/invocation and L2 hit-rate to `op=health`; expect swingsearchgrade to finish inside 300s.

### 4. Dead-man monitoring: healthchecks.io pings (S)
- **Build:** in `api/warm.js` ping `https://hc-ping.com/<uuid>/start` on entry, `/<uuid>` on success, `/<uuid>/fail` with the JSON report body on failure; one check per matrix job in #2 (20 free checks → group chains, or 1 check per GH job via a reusable step). Surface check status in the health banner (`op=health` fetches healthchecks' read-only API) so "cron failed" is visible in the UI, not derived client-side from `failed[]`.
- **Alternatives:** Sentry Crons (`withMonitor`, only 1 free monitor), cronitor-js (34★), Axiom log drain for retention. **Measure:** time-to-detect a failed night ≤ 1h.

### 5. Edge Config for latched state + kill switches (S)
- **Build:** move `regime latched`, `promotion/eligibility flags`, `maintenance/kill-switch` into Edge Config (`@vercel/edge-config` CJS; writes via REST from the nightly job). Frontend reads via one `/api/flags`. Resolves the "regime raw vs latched disagree" class by making the latched value a single strongly-visible key. **Risk:** small (≤512KB total), slow writes (seconds) — not for ledgers.

### Deferred research (not proposals yet)
- **Turso/libSQL** as the ledger DB (picks/scoreboard/registry rows): SQL + strong consistency + the same SQLite file usable offline in `research/`. Large migration (L); do after #1 proves Blob CAS insufficient.
- **hyparquet(+writer)**: emit `research/` panels as Parquet into Blob; browser/function read column slices via range requests; DuckDB-wasm in a research tab for ad-hoc queries. Pure-JS, ESM-only (dynamic import).

## Rejected / noise
- vercel/workflow (2,444★) — needs Nitro/Next compiler plugin; not usable from vanilla `api/*.js` CJS.
- triggerdotdev/trigger.dev (16,454★) — requires its own worker runtime/deploy; overkill for 38 nightly HTTP calls.
- windmill-labs/windmill, hatchet-dev/hatchet, timgit/pg-boss — self-hosted or long-running worker required; not zero-ops on Vercel.
- upstash/qstash-js — 10 schedules on free tier (<38 chains); fine as a retrying publisher but GH Actions already covers it.
- duckdb/duckdb-node-neo — native binary inside a 250MB function bundle; cold-start and size risk; use wasm/hyparquet instead.
- cloudflare/workers-sdk (D1/R2) — D1 REST query exists (POST `/accounts/{a}/d1/database/{d}/query`, 5M reads/day free) but adds a second cloud with cross-region latency; no edge over Turso/Blob.
- neondatabase/serverless — good driver, but Postgres scale-to-zero cold starts + 100 CU-h/mo free; Turso is the lighter SQL option if SQL is ever needed.
- tinybirdco/* — ClickHouse SaaS, 1k req/day free; analytics-scale tool for a KB-scale ledger.
- apache/arrow (JS) — heavy dependency for what hyparquet does in 0 deps.
- sindresorhus/p-limit v7, p-memoize, p-queue, p-retry — ESM-only; `lib/http.js` already has retry/backoff and a worker pool; async-cache-dedupe covers memoization.
- epicweb-dev/cachified — ESM-only, SWR semantics similar to async-cache-dedupe (CJS) which wins on module fit.
- SGrondin/bottleneck, mhart/aws4fetch — unmaintained (2024).
- jperasmus/stale-while-revalidate-cache (80★), cronitorio/cronitor-js (34★), logtail-js (75★), axiomhq/axiom-js (149★) — small; use via plain HTTP if ever adopted.
- open-telemetry/opentelemetry-js, vercel/otel — OTel SDK cold-start cost not justified for a nightly cron; dead-man ping is the right primitive.
- louislam/uptime-kuma (92k★) — push monitors work but self-hosted.
- lucia-auth/lucia — deprecated Mar 2025 (now a guide); its single-file session code is vendorable if a hand-rolled session is ever wanted.
- better-auth (30k★), nextauthjs/next-auth (@auth/core) — ESM-only and DB-backed; for a single-user site the existing `requireTrusted` bearer + Vercel Deployment Protection suffices; Clerk if a small team appears.
- stocknear/frontend (43★, AGPL, Svelte) — backend repo no longer public; nothing verifiable to port. virattt/ai-hedge-fund — Python LLM picker; contradicts the "LLM pickers are flat" conclusion.
