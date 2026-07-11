# Architecture Improvement Plan — market-news-app

> **Phase 1 audit — read-only.** No production code has been modified. This document is the
> deliverable of the audit pass. Every issue below carries: Severity · Evidence (file:line) ·
> Impact · Recommended change · Implementation risk · Disposition (recommended batch vs deferred).
>
> Audit method: six parallel read-only reviewers over (1) the daily cron, (2) Blob storage &
> data integrity, (3) `?op=` routing & security, (4) external-feed reliability, (5) frontend &
> duplicated scoring, (6) cost. Findings are consolidated and de-duplicated here.

---

## Implementation status (updated)

Branch `harden/security-batch1` — 4 batches shipped, **561/561 `node --test` green**, nothing deployed.

| Batch | Commit | Findings addressed |
|-------|--------|--------------------|
| 1 — Security | `fc9ab0e` | H2, H3, H4, H5, H8, M12, M15 (+ auth follow-through) |
| 2 — Data integrity | `7abebd4` | H1, H14, M5 |
| 3 — Cron resilience | `f32bfd3` | H9, H10, M1, M2 |
| 4 — Feed reliability | `9d635c6` | H6, H7 (partial), M11 (+ retry capability for M7) |

**Requires your action before Batch 1 is active:** set `CRON_SECRET` (+ optional `ALERTS_INGEST_TOKEN`, `INSIDER_INGEST_TOKEN`) in Vercel; update the two external collectors to send the token/bearer; deploy.

**Not yet done (need your deploy + live verification, or are larger):** H11/H12/M14 (Batch 5 frontend slice), H13 (Apex scorer unification — touches live client scoring), H15 + M8/M10/M13 (Phase 3 cost/scaling), plus the browser-triggered admin-write residual (`recalibrate`/`backfill`/`exits`/`longshort`/`pead`/`gameplan`). M4/M6 (insider sharding / schema envelope) deferred from Batch 2 as lower-urgency.

---

## 0. Repository assessment

A single-user momentum/regime **dashboard** (explicitly not an alpha engine — see `APP-REVIEW-FOR-CHATGPT.md` §6). Vanilla-JS no-build frontend, Node ESM Vercel serverless backend, Vercel Blob JSON storage, one daily cron. Constraints are real and respected: 11 `api/*.js` files fit the Hobby 12-function cap by multiplexing ~130 logical ops through `?op=` into `lib/*-routes.js`; a single 13:00-UTC cron does ~48 jobs under a 60s budget.

**The codebase is in better shape than its size suggests.** The good foundations found during audit:

- Date-keyed ledgers are **overwrite-by-date**, so cron retries do **not** duplicate picks/snapshots.
- The Yahoo cookie+crumb handshake is a **single cached adapter** (`lib/options-baseline.js`), reused (not re-implemented) by `lib/firesale.js`, refreshed once on 401.
- LLM output is **validated before it affects stored data** (parse/clamp/enum-allowlist/ticker-allowlist in `lib/alerts-fable.js:97-117` and peers); LLM tools are **not** general-purpose (only fixed `submit_*` + hosted `web_search`).
- LLM spend is **already tightly bounded and cached** — every call is a single batched `messages.create`, cron pre-builds and on-demand reads the cache. No per-ticker LLM loops anywhere.
- No secret logging; no CORS-open headers; the no-build **shared ES-module pattern already works** (`public/js/format.js` is imported by `app.js`).

**The problems cluster in five areas:** (A) the cron can silently drop jobs and hide it; (B) a failed provider/scan can be persisted as a legitimate empty dataset, corrupting permanent history; (C) essentially every expensive/write/LLM op is reachable unauthenticated; (D) no fetch has a timeout and failure is indistinguishable from "no data"; (E) the Blob read-all-history pattern grows unbounded. The frontend monolith and the Apex train/serve duplication are real but lower-urgency.

---

## 1. High-severity issues

