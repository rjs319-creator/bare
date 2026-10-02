# Lane 3 — Frontend charting, UI components & PWA patterns

## Lane summary
Screened 53 repos (all verified via `gh api repos/*`; GitHub search quota was exhausted mid-run so the long tail came from direct lookups) across candlestick/time-series libs, treemap/heatmap/sparkline libs, zero-dep vanilla component kits, service-worker/offline patterns and reference trading UIs. Current state audited: `public/js/app.js` (10,720 lines) hand-draws candles in `drawChart` (lines 10556-10708) and sector tiles in `renderSectorHeatmap` (862), `pattern-chart.js` (99 lines, canvas, comment says "repo convention: canvas only"), `sw.js` has **no fetch handler** (zero offline), `session-board.js` renders cards with no sort/filter, `command-palette.js` uses a plain regex/substring match, and `vercel.json` sets **no CSP header** so both CDN pins and vendored files work. Headline: adopt **TradingView lightweight-charts v5** (vendored ESM, 193 KB, Apache-2.0) as the one chart engine for candles + frozen levels + pattern overlays, add a **d3-hierarchy treemap** (14 KB) for a finviz-style sector map, and make the PWA offline-first with a ~60-line stale-while-revalidate `sw.js` plus `idb-keyval` last-good snapshots. Everything else is tiny vendorable utilities or UX reference only.

## Candidates
| Repo | Stars | Last push | License | Lang | What it does | Fit | Verdict |
|---|---|---|---|---|---|---|---|
| tradingview/lightweight-charts | 17,445 | 2026-10-01 | Apache-2.0 (+attribution NOTICE) | TS | Canvas financial charts, 193 KB standalone ESM, `createPriceLine`, v5 plugin API, dark theme via options; repo ships 30 plugin examples (trend-line, rectangle-drawing-tool, user-price-lines, session-highlighting, volume-profile, tooltip) | replaces `app.js drawChart`, augments `pattern-chart.js`, `ignition.js` annotated chart | **ADOPT** |
| klinecharts/KLineChart | 4,184 | 2026-09-30 | Apache-2.0 | TS | Zero-dep K-line chart, 228 KB UMD, built-in indicators + overlays (`priceLine`, `segment`, `rect`, fib), mobile | same slot as above | RESEARCH-ONLY (bake-off alt) |
| leeoniya/uPlot | 10,532 | 2026-09-28 | MIT | JS | 49 KB IIFE, fastest time-series; OHLC via demo plugin only | Scoreboard cohort excess-return curves, `evolve.js` equity lines | ADOPT (secondary, only if multi-series perf bites) |
| chartjs/chartjs-chart-financial | 809 | 2025-05-08 | MIT | JS | Candle/OHLC plugin, needs Chart.js 203 KB + date adapter | — | REJECT (slow cadence, 2 deps) |
| apexcharts/apexcharts.js | 15,166 | 2026-10-02 | MIT | JS | SVG charts incl. candlestick, treemap, heatmap; 937 KB | — | REJECT (size) |
| apache/echarts | 67,435 | 2026-09-30 | Apache-2.0 | TS | Everything incl. candlestick/treemap; 1.1 MB | — | REJECT (size) |
| plotly/plotly.js | 18,351 | 2026-09-30 | MIT | JS | finance dist 1.27 MB | — | REJECT (size) |
| d3fc/d3fc | 1,350 | 2024-09-28 | MIT | JS | D3 financial components, 158 KB + d3 | — | REJECT (stale, D3 dep) |
| tvjsx/trading-vue-js | 2,304 | 2024-06-24 | MIT | JS | Hackable candles, draw anything; Vue-only | overlay-API ideas | REFERENCE |
| d3/d3-hierarchy | 1,275 | 2025-04-08 | ISC | JS | Treemap/pack layouts, 14 KB, no DOM dep | `renderSectorHeatmap` → finviz-style sector map | **ADOPT** |
| wa0x6e/cal-heatmap | 3,128 | 2026-09-12 | MIT | TS | Calendar heatmap, 151 KB (bundles d3) | Scoreboard beat-rate calendar | REJECT (size; 20-line SVG does it) |
| fnando/sparkline | 547 | 2023-10-17 | MIT | JS | SVG sparklines, 2 KB | already have `sparkSvg` | REJECT (duplicate) |
| frappe/charts | 15,086 | 2025-07-02 | MIT | JS | Zero-dep SVG charts 67 KB, heatmap incl. | — | REJECT (no candles, slowing) |
| observablehq/plot | 5,396 | 2026-09-01 | ISC | JS | Grammar-of-graphics, 204 KB | research notebooks only | REFERENCE |
| tofsjonas/sortable | 503 | 2025-10-26 | Unlicense | TS | 1 KB click-to-sort `<table>` | `today.js` redundancy/ranked tables, `leaderboard.js` | **ADOPT** (vendor) |
| krisk/Fuse | 20,496 | 2026-08-09 | Apache-2.0 | JS | Fuzzy search, 25 KB ESM | `command-palette.js` ticker/section fuzzy match | **ADOPT** (vendor) |
| caroso1222/notyf | 2,877 | 2023-01-07 | MIT | JS | 7 KB zero-dep toasts, a11y | in-app alert toasts (`notify-prefs.js`, push mirror) | ADOPT (vendor; small, stable) |
| jakearchibald/idb-keyval | 3,249 | 2026-07-08 | Apache-2.0 | TS | 4 KB promise IndexedDB kv | last-good snapshot cache in `fetch-json.js` | **ADOPT** (vendor) |
| GoogleChrome/workbox | 13,021 | 2026-09-29 | MIT | JS | SW strategies; `workbox-sw` loads modules from CDN at runtime | SWR/network-first recipes | REFERENCE (hand-roll 60 lines) |
| mdn/pwa-examples | 1,012 | 2026-07-08 | CC0 | JS | Canonical offline/push SW samples | `sw.js` fetch handler shape | REFERENCE |
| NeXTs/Clusterize.js | 7,265 | 2026-06-15 | MIT | JS | 6 KB virtual list | only if a universe-wide (2000-row) table is added | REFERENCE |
| TanStack/virtual | 7,128 | 2026-09-21 | MIT | TS | Headless virtualizer; `virtual-core` 47 KB ESM | same | REFERENCE |
| finos/regular-table | 404 | 2026-09-11 | Apache-2.0 | JS | `<regular-table>` web component, async virtual data model, 28 KB | ranked-table virtualization if needed | REFERENCE |
| grid-js/gridjs | 4,692 | 2026-01-29 | MIT | TS | 51 KB sortable/filterable grid | — | REJECT (Preact inside, styling fight) |
| tabulator-tables/tabulator | 7,778 | 2026-09-30 | MIT | JS | Full data grid 443 KB | — | REJECT (size) |
| ssleptsov/ninja-keys | 1,705 | 2024-07-14 | MIT | TS | Web-component command palette, 15 KB (Lit) | — | REJECT (palette exists; Lit dep) |
| ghostfolio/ghostfolio | 9,391 | 2026-10-01 | AGPL-3.0 | TS | Wealth mgmt: holdings, allocation treemap, benchmark-vs-portfolio | position-tracking UX for the "no portfolio" gap | REFERENCE |
| wealthfolio/wealthfolio | 9,097 | 2026-10-01 | AGPL-3.0 | Rust/React | Local-first portfolio tracker | same | REFERENCE |
| stocknear/frontend | 43 | 2026-09-16 | AGPL-3.0 | Svelte | Open stock-analysis UI (screener, heatmap, options flow pages) | page layouts for Session Board / options | REFERENCE |
| freqtrade/frequi | 1,085 | 2026-10-01 | GPL-3.0 | Vue | Trade-bot dashboard: open trades vs levels, log pane | live-status-vs-levels row design | REFERENCE |
| Eleven-Trading/TradeNote | 967 | 2025-04-14 | GPL-3.0 | JS | Trading journal: per-trade MFE/MAE, calendar P&L | Scoreboard calendar view | REFERENCE |
| openbq-org/OpenBB | 73,737 | 2026-10-01 | custom | Python | Platform; Terminal Pro UI is closed | — | REJECT (UI not open) |
| StockSharp/StockSharp | 10,828 | 2026-10-01 | custom | C# | Desktop algo platform | — | REJECT |

