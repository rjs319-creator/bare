# Decision-Quality Gaps — Closed (branch `feat/decision-quality-gaps-v2`)

Response to the re-issued "5 improvements" review. Method: audited the live architecture
against every sub-bullet (the review is ~85–90% already shipped — `lib/decision.js`,
`op=today`, `governance.js`, `maturity.js`, WHY NOW), then **closed the genuine gaps** the
audit found rather than rebuilding working features. All work is additive; no rewrites.

## What changed, by improvement

### #1 Today dashboard
- **Single top-5–10 shortlist** now rendered (`p.top`, widened 8→10) as a "Top Plays" grid —
  previously computed server-side but ignored by the renderer.
- **Per-stock holding period** — `HOLD_WINDOW` per horizon in `decision.js`, on every card.
- **`resolved` lane** rendered in "Since yesterday" (was computed, never shown).
- **Related-workspace strip** links Quick Hit / Opportunities / Edge Book / Game Plan as
  drill-downs (consolidation, not competing landing pages).
- **Today is the true default landing** — first-time visitors now land on the command center
  (`app.js`: `return 'home'`), with the 📘 Guide beside it in the home sub-nav.

### #2 Strategy families
- Five named archetypes (**Trend continuation / Early momentum / Event-driven / Intraday /
  Context**) in `decision.js` (`STRATEGY_FAMILIES`, `STRATEGY_FAMILY_META`, `STRATEGY_FAMILY`,
  `familyForSource`). Every signal is stamped; merged names roll up the distinct families they
  span. Family chip on each Today card; contributing models stay visible via the evidence line.
- The pre-existing correlation-discount (`CORR_DISCOUNT`) and 8-domain breadth are untouched —
  the new families are a **product grouping layered on top**, not a replacement for the honest
  independence math.

### #3 Evidence-based card metrics
- `expectancyFor` now passes through **mean, median, 90% CI** (the Scoreboard already computed
  them). Today's track line shows success-rate · mean-vs-market · median · sample **separately**,
  plus a **CI chip** and a **model-version chip**; honest "insufficient data" empty state.
- Opportunities / Quick Hit cards gained an evidence line (`oppTrack`) with the setup class's
  realized win/avg/n, and an explicit insufficient-data state below the 8-pick floor.

### #4 Scoreboard governance
- **Per-sector performance split** (`bySector`, GICS via `SECTOR_OF`, ≥5-pick floor).
- **Results excluding the largest winners** (`avgExTopWinners` / `exTopN`) — drops the top ~10%
  winners to expose lottery-winner concentration; shown on each card.
- **Calibration curve** finally drawn (predicted-vs-actual win rate per score band) — the binned
  table was computed but only the Brier scalar was rendered.

### #5 Ticker detail page
- Chart canvas now overlays the **trade plan**: entry/breakout, stop (invalidation), target as
  dashed level lines (kept inside the visible price range) + legend; **ATR** surfaced in the
  levels box (was computed, never shown); **event-marker capability** wired (renders only when
  the payload carries real event dates — no fabrication).
- WHY NOW block shows the **track-record data-as-of timestamp + model version**.

## Tests added (all `node:test`, per the chosen no-new-infra path)
- `test/decision.test.js` — hold window per horizon; median/CI passthrough + null-degrade;
  strategy-family mapping, safe default, merge span roll-up.
- `test/decision-routes.test.js` — top shortlist cap(10)+rank-order; resolved lane present; hold window on top.
- `test/scoreboard.test.js` — exclude-largest-winners concentration + sub-floor no-op.
- `test/render-guard.test.js` — new Today fields present + render-clean (no NaN/undefined/template leak); CI/median scanned.
- Full suite: **731 pass / 0 fail**.

## Files requiring manual review / follow-up
1. **Chart event markers** are wired but no source feeds `data.events` yet — earnings dates
   aren't in the chart data path. To light up markers, `api/price.js` (or the chart data
   assembly) must include event dates. Until then the capability is dormant (honest, not broken).
2. **Deeper WHY NOW joins NOT done** (documented, larger backend efforts): liquidity/spread/
   dilution/sector-exposure fields, historical-analog performance with CIs, and a per-ticker
   **signal-history / score-change timeline** all need new data plumbing (`whynow-routes.js`
   + a per-ticker history store). These remain gaps.
3. **Evidence-status vocabulary** deliberately kept as the app's calibrated maturity grades
   (Validated/Promising/…) rather than the spec's literal Experimental/In-sample/Walk-forward/
   Live-forward/Production — a product decision to avoid discarding real resolved-sample thresholds.
4. **"Since yesterday" lanes** (incl. the new resolved lane) require the warm cron to have
   written a prior `op=today&log=1` snapshot; empty on day 1 by design.
5. **No Playwright** — per the chosen approach, E2E coverage extends the existing data-level
   render-integrity guards instead (the app is vanilla-JS/no-build; a browser harness was
   deferred). A future Playwright pass over Today load / drill-down / WHY NOW / Scoreboard
   remains a reasonable follow-up.
