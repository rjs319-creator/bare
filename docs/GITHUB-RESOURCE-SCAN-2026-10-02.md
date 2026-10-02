# GitHub Resource Scan — 2026-10-02

Seven parallel research agents swept GitHub (plus npm and the underlying public
endpoints) for anything the market-news-app could adopt, port, or learn from.
Roughly 360 repositories were screened and 128 were verified with `gh api`
(stars, last push, license) and kept in the lane tables. The per-lane reports,
with full candidate tables and rejection lists, live in
`docs/github-scan-2026-10-02/`.

## Headline

The best finds are **not stock-picking libraries**. They are:

1. **Fixes to our own plumbing that need no new vendor** — the installed
   `@vercel/blob` already supports conditional (`ifMatch`) writes, which ends the
   lost-append problem in `lib/store.js`; the GitHub Actions matrix pattern we
   already use for one tick can replace the 38-job in-process nightly chain.
2. **Official, zero-dependency HTTP feeds** we are not using — CBOE delayed
   option chains *with Greeks*, FINRA Reg SHO daily short volume, Nasdaq
   earnings/splits/dividend calendars, Treasury yield CSV, Tiingo's free
   delisting-complete ticker list. All answered 200 with no key during the scan.
3. **A handful of small, vendorable JS libraries** — TradingView
   lightweight-charts, d3-hierarchy, Fuse, idb-keyval, async-cache-dedupe,
   stdlib stats packages, the official vollib TypeScript port.
4. **Instruments for the LLM harness** — promptfoo golden-set evals, an
   autoevals-style factuality judge, and a token/cost ledger (the `usage` field
   on every Claude response is currently never read).

Nothing found changes the standing conclusion that there is no durable retail
alpha. Every alpha-shaped proposal below is an **AVOID-side shadow overlay**
with a preregistered hypothesis, consistent with the registry's history that
only AVOID lanes survive.

### Corrections to the lane reports

- The codebase is **CommonJS** (406 `require` files, zero ESM imports). ESM-only
  packages (hyparquet, p-limit v7, vollib-ts) need `await import()` or a
  vendored port. The brief said ESM; lane 7 caught it.
- **Fractional Kelly already exists** in `lib/cern.js` (sizing) and
  `lib/screener-routes.js` (meta-label sizing). Lane 6's "add Kelly" proposal is
  downgraded to "unify and surface in the risk-budget widget".
- `lib/evidence-stats.js` rounds `avg`/`sd` to 2dp and `se` to 4dp but already
  keeps full-precision `avgExact`/`seExact` copies. The defect is that legacy
  summaries and some gates read the rounded fields; the fix is a schema
  migration plus oracle tests, not new math.

---

## Proposals, ranked

Effort: S = a day or less, M = several days, L = weeks. "Shadow" means weight-0,
Scoreboard-tracked, FDR-gated like everything else.

### Tier 1 — Plumbing that removes a known pain (no alpha claim)