Also screened and dropped: Chart.js, tui.chart (archived), SlickGrid, simple-datatables, shoelace (archived → webawesome), hyperlist, list.js, toastify-js, hotkeys-js, idb, Dexie, serwist, perspective, ag-grid, cmdk, lucide, maybe-finance (archived), portfolio-performance, DKirwan/calendar-heatmap, d3.

## Top proposals

### 1. lightweight-charts v5 as the single chart engine (ADOPT, effort M)
- **Build**: `public/js/vendor/lightweight-charts.mjs` (pin 5.2.1, ESM standalone 193 KB; **not on cdnjs**, so vendor from jsdelivr `npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.mjs`; the vendored file also gets precached by the new SW). New `public/js/chart-engine.js` wrapping `createChart` + `CandlestickSeries` + `HistogramSeries` (volume) with the app dark palette (`#060b14` bg, existing up/down greens/reds).
- **Plugs in**: replaces `app.js drawChart/renderChart` (10311-10708, ~400 lines, incl. indicator/signal glyphs); `pattern-chart.js` keeps its API (`drawPatternChart(host, chart, det)`) but draws frozen `plan.trigger/stop/target` via `series.createPriceLine({price, color, lineStyle, title})`, pivots via the repo's `trend-line` + `anchored-text` plugin examples, confirmation bar via `session-highlighting`. Session Board and Ignition expand-cards get the same component.
- **Shape**: vendored file + 3-4 plugin examples ported from TS to plain JS (they are ~100-200 lines each, Apache-2.0).
- **Risk**: Apache-2.0 NOTICE requires a visible TradingView attribution link on the chart; breaks the "canvas only, no chart lib" convention stated in `pattern-chart.js` (make that an explicit decision); plugin examples are TypeScript (one-off hand port, no build step). Bake-off against klinecharts (overlays built in, no attribution clause, but 228 KB UMD and heavier API) on one card before committing.
- **Measured**: not a Scoreboard item; measure render-integrity tests (existing pattern) + Lighthouse LCP on the Session Board tab before/after, and chart JS bytes shipped.