### H1 — Provider/scan failure persisted as an empty ledger, clobbering complete history
- **Severity:** High (permanent, unrecoverable data corruption)
- **Evidence:** `lib/apex-routes.js:73-88` per-scope `try{…}catch{/* skip */}`, then `writeDay(date, picks, sp500)` called **unconditionally** at `apex-routes.js:100` (same shape: `writeApexDay` :563, `writeGhostDay` :613). `lib/store.js:14` writes with `allowOverwrite:true`.
- **Impact:** If some/all scopes throw on a cron re-hit, the reduced/empty array **overwrites a previously-complete same-day snapshot**. All-scopes-fail ⇒ a legitimate-looking "0 picks" day; the Scoreboard then measures a truncated universe. Newer event ledgers already guard (`screener-routes.js:1835,2070` gate on `length`) — the three oldest core ledgers do not.
- **Recommended change:** Refuse to overwrite a complete day with a run where any scope failed or `picks.length < existing`; write to `<date>.partial` or skip when empty. One extra read to compare.
- **Risk:** Low (additive guard).
- **Disposition:** **Recommended batch — Data Integrity.**

### H2 — `/api/warm` cron endpoint is fully public (no CRON_SECRET)
- **Severity:** High (cost + integrity)
- **Evidence:** `api/warm.js:28` — handler runs the full cycle with no inbound auth (no `Authorization: Bearer`, no `x-vercel-cron` check).
- **Impact:** One anonymous GET fans out to ~3 backtest scans + ~4 screener scans + `track/narrative/apexlog/ghostlog/archive/intracapture/optionsflow` — dozens of Yahoo scans, an LLM call, and many Blob writes, on demand and repeatable.
- **Recommended change:** Require `req.headers.authorization === 'Bearer '+process.env.CRON_SECRET`; set the secret in Vercel cron config.
- **Risk:** Low.
- **Disposition:** **Recommended batch — Security.**

### H3 — Spoofable `?warm=1` / `x-warm` forces the full live scan + cache rewrite
- **Severity:** High (cost)
- **Evidence:** `api/screener.js:236` `isWarm = !!(req.headers['x-warm'] || req.query.warm)`; `lib/candle-cache.js:48-55` bypasses cache and rebuilds/writes on `isWarm`.
- **Impact:** `GET /api/screener?scope=large&warm=1` runs the ~515-ticker live Yahoo scan (~23s) + a Blob write, bypassing the CDN — a cheap lever to run up Yahoo load, function-seconds, and Blob writes.
- **Recommended change:** Gate the cache-bypass/write path on `CRON_SECRET`, not a spoofable header.
- **Risk:** Low-Medium (keep the real cron working).
- **Disposition:** **Recommended batch — Security.**

### H4 — Ingest token gates fail OPEN; GET can wipe stores
- **Severity:** High
- **Evidence:** `lib/alerts-routes.js:15` and `lib/capture-routes.js:142`: `if (token && … !== token) 401` — when the env var is unset, `token` is falsy and the check is skipped. Combined with no method check, `GET …?op=insideringest&reset=1` (`capture-routes.js:147`) / `op=alertsingest&reset=1` (`alerts-routes.js:18-22`) wipe the store unauthenticated.
- **Impact:** Silent, credential-less destruction of the alerts / insider history.
- **Recommended change:** Fail **closed** — if the token env var is missing, reject `503 not configured`; require POST for ingest/reset.
- **Risk:** Low (verify external builders send the token).
- **Disposition:** **Recommended batch — Security.**