| # | Proposal | Source | Effort | Plugs into |
|---|---|---|---|---|
| 1 | **Compare-and-swap Blob writes.** `updateJSON(path, mutate, {retries})` loops read → `put(..., {ifMatch: etag, allowOverwrite: true})` → retry on `BlobPreconditionFailedError`. Migrate every read-modify-write caller (pulse2-store, insider-cluster, nav-ledger, immutable-ledger, candle-cache shards). Private store + `get({useCache:false})` for hot singletons to dodge the CDN read-back lag. | `@vercel/blob` ≥2.6 (installed 2.4 exposes `ifMatch`; bump for `useCache:false`) | S | `lib/store.js` |
| 2 | **Nightly chains as a GitHub Actions matrix.** One job per `ROOT_CHAINS` entry, `fail-fast:false`, `max-parallel:4`, `timeout-minutes:6`, each calling the existing `warmChainOne` endpoint with `CRON_SECRET`. Per-chain memory isolation, per-chain log, failure e-mail, single-chain re-run. `api/warm.js` keeps only cache-warm + health report. Matrix generated from `lib/warm-chains.js` with a test pin. | pattern already in `.github/workflows/evidence-tick.yml` | S→M | `api/warm.js`, `lib/warm-chains.js`, new workflow |
| 3 | **Dead-man monitoring.** healthchecks.io `/start`, success, `/fail` pings per chain; `op=health` reads the check status so a failed night is visible in the UI banner instead of being re-derived client-side. | healthchecks/healthchecks (BSD-3, hosted free tier 20 checks) | S | `api/warm.js`, health banner |
| 4 | **Fetch memoization.** `memoFetchJSON(url, {ttl, tag})` = in-flight dedupe + TTL (async-cache-dedupe, CJS) → Vercel Runtime Cache (`@vercel/functions getCache`, per-region, tagged, 2 MB items) → `fetchWithTimeout`. Route candle-cache, FMP/Finnhub/Yahoo helpers and the ~2,800-call swingsearchgrade path through it; `expireTag('candles')` after the nightly rebuild. Only cache `r.ok`. | mcollina/async-cache-dedupe (MIT), vercel/functions | M | `lib/http.js` |
| 5 | **Exact-precision evidence schema + stdlib oracle tests.** Persist `exact:{avg,se,ci95,tCI,bootstrapCI,ess}`; move rounding to the renderer; `fdrAdjust` and gates read exact only; one-off migration recomputes legacy summaries. Dev-dependency `@stdlib/stats-padjust`, `stats-base-dists-t-cdf`, `stats-ttest` as test oracles (match to 1e-10 across df 2–500). Report how many registry verdicts flip. | stdlib-js/stdlib (Apache-2.0) | S | `lib/evidence-stats.js`, `lib/research/hypothesis-registry.js`, `lib/evidence-routes.js` |
| 6 | **LLM cost ledger.** `recordUsage({callSite, model, usage})` → daily Blob doc `llm/usage/YYYY-MM-DD.json`, static price constants, surfaced in `op=health`. The preregistered EDGAR pilot's "> $200/mo" stop rule is currently unmeasurable; a 2× day-over-day jump doubles as a fan-out bug detector. | anthropics/claude-cookbooks observability pattern | S | `lib/fable-call.js` |
| 7 | **promptfoo golden-set regression for the 29 Claude call sites.** Per prompt family (evidence-extract, earnings tone, pulse narrative, bear case, gameplan reflection): 20–40 frozen inputs, schema + `javascript` assertions (source indexes ⊆ inputs, numbers verbatim), `llm-rubric` graded by Haiku. Custom provider calls `buildFableRequest` so the exact request shape is tested. A pass-rate drop blocks a `PROMPT_VERSION` bump. | promptfoo/promptfoo (MIT, dev-dep) | S | `research/llm-evals/` |
| 8 | **Shadow extraction judge.** Vendor autoevals' Factuality/ClosedQA templates (MIT) as `lib/llm-judge.js`; Haiku second-reads 10% of `evidence-extract` outputs ("is each event supported verbatim by cited headlines?"), 2% adjudicated by Fable 5.1; ledger `judge/v1/`. Also fix `lib/evidence-extract.js:124`, which returns the same empty shape for refusal, empty, and failure. Feeds the registry's "≥90% extraction agreement" gate. | braintrustdata/autoevals | S→M | `lib/evidence-consensus.js` |
| 9 | **Edge Config for latched state and kill switches.** Latched regime, promotion flags, maintenance switch as single strongly-visible keys written from the nightly job; resolves the "regime raw vs latched disagree" class. | `@vercel/edge-config` (CJS) | S | regime router, `/api/flags` |

### Tier 2 — Better data, zero new runtime dependencies

