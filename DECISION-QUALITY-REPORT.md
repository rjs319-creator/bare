# Final Report — Precise Decision-Quality Improvements

Ten commits on `main` (`5a76c0a…9575cb9`), **28 files changed (+2,575/−27)**, all deployed to prod
(`market-news-app-chi.vercel.app`) and verified end-to-end. This closes all five *genuine* gaps
from the audit; the other five asks were already built and were **not** rebuilt.

## Capability matrix (repository evidence + acceptance status)

| # | Feature | Status | Where | Acceptance |
|---|---------|--------|-------|-----------|
| 1 | Signal-independence / false-confluence | Pre-existing | `lib/redundancy.js`, `op=redundancy` | (prior work) |
| 2 | **Component laboratory** | ✅ Shipped | `lib/component-lab.js`, `op=complab` | Matched study on 198 real records, 5 components, source-linked |
| 3 | **Remaining-edge ranking** | ✅ Shipped | `lib/remaining-edge.js`, `today/origins.json` | Re-ranks live board; run-up name 62.5→50 (test) |
| 4 | Setup-lifecycle state | Pre-existing | `decision.js lifecycleState` | (prior work) |
| 5 | **Adversarial failure model** | ✅ Shipped (**shadow**) | `lib/failure-model.js`, `op=failuremodel` | Replay over ledger; stays shadow (see §5) |
| 6 | **No-trade / opportunity-density** | ✅ Shipped | `lib/opportunity-density.js` | Decision persisted before outcomes; red-tape day → reduced/33% |
| 7 | **Lead-time / early-detection** | ✅ Shipped | `lib/leadtime.js`, `op=leadtime` | 1,262 picks; "early" requires conversion |
| 8 | Event-time outcomes | Pre-existing | `apex-routes.js resolveTrade` | (prior work) |
| 9 | Model-disagreement | Pre-existing (partial) | `evolve.js` agreement dispersion | (prior work) |
| 10 | Algorithm bidding / specialists | Pre-existing | EVOLVE ensemble | (prior work) |

## 1. Files changed

**10 new pure/route modules:** `remaining-edge.js`, `remaining-edge-origins.js`, `leadtime.js`,
`leadtime-routes.js`, `opportunity-density.js`, `failure-model.js`, `failure-model-eval.js`,
`failure-model-routes.js`, `component-lab.js`, `component-lab-routes.js`.
**Modified:** `decision.js` (remaining-edge composite factor), `decision-routes.js` (origins +
opportunity + failure + tape wiring), `api/tracker.js` (3 new ops), `public/js/today.js` +
`public/js/app.js` + `public/css/app.css` (banners, chips, 4 lazy panels). **10 new test files.**

## 2. Database changes (Vercel Blob)

Two new docs, no migration: `today/origins.json` (immutable remaining-edge origin snapshots),
`today/opportunity-log.json` (rolling 180-day no-trade decisions, written *before* outcomes).
Three cache docs: `apex/leadtime.json`, `apex/failure-model.json`, `apex/component-lab.json`.

## 3. Infrastructure reused

The `op=today` decision engine + multiplicative composite + snapshot/lane-diff cron;
`decision-costs.js`; the Scoreboard's first-appearance ledger dedup + `fetchDailyHistory` +
store readers (lead-time/failure/complab all reuse these); the lazy-panel pattern; `op=tape`
(same-day tape read).

## 4. Formulas & thresholds

- **Remaining-edge:** `mult = clamp(fracLeft × extFactor × decayFactor, 0.15, 1)`; extension
  trims past 0.5R (k 0.35), decay past horizon hold (0.03/bar); floored to 0.15 when net edge ≤ 0.
- **Lead-time:** breakout = first +8% within 63 bars; "early" iff breakout-rate ≥ 0.4 ∧
  early-share ≥ 0.2 ∧ median wait ≤ 21.
