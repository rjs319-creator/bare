# Lane 4 — Alternative data, filings NLP & sentiment

## Lane summary
Searched ~40 `gh search repos` queries across SEC-filing NLP, finance NLP models, social/attention, insider/institutional, event calendars and "free" alt data; the GitHub search bucket was rate-limited twice (shared with other lanes), so verification was done through `gh api repos/...` (stars / pushed_at / license checked for every row below). 44 repos screened, 15 kept. Headline: **almost nothing in this lane needs a new dependency** — the best raw material is already reachable from `lib/edgar.js` (the `data.sec.gov/submissions` JSON it fetches carries `filings.recent.items`, i.e. 8-K item codes, unused today) and from free JSON/CSV endpoints (Wikimedia pageviews, ARK fund CSVs, iTunes RSS). The repos are mostly REFERENCE/RESEARCH-ONLY (Python: edgartools, sec-parser). Three of the lane's "obvious" ideas are already in the hypothesis registry as **no-edge** (congress-flow, activist-13d-initial, buyback-authorization-8k) and are not re-proposed.

## Candidates

| Repo | Stars | Last push | License | Lang | What it does | Fit | Verdict |
|---|---|---|---|---|---|---|---|
| dgunning/edgartools | 2759 | 2026-10-01 | MIT | Python | 10-K/10-Q item extraction, 8-K items, 13F, Form 4, XBRL | offline backfill in `research/` for proposals 1–2 | RESEARCH-ONLY |
| alphanome-ai/sec-parser | 294 | 2026-06-25 | MIT | Python | Semantic tree of EDGAR HTML (titles/sections) | MIT reference for a JS Item 1A/7 extractor (`lib/filing-text-delta.js`) | PORT (reference) |
| lefterisloukas/edgar-crawler | 548 | 2025-07-18 | GPL-3.0 | Python | Item-level text extraction 10-K/10-Q/8-K | same job, but GPL | REFERENCE only |
| SEC-API-io/sec-api-python | 320 | 2026-04-13 | MIT | Python | SDK for commercial sec-api.io (8-K item taxonomy, 13D/G, NT filings) | item taxonomy reference; service is paid | REFERENCE |
| facundoolano/google-play-scraper | 2976 | 2026-09-29 | MIT | JS (ESM) | Play Store app details/reviews/rank; deps got+cheerio | `lib/tech-evidence/adapters/appstore.js` consumer sleeve | ADOPT (npm) |
| facundoolano/app-store-scraper | 1430 | 2025-07-27 | MIT | JS | iTunes ratings/rank; depends on deprecated `request` | call iTunes lookup/RSS JSON directly instead | PORT (2 endpoints) |
| frefrik/ark-invest-api | 81 | 2026-01-08 | MIT | Python | Parses ARK daily holdings CSVs → trades | CSV URLs + diff logic for a CERN event type | PORT (reference) |
| huggingface/transformers.js | 16336 | 2026-10-02 | Apache-2.0 | JS | Run ONNX models (FinBERT) in Node | offline FinBERT vs Claude tone bake-off only; model > Vercel bundle | RESEARCH-ONLY |
| ProsusAI/finBERT | 2244 | 2022-09-09 | Apache-2.0 | Py/Notebook | Finance sentiment BERT | baseline for the bake-off above | RESEARCH-ONLY |
| AI4Finance-Foundation/FinGPT | 21309 | 2026-09-23 | MIT | Py/Notebook | Finance LLM fine-tunes + sentiment benchmarks | benchmark datasets only | RESEARCH-ONLY |
| JianLoong/sentimentanalysis | 7 | 2022-10-24 | Apache-2.0 | JS | Lexicon scoring (AFINN/VADER/NRC) in JS | pattern for a 50-line LM word-count in `lib/toneshift.js` | REFERENCE |
| sdil87/trendspy | 121 | 2024-12-25 | MIT | Python | Google Trends client (works where pytrends broke) | offline attention study only; Google 429s server IPs | RESEARCH-ONLY |
| QuantConnect/Lean.DataSource.QuiverQuantWikipedia | 3 | 2026-06-18 | none | C# | Wikipedia-pageview dataset contract | schema reference for proposal 5 (raw Wikimedia API is free) | REFERENCE |
| EarningsCall/earningscall-js | 4 | 2026-06-04 | MIT | TS | SDK for earningscall.biz transcripts/audio | fixes "FMP has no transcripts"; full coverage is paid | REFERENCE (commercial) |
| btopn/OpenInsider-MCP | 101 | 2026-08-07 | MIT | TS | OpenInsider screener as MCP | duplicates Form 4 cluster ledger | REJECT |

## Top proposals