| # | Proposal | Source | Effort | Plugs into |
|---|---|---|---|---|
| 10 | **CBOE delayed option chains with Greeks.** `GET cdn.cboe.com/api/global/delayed_quotes/options/{SYM}.json` (follow 307). Verified: AAPL 3,538 contracts with iv/delta/gamma/vega/theta/rho/OI/volume. Replaces the Yahoo crumb dance that has no Greeks; `greeksCapability()` stops refusing. Run both adapters 20 sessions and compare OI-confirm hit rates. CBOE terms: own analytics fine, do not republish raw chains in `/feed`. | simonlin1212/global-stock-data endpoint cookbook | S | `lib/options-universe-v2.js`, `lib/options-baseline.js`, `lib/options-execution-v2.js` |
| 11 | **Model Greeks fallback.** `lib/options-greeks.js` wrapping the official vollib TypeScript port (LetsBeRational IV solver, MIT; v0.1.1, so vendor ~400 lines rather than depend). Every output stamped `source:'model-bsm-from-quoted-iv'`. Lets the delta-band contract selector replace the moneyness proxy; shadow hypothesis in `options-hypotheses-v2.js`. | vollib/vollib-ts | S | `options-config-v2.js deltaBandProxy` |
| 12 | **FINRA Reg SHO daily short volume + SEC fails-to-deliver.** One 0.5 MB pipe-delimited file per day (`CNMSshvol{YYYYMMDD}.txt`, ~12k symbols). Short-volume ratio, 20d z, exempt-spike flag. Feature for Ignition/CERN, plus a preregistered decile hypothesis next to the no-alpha short-interest overlay. FINRA terms are non-commercial; note it. | FINRA CDN, daniel3303/Equibles as reference | S | new `lib/finra-shortvol.js`, registry |
| 13 | **Official calendars and macro pack.** Nasdaq earnings/splits/dividends calendar JSON (needs browser UA; keep FMP as fallback), Treasury daily-yield CSV (2s10s without FRED's lag), BLS v2 (25 req/day keyless). Port the moshejs typed clients (~50 lines each) rather than install. | api.nasdaq.com, treasury.gov, api.bls.gov | S each | Session Board premarket, `pulse2-freshness`, CERN splits, regime lever |
| 14 | **Survivorship-free universe v2.** (a) Tiingo `supported_tickers.zip` (no key; 8,230 US stocks with an end date) diffed against the 2,573-delisting secmaster; (b) PIT delisting-event feed from EDGAR Form 25/25-NSE and 15-12G/15-15D via the already-wired daily index (the method BlackFalconData sells); (c) vendor fja05680/sp500 historical S&P 500 constituents (MIT) for PIT index membership since 1996. Re-run the momentum baseline and report the shift in the survivorship bias estimate. | Tiingo, EDGAR, fja05680/sp500 | S / M / S | `research/lib/secmaster.js`, `research/04-survivorship-bias.js`, CERN |
| 15 | **Earnings-call transcripts, offline.** defeatbeta's open Hugging Face parquet (2.3 GB, speaker-attributed, weekly refresh) fills the FMP transcript gap for the tech/biotech universes; offline ingest → per-symbol Blob JSON. hyparquet (MIT, zero deps, HTTP range reads) is the only Vercel-side path if live freshness is ever needed. Add a `source=defeatbeta` arm to the earnings-tone hypothesis. Dataset is Yahoo-scraped with no license statement; personal research use. | defeat-beta/defeatbeta-api, hyparam/hyparquet | M | `lib/earnings-tone.js`, `lib/toneshift.js` |

### Tier 3 — New shadow hypotheses (AVOID side, preregistered)

| # | Proposal | Hypothesis & measurement | Effort |
|---|---|---|---|
| 16 | **Filing red-flag AVOID lane.** 8-K Item 4.01 (auditor change), 4.02 (non-reliance), 3.01 (listing deficiency), 5.02 CFO/CEO exit; `NT 10-K`/`NT 10-Q`; EDGAR FTS "substantial doubt" first mention. `lib/edgar.js` already extracts 8-K item numbers (line 148) but nothing consumes them. Clone the insider-cluster feed/store/routes pattern. | First NT filing in 252 sessions → negative cost-net SPY-excess at 21/63 sessions from next open; same-name placebo 126 sessions earlier (filing effect minus name effect). Min N 300 dev events per flag; 2-year backfill with edgartools offline; nightly tick reads the 8-K/NT subset of the daily index. | S→M |
| 17 | **ARK daily-holdings diff as a CERN forced-flow type.** Fetch 6 ARK CSVs after close, diff shares vs prior snapshot, emit events with decay curves. | Net buys ≥10% of 20d ADV in names < $50M ADV → positive 1–5d excess that reverses by day 21; sells as AVOID. ARKK return as factor control; N 300 in ~3 months. Cheap to falsify. | S |
| 18 | **Factor-adjusted Scoreboard.** Port pandas-datareader's Ken French loader (~40 lines, no key) to `lib/factors/ken-french.js`; extend `lib/orbit-factor-model.js residualWindow` with style-ETF proxies (IWM−SPY, IWD−IWF, MTUM−SPY, QUAL−SPY) for live windows; add `alphaFF` next to `excessSPY` with HAC t-stat. Validate offline with alphalens-reloaded + linearmodels Fama-MacBeth. | Preregister "alphaFF ≥ 0, q ≤ 0.1" as a shadow gate for 6 months; report how many Validated hypotheses lose significance (likely outcome given "momentum = survivorship"). ETF-proxy betas must correlate > 0.8 with FF betas or the live column stays shadow. | M |
| 19 | **Wikipedia pageview attention reversal.** Wikimedia REST pageviews (free, daily, history to 2015, the only attention source with a 10-year backfill). Ticker → article via Wikidata P414. | Top-decile 7-day pageview z-spike with |5d return| < 1 ATR → negative 21d excess (Da–Engelberg–Gao). Full-universe panel, purged blocks, ≥3/4 block consistency. Must earn its place via *divergence* from StockTwits, not agreement. | S data / M study |
| 20 | **App-store review velocity → tech operational evidence.** iTunes lookup + RSS top-charts JSON directly (skip the deprecated-dep scraper); google-play-scraper (MIT, ESM) for Android. ~25 consumer names registered in `tech-evidence/registry.js`. Also extend `adapters/jobs.js` with Ashby and Workday public JSON endpoints. | 30-day review-velocity acceleration ≥5 sessions pre-earnings → positive revenue surprise and 21-session sector-peer excess. Reuses the techev forward ledger; ~100 events/yr so min N 200 before any grade above PROMISING_RESEARCH. | M |
| 21 | **"Lazy Prices" 10-K/10-Q text change.** Offline with edgartools: YoY cosine/Jaccard of Item 1A + Item 7 plus Loughran-McDonald word-share deltas (vendor the dictionary CSV, not GPL pysentiment). Port a sec-parser-style (MIT) regex sectioner to `lib/filing-text-delta.js` only if the sealed pass survives. | Bottom-quintile YoY similarity → negative 63-session excess; top quintile ≥ 0. N ≥ 500 per quintile per season; FDR across 4 variants. Published anomaly, likely decayed; AVOID overlay only. | L |
| 22 | **Dealer GEX / gamma-flip / max-pain overlay.** Per strike `GEX = Γ × OI × 100 × S² × 0.01`, net, flip level, max-pain, from full CBOE chains (needs #10, Γ from #11). Session Board `live` gains `gammaFlipDistancePct`, weight 0. Re-derive the formula (source repos are unlicensed). | Intraday lane outcomes conditioned on spot above/below flip, with shuffled-flip negative control. Expect no alpha; value is a regime read for the intraday lane. | M |
| 23 | **Independent overfit cross-check.** `research/101-overfit-crosscheck.py` recomputes PBO/DSR/MinBTL with purgedcv and runs arch's SPA/Reality Check over the full family of live screeners vs SPY ("does the best screener beat the benchmark after accounting for everything we tried?" — a test the site lacks), plus StepM as a Romano-Wolf alternative to BH. Disagreement thresholds fail CI; port StepM (~150 lines) once validated. One vectorbt parity script against the pick ledger catches PIT/fill bugs. | Cross-check badge per hypothesis; promotion gates unchanged until 3 months of agreement. | M |

### Tier 4 — Frontend (no CSP header is set, so CDN pins and vendored files both work)

| # | Proposal | Source | Effort | Replaces |
|---|---|---|---|---|
| 24 | **lightweight-charts v5 as the single chart engine.** Vendor the 193 KB standalone ESM (not on cdnjs; pin 5.2.1 from jsdelivr into `public/js/vendor/`). `public/js/chart-engine.js` wraps candles + volume histogram with the app palette; frozen entry/stop/target via `createPriceLine`; pivots and confirmation bars via the repo's trend-line, anchored-text and session-highlighting plugin examples (TS → plain JS, ~100–200 lines each). Apache-2.0 NOTICE requires a visible TradingView attribution. Bake off against klinecharts on one card first. Explicitly retire the "canvas only" convention in `pattern-chart.js`. | tradingview/lightweight-charts (17.4k★) | M | `app.js drawChart` (~400 lines at 10311–10708), `pattern-chart.js`, Ignition/Session Board expand cards |
| 25 | **Finviz-style sector treemap.** d3-hierarchy (14 KB, ISC) treemap over sector → industry → ticker, area = cap or dollar volume, fill = `changePct` via existing `sectorStyle()`; inline SVG so it stays theme-aware; click → command-palette ticker route; second mode colours by relative strength. | d3/d3-hierarchy | S | `app.js renderSectorHeatmap` equal-size chips |
| 26 | **Offline-first PWA.** `sw.js` has no `fetch` handler today. Add app-shell precache + stale-while-revalidate for snapshot-shaped `/api/*` reads (sessionboard, today, sectors, scoreboard summary), network-only for `/api/price` and bearer calls, never for `*tick*`/warm/tracker. `fetch-json.js` gets an idb-keyval (4 KB) last-good layer returning `stale:true` with an "as of HH:MM" strip instead of an empty state. Also mitigates Blob-lag empties client-side. Never cache empty-state responses. | mdn/pwa-examples, jakearchibald/idb-keyval | M | `public/sw.js`, `public/js/fetch-json.js` |
| 27 | **Micro-kit.** tofsjonas/sortable (1 KB) for ranked tables in `today.js`/`leaderboard.js`; Fuse.js (25 KB, lazy on first ⌘K) for fuzzy section/ticker/company search in `command-palette.js`; Notyf (7 KB) for in-tab toasts on push arrival and grade changes. | all MIT/Unlicense/Apache | S | substring palette match, unsorted tables |

### Tier 5 — Execution realism and portfolio

| # | Proposal | Source | Effort | Measured against |
|---|---|---|---|---|
| 28 | **Paper-execution ledger on Alpaca paper.** At the open, one 1-share bracket order per Session Board A/B row at the frozen levels; poll fills; append-only `paper-exec/YYYY-MM-DD.json` shard. GitHub Actions tick (Vercel cron is wrong for intraday). Raw `fetch` against three paper endpoints; no SDK needed. | alpacahq/alpaca-trade-api-js (Apache-2.0) as reference | M | Fill rate per grade/timeframe; realized R vs daily-bar R (resolves **stop-first vs target-first within a day**, which daily bars cannot); `fill − frozenLevel` distribution recalibrates `lib/costs.js` TIERS; reconciliation test that every snapshot id appears or carries `notPlaced`. Alpaca fills on NBBO touch, so a lower bound on friction. |
| 29 | **Unified fractional-Kelly and Monte Carlo in the risk budget.** Lift the two existing Kelly implementations into `lib/risk-kelly.js`; add vol-target size and a bootstrap MC of a 20-trade plan's drawdown from resolved R-multiples; widget renders "no size — lane has no measured edge" when Kelly ≤ 0. Governance test: nothing exceeds `MAX_POSITION_PCT`. | in-house (~150 lines) | S | No Scoreboard claim; arithmetic over served evidence. |
| 30 | **Paper house book + performance metrics.** Ghostfolio-style Activities ledger (copy the schema, never the AGPL code); server book buys every A/B row at next open under exec-v1; per-browser "my book" in localStorage first (no accounts). `lib/perf-metrics.js` ports empyrical-reloaded's Sortino/Calmar/Omega/rolling-beta (Apache-2.0) at exact precision. ERC/risk-budgeting from lequant40/portfolio_allocation_js (MIT) if the diagonal-σ optimizer ever needs covariance. | ghostfolio, wealthfolio (schema), empyrical-reloaded | L | House-book equity curve must reconcile with the Scoreboard's equal-weight aggregate of the same rows within cost tiers; divergence is a dedup/episode bug detector. |

---

## What was deliberately rejected

- **Every "LLM picks stocks" framework** (FinGPT, FinRobot, FinMem, ai-hedge-fund, StockAgent, FinAgent, AlphaAgent, TradingAgents forks). Confirms the 2026-09-09 verdict. TradingAgents itself was already adopted.
- **Backtesting engines** (vectorbt, zipline-reloaded, Lean, nautilus, backtrader, backtesting.py). The site's "backtest" is an event study; engines add nothing but one offline parity script. mlfinlab is proprietary since 2021.
- **Congress trading, 13D activist, buyback and OpenInsider trackers.** All three hypotheses already sit in the registry as no-edge; OpenInsider is a Form 4 re-skin of the cluster ledger.
- **Reddit/Pushshift and Google Trends.** Pushshift is dead; Google blocks datacenter IPs. Wikipedia pageviews is the testable attention source.
- **Big chart libraries** (apexcharts, echarts, plotly, Chart.js financial, d3fc). 0.9–1.3 MB for 5% of features, or stale.
- **Full data grids** (tabulator, ag-grid, gridjs, SlickGrid). Card-based board doesn't need them; regular-table or Clusterize if a universe-wide table ever ships.
- **Durable-workflow vendors** (Vercel Workflow SDK needs a Nitro/Next build step; Trigger.dev, Inngest, Windmill, Hatchet need a worker runtime or wrap every op). GitHub Actions already covers 38 nightly HTTP calls. Vercel Queues (beta) is the long-term native option to watch.
- **Postgres/ClickHouse/D1** (Neon, Tinybird, Cloudflare). Blob CAS first; Turso/libSQL is the lighter SQL option if CAS proves insufficient.
- **Runtime finance MCP servers.** Each tool round-trip loops inside a 40 s Vercel request; fetchers are already memoised in Node. The FMP MCP tool manifest is a useful typed catalogue for `lib/fmp-client.js`, nothing more.
- **GPL/AGPL code** (edgar-crawler, pysentiment, Ghostfolio, Wealthfolio, stocknear, frequi, sec-edgar-mcp, backtesting.py, backtrader). Borrow schemas and UX, never code.
- **IBKR/Tradier** for paper execution: stale SDKs or a resident gateway; Alpaca paper is the only serverless-fit option.
- **Paid transcript APIs** (earningscall.biz, sec-api.io). Flagged as options if budget appears; defeatbeta covers research use.

## Suggested sequencing

1. **Sprint 1 — plumbing** (#1–#9). All S/M, no alpha claim, removes the four pain points the nightly audits keep hitting. #1 and #2 first; #5 and #6 next because the EDGAR AVOID pilot's stop rules depend on them.
2. **Sprint 2 — data feeds** (#10–#15). Zero-dependency adapters behind existing provider interfaces; each ships with a 20-session side-by-side against the current vendor.
3. **Sprint 3 — hypotheses** (#16, #17, #18, #22, #23 first; #19–#21 as research scripts). Each is a registry row with a placebo and a minimum N before it is built live.
4. **Parallel UI track** (#24–#27). Independent of the above; #24 is the only M item and benefits from being done before #30 needs an equity-curve chart.
5. **Tier 5** after Sprint 1 lands, since #28 and #30 depend on CAS-safe appends (#1).

## Gotchas surfaced during the scan

- GitHub's search API (30/min) is shared across concurrent agents and was exhausted by every lane; the core repos API (5,000/hr) was fine. Future swarms should pre-seed candidate lists and verify with `gh api repos/`.
- `www.sec.gov` did not resolve from the sandbox while `data.sec.gov` and `efts.sec.gov` did; the FTD zip path is unverified.
- polygon-io's JS client is now `massive-com/client-js`; `yahoo-finance2` v4 requires Node ≥22 and pulls the MCP SDK (do not install; port endpoints).
- Hugging Face's datasets-server `/filter` is disabled for the defeatbeta dataset, so there is no pure-JSON path to transcripts.
- `simonlin1212/global-stock-data` grades every public endpoint's terms (tier A/B/C); CBOE, FINRA and api.nasdaq.com are tier C (own analytics fine, redistribution not).