### H5 — ~40 LLM / web-search / write ops reachable by anonymous GET
- **Severity:** High (largest cost exposure)
- **Evidence:** dispatched from `api/tracker.js:50-177` with no auth: `pulse`/`pulserefine`, `anomalytick`, `biotechtick`, `secondwavetick`, `crossassettick`, `toneshifttick`/`tone`, `readthroughtick`, `optionsassess`, `alertsassess`, `narrative`, `recalibrate`, `track`, `*log`, `archive`, `*build`, `baseline`, `backfill`. Web-search sites: `lib/pulse-routes.js:174`, `anomaly.js:115`, `biotech.js:305`, `secondwave.js:115`, `crossasset.js:95`, `toneshift.js:92`, `earnings-tone.js:111`.
- **Impact:** Each anonymous hit spends Anthropic tokens **plus** metered web-search calls and/or Blob writes; `recalibrate` can re-weight the model.
- **Recommended change:** One shared `CRON_SECRET` gate in the dispatcher on every write/LLM/tick/build op (all are cron-driven — the warm cron just forwards the header). Leave cached read ops public.
- **Risk:** Low.
- **Disposition:** **Recommended batch — Security** (single fix covers H2/H3/H5 and most write-op exposure).

### H6 — No request timeout / AbortController on any fetch
- **Severity:** High (reliability)
- **Evidence:** grep for `AbortController` / `AbortSignal.timeout` / `signal:` across `lib/` + `api/` → zero real matches. Fetch sites incl. `lib/screener.js:37`, `fundamentals.js:31-189`, `edgar.js:20-69`, `options-baseline.js:22-131`, `earnings.js:21`, `api/momentum.js:73`.
- **Impact:** A single hung upstream socket consumes the entire 60s function budget; behind 12-18-wide pools one slow host starves the pool and fails the request with no partial result.
- **Recommended change:** One shared `fetchWithTimeout(url,{timeoutMs})` using `AbortSignal.timeout` (6-8s Yahoo/Finnhub, 10s SEC), catching `AbortError` distinctly.
- **Risk:** Low (behavior-neutral on happy path).
- **Disposition:** **Recommended batch — Feed Reliability.**

### H7 — Provider failure indistinguishable from "no data"
- **Severity:** High (integrity + observability)
- **Evidence:** `lib/screener.js:53-58` returns `null` identically for network error / empty / <60 candles; `fundamentals.js:32,71`, `edgar.js:35,71`, StockTwits fetches all `catch { return [] }`. No categorization of ok / empty / 429 / 401 / 5xx / timeout / bad-JSON.
- **Impact:** A throttled or auth-failed provider looks exactly like "this ticker has no signal" — screeners silently drop names; feeds a false empty into H1.
- **Recommended change:** Return a discriminated result `{status:'ok'|'empty'|'rate_limited'|'auth'|'unavailable'|'timeout'|'bad_response', data}` at the fetch boundary (compat shim `data ?? null` keeps callers working). `lib/fundamentals.js:182-199` already models this correctly.
- **Risk:** Medium (many call sites; migrate incrementally).
- **Disposition:** **Recommended batch — Feed Reliability** (pair with H6 in the shared helper).

### H8 — No HTTP method enforcement on mutating ops
- **Severity:** High (abuse surface)
- **Evidence:** `grep req.method` across `api/`+`lib/` → one hit (`api/news.js:36`). Every mutating op accepts GET (crawlers, prefetch, `<img src>`, link-preview bots can trigger).
- **Recommended change:** Per-op method table enforced in the dispatcher (reject GET on writes).
- **Risk:** Low.
- **Disposition:** **Recommended batch — Security.**

### H9 — Cron has no time-budget guard before the 60s wall
- **Severity:** High
- **Evidence:** `api/warm.js:44-300` — ~30 sequentially `await`ed sub-request `fetch`es; no `Date.now()-start` check; `vercel.json` warm `maxDuration:60`.
- **Impact:** Warm's wall-clock = sum of every sub-request latency; if the tail exceeds 60s, warm 504s and every stage after the cutoff (e.g. `tonetick`, `corebuild/corelog/coredrift`, `attentiontick`) silently never runs that day. Non-deterministic which ledgers get logged.
- **Recommended change:** Track `start`, short-circuit remaining stages past a soft budget (~45s) recording `{skipped:'budget'}`; or convert more of the tail to the fire-and-forget kicks the AI ticks already use.
- **Risk:** Low.
- **Disposition:** **Recommended batch — Cron Resilience.**

