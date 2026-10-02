# Site audit — 2026-10-02

Read-only audit of production (`https://market-news-app-chi.vercel.app`) plus the nightly
cron's last run, with the defects that could be fixed without entering another agent's files
fixed in this branch (one `fix:` commit per item, each with a regression test). Everything
else is listed under **Handoffs** with the exact file/line and the evidence.

## Method

| Probe | What was done |
|---|---|
| Baseline | `npm run check` (clean) and the FULL `npm test` on `origin/main` f1e8603: **6237 tests, 0 fail, 0 flaky, 31s** (not ~10 min — the scan-loop wall-clock flake was fixed in #424). After the fixes: 6250 pass, 0 fail. |
| Production GETs (no bearer, no write ops) | `op=health`, `op=sessionboard`, `op=today`, `op=scoreboard`, `/api/sectors`, `/api/price?tickers=AAPL,MSFT`, `/feed/daytrade.json`, `/feed/daytrade.md`, `/`, `manifest.webmanifest`, `sw.js`, every URL referenced by `index.html` and `sw.js`, and **58 read-only tracker ops the UI calls** (status, latency, payload size, `x-vercel-cache`, envelope). |
| Vercel runtime | Vercel CLI logged in (`rjs319-2501`, team `ravi-shah-s-projects1`, project `market-news-app`, Node 24.x). Runtime-error clusters (7d) and runtime logs (48h) via the Vercel MCP tools: grouped by status, by path, and the 22:00 UTC cron window. |
| GitHub Actions | `gh run list --limit 40`: every scheduled workflow (daytrade-scan, evidence-tick, pulse2-tick, tech-command-tick) and CI **succeeded** over the last 4 days. No failures to open. |
| Static frontend analysis | acorn-based scan of `public/js/*.js` (42 ES modules): every `import { x } from './y.js'` resolves to a real export (0 bad); every bare-identifier call resolves to a declaration somewhere in the bundle or a browser global (0 unresolved). |
| Rendered frontend | Playwright drive of 14 views on prod (`today`, `session`, `scoreboard`, `daytrade`, `events`, `rotation`, `patternradar`, `ensemble`, `quickhit`, `start`, `momentum`, `sectors`, `options`, `alerts`): **0 console errors, 0 page errors**; one render leak (Options, below). |
| Memory experiment | Offline synthetic run of the `forecastshadowtick` inference (517 names × 3y) to explain its crash. |

## Findings

Severity: CRITICAL = data loss / security; HIGH = wrong or missing data shown to users, or a
pipeline that cannot complete; MEDIUM = degraded/misleading but recoverable; LOW = cosmetic.

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | HIGH | **Session Board market block was null on every board.** `op=sessionboard` served `market.mode / spyChangePct / asOf = null` while the `market` source reported `ok:true`. Root cause: `lib/session-board-routes.js` handed the persisted `pulse2-market-state-doc-v1` **wrapper** (`{schema, at, state, coverage}`) to the assembler, which reads the inner `state`. | **FIXED** dd925c5 |
| 2 | HIGH | **Degraded `op=ensemble` was CDN-cached.** The route set `s-maxage=300, stale-while-revalidate=3600` before checking the view; one timed-out `op=today` pull (04:27 UTC) pinned an "engine unavailable / ranking []" board at the edge — re-probing minutes later returned the identical `generatedAt`. `op=omega` / `op=omegafunnel` cached their empty "op=today unavailable" state for 60s. | **FIXED** 5d48857 |
| 3 | MEDIUM | `op=patterns` set its CDN header before the `no-store` / `not-built-yet` early returns, so an empty radar could be pinned for 5 min + 24h SWR. | **FIXED** 556e700 |
| 4 | HIGH | **Biotech refused as "degraded data" every day.** `op=today` → `dataGate.perSource.biotech.ok=false`, reason `liquidity data on only 0% of rows (<50%)`. The engine measures `avgDollarVol` for its gates but never returned it, and `toWireItem` never published it, so `lib/data-gates dollarVolOf` saw nothing. The Today banner listed biotech among "5 source(s) cannot support a NEW entry". | **FIXED** 7710694 |
| 5 | HIGH | **`op=govdemandtick` FUNCTION_INVOCATION_TIMEOUT at 300s** (health `chain:govdemand`, `govdemandresolve` skipped). Provider phases after the collect were count-bounded but not time-bounded (collect ≤40s + 6 cadence × 15s + 10 revenue × 8s + SPY + 8 price × 8s ≈ 290s) and every write sits at the end, so a slow USAspending night persisted nothing and replayed the same cursor batch. | **FIXED** 283e87f — 150s tick budget; remaining fetches skipped and counted in the response; the tick always persists. |
| 6 | HIGH | **Contradictory regime on the Today page.** Header: "The market is **RISK-ON** and the tape is choppy" (from `op=tape` → `lib/macro.js` macro regime: VIX/macro-risk rule). Four lines below: "**Risk-off** · breadth 22% · riskoff tape" (from `op=today` → screener `computeRegime`: SPY-200DMA + breadth <40% ⇒ bearish). Same split across ops: `today`/`evidence`/`ignition` = risk-off; `daytrade`/`gapgo`/`gapdown`/`tape`/`brief`/`core`/`trend`/`feed` = risk-on; `pulse2` mode = ROTATION. The screener's own `regime.raw` (RISK_OFF) vs `regime.active` (latched SPY-200DMA, RISK_ON) also disagree — the "raw vs latched" note in memory is this. | **HANDOFF** (design: pick one canonical regime for display; render sites are `public/js/app.js:4355` and `public/js/today.js:459`, both in files I must not edit) |
| 7 | MEDIUM | **Options view render leak**: "quote undefined/undefined (undefined% of mid)" in the executable-liquidity line when the quote is crossed/missing. Render site `public/js/app.js:1781` — `${q ? \` · quote ${q.bid}/${q.ask} (${q.spreadPctOfMid}% of mid)\` : …}` guards on `q` but not on its fields. | **HANDOFF** (app.js owned by another agent; fix: guard `Number.isFinite(q.bid) && Number.isFinite(q.ask)`, else "no two-sided quote") |
| 8 | HIGH | **`op=patterns` returns 24.5 MB** (`radar` = 17,100 episode cards; `developing` 6,078, `triggeredNow` 5,054). The UI pages client-side (`PR_PAGE_SIZE`) over the full list, so every Pattern Radar open downloads 24.5 MB. `op=scoreboard` / `op=momentum` 5.5 MB, `op=rlt` 5.2 MB, `op=alerts` 1.2 MB. | **HANDOFF** (needs server-side paging + a UI change in app.js; the bucket counts in the headings read `items.length`) |
| 9 | MEDIUM | **Liquidity gate misfires on non-equity rows.** `optionsflow` (160 contract rows), `sw` (Second Wave), `ca` (Cross-Asset) all fail `liquidity data on only 0%` because `dollarVolOf` looks for equity dollar-volume fields these rows never carry; `ts` (Tone Shift) fails `cutoff 2026-09-11 is 15 sessions behind` — its nightly input has not advanced since 09-11. Together with #4 this is the "5 source(s) cannot support a NEW entry" banner. | **HANDOFF** (gate spec per source — `lib/data-gates.js` — and a stale tone-shift pipeline to check) |
| 10 | LOW | `/favicon.ico` and `/robots.txt` 404 (the page links `/icon.svg`; Safari and crawlers still request these). `manifest.webmanifest`, `icon.svg`, `sw.js`, all `index.html` refs: 200. | note |
| 11 | — | `/api/price?symbol=AAPL` → 400 `Missing tickers`: not a defect, the API takes `tickers=`; `?tickers=AAPL,MSFT` → 200. `op=timing` 400 on GET: expects a POST body. | none |
| 12 | — | Dates/freshness: `health.data.spyDate 2026-10-01`, `sessionsBehind 0`, `stale:false`; `sessionboard.session.etDate 2026-10-02`; `feed sessionDate 2026-10-01`; `today` 0 NaN, 0 `undefined`. No stale `asOf` found. | none |

### Cache posture note

Vercel strips `s-maxage` from the client-visible `cache-control` (every op shows
`public, max-age=0, must-revalidate`); the only trustworthy signal is `x-vercel-cache`.
`op=today` was HIT (cached as designed); `op=ensemble` was HIT **on a degraded payload** (#2).

## Nightly cron — 2026-10-01T22:05Z run (coordinator addendum)

`op=health`: `healthy:false`, `failStreak:1`, `recentRuns[0].failCount:2`, problems
`chain:insidercluster, chain:forecastshadow, chain:govdemand, chain:pattern, chain:pitdata,
chain:pulse2, chain:challenger`. Vercel logs for 21:58–22:12 UTC: 14 × 504 and 6 × 500, all
`/api/tracker`, and **no runtime error clusters** — the 500s carry no stack, i.e. the function
process died rather than throwing.

| Chain | Evidence | Verdict |
|---|---|---|
| `govdemand` | `op=govdemandtick` http:504 after 300,031 ms; `govdemandresolve` skipped. | Code defect — **FIXED** (#5, 283e87f). `lib/govdemand-collect.js` already had a 25s collect deadline; the later phases did not. |
| `forecastshadow` | `op=forecastshadowtick` `FUNCTION_INVOCATION_FAILED` after 59.6s, no stack. Handler: SPY 3y → 11 sector ETFs 3y → **517 LARGE names × 3y** (`FETCH_CONCURRENCY 6`) → `makePanel` → `runInference` in-process. Synthetic offline run (517 × 756 bars, frozen cfg): fetch set 76 MB heap, panel 88 MB, **inference ~19s with RSS climbing to ~1.03 GB**; it runs out of memory with `--max-old-space-size=400` and completes at 700 (heap after GC 92 MB → a ~0.5–0.7 GB transient working set inside `lib/forecast/*`). | Not a null-guard/throw — every phase fails closed with a 502 and the tracker's top-level `catch` would have returned JSON. The signature is **OOM under co-location**: `lib/warm-chains.js` already documents that waves "land on one instance at once"; at 22:02:22–31 the same instance was also serving `op=daytrade`, `op=scoreboard` (both logged warnings then 500 with no stack) and the `insidercluster` chain. A ~1 GB transient on a 3009 MB function shared with three other heavy invocations is enough. **HANDOFF**: isolate the tick (the GitHub Actions matrix PR) or cut the inference's working set in `lib/forecast/infer.js` (per-horizon fits retain full feature matrices; `trainSessions 500 × 517 names`). No change made here. |
| `insidercluster` | chain `httpStatus:500, complete:null` (no report); no `insider*` log line at all in the window. `runInsiderClusterTick` wraps `tickCore` in try/catch → 502 on any throw; `fetchDailyForm4` already treats EDGAR's S3-style `403 <Code>AccessDenied</Code>` as "no index" and fails closed on any other 403; `op=insidercluster` shows ledger days through 09-26 (12 days, 3 rows). | **No code defect found.** Same timestamp cluster as the forecastshadow crash → killed as a co-located invocation. Expect it to pass once isolated. |
| `pattern`, `pitdata`, `pulse2`, `challenger` | "never persisted a report for this run — killed before finishing (function wall)". | **Obvious wall-time bug, noted not fixed**: `lib/warm-chains-routes.js:47` calls each step with `fetch(url, { headers })` and **no `AbortSignal`**. `runChain` refuses to *start* a step past `CHAIN_DEADLINE_MS` (240s) but a step already running can hold the chain to the tracker's own 300s wall, after which the chain dies with no report. Fix: `signal: AbortSignal.timeout(remainingChainBudget)` so a hung step is recorded as `error` and the report still lands. `pitdata` runs `v3collect` three times in one chain; `pulse2` runs four writers; `challengerlog` is the deep self-fetch chain from the 08-19 audit. |

Also observed in the same window: read ops `op=daytrade` and `op=scoreboard` returned 500 at
22:02:31 (same no-stack signature), so during the 22:02 wave the public UI itself was briefly
erroring.

## Fixes in this branch (commit per item)

| Commit | Files | Test |
|---|---|---|
| dd925c5 fix: sessionboard reads the pulse2 market-state doc's inner state | `lib/session-board-routes.js` (`unwrapMarketState`, `marketForBoard`) | `test/session-board-routes.test.js` +3 (wrapped doc → `mode ROTATION`, `spyChangePct -0.41`, `asOf`, leaders from today) |
| 5d48857 fix: never CDN-cache a degraded ensemble or OMEGA board | `lib/omega-ensemble-routes.js`, `lib/omega-swing-routes.js` | `test/omega-ensemble-routes-cache.test.js`, `test/omega-swing-routes-cache.test.js` (fetch stubbed to time out → `no-store`) |
| 556e700 fix: op=patterns sets its CDN header only for a ready radar | `lib/pattern-routes.js` | `test/pattern-routes-cache.test.js` |
| 7710694 fix: biotech wire items carry the measured liquidity | `lib/biotech-engine.js` (returns `liquidity`), `lib/biotech-routes.js` (`avgDollarVol` on the wire) | `test/biotech-downstream.test.js` (+1: `dollarVolOf(toWireItem(...)) === 4e7`) |
| 283e87f fix: govdemand tick stops provider fetches on a wall budget and persists | `lib/govdemand-routes.js` (`makeTickBudget`, `TICK_BUDGET_MS`, `budget` in the response) | `test/govdemand.test.js` (+3) |

Deliberately NOT changed: `api/warm.js`, `lib/health.js`, `lib/store.js`, `lib/http.js`,
`lib/evidence-stats.js`, `lib/fable-call.js`, `public/js/app.js`, `public/sw.js`,
`fetch-json.js`, `command-palette.js`, `risk-budget.js` (other agents / other PR).

## Handoffs to the orchestrator

1. **Regime contradiction on Today** (#6) — choose the canonical regime. Honest option: show
   the screener regime (`today.regime`, breadth-aware, used for sizing) in the header and
   label the macro read as "macro: risk-on". Render sites `public/js/app.js:4355`,
   `public/js/today.js:459`; data sources `lib/macro.js:53-54` vs
   `lib/swing-screener-engine.js:computeRegime`.
2. **Options render leak** (#7) — `public/js/app.js:1781`.
3. **24.5 MB `op=patterns`** (#8) — server-side paging in `lib/pattern-routes.js` plus the
   pager in `public/js/app.js` (`PR_PAGE_SIZE`, heading counts).
4. **Chain steps without an abort** — `lib/warm-chains-routes.js:47` (see table above);
   complementary to the matrix PR.
5. **forecastshadow OOM under co-location** — isolate or shrink the inference working set.
6. **Liquidity gate on optionsflow / second-wave / cross-asset rows; stale tone-shift cutoff**
   (#9) — `lib/data-gates.js` spec per source; check why `ts` stopped at 2026-09-11.
7. LOW: add `public/robots.txt` and a `favicon.ico` (or a rewrite to `icon.svg`).

## Appendix — probe results (2026-10-02 ~04:20–04:30 UTC, market closed)

- `op=health` 200 — `healthy:false`, `lastRun.at 2026-10-01T22:05:28Z`, `failed:[]`,
  `warmFails:[]`, `failStreak:1`, data `spyDate 2026-10-01` fresh.
- `op=sessionboard` 200 (61 KB) — 20 items (C×10, F×10), `market` all null (#1), `regime
  risk-off 22%`, sources all ok, `persisted:true`.
- `op=today` 200 (526 KB, CDN HIT) — 0 signals, `dataGate.degraded:true` (5 sources, #4/#9),
  `regime Risk-off`.
- `op=scoreboard` 200 (5.5 MB, 15s cold) · `op=patterns` 200 (24.5 MB, 9s) · `op=rlt` 5.2 MB ·
  `op=alerts` 1.2 MB · `op=techcommand` 0.9 MB.
- `op=ensemble` 200 `ok:false degraded` CDN HIT (#2) · `op=omega` 200 degraded, cards [].
- `/api/sectors` 200 (13 ETFs) · `/api/price?tickers=AAPL,MSFT` 200 · `/feed/daytrade.json`
  200 (`regime risk-on`, `sessionDate 2026-10-01`, candidates [] — closed) · `/` 200 (105 KB,
  one module script `/js/app.js`).
- All 58 UI read ops: 200 (except `timing` 400 by contract). No `NaN`/`undefined` in any
  JSON payload. 14 Playwright-driven views: 0 console errors.
