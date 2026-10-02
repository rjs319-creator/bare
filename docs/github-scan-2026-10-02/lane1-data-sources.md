# Lane 1 — Market data sources & API clients

## Lane summary
Ran ~45 `gh search repos` queries across the eight categories (survivorship-free EOD/delistings, intraday/bulk quotes, SEC EDGAR, FINRA/FTD, transcripts, corporate actions/calendars, options chains, macro) plus the data sections of `awesome-quant` and `awesome-financial-data-apis`; screened 48 repos, verified 40 with `gh api repos/...`, and live-probed the underlying endpoints with curl (CBOE, FINRA, Nasdaq, Treasury, BLS, Tiingo, Hugging Face). Headline: for a zero-dep Node app the best "repos" are **documentation of official pure-HTTP feeds, not libraries** — CBOE delayed chains with full Greeks, FINRA Reg SHO daily short volume, Nasdaq earnings/splits/dividend calendars, Treasury yield CSV, BLS v2 and Tiingo's free delisting-complete ticker list all answered 200 with no key and no dependency. The one real library-shaped gap (earnings transcripts) is best filled offline from defeatbeta's open Hugging Face parquet. Almost every strong GitHub project in this space is Python-only (edgartools, OpenBB, yfinance) and is RESEARCH-ONLY here. Nothing found replaces FMP for bulk quotes.

## Candidates