### H10 — Health record written only at the end → timed-out runs are invisible
- **Severity:** High (observability)
- **Evidence:** `api/warm.js:318-320` single `writeHealthRun(summarizeRun(result))` after the whole chain; `lib/health.js:35-40`. No `console.*` anywhere in `warm.js`.
- **Impact:** If warm 504s mid-tail (H9), no health record persists → `op=health` shows the previous run and `failStreak` stays 0 — the failure you most want to see produces no telemetry.
- **Recommended change:** Write a "run started" stub up front that a clean finish flips to complete; emit a structured `console` line per stage.
- **Risk:** Low.
- **Disposition:** **Recommended batch — Cron Resilience.**

### H11 — Frontend: no central fetch client, and stale responses can overwrite newer renders
- **Severity:** High (correctness + maintainability)
- **Evidence:** `public/js/app.js` has **98** bare `fetch(` sites, no wrapper. Grep for `AbortController|abort|generation|reqId|seqToken` across `public/js/*.js` → zero. Scope-var read-at-call-time + write-on-return in `runCoilUI` (6069), `fetchApexScope` (2712), refresh handlers; module-level singletons `apexLast` (2451), `ghostLast` (4340), `optionsFlowAll` written by whichever response lands last.
- **Impact:** Switch scope A→B or double-tap refresh and the slower response overwrites the newer render / corrupts shared state. No timeout means a hung LLM-backed op leaves a tab on its skeleton forever.
- **Recommended change:** Introduce `public/js/core/api.js` — one `apiGet(path,{signal,timeoutMs})` returning `{ok,data,error}`; add a per-tab generation counter (bail if `myGen !== currentGen`) and/or abort the previous in-flight request. Migrate tabs incrementally.
- **Risk:** Low-Medium (98 sites, but per-tab and mechanical).
- **Disposition:** **Recommended batch — Frontend Slice** (start with one tab).

### H12 — Error state renders identically to empty state
- **Severity:** High (product / data-trust)
- **Evidence:** pervasive `fetch(...).then(r=>r.json()).catch(()=>null)` (dozens of sites: `app.js:886, 3247, 4015, 4764, 5016, 5246, 5565, 5992, 6075…`); renderers treat `null`/`{empty:true}`/no-rows identically (`renderMoverStudy` 1767). Six separate ad-hoc error renderers.
- **Impact:** A network/500 failure looks exactly like a quiet market — the user cannot tell a broken feed from "nothing today." Directly contradicts the app's honesty premise.
- **Recommended change:** Standardize four states in `api.js` + a shared `renderState(el,{loading|empty|error|data})`; stop mapping fetch failure to the empty branch.
- **Risk:** Low-Medium.
- **Disposition:** **Recommended batch — Frontend Slice.**

### H13 — Apex scoring duplicated server↔browser (train/serve skew)
- **Severity:** High (latent correctness)
- **Evidence:** byte-identical logic — `lib/apex.js:37-46/49-69/71-74/85-94/25-30` vs `public/js/app.js:2651-2661/2662-2678/2679-2682/2687-2696/2609-2614` (`apexFundamentalScore`/`apexPillars`/`apexComposite`/`apexTier`/`apexRawRegime`). Both files' comments admit "MUST stay in sync." (The old `index.html` inline copy has moved into `app.js`.)
- **Impact:** The Custom tab scores/labels client-side; the ledger scores server-side. A one-line edit to either silently diverges what the user sees from what the Scoreboard grades. It is the **only** genuine server↔client formula duplication (coil/timing/options-flow are correctly server-authoritative + client-render).
- **Recommended change:** Move the pure functions into a shared browser-compatible ES module (dual-mode `lib/apex.js` or `shared/apex-core.mjs`), imported both sides exactly like `format.js`; delete the `app.js` copies; export one `SCORING_VERSION`.
- **Risk:** Low.
- **Disposition:** **Recommended batch — Data Integrity** (pairs with H14).