### 1. Filing red-flag AVOID lane (8-K items + NT 10-K + going concern) — ADOPT, effort S/M
**Build:** `lib/filing-redflags.js` + `-feed.js` + `-routes.js`, cloned from the `insider-cluster-*` / `dilution-filings.js` (424B5) pattern. Sources, all already wired: (a) `submissions/CIK….json` → `filings.recent.items` for 8-K **Item 4.01** (auditor change), **4.02** (non-reliance/restatement), **3.01** (exchange deficiency/delisting notice), **5.02 with CFO/CEO departure**; (b) daily index form types `NT 10-K` / `NT 10-Q`; (c) EDGAR FTS `"substantial doubt" "going concern"` restricted to 10-K/10-Q. No new dependency; edgartools only for the offline backfill.
**Hypotheses (one registry row each, family `event-drift`, AVOID side):** "A first NT 10-K/10-Q (no NT in prior 252 sessions) is followed by negative cost-net SPY-excess over 21 and 63 sessions from the next open" ; same template for Item 4.02, Item 3.01, Item 4.01-without-2.02, going-concern first mention.
**Measurement:** next-open entry, SPY-excess at 5/21/63 sessions, **same-name placebo 126 sessions earlier** (the registry's lesson from 13D/buyback: distressed filers are chronic underperformers — the test is filing effect minus name effect), kit eligibility (≥60 bars, close ≥ $2, ADV60 ≥ $2M). Min N: 300 dev events per flag (NT 10-K alone yields ~400/yr; 4.02 ~150/yr → 2-year backfill 2024-07→2026-06, holdout 2026-07→). Prospective ledger ticks nightly in `api/warm.js` as one chain step reading the 8-K/NT subset of the daily index (cheap: one index fetch).
**Risk:** Item codes missing on older filings (fallback: FTS); the registry already shows AVOID lanes are the only kind that survive here — do not build a long side.

### 2. "Lazy Prices" 10-K/10-Q text-change — RESEARCH-ONLY first, then PORT, effort L
**Build:** offline `research/` script using edgartools to pull Item 1A + Item 7 for the ~3,000-name universe (2019→), compute YoY cosine/Jaccard similarity plus LM uncertainty/litigious word-share delta (Loughran-McDonald master dictionary from sraf.nd.edu — free for non-commercial use; vendor the CSV, not pysentiment which is GPL-2). If the sealed pass survives the kit's gates, port a regex Item extractor to `lib/filing-text-delta.js` (model it on sec-parser, MIT — not edgar-crawler, GPL) and run it as a quarterly batched chain step writing per-CIK similarity to Blob.
**Hypothesis:** "Bottom-quintile YoY similarity of 10-K/10-Q risk-factor + MD&A text (vs the filer's prior same-form filing) is followed by negative cost-net SPY-excess over 63 sessions; top quintile is ≥ 0 (Cohen–Malloy–Nguyen 2020)."
**Measurement:** quintile spread and bottom-quintile excess at 21/63 sessions, benchmark SPY, placebo same-name prior year; N ≥ 500 filings per quintile per filing season; FDR across the 4 feature variants.
**Risk:** slow horizon vs the 1/5/10/20d Scoreboard (needs the existing A@63 column); heavy text fetch (~4k docs/season) must be chunked across nights; published anomaly, likely decayed — treat as AVOID overlay only.

### 3. Consumer-app rank / review velocity → tech operational evidence — ADOPT (npm) / PORT, effort M
**Build:** `lib/tech-evidence/adapters/appstore.js` beside `adapters/jobs.js`. iOS: call `itunes.apple.com/lookup?id=` (ratingCount, averageUserRating) and the RSS top-charts JSON directly — skip `app-store-scraper`'s deprecated `request` dep. Android: `google-play-scraper` (ESM, got+cheerio, fits Vercel) or port its `app()` endpoint. Register ~25 consumer names (HOOD, COIN, DUOL, RBLX, SNAP, PINS, SOFI, DKNG, SPOT, UBER, DASH, ABNB, RDDT, APP, AFRM, CHWY, ETSY, ROKU, PTON, BMBL, LYFT, U, NFLX, HIMS, CART) in `tech-evidence/registry.js`.
**Hypothesis:** "A positive 30-day acceleration in review-count velocity (iOS + Play, z-scored per app) measured ≥ 5 sessions before earnings predicts a positive revenue surprise and positive cost-net sector-peer-excess over the 21 sessions after the print."
**Measurement:** reuse the techev forward 5/10/21-session ledger (sector-peer and SPY excess), N: 25 names × 4 prints = ~100 events/yr → minimum N 200 (two years) before any grade above PROMISING_RESEARCH; also report sign-hit-rate on surprise.
**Risk:** Play scraping brittle/ToS-gray (iTunes endpoints are stable public JSON); `lib/nsl/providers.js` notes app-store *analytics* are licensed — raw ranks/review counts are not; small universe → slow accrual.

### 4. ARK daily-holdings diff as a CERN forced-flow event type — PORT (reference), effort S
**Build:** nightly fetch of the 6 ARK ETF holdings CSVs (ark-funds.com, published after close), diff shares vs the prior Blob snapshot (`frefrik/ark-invest-api` has the URLs and the trade-derivation logic), emit events into `lib/cern.js` alongside index adds/lockups with its decay curves.
**Hypotheses:** "ARK net buys ≥ 10% of 20d ADV in names with ADV < $50M are followed by positive 1–5-session SPY-excess that reverses by session 21 (price pressure, not information)"; mirror for sells as an AVOID flag.
**Measurement:** CERN decay-curve ledger at 1/5/21 sessions, SPY-excess with ARKK return as an added factor control, placebo same-name 126 sessions earlier; ARK trades 20–40 names/day → N 300 within ~3 months.
**Risk:** CSV schema churn; ARK AUM is far smaller than 2021 so impact is likely sub-cost — this is cheap to falsify, which is the point.

### 5. Wikipedia-pageview attention spike (second attention source) — RESEARCH-ONLY first, effort S data / M study
**Build:** Wikimedia REST pageviews API (free, daily, history to 2015 — the only attention source with a 10-year free backfill; `lib/constituents.js` already touches Wikipedia). Offline study in `research/`; only if it passes, a `lib/attention-wiki.js` nightly step. Reddit (official OAuth API) stays deferred — the brief's "agreement doesn't pay" finding means a third attention gauge must earn its place via divergence vs StockTwits, not agreement.
**Hypothesis:** "A top-decile 7-day pageview z-spike with |5-day return| < 1 ATR (attention without a price move) is followed by negative cost-net SPY-excess over 21 sessions (Da–Engelberg–Gao attention-reversal)."
**Measurement:** full-universe daily panel, decile spread and top-decile excess at 5/21 sessions vs SPY, purged walk-forward blocks, FDR q < 0.05; N is in the thousands, so gate on block consistency (≥3/4 blocks). Placebo: same spike definition on pageviews shifted +30 days.
**Risk:** mapping tickers → article titles (Wikidata P414 exchange-ticker property solves most); documented effect is weak and crowded.

Minor, no repo needed: extend `adapters/jobs.js` with Ashby (`api.ashbyhq.com/posting-api/job-board/{org}`) and Workday (`{tenant}.myworkdayjobs.com/wday/cxs/.../jobs`) alongside the existing Greenhouse/Lever parsers — widens the techev universe, feeds the existing ledger.

## Rejected / noise
- timothycarambat/senate-stock-watcher-data (100★, dead 2021), P-H-B-D/CapitolTradesScraper, jsconiers/quiver-quant-mcp — congress flow already `no-edge` in the registry (`congress-flow`); 45-day disclosure lag; Quiver is paid; Capitol Trades scraping is ToS-gray.
- sd3v/openinsiderData, btopn/OpenInsider-MCP — OpenInsider is a Form 4 re-skin; the cluster-buy ledger already covers it.
- Activist 13D trackers / 13F parsers — `activist-13d-initial` evaluated 2026-09-19, no-edge (name effect); 13F has a 45-day lag and the clone literature is flat.
- Buyback trackers — `buyback-authorization-8k` no-edge; XBRL `StockRepurchaseProgramAuthorizedAmount1` already in companyfacts if ever needed.
- IRightThings/PDUFA-tracker, SaeedMohamed17/lockup-watch (0–1★) — biotech radar and CERN lockups already built.
- pat310/google-trends-api (974★, dead 2022), GeneralMills/pytrends (2024) — Google blocks datacenter IPs; attention story is better tested with Wikipedia first.
- Snaporaz6/ais-vessel-tracker (0★) / aisstream.io — websocket-only, no serverless fit, no clean vessel→ticker mapping; satellite (Sentinel) and card-spend data are not free in any usable form.
- hackingthemarkets/wallstreetbets-tracker, RyanElliott10/wsbtickerbot, asad70/reddit-sentiment-analysis — all Pushshift-era, Pushshift is dead; snoowrap (1031★) last pushed 2023.
- edgar-crawler, py-xbrl, pysentiment — GPL; cannot be ported into the MIT-style codebase.
- orgupdate/Apify-Workday-Job-Scraper — Apify-platform wrapper; the Workday cxs JSON endpoint is public.
- EarningsCall/earningscall-js — would close the transcript gap, but free tier is demo-only; flag for the user as a paid option, not a build.
- sec-edgar-downloader, sec-edgar/sec-edgar — plain downloaders; `lib/edgar.js` already does this.