### 2. Sector treemap with d3-hierarchy (ADOPT, effort S)
- **Build**: vendor `d3-hierarchy@3.1.2/dist/d3-hierarchy.min.js` (14 KB, ISC; on cdnjs too). New `public/js/sector-treemap.js`: `treemap().size([W,H]).padding(2)` over sectors → sub-industries → tickers, area = market cap or dollar volume (both already returned by `/api/sectors` / screener payloads), fill = `changePct` with the existing `sectorStyle()` scale, output inline SVG `<rect>`+`<text>` (matches site style, stays theme-aware).
- **Plugs in**: replaces equal-size chips in `app.js renderSectorHeatmap` (862-874); click a tile → `command-palette` ticker route; also a second mode colouring by relative strength from the sector-rotation module.
- **Risk**: none material; label collision on small rects (hide below 40 px).
- **Measured**: UI-only; count tab dwell/clicks via existing lightweight telemetry if any, else none.

### 3. Offline-first PWA: SWR service worker + idb-keyval snapshots (ADOPT, effort M)
- **Build**: `sw.js` gains `install` precache of the app shell (`/`, `/js/*.js`, `/css/app.css`, vendor files, `/icon.svg`) and a `fetch` handler: cache-first for same-origin static, **stale-while-revalidate** for `GET /api/*` reads that are snapshot-shaped (`sessionboard`, `today`, `sectors`, `scoreboard summary`), network-only for `/api/price` and anything with a bearer. Pattern from `mdn/pwa-examples` + Workbox's SWR recipe, hand-rolled (~60 lines), so no runtime CDN dependency inside the SW. `fetch-json.js` gets an `idb-keyval` (vendored 4 KB) layer: write last-good JSON per op with `asOf`; on fetch failure or Blob-lag empty payload, return the cached snapshot flagged `stale:true` so `session-board.js` / `today.js` show an "as of HH:MM, offline/stale" strip instead of an empty state (also mitigates the Blob read-after-write lag pain point client-side). Bump `VERSION` on deploy (append git sha at build time is not possible without a build step; use a manual constant and a `message` channel to prompt reload).
- **Risk**: must never cache empty-state responses (known CDN-cached-empty-state gotcha); exclude `/api/warm`, `/api/tracker` and anything with query `op=*tick*`; SW cache versioning discipline.
- **Measured**: offline Lighthouse PWA audit passes; count `stale:true` renders in a client counter to quantify Blob-lag exposure.

### 4. Micro-kit: sortable + Fuse + Notyf (ADOPT, effort S)
- `tofsjonas/sortable` (1 KB, Unlicense): add `class="sortable"` to tables in `today.js` (redundancy pairs at 685, ranked rows) and `leaderboard.js`; no virtualization needed at current row counts (board ≤ ~200 cards). If a universe-wide table ever ships, use `regular-table` or `Clusterize.js`.
- `Fuse.js` (25 KB ESM, Apache-2.0): replace substring match in `command-palette.js` with fuzzy over sections + Learn concepts + ticker names (not just symbols); keep `TICKER_RE` fast-path.
- `Notyf` (7 KB, MIT): in-app toast when a push arrives while the tab is open (`sw.js` → `postMessage` → toast), and for "upgraded/downgraded since last look" from `session-board.js` lines 139-140. All three vendored in `public/js/vendor/` with pinned version in filename.
- **Risk**: Notyf last pushed 2023 but tiny and stable; Fuse adds 25 KB (lazy-import on first ⌘K).

## Rejected / noise
- apexcharts / echarts / plotly: 0.9-1.3 MB each for features the site uses 5% of.
- chartjs-chart-financial: needs Chart.js + date adapter, last push 2025-05, 809 stars.
- d3fc: 2024 last push, pulls full d3.
- tabulator, gridjs, ag-grid, SlickGrid: full grids for a card-based board; gridjs bundles Preact.
- ninja-keys, cmdk: palette already exists; Lit/React deps.
- cal-heatmap: 151 KB for a calendar that is 20 lines of SVG.
- fnando/sparkline, frappe/charts, list.js: duplicate existing `sparkSvg`/tables.
- workbox-sw via CDN: runtime loads from a CDN inside the SW — bad for offline; use as recipe only.
- OpenBB: Terminal Pro UI closed; StockSharp: C# desktop.
- maybe-finance: archived 2025-07; shoelace: archived (webawesome successor is 1.3k stars, heavy CSS framework).
- Ghostfolio/wealthfolio/stocknear/frequi/TradeNote: AGPL/GPL — borrow UX only, never code.