### H14 — Persisted picks carry no `scoringVersion`
- **Severity:** High (historical integrity)
- **Evidence:** ledger writer `add(rec)` at `lib/apex-routes.js:65-70,78-87` stamps only `{date,ts,ticker,company,section,tier,scope,entry}`. `grep scoringVersion|signalVersion|scoreVersion` in `lib/` → zero. Model versioning exists only as a separate `apex/model.json` singleton, never written onto the pick.
- **Impact:** When thresholds/presets/`activeId` change, historical picks can't be attributed to the model that produced them — the Scoreboard blends picks from different scoring regimes as one, undermining the self-tracking premise.
- **Recommended change:** Stamp `scoringVersion` (Apex `activeId`) on every logged `rec`; backfill a sentinel for pre-existing records. Once H13 lands, both sides read one `SCORING_VERSION`.
- **Risk:** Low (additive field).
- **Disposition:** **Recommended batch — Data Integrity.**

### H15 — Blob `readAll*`-entire-history pattern grows unbounded (biggest cost)
- **Severity:** High (cost / scaling)
- **Evidence:** 31 `readAll*` scanners in `lib/store.js` (template `store.js:28-49`: `list({prefix,limit:1000})` then parallel GET of every historical daily file), invoked ~80× across the codebase. The scoreboard reads 13 growing prefixes + a singleton every compute (`apex-routes.js:253-268`) then re-fetches Yahoo daily history for every unique ticker (`:375-381`).
- **Impact:** ~2,600+ Blob GETs for one scoreboard compute at ~200 trading days, climbing every day; function wall-time creeps toward 60s as prefixes grow. Nothing prunes or rolls up.
- **Recommended change:** Maintain a rolling per-`section:tier` aggregate doc updated incrementally each cron with only newly-matured picks (resolution is append-only — a matured return never changes). Scoreboard then reads O(1) docs instead of O(days) files and drops the full Yahoo re-fetch. SQL is the durable fix (see §5).
- **Risk:** Medium (new incremental writer + a fallback recompute path).
- **Disposition:** **Deferred to Phase 3** (bigger change; the edge cache `apex-routes.js:475` `s-maxage=1800` currently hides it from users).

---

## 2. Medium-severity issues

