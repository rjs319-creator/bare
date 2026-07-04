# Roadmap

Tracks the major upgrades to the market-intelligence app: what shipped, the honest
state of each, and what could come next. Every signal here follows the same rule —
**ship it as a standalone, Scoreboard-tracked overlay first; only wire it into the core
score once the track record proves it beats the market.**

---

## Shipped

### 1. Historical baseline archive — beat-the-market Scoreboard ✅

Every logged pick is now measured **against the S&P 500** over the same window, so the
Scoreboard answers "did it beat the market?" not just "did it go up?".

| Piece | File | Role |
|---|---|---|
| Benchmark + excess | `lib/apex-routes.js` | `spyForwardReturn()`; `summarizeReturns()` reports `avgExcess` + `beatMktRate` per horizon |
| Horizons | `lib/apex-routes.js` | `HORIZONS` = 1 / 5 / 10 / 20 day (+ 1m / 3m) |
| S&P anchor | `lib/store.js` | `writeDay(date, picks, sp500)` stamps the SPY close on each daily file |
| UI | `public/js/app.js`, `public/css/app.css` | "vs S&P +X% · beat Y%" line per horizon cell |

Note: `sp500` is the SPY ETF close (~$744), whose **percentage** moves match the index —
correct for excess-return math.

### 2. Decay curves per CERN event type ✅

For each of the 7 CERN forced-flow event types, the excess-vs-S&P return is tracked at
each day 1→20, averaged, and drawn as a curve with a **recommended holding window**
(the peak of the initial positive stretch — an isolated good day in an underwater curve
is *not* a window).

| Piece | File | Role |
|---|---|---|
| Calculator | `lib/cern-decay.js` | `computeDecayCurves()` (pure, unit-tested) |
| Endpoint | `lib/apex-routes.js` → `op=cerndecay` | reads the CERN archive, fetches SPY, builds curves |
| UI | `public/js/app.js` (Events tab) | inline-SVG decay chart + hold-window chip per type + trust gate |

Trust gate: a window firms up only after ~20 events of that type have aged the full 20
days. On live data, LOCKUP_EXPIRY reads **"no edge (fades)"** (matches its known bleed).

### 3. Earnings-call tone scorer ✅

For a screener-filtered stock that recently reported, Claude (Haiku) scores management's
call tone **−10…+10** with a one-sentence reason. Surfaced as a 🎙 chip + a Scoreboard
"Earnings-Call Tone" section (Bullish / Neutral / Bearish).

| Piece | File | Role |
|---|---|---|
| Engine | `lib/earnings-tone.js` | tone tool, bucketing, recency gate, web-search scorer |
| Routes | `lib/tone-routes.js` → `op=tonetick` / `op=tone` | score + log; read for chips |
| Cache | `lib/store.js` | `tone/cache/<sym>-<date>.json` — a call is scored once |

**Data note:** the FMP plan does **not** include transcripts (402/403). So Claude
**web-searches** each call's coverage instead (same pattern as Market Pulse), gated by the
FMP `stable/earnings` date (which does work on the plan). Not CERN-wired — CERN has no
earnings event type.

### 4. Fast-vs-sticky attention split ✅

Splits the archived StockTwits mention signal into **Sticky** (sustained interest over
many days → tends to keep drifting) vs **Fast** (a short hype spike → tends to reverse),
using a presence-first rule (robust to thin per-name history).

| Piece | File | Role |
|---|---|---|
| Classifier | `lib/attention.js` | `classifyAttention()` (pure, unit-tested) |
| Routes | `lib/attention-routes.js` → `op=attention` / `op=attentiontick` | chips + Scoreboard ledger |
| UI | `public/js/app.js` | 📈 Sticky / ⚡ Fast chips + Scoreboard "Attention" section |

### 5. Novice hover explanations ✅

Plain-English `title` tooltips (with a subtle ⓘ cue where useful) across the app:
Scoreboard sections + horizon columns + decay chart, every sub-tab button, Screener
criteria chips, and the Custom/Ghost scoring pillars. `public/js/app.js` +
`public/css/app.css` only.

---

## Honest state

- **Truth-telling by design.** Steps 1–4 are measurement tools. Given the app's own
  research (no durable edge found; social sentiment weak/contrarian), expect the
  Scoreboard to reveal that several signals **don't** beat the market. That is the tool
  working, not a bug.
- **Some sections fill on their own schedule:** decay curves need weeks of resolved
  events; tone fills at the next earnings season; attention is live now but its
  day-over-day precision sharpens as the archive grows.

## Verification

- **Server / data side** (Claude, FMP, Blob keys can't run locally): deploy to prod, then
  `curl` the `op=` endpoints.
- **Browser UI**: Playwright headless against the live site asserts the rendered DOM
  (tooltips, chips, sections). All checks currently pass.
- **Unit tests**: `npm test` — pure logic for every new module.

## Possible next steps

- **Promote proven overlays into scoring.** Once the Scoreboard shows a signal (tone,
  attention-sticky, a CERN type) genuinely beats the market with enough sample, add it as
  a bounded input to the relevant score.
- **Richer transcripts** for tone if a transcript feed is ever added (engine already
  supports a verbatim path in `lib/earnings-tone.js`).
- **Deeper attention history** to move from presence-first to full trend-shape
  classification as the daily archive matures.
