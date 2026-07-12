# Market News App — Architecture Briefing for Review

> **Instructions for the AI reviewer:** This is a briefing on a personal stock-market
> analysis web app. I want you to analyze it and suggest **concrete areas of improvement**.
> Focus on: architecture & maintainability, performance, product/UX, data reliability,
> testing gaps, security, and cost. Prioritize your suggestions (High/Med/Low impact) and
> be specific. Where you'd need to see code to be sure, say so and tell me which file to paste.
> **Do NOT re-suggest trading "edges" that the "Honest Research Findings" section below says
> are already debunked** — that ground is covered; assume the app is a dashboard, not an alpha engine.

---

## 1. What the app is

A single-user (personal) **stock-market screening & analysis dashboard**. It scans the US
equity universe (~2000 tradeable names), runs many rule-based + AI-assisted screeners, tracks
every pick's forward return in a "Scoreboard," and layers Claude/Fable LLM reasoning on top of
mechanical signals. Live at a Vercel URL. Solo developer, iterated over many sessions.

**Core philosophy:** honesty over hype — extensive backtesting has repeatedly *rejected* claimed
edges, and the app openly labels what is unproven. It is best understood as a **momentum/regime
dashboard with a falsifiable self-tracking layer**, not a profitable trading system.

---

## 2. Tech stack & hard constraints

- **Frontend:** Vanilla JS ES modules under `public/js/*.js` — **no framework, no build step, no
  bundler**. `public/js/app.js` is ~7,400 lines. `public/index.html` ~1,350 lines. `public/css/app.css`
  ~2,200 lines. Charts are **hand-drawn on `<canvas>`** (no chart library).
- **Backend:** Vercel **serverless functions** in `api/` (Node, ESM). Business logic lives in
  `lib/*.js` (~130 modules, mostly 40–500 lines each).
- **Dependencies (entire `package.json`):** only `@anthropic-ai/sdk` and `@vercel/blob`. Everything
  else is hand-rolled or raw `fetch`.
- **Storage:** **Vercel Blob** (key-value JSON files, e.g. `picks/<date>.json`, `apex/<date>.json`,
  `ghost/<date>.json`). No SQL database.
- **LLM:** Anthropic Claude models — `claude-fable-5` (fast parametric calls, `maxRetries:0`,
  tool-forced, bounded single call), Haiku (for web-search-backed reasoning under 60s wall clock).
- **CRITICAL CONSTRAINT — Vercel Hobby plan caps at 12 Serverless Functions.** This shapes the
  entire architecture: there are only **11 `api/*.js` entry files**, and *dozens* of logical
  endpoints are multiplexed through them via an `?op=<name>` query param that dispatches into
  `lib/*-routes.js` modules. (e.g. `api/tracker.js` alone handles ~100 ops.)
- **Cron constraint — Hobby caps crons at once/day.** A single daily cron `/api/warm` (13:00 UTC)
  warms caches AND triggers all the daily logging/snapshot ops in sequence, under a 60s
  `maxDuration` budget (late ops risk being skipped if it runs long).
- **Data feeds:** Yahoo Finance (candles `/v8/chart`, option chains `/v7/options` w/ cookie+crumb
  handshake), Finnhub (fundamentals, insiders), FMP Starter ($22/mo paid — earnings), SEC EDGAR
  (Form 4 insiders, via an external box), StockTwits (trending/social), plus an external Python
  collector for X/social alerts.

---

## 3. Architecture & routing pattern

```
Browser (vanilla JS, ES modules)
  └─ public/js/app.js  (nav hub: TAB_GROUPS → subtabs; lazy-loads each tab via ensure*() hooks)
        │ fetch()
        ▼
api/<entry>.js   (11 functions — the 12-function budget)
  ├─ dispatches on ?op=<name>
  └─ delegates to lib/<feature>-routes.js  (23 route modules)
        └─ calls lib/<feature>.js  (pure logic + data fetch)
              └─ Vercel Blob (lib/store.js: readJSON/writeJSON, readAll*, write*Day)
              └─ Anthropic SDK (Claude/Fable reasoning)
```

**Key patterns:**
- **Feature = a triplet:** `lib/<x>.js` (logic) + `lib/<x>-routes.js` (HTTP dispatch) + a tab in
  `app.js`. Most screeners follow this.
- **Scoreboard / pick-tracking:** every screener logs its picks daily to Blob; `api/tracker.js`
  (`op=scoreboard`) computes realized 1w/1m/3m forward returns + win rate + expectancy per
  section/tier with first-appearance dedup. This is the app's "falsifiability" backbone — every new
  screener ships as a *falsifiable class* benchmarked vs its sector/SPY.
- **LLM layering ("both, gated"):** mechanical signal first; an LLM (Fable/Haiku) re-reads and can
  correct/annotate; the LLM version is A/B-tracked and only auto-promoted after N resolved picks
  clear a Wilson-lower-bound gate. Used for social alerts, options flow, dual-read narratives, etc.
- **Duplicated scoring hazard:** a few scorers (e.g. Apex) exist in BOTH `lib/apex.js` (server) and
  inline in `index.html` (client) and must be kept in sync manually — a known smell.

---

## 4. Directory structure (core)