| ID | Issue | Evidence | Recommended change | Risk | Disposition |
|----|-------|----------|--------------------|------|-------------|
| M1 | No market-holiday handling (weekends only) | `lib/stats.js:35-39` `nowET` returns `isWeekend` only; no NYSE calendar | Add holiday set or gate on SPY latest-candle-date == today; record `skipped:'holiday'` | Low-Med | Recommended — Cron |
| M2 | `op=archive` has no weekend/holiday guard → skews baseline | `lib/capture-routes.js:46-107`; baseline counts each day `:114-133` | Same skip as other logging ops, or tag weekend snapshots for exclusion | Low | Recommended — Cron |
| M3 | Empty vs failure conflated in ledgers & health | `apex-routes.js:73-100`; `health.js:19` grades on `ok!==false`, ignores count | Distinguish suspicious-empty from quiet-market; flag `degraded`; surface `count:0` on core stages | Med | Recommended — Data Integrity (with H1/H7) |
| M4 | RMW lost-update on shared singleton docs | insider `capture-routes.js:145-163`; resolved `apex-routes.js:1004-1026`; model `:1162-1195`; notify/sharp `predict-routes.js:122-217` | Shard insider per-batch (precedented: fundshard `store.js:800-819`); version-check low-freq admin docs | Med | Recommended — Data Integrity |
| M5 | 8 whole-ledger readers miss the CDN cache-bust | `store.js:42,89,128,167,207,245,285,847` fetch `b.url` without `?_=Date.now()` (writers use `cacheControlMaxAge:300`) | Append `?_=`+Date.now() (parity with newer readers), or write current-day file `cacheControlMaxAge:0` | Very Low | Recommended — Data Integrity |
| M6 | No `schemaVersion`/`source` envelope on records | timestamps only; `grep schemaVersion` → 0; `source` appears once (`capture-routes.js:104`) | Add `schemaVersion` (+`source`) to `writeXDay`/`writeJSON` wrappers; readers default missing→v1 | Low | Recommended — Data Integrity |
| M7 | No retry/backoff for retryable failures | only the 401 crumb-refresh exists (`options-baseline.js:50`); Finnhub/SEC/StockTwits none | Bounded 2-attempt retry + exp backoff + jitter, gated to 429/5xx/network/timeout, respecting the deadline | Low-Med | Recommended — Feed Reliability |
| M8 | Uncoordinated per-provider concurrency (12-18 to Yahoo) | `screener-routes.js:78,261,311,421,615`; `mapLimit` reimplemented 3× | One shared per-host limiter (Yahoo ≤8, SEC ≤10/s) replacing duplicated pools | Med | Deferred — Phase 3 |
| M9 | SWR can present ≤24h-stale data as live | `screener-routes.js:386,767,1111` `stale-while-revalidate=86400`; body has no feed timestamp | Add `dataAsOf`/`stale` field from the underlying cache timestamp; shorten SWR for intraday views | Low | Recommended — Feed Reliability (cheap) |
| M10 | No `source`/`fetchedAt` on live feed records | `fundamentals.js`, `macro.js`, `options-baseline.js`, `edgar.js` return bare data | Stamp `{source,fetchedAt}` at the fetch boundary | Low | Deferred — Phase 3 |
| M11 | Provider failure/latency not logged | only `screener.js:57` logs; others bare `catch{}` despite `lib/log.js` existing | Log category+duration+provider in the shared fetch helper | Low | Recommended — Feed Reliability (with H6/H7) |
| M12 | Prompt-injection: untrusted text not fenced / no system role | posts inline in user turn `alerts-fable.js:72-90`; headlines `apex-routes.js:1398`; web-search text in all `*tick` ops; most calls set no `system` | Move instructions to `system:`; wrap untrusted text in fenced `<untrusted>…</untrusted>` with "data, not instructions". Output validation (parse/clamp/allowlist) already good — keep it | Low | Recommended — Security (prompt edits) |
| M13 | Backtest doesn't reuse the candle cache | `api/backtest.js:110,231` calls `fetchDailyHistory` for the whole universe; screener already caches (`api/screener.js:243`) | Reuse `loadCandleCache` in backtest → removes ~770 Yahoo fetches/cron + every on-demand re-scan | Low-Med | Recommended — Feed Reliability / Cost |
| M14 | app.js is a 7,429-line monolith | one IIFE, ~330 fns, ~43 `*Loaded` flags + ~60 module-level singletons | Incremental tab extraction using the working `format.js`/`quickhit.js` pattern; start with **Day Trade** tab (`app.js:5234-5537`, self-contained) | Med | Recommended — Frontend Slice (one tab now) |
| M15 | Input validation inconsistent | good: `whynow-routes.js:59`, `alerts-fable.js:104`; weak: `api/price.js:18,66,90` raw ticker into URL path | Shared `isValidTicker()` at every provider-URL boundary | Low | Recommended — Security |

---

## 3. Low-severity issues