- **Opportunity-density:** weighted 0–1 components (bestEdge .24, depth .20, freshness .18,
  track .16, breadth .12, quality .10); gates — risk-off ×0.5/cap 33%, **red tape (SPY ≤ −0.4%)
  ×0.5/cap 33%, choppy (trend-eff < 0.22) ×0.75/cap 66%** — penalties only; decision at 62/45/28.
- **Failure model:** weighted features (earnings .25, extended .20, climax .15, failed-breakouts
  .13, illiquid .12, breadth .11, sector .10, chop .10, track .10, single-factor .08); prob cap
  0.95, size floor 0.25.
- **Component lab:** k-NN (k=5) matched on regime/sector/prior-return/liquidity, caliper 1.5;
  verdict from 95% CI + |t| ≥ 2 + |incr| ≥ 0.5pp.

## 5. Evidence-family mapping

Unchanged — reused the existing 9 `EVIDENCE_FAMILIES` / `SOURCE_FAMILY` map in `decision.js`;
the failure model's `singleFactor` feature reads `evidence.singleFamily`.

## 6. Before/after ranking examples

- **#3:** run-up name (consumed 50%, wide stop) **62.5 → 50.0** vs an identical fresh peer
  (test-proven); prod: origins active, 255 tracked.
- **#6:** red-tape day **normal/88.9/100% → reduced/44.5/33%** live (rawScore 88.9 × 0.5 verified
  on prod).
- **#7 (prod replay):** Ignition genuinely-early (73% conversion); Ghost/coil/DownDay flagged
  **low-conversion**.

## 7–8. Validation sample sizes & confidence intervals

- **#7:** 1,262 first-appearance picks, 800 evaluated, 7 algorithms.
- **#5:** 245 evaluated; approved +8.6% vs rejected 0%; but rejected only *matched* market
  (+0.11% excess) → **stays shadow**.
- **#2:** 198 records; e.g. lower-volatility additive **+4.19% (t 3.9, CI [2.08, 6.29])**,
  clean-structure +9.92% (t 2.29, CI [1.43, 18.41]); confounding correction shown (rising-50
  naive −4.75 → matched −7.72).

## 9. Baseline comparisons

Every new factor is byte-identical when its input is absent (asserted): remaining-edge with no
origins, opportunity with no tape, failure model never enters the composite. The rank changed
only where the new evidence earned it.

## 10. Tests & build

**Suite 1069 passing, 0 failures** (was 996; +73 across 20 new test files), `npm run check`
clean. Two `/verify` passes drove the live app; all 4 Scoreboard panels + Today banners render
with zero console errors.

## 11. Known limitations

- **#5 stays in shadow** — the "predictive" replay is single-regime and the rejected bucket only
  matched (didn't lag) the market, so it never binds. Correct, per the discipline.
- **#3 not yet observable on prod** — origin store <1 day old; demotion needs a date boundary.
- **#2 recommendations all "observe"** — single-regime ledger; verdicts stand but no action
  recommended.
- **#6 tape penalty** assumes a long-dominated board and depends on `op=tape` being up (reverts
  to breadth-only if down, though freshness flags it).

## 12. Highest-EV next improvement

**Extend the opportunity-density freshness input to use real aged origins** once the store
crosses a day boundary — today every name reads fresh, inflating the density. Once origins age,
freshness and remaining-edge will discriminate live, which (a) makes #3's re-ranking visible and
(b) sharpens #6's decision. It requires no new code — just a day of elapsed cron runs — and it's
the single change that unlocks the demonstrated value already built.

---

**No completion percentage claimed, and no alpha claimed without OOS evidence** — the honest
verdict across the arc is that the app remains a momentum/regime dashboard whose one durable lever
is regime avoidance; every new model that couldn't clear regime-robust OOS validation was held in
shadow/observe rather than allowed to bind.

_Commits: `4d33d46` (§3+§7) · `98cbf60`/`d7b5d46` (§6) · `726dc6d`/`1af75cb`/`41e143a` (§5) ·
`d97afd3`/`208054e` (§2) · `9116aa9` (panel race fix) · `d957c04` (§6 tape fix). Deployed via
`vercel --prod`; suite 1069 green._
