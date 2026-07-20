# Point-in-Time Security Master (2026-07)

Every verdict in the NSL incremental-value series (#3–#6) carried the same caveat: **survivorship
unsafe** — the universes were current survivors, so names that were tradeable during the test window
but have since delisted were silently absent. `research/04` measured what that costs in raw returns
(a naive small-cap backtest overstates forward returns by ~**+0.4%/21d, +1.1%/63d**, Shumway-adjusted).
This builds the mechanism that lets a backtest actually **include** those names: a point-in-time
security master over a survivorship-complete universe.

## What it is

`research/lib/secmaster.js` (`pit-secmaster-v1`) turns the research rig's survivorship-complete FMP
cache — ~10k US symbols whose daily price + quarterly income FMP **retains to the last trading day**,
including delisted names like SIVB and FRC — into:

- a per-symbol **listing record** — `{ firstDate, lastDate, delisted, delistDate, nBars, sector }`,
- `universeAt(asOf)` — the cross-section that was actually tradeable **then**: a name is included from
  its first bar up to the day it stopped trading, and excluded after. Optional PIT cap-band + liquidity
  filter (close × report-lagged shares, trailing-20d ADV), identical to the panel in `research/03`.
- `candlesFor(sym)` — the delisted-inclusive price history adapted to the ascending OHLCV shape the
  NSL harnesses already consume, so an experiment can draw a **survivorship-free** universe directly.

The pure core (`buildRecord` / `memberAsOf` / `universeFrom` / `candlesFor`) is unit-tested
(`test/secmaster-pit.test.js`) — the load-bearing invariant is that a delisted name is a member
**before** its last bar and absent **after**.

## Why this, and not the app's `lib/security-master.js`

The app already ships a clean PIT interface (`secmaster-v1`), but it is populated only from ~55
Wikipedia-scraped S&P-500 removals plus the pick ledger, so it declares `survivorshipSafe = false` by
construction and cannot supply price history for the delisted names it names. This research-side
master is the real, survivorship-complete population (2,573 delisted names with full retained history),
built entirely offline from the cache — no live-app coupling, nothing deployed.

## Coverage (built from 10,096 cached symbols)

| | count |
|---|---|
| symbols with usable history | 9,985 (111 skipped, no price) |
| active today | 7,412 |
| **delisted** (last bar < 2026-04-01) | **2,573** |

Delisted by year: 2021 · 147 · 2022 · 385 · 2023 · 649 · 2024 · 465 · 2025 · 724 · 2026 · 203.

## The survivorship hole this exposes

For each past as-of date, how many names were listed **then** but are delisted **now** — exactly the
rows a present-day universe silently drops:

| As of | Listed then | Since delisted | Hidden by a survivor-only list |
|---|---|---|---|
| 2022-06-30 | 8,101 | 2,048 | **25.3%** |
| 2023-06-30 | 7,812 | 1,556 | 19.9% |
| 2024-06-30 | 7,584 | 1,087 | 14.3% |

A quarter of the mid-2022 universe is invisible to a naive backtest. That is the bias, made concrete.

## It works — delisted-inclusive membership

Verified end-to-end in `research/50-secmaster-build.js`:

- **FRC** (First Republic): listed 2021-06-25 → 2023-05-23. In-band member at 2023-03-24
  ($2.26B cap, post-crash) — **included while it traded** — and correctly **dropped** by 2024.
- **SIVB** (Silicon Valley Bank): listed 2021-06-28 → 2023-03-09; correctly out of the small/mid band
  before its collapse (it was large-cap), and gone after — the master never resurrects a dead name.

## How to use it

```
node research/50-secmaster-build.js         # build research/data/secmaster.json + validation report
```

```js
const SM = require('./research/lib/secmaster');
const recs = SM.loadRecordsForSyms(candidateSymbols);        // load series once
const universe = SM.universeFrom(recs, Date.parse('2022-06-30'), SM.DEFAULT_BAND);  // survivorship-free
const candles = SM.candlesFor(recs['FRC']);                  // feed any NSL harness
```

## Honest scope / limits

- **Delisting date ≈ last traded bar.** The free feed carries no delisting reason code (merger vs
  bankruptcy vs going-private); a return-based study should still apply a Shumway-style penalty for the
  wipeout cases, as `research/04` does.
- **No CUSIP/FIGI**, so `securityId == symbol` and ticker-reuse (a symbol reassigned to a new company
  after a delisting) is not yet split — a known gap for very long windows.
- **Coverage is the cache**, ~10k symbols across the 2021–2026 FMP pull; older or non-US names are out
  of scope on the free/Starter tier.
- Sector is overlaid from the survivor superset where present, else null (delisted names often lack it).

## What this unblocks

The NSL edge tests can now be re-run **survivorship-free**: draw each decision date's cross-section
from `universeAt` (delisted names included) and feed `candlesFor` to the existing harnesses. That
turns "no edge, but survivorship-caveated" into a verdict that can actually be trusted — the next
step (a survivorship-free re-run of E8 twins vs the survivor-only #5 result) consumes exactly this.

_Built by research/50-secmaster-build.js from research/lib/secmaster.js. Offline research — nothing deployed._