| ID | Issue | Evidence | Change | Disposition |
|----|-------|----------|--------|-------------|
| L1 | Unknown op falls through to `runScoreboard` | `api/tracker.js:177` | Explicit op allowlist + 404 default | Recommended — Routing |
| L2 | 130-line `if`-chain dispatch (not a map) | `api/tracker.js:50-177` | `const OPS = {…}` registry with per-op metadata (methods/auth/handler) | Recommended — Routing (enables H5/H8 cleanly) |
| L3 | Inconsistent error envelope / status codes | 64×200, 29×502, 10×400…; raw `e.message` echoed `capture-routes.js:164` | Standardize `{success,data,error}` + real status; strip internal messages | Recommended — Routing |
| L4 | Corrupt current-day blob silently dropped | `store.js:46,93,132` bare `catch{}` | Count decode failures → `logError` + health | Low — Data Integrity |
| L5 | No deterministic `id` persisted on records | dedup is positional (`apex-routes.js:67`) | Persist `id = section:tier:scope:ticker:date` | Deferred |
| L6 | StockTwits fetch duplicated 4× | `cern-run.js:74`, `capture-routes.js:21`, `dualread-routes.js:20`, `api/momentum.js:73` (2 skip `r.ok`) | Extract one `fetchTrendingStockTwits()` util | Deferred |
| L7 | EDGAR sequential 60-filing loop can exceed budget | `edgar.js:100-115` (≥7.2s sleep + 60 hops, no timeout); `loadCikMap` throws | Add timeout, deadline cap, catch CIK-map failure | Deferred (external-box path) |
| L8 | app.js mutable global state | ~60 module-level `let` singletons | Encapsulate per-tab during extraction (M14) | Rolls up with M14 |