| Repo | Stars | Last push | License | Lang | What it does | Fit | Verdict |
|---|---|---|---|---|---|---|---|
| simonlin1212/global-stock-data | 1,664 | 2026-09-25 | Apache-2.0 | Py (skill md) | Zero-auth official-source cookbook: CBOE chain+Greeks, FINRA Reg SHO, EDGAR frames/FTS, Treasury, CFTC, Nasdaq calendar; terms graded per source | Options, short-volume, calendars; every endpoint is pure HTTP | ADOPT (endpoints, not code) |
| defeat-beta/defeatbeta-api | 757 | 2026-09-29 | Apache-2.0 | Python | Yahoo-derived dataset republished weekly on HF: `stock_earning_call_transcripts.parquet` (2.3 GB), prices, splits, dividends, earnings calendar, SEC filings | Fills FMP transcript gap for `lib/earnings-tone.js`; research panels | RESEARCH-ONLY (offline) / PORT via hyparquet |
| hyparam/hyparquet | 955 | 2026-09-27 | MIT | JS | Pure-JS parquet reader, zero deps, supports HTTP range reads | Only way to read defeatbeta parquet from Vercel without Python | PORT/ADOPT (1 small dep) if P4 goes live |
| BlackFalconData-org/delisted-stocks-list | 0 | 2026-04-17 | none | — (Apify) | 36k delistings since 2002 from EDGAR Form 25 / 15-12G / 15-15D with CIK+accession provenance | Survivorship-free universe; method is replicable with the already-wired EDGAR daily index | REFERENCE (replicate, don't buy) |
| hydrosquall/tiingo-python | 321 | 2025-12-14 | MIT | Python | Tiingo client; Tiingo's `supported_tickers.zip` (no key) lists start/end dates for 16,529 US stocks, 8,230 with an endDate (delisted) | Extends PIT secmaster (2,573 delisted, FMP-only) | RESEARCH-ONLY (pure HTTP, Python not needed) |
| EodHistoricalData/EODHD-openapi | 3 | 2026-09-16 | MIT | OpenAPI | Spec for EODHD REST (All-World plan includes delisted tickers, splits, dividends, fundamentals) | Sharadar alternative at ~$20–80/mo | REFERENCE (pure HTTP; paid) |
| gadicc/yahoo-finance2 | 801 | 2026-08-09 | MIT | TS/Deno | Unofficial Yahoo client: quote, chart, options, screener, fundamentalsTimeSeries, `streamer.ts` (websocket protobuf) | Documents crumb flow + websocket wire format; npm 4.x drags MCP SDK, zod, tough-cookie, Node>=22 | REFERENCE (port endpoints; do not install) |
| yahoofinancelive/yliveticker | 173 | 2026-03-28 | MIT | Python | Yahoo `streamer.finance.yahoo.com` websocket + PricingData protobuf | Near-real-time quotes for the launchd fallback box only (serverless can't hold sockets) | REFERENCE |
| dgunning/edgartools | 2,759 | 2026-10-01 | MIT | Python | Typed parsers for 10-K/8-K/XBRL/Form 3-4-5/13F, clean text extraction | Reference for Form 4 / 13F / 8-K item parsing already done by hand in `lib/` | RESEARCH-ONLY |
| daniel3303/Equibles | 231 | 2026-10-01 | AGPL-3.0 | C# | Self-hosted scrapers: SEC FTD, FINRA short vol/interest, Congress trades, CFTC, CBOE, FRED, USAspending | Working reference for SEC FTD zip + FINRA Reg SHO ingestion | REFERENCE (AGPL; read, don't vendor) |
| moshejs/treasury-fiscaldata (+ newyorkfed, commitments-of-traders) | 1–2 | 2026-07-16 | MIT | TS | Typed zero-dependency clients for Treasury FiscalData, NY Fed SOFR/SOMA, CFTC COT | Tiny, vendorable; macro tab | REFERENCE (ports are ~50 lines each) |
| EarningsCall/earningscall-js | 4 | 2026-06-04 | MIT | TS | Zero-dep JS client for earningscall.biz transcripts (speaker-level, prepared vs Q&A) | Paid transcript source with a JS client; demo key covers only AAPL/MSFT/NVDA | REJECT for free; REFERENCE if budget appears |
| itsfabtrading/Gex-Multi | 7 | 2026-08-04 | Apache-2.0 | Python | Dealer GEX / gamma-flip from public CBOE chains | Shows how to use the CBOE JSON (field names, expiry parsing) | REFERENCE |
| massive-com/client-js (ex-polygon) | 273 | 2026-10-01 | MIT | TS | Official Polygon/Massive REST+WS client (axios, websocket, cross-fetch) | Paid survivorship-free EOD (`tickers?active=false`); deps too heavy | REFERENCE (call REST directly if ever bought) |
| JerBouma/FinanceDatabase | 9,390 | 2026-09-27 | MIT | Python/CSV | 300k-symbol metadata (sector/industry/country) as CSVs on GitHub raw | Richer sector map than Nasdaq Trader lists; fetchable as plain CSV | RESEARCH-ONLY |

## Top proposals

### P1 — Survivorship-free universe v2: Tiingo ticker list + EDGAR Form 25/15 feed (RESEARCH-ONLY → data pipeline)
- **Build:** (a) nightly-safe offline script `research/64-secmaster-tiingo-xcheck.js` that downloads `https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip` (verified 200, 804 KB, no key; 8,230 US stocks with an `endDate`) and diffs it against `research/lib/secmaster.js` (2,573 delisted, FMP-derived) to find dead names FMP dropped; (b) a PIT **delisting-event** feed built from the already-wired EDGAR daily index — Form 25/25-NSE (exchange delisting, effective T+10 business days) and 15-12G/15-15D (deregistration) — the exact method BlackFalconData sells on Apify.
- **Plugs into:** `research/lib/secmaster.js` (`universeAt`), `research/04-survivorship-bias.js`; later a `lib/cern/*` "delisting pending" AVOID flag.
- **Shape:** offline script + JSON artifact; zero deps (Node `zlib.inflateRawSync` handles the single-entry zip). Delisted *prices* for the extra names need Tiingo EOD (free tier is symbol-capped; Power plan ~$10/mo) — that is the cheap Sharadar alternative; do not buy without the user.
- **Effort:** S (xcheck) / M (Form 25 feed). **Risk:** Tiingo list has no license statement; ticker renames need CIK joins; Form 25 → ticker resolution is lossy (BlackFalcon ships a `confidence` score for a reason).
- **Measure:** re-run the E8 twin + momentum baseline with the widened master; report the shift in the +0.40%/63d survivorship bias; Form-25 AVOID flag goes to Scoreboard as a shadow overlay.

### P2 — CBOE delayed option chains with Greeks (ADOPT, pure HTTP)
- **Build:** `lib/cboe-chain.js`: `GET https://cdn.cboe.com/api/global/delayed_quotes/options/{SYM}.json` (follow the 307 to `cdn-api.cboe.com`; verified 200, AAPL = 3,538 contracts with `iv, delta, gamma, vega, theta, rho, open_interest, volume, bid/ask` plus underlying quote). Indexes use `_SPX`, `_VIX`.
- **Plugs into:** `lib/options-universe-v2.js` / `lib/options-baseline.js` (replace the Yahoo `v7/finance/options` + crumb dance, which has no Greeks); OI-confirm and options-flow get real IV/delta instead of inferred.
- **Shape:** zero-dep fetch adapter behind the existing provider interface; one 1.5 MB JSON per symbol → keep the rotating shard, memoize per session.
- **Effort:** S. **Risk:** CBOE terms are tier C (redistribution needs a licence); fine for the site's own analytics, do not expose raw chains in the public `/feed`. Delayed 15 min.
- **Measure:** run Yahoo and CBOE adapters side by side for 20 sessions; compare OI-confirm hit rates and Scoreboard excess of options-flow picks under each.

### P3 — FINRA Reg SHO daily short volume + SEC fails-to-deliver (ADOPT, pure HTTP, shadow overlay)
- **Build:** `lib/finra-shortvol.js`: `https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt` (verified 200, 549 KB pipe-delimited, ~12k symbols: ShortVolume, ShortExemptVolume, TotalVolume). Derive daily short-volume ratio, 20d z-score, and an "exempt spike" flag. `lib/sec-ftd.js`: semi-monthly `cnsfails{YYYYMM}{a|b}.zip` (sec.gov DNS blocked in this sandbox, so not probed; Equibles and `Yuvrajchandra/failstodeliver` both use that path).
- **Plugs into:** a new `shortvol` hypothesis in the registry next to the existing (no-alpha) short-interest overlay; CERN forced-flow and Ignition low-float lanes as a feature, not a picker.
- **Shape:** nightly cron step (one 0.5 MB fetch, no fan-out) writing a sharded Blob; zero deps.
- **Effort:** S. **Risk:** FINRA terms say non-commercial and no scraping tools — a single daily file download for a personal research site is the common reading, but note it; short volume ≠ short interest and the literature says it is mostly market-maker hedging (expect no alpha; the value is a cleaner AVOID/liquidity feature).
- **Measure:** preregistered gate; 1/5/10/20d excess vs SPY by short-volume-ratio decile, FDR-controlled, same as the SI overlay.

### P4 — Earnings-call transcripts from defeatbeta's open parquet (RESEARCH-ONLY first, optional PORT)
- **Build:** offline `research/65-transcripts-ingest.js` or a Python/DuckDB one-off that reads `hf://datasets/defeatbeta/yahoo-finance-data/data/US/stock_earning_call_transcripts.parquet` (2.3 GB, speaker-attributed paragraphs, weekly refresh; sibling files: `stock_split_events`, `stock_dividend_events`, `stock_earning_calendar`, `stock_sec_filing`) and emits per-symbol JSON for the names in the tech/biotech universes. HF datasets-server `/filter` is disabled for this dataset, so there is no pure-JSON path; on Vercel the only zero-Python route is `hyparquet` (MIT, zero deps) doing HTTP range reads of the row groups you need.
- **Plugs into:** `lib/earnings-tone.js` / `lib/toneshift.js` (currently hitting FMP `earning-call-transcript`, which the plan does not include) and the TradingAgents reflection loop's fundamentals analyst.
- **Shape:** offline pipeline → Blob JSON (preferred); hyparquet port only if live freshness is needed. **Effort:** M.
- **Risk:** dataset carries no licence and is scraped from Yahoo (personal-use terms); weekly lag means the tone signal is late for the first days after a call; 2.3 GB cannot be read inside the 300 s cron.
- **Measure:** earnings-tone grade already exists in the hypothesis registry — add a `source=defeatbeta` arm and compare coverage (% of universe with a transcript within N days) and Scoreboard excess vs the FMP-less baseline.

### P5 — Official calendars & macro pack: Nasdaq calendars, Treasury curve, BLS (ADOPT, pure HTTP)
- **Build:** `lib/nasdaq-calendar.js` → `https://api.nasdaq.com/api/calendar/{earnings|splits|dividends}?date=YYYY-MM-DD` (verified 200 with a browser UA + `Accept: application/json`; earnings rows carry `epsForecast, noOfEsts, lastYearEPS, time`; splits carry `ratio, executionDate`; dividends carry ex/record/pay dates). `lib/treasury-curve.js` → the Treasury daily-yield CSV (verified, 1 Mo…30 Yr). `lib/bls.js` → `https://api.bls.gov/publicAPI/v2/timeseries/data/{series}` (verified, no key for 25 req/day).
- **Plugs into:** Session Board premarket fields and `lib/pulse2-freshness.js` (earnings calendar without the FMP 10k cap), CERN event lists (splits as a forced-flow event type), Regime router (2s10s from Treasury instead of FRED's one-day lag).
- **Shape:** zero-dep adapters; the moshejs TS clients are the model for the shape (typed, ~50 lines, no deps) and can be ported rather than installed. **Effort:** S each.
- **Risk:** `api.nasdaq.com` is unofficial (tier C, UA-sensitive, occasionally 403s from datacenter IPs — keep FMP as fallback); Treasury CSV changes columns when new tenors are added.
- **Measure:** data-quality only (coverage vs FMP calendar, missing-day counts in the health op); the regime lever already has its own gate.

## Rejected / noise
- **OpenBB (73.7k★)** — Python platform; provider adapters are the only interesting part and they wrap the same endpoints above.
- **ranaroussi/yfinance (25k★)** — Python; everything it does is already in `lib/` via the chart/quote endpoints.
- **sec-edgar, sec-edgar-downloader, edgar-crawler, sec-edgar-mcp, datamule, edgar-sec** — Python downloaders over EDGAR; the site already has daily index, FTS, companyfacts, Form 4 bulk.
- **SEC-API-io/sec-api-node (311★)** — paid API ($); nothing it adds (Form 4/13F stream, FTS) is missing.
- **alpaca-trade-api-js / alpaca-py** — brokerage-centric, needs account; data is IEX-only on the free tier.
- **databento/*** — superb but paid per-GB and futures/L2 oriented; no fit for an EOD research site.
- **python-xbrl, ScraXBRL** — stale (2022–2024); `data.sec.gov` frames/companyfacts already give parsed facts.
- **alphasmo/alphasmo-tools** — 2★ TS CLI/MCP over EDGAR 13F/Form 4; duplicates existing insider ledger; pulls MCP SDK + zod.
- **ECTSum, Earnings-Calls-NLP, Seeking Alpha scrapers** — static academic sets or ToS-violating scrapers.
- **Clarkdrengen/open-equity-data, market-structure-scraper** — 0★, empty README or single-author scripts.
- **neutraltone/awesome-stock-resources (14.5k★)** — stock *photography*; wrong "stock".
- **WRDS/CRSP merge repos** — require academic licences.
- **FinanceDatabase as a delisting source** — metadata only, no end dates.
