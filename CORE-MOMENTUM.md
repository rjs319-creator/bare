# Core Momentum — survivorship-safe small/mid sector-neutral 12-1 sleeve

A research-validated momentum screener wired into the app's existing ledger + drift
machinery. It is the deployable output of the `research/` investigation (steps 14–21;
`research/momentum_score.py` is the Python reference, this is the JS port).

## The strategy (do not tune without out-of-sample evidence)

- **Universe:** US common stock, market cap **$800M–$5B**, ADV ≥ $3M, **excluding Healthcare**
  (biotech moves on binary FDA/trial events, not trend persistence — it was the worst major
  sector in research).
- **Filter:** drop the **top realized-volatility tercile** (high-vol momentum is crash-prone
  and doesn't persist).
- **Signal:** **sector-neutral 12-1 momentum** — the 12-month return skipping the most recent
  month, minus the within-sector median (the universe is finance-heavy, so raw momentum makes
  large uncompensated sector bets).
- **Selection:** equal-weight the **top quintile** with a **rank buffer** (enter on top 20% by
  score, hold until a name drops out of the top 40% — cuts turnover/whipsaw).
- **Rebalance:** **quarterly** (monthly over-trades a slow signal). ~63-session time hold;
  levels are intentionally **wide** because research showed tight stops bleed momentum names.

### Honest expectation
In-sample IR was 1.5–1.8, but the filters were chosen on the same ~5-year sample, so that is
optimistic. **Realistic forward IR ≈ 0.8–1.2.** This is a concentrated *sleeve*, not a
replacement for broad exposure, and it carries the usual single-regime-history caveat. The
drift badge + kill-switch exist precisely to catch decay live.

## Why a forward screener can ignore survivorship bias
Survivorship bias only distorts *backtests* (already handled in `research/`). A forward
screener that screens today's universe and tracks the real outcomes of the names it actually
picks is unaffected — which is why this uses FMP's current `company-screener` snapshot rather
than the PIT-shares reconstruction the backtest needed.

## Architecture (mirrors the Apex ledger/drift pattern; stays within the 12-function Hobby cap)

| Piece | File | Role |
|---|---|---|
| Engine (SSOT) | `lib/stablecore.js` | FMP universe + features + `buildBook` + trade levels |
| Route handlers | `lib/stablecore-routes.js` | the four `op=` handlers below |
| Storage | `lib/store.js` | `core/` ledger (`writeCoreDay`/`readAllCore`) + feature/resolved/book caches |
| Dispatch | `api/tracker.js` | routes `op=core*` (no new Serverless Function) |
| Cron | `api/warm.js` | daily: `corebuild` → `corelog` → `coredrift` |
| UI | `public/index.html`, `public/js/app.js` | 📈 **Core Momentum** subtab (book + health badge + kill-switch) |
| Tests | `test/stablecore.test.js` | unit tests for the pure engine functions |

### Ops (all behind `/api/tracker`)
| Op | What it does |
|---|---|
| `?op=corebuild` | Resumable, chunked refresh of the universe + per-name feature cache (250/run, ~4 runs to fully seed; then continuous). |
| `?op=core` | Compute & serve today's ranked book (what the tab reads). |
| `?op=corelog` | Log the book to the ledger — **self-gated to the quarterly rebalance window** (first half of Jan/Apr/Jul/Oct), once per quarter. `&force=1` overrides. |
| `?op=coredrift` | Resolve outcomes (`outcome.js` + daily history), report live win-rate / profit-factor / mean-return with a Wilson interval, health status, and the kill-switch vs the research baseline. |

## Deployment

### Prerequisites (env — both already used elsewhere in the app)
- `FMP_API_KEY` — FMP Starter key (universe + price history).
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob store (auto-injected once a Blob store exists).

### Steps
1. **Deploy:** `vercel --prod --yes` (no new function; `api/tracker.js` gains the ops).
2. **Seed the cache** (optional — the cron does it automatically over a few days):
   ```
   curl 'https://<host>/api/tracker?op=corebuild'      # repeat ~4× to cover the full universe
   curl 'https://<host>/api/tracker?op=core'           # confirm a book appears
   ```
3. **First ledger entry:** `op=corelog` logs automatically in the next rebalance window
   (Jan/Apr/Jul/Oct). To seed one immediately for testing: `?op=corelog&force=1`.
4. **Track record** matures over ~3 months as `op=coredrift` resolves each quarter's picks.

### What you'll see while it warms up
- **Before the cache is seeded:** the tab shows "Building the universe feature cache — N names cached so far."
- **Before ≥15 signals resolve:** the health badge reads "Track record: building."
- This is by design — the cadence is quarterly, so the live edge confirms slowly.

## Monitoring / kill-switch
The health badge classifies live performance vs the research baseline (win ≈ 0.62, PF ≈ 1.4):
**HEALTHY** / **DEGRADING** (reduce size) / **BROKEN** (informational only). A negative live
mean-return trips the **kill-switch** banner — revert to passive small/mid exposure until it
recovers. Re-confirm the edge after ~8 live quarters before sizing up.