**Positive findings (no action, documented):** overwrite-by-date idempotency (retries don't duplicate — `store.js:18-24`); single cached Yahoo crumb adapter; no unguarded `JSON.parse` on blob content; LLM output validation + non-general tools; LLM caching already thorough; no secret logging; `isEarningsAdjacent` (`fundamentals.js:182-199`) is the correct degradation model.

---

## 4. Data classification

| Class | Blob prefixes | Notes |
|-------|---------------|-------|
| **Permanent factual history** (unrecoverable) | `picks/`, `apex/<date>`, `ghost/`, `edge/`, `core/<date>`, `archive/`, `apex/insider.json`, event ledgers (`gap/ gapdown/ downday/ coil/ fade/ trend/ daytrade/ confluence/ intraday/ readthrough/<date> anomaly/<date> biotech/<date> secondwave/ crossasset/ toneshift/ timing/<date> dualread/day/ aligned/day/ predict/ predmkt/ tone/<date> attention/`), `sharp/events.json`, `notify/feed.json` | H1, M4, M6 bite hardest here. Only `savedAt`; no schema version. |
| **Rebuildable derived** | `apex/resolved.json`, `core/resolved|features|buildstate|book.json`, `apex/backfill|exits|longshort|pead.json`, `apex/fundshard/*`, `*-eng.json` learner states, `apex/cern.json`, `scoreboard/summary.json`, `apex/model.json`, weight docs | RMW risk (M4) for resolved/model. |
| **Short-lived serve cache** | `readthrough/latest|raw`, `anomaly/…latest`, `secondwave|crossasset|biotech|toneshift|pulse|calibration|shortinterest` cache keys, `candle-cache`, `gameplan/<date>`, `dualread/<ticker>` | Empty writes here are safe (rebuildable). |
| **Debug / observability** | `health/runs.json` (30-run ring), `lib/log.js` stdout | — |

---

## 5. Cost findings

- **LLM spend is NOT the problem** — already tightly bounded and cached. ~12-15 single bounded batched calls/cron/day (~10 Haiku+search, ~5 Fable-5); no per-ticker loops; on-demand features read the cron's cached result (pulse/optionsassess/dual-read quadrant cache/tone permanent per-earnings cache). No material avoidable duplicate calls.
- **Single biggest avoidable cost = the `readAll*` full-history Blob pattern (H15).** Scoreboard + every ledger `*tick` `list`+GET every daily file ever written on each run (~2,600+ GETs/scoreboard compute at ~200 days, growing daily) and layer a full Yahoo re-fetch of all tickers on top. **Fix = precomputed incremental aggregates now; SQL later.**
- **Provider fan-out:** ~2,000-2,500 Yahoo calls/cron/day (estimate) — a rate-limit/reliability cost (free feed), not $. Biggest cache gap is backtest not reusing the candle cache (M13, ~770 fetches/cron).
- **Paid providers bounded:** FMP Starter / Finnhub used only in fundamentals/earnings/downgrades/ipo/pead/stablecore; screener enrich caches fundamentals+insiders per-scope in Blob (`screener.js:136-165`).
- **Grows with history:** everything on `readAll*` (scoreboard, `*book`/`*tick` resolvers, attention, calibration, core) gets linearly slower and Blob-op-costlier forever; nothing prunes/rolls up. **Precomputed daily aggregates convert this dominant unbounded cost to constant.**
- **Hobby → Pro tradeoff:** Pro lifts the 12-function cap (the entire `?op=` mux exists only to fit Hobby), raises the 60s wall the AI ticks keep fighting, and allows multiple crons instead of one 40-op mega-cron. It does **not** by itself reduce Blob-GET growth (that's H15).
- **SQL tradeoff (do not migrate in this phase):** a single indexed `picks(section,tier,date,ticker,…)` table replaces 31 `readAll*` prefix-scans with indexed incremental queries and makes resolution/aggregation cheap; Blob then holds only candle + LLM-narrative caches (its natural fit). Right structural fix for §5's items 2/5-8; sequence it after the incremental-aggregate stopgap proves the access pattern.

---

## 6. Recommended implementation sequence

All changes are **gated on your approval** — nothing below is implemented yet. Each batch is independently shippable, ordered by value-per-risk. Characterization tests precede any fragile edit; `node --test` runs after each batch; no auto-deploy.

**Batch 1 — Security (highest exposure, lowest risk).** Add `CRON_SECRET`; gate every write/LLM/tick/build op + the `?warm=1` cache-bypass in the dispatcher (H2/H3/H5). Fail-closed ingest + require POST (H4). Per-op method table (H8) via an op registry (L1/L2). `isValidTicker()` at URL boundaries (M15). Move LLM instructions to `system:` + fence untrusted text (M12). **Needs: `CRON_SECRET`, `ALERTS_INGEST_TOKEN`, `INSIDER_INGEST_TOKEN` set in Vercel; external collectors updated to send them.**

**Batch 2 — Data integrity.** Guard the unconditional writes (H1) + suspicious-empty detection (M3). Cache-bust the 8 ledger readers (M5). `scoringVersion` stamp on picks (H14) + unify Apex into a shared ES module (H13). `schemaVersion`/`source` envelope (M6). Shard insider ingest / version-check admin docs (M4).

**Batch 3 — Cron resilience.** Time-budget guard + `{skipped:'budget'}` (H9). Up-front health stub + per-stage `console` line (H10). Market-holiday guard (M1/M2).

**Batch 4 — Feed reliability.** Shared `fetchWithTimeout` + discriminated `{status,data}` result + category/latency logging (H6/H7/M11). Bounded retry+jitter (M7). `dataAsOf`/`stale` flag (M9). Backtest reuses candle cache (M13).

**Batch 5 — Frontend vertical slice.** `core/api.js` client with timeout + `{ok,data,error}` + generation guard (H11). Shared `renderState` splitting error/empty (H12). Extract the **Day Trade** tab as the first slice (M14), encapsulating its globals (L8).

**Phase 3 (deferred, larger).** Incremental scoreboard aggregate (H15). Per-host concurrency limiter (M8). `source/fetchedAt` on all live feeds (M10). Continue tab extraction. Evaluate Pro upgrade and the SQL migration for tracking data.

**Deferred with reason:** SQL migration and Pro upgrade (infra decisions, explicitly out of scope this phase); full app.js decomposition (high regression risk without characterization tests — do it slice-by-slice); L5/L6/L7 (low value now).

**What remains insecure regardless:** without real user auth, "public read" ops stay world-readable — acceptable for a single-user dashboard. The `CRON_SECRET` gate protects cost/writes, not read confidentiality. Same-origin/CORS is not an auth control against direct `curl`.