```
api/          11 serverless entrypoints (backtest, momentum, news, options, picks,
              price, screener, sectors, tracker, warm, chart)
lib/          ~130 logic + *-routes modules. Biggest: screener-routes.js (2600),
              apex-routes.js (1400), store.js (900), screener.js (558), signal.js (461)
public/
  index.html  (1350)   nav shell + some inline scoring
  css/app.css (2200)
  js/app.js   (7400)   ← the monolith: nav, rendering, most tab logic
  js/*.js      opportunities, quickhit, leaderboard, ticker-lookup, command-palette,
               live-price, flow-badge, themes, format ...
research/     ~45 standalone backtest/experiment scripts (Node + Python) + markdown writeups
test/         node --test files (suite ~390 tests)
*.md          ROADMAP, PICK-TRACKING, HOW-TO-USE, CORE-MOMENTUM (design/status docs)
scratch-*.js  ad-hoc throwaway experiment files in repo root (clutter)
```

---

## 5. Feature inventory

**Top-nav tab groups:** 🏠 Home · ⚡ Quick Hit · 🔎 Screeners · 📊 Markets · 🔮 Predict ·
🔬 Research · 🏆 Track — each expands to sub-tabs.

**Screeners / detectors (each with its own Scoreboard class):**
- Apex Runner (regime-adaptive 4-pillar breakout model, walk-forward re-optimization, drift detection)
- 👻 Ghost Accumulation Index (6-pillar quiet pre-breakout accumulation, insider/EDGAR + earnings feeds)
- 🚀 Gap & Go (unscheduled ≥5% gap-up + opening-range-breakout continuation) — the one deflation-surviving event edge
- Day Trade screener (rel-strength ranked, entry-timing grade)
- ⚡ Coil Radar (volatility compression → abnormal-move prediction)
- 🪁 Down-Day Mode (red-tape router: reversion longs + overheated shorts + honest sit-out)
- 🕵️ Stealth (no-news volume movers, AI-classified Accumulation/Explained/Noise)
- 🔗 Read-Through (second-order "who benefits and hasn't moved yet")
- 🧬 Biotech Radar, 🔮 Predict, 📡 Market Pulse (social distillation), Options/Unusual-Flow,
  Trade Alerts (social/X), Second Wave, Cross-Asset, Tone Shift, WHY NOW (per-ticker composition), and more.
- Dual-Horizon read (short-term × long-term rating on every ticker + Fable narrative + quadrant Scoreboard)

**Cross-cutting:** live-price ticker, command palette, entry-timing grade (🟢1-10), portfolio/sizing
panel, self-tuning feedback loops (Wilson-bounded per-class track record → auto feature/demote).

---

## 6. Honest research findings (already settled — do not re-suggest these as "edges")

Multi-session empirical backtesting concluded:
- **No durable, regime-robust, statistically-significant standalone alpha** was found in any tested
  direction on the available data.
- Breakout screen profit factor < 1 over the trailing year (structure stops were the leak).
- Only **momentum factors** carry weak edge (rank-IC ~0.10); volume-surge, base/VCP contraction,
  volume dry-up are **DEAD** (IC ~0) despite being classic screen gates.
- Exits: "hold, don't stop" beats tight stops but is regime timing, not standalone edge.
- Market-neutral long/short: spread insignificant (t≈0.5).
- PEAD (post-earnings drift): promising in one risk-on window, **died out-of-sample** (reversal, not drift).
- Insider (EDGAR): real positive signal in small-caps but **redundant** with momentum (confirmation flag only).
- Earnings/fundamentals (BONUS pillar): the **one feed that adds incremental large-cap edge** (IC +0.118, additive).
- **The one defensible lever is regime avoidance** (don't go long in macro risk-off; VIX+credit macro layer quantifies it).

The app is honest about all of this in-UI. Treat it as a **dashboard**, and focus improvement
suggestions on engineering/product/UX quality, not on inventing new alpha.

---

## 7. Known smells / tech debt (candidates you might expand on)

- `public/js/app.js` is a **7,400-line monolith** with no module boundaries beyond a few extracted files.
- `lib/screener-routes.js` (2,600) and `lib/apex-routes.js` (1,400) are very large route files.
- **Duplicated scoring logic** (server `lib/*.js` vs inline in `index.html`) kept in sync by hand.
- ~20+ `scratch-*.js` throwaway files committed in the repo root.
- **No automated frontend tests** (tests are backend `node --test` only); no CI mentioned.
- The `?op=` multiplexing (100 ops through 11 functions) is a workaround for the 12-function cap —
  hurts discoverability, cold-start isolation, and per-endpoint config.
- Single daily cron doing many heavy ops under one 60s budget → late ops can silently skip.
- Blob read-modify-write **races** have bitten before (fixed with cache-busting reads + sharded writes) —
  worth a systematic audit.
- No real database — everything is JSON blobs, which limits querying and grows unboundedly.
- Manual `vercel --prod` deploy (git push does NOT auto-deploy this project).

---

## 8. What I'd like from you

1. The **top 5–10 highest-leverage improvements**, ranked, with rationale.
2. How you'd **refactor the `app.js` monolith** without adding a build step (or whether adding one is worth it).
3. Whether the **12-function `?op=` workaround** should be re-architected (e.g. upgrade plan vs. a single
   router function vs. edge functions) and the tradeoffs.
4. **Reliability/data-quality** improvements for the free/paid feed mix (Yahoo crumb fragility, rate limits,
   the daily-cron bottleneck).
5. **Testing strategy** to get meaningful coverage on a no-build vanilla-JS frontend.
6. Anything about **cost, security, or observability** that stands out.

Ask me to paste any specific file (I'll tell you it's large) before making claims that depend on
seeing the implementation.
```
