# Challenger Decision System (`challenger-decision-v1`)

A **shadow-only** challenger that composes existing infrastructure into a cross-sectional
residual-return ranker, a competing-risk survival/timing layer, a structured event-surprise
engine, and one four-outcome decision function (**TRADE / WAIT / AVOID / NO_TRADE**).

It **never** alters production ranks, recommendations, allocation, or governance weight. It is
registered through the existing maturity/governance machinery with status `paper`
(deployment weight `0`) and is promotable only after strict OOS + live-forward validation.

Shipped: merged to `main`, deployed to prod, and shadow-verified (read + write paths).

## What already existed vs. what this added

~70% is reuse. The new work is the composition layer only.

| Capability | Reused | Added by this system |
|---|---|---|
| PIT forward return / cross-sectional excess vs SPY & sector | `evolve-labels.labelEvent`, `sliceForward`, `benchmarkReturn` | — |
| Triple-barrier target/stop/timeout | `evolve-labels.tripleBarrier` | — |
| Empirical-Bayes shrinkage | `evolve.pooledRate` | Hierarchical **competing-risk** table (horizon→family→regime→cap→stage→event) |
| Cross-sectional ranker | `decision.rankSignals`, `evolve.scoreCandidate` | **Residual-return** percentile ranker (`challenger-rank-v1`) |
| Failure probability | `failure-model.assessSignal` (`shadow:true`) | — |
| Remaining edge / execution / costs | `remaining-edge`, `execution-policy`, `costs` | — |
| Regime PIT | `evolve-regime.buildRegimeVector`, `macro.js` | — |
| Board-level no-trade / density | `opportunity-density` | Wired as the NO_TRADE cause |
| Event awareness | `decision-normalizers.classifyEarnings`, news/tone/options/insider feeds | **Strict structured event-surprise schema + score** (`event-surprise-v1`) |
| Four-outcome decision | *none* | **TRADE/WAIT/AVOID/NO_TRADE** (`challenger-decision-v1`), WAIT trigger/invalidation/expiry |
| Validation | `evolve-walkforward`, `evolve-dsr`, `evolve-uniqueness`, `rankquality` | Challenger orchestration + baselines + leave-year/leave-winners-out + ridge trained-shadow |
| Maturity / governance | `maturity`, `governance` (`paper` = weight 0) | Registered `challenger-decision`; inherits shadow gating |
| Immutable PIT storage | `immutable-ledger`, `store`, `run-manifest`, `security-master` | `shadow/` daily ledger + `challenger` immutable stream + append-only resolution |

## Files

**Modules** — `lib/challenger-rank.js`, `challenger-survival.js`, `challenger-events.js`,
`challenger-decision.js`, `challenger-eval.js`, `decision-sources.js`, `challenger-routes.js`.
**Tests** — `test/challenger-core.test.js`, `test/challenger-integration.test.js`.
**Touched (additive)** — `lib/store.js` (shadow ledger), `lib/strategy-registry.js`
(`challenger-decision`, core:false), `api/tracker.js` (dispatch + privileged/expensive sets),
`lib/warm-chains.js` (log in `reprime`, resolve in `ticks3`), `public/js/today.js` +
`public/css/app.css` (action-first section).

## Architecture / data flow

`op=challenger` → `decision-sources.gatherRankedSignals` self-fetches the same cached
endpoints op=today uses → `rankSignals` → `challenger-decision.decideBoard`: enrich each
signal with failure + event surprise → cross-sectional residual rank → competing-risk
survival → four-outcome gate. Survival history comes from this challenger's **own** resolved
barrier outcomes (`shadow/resolved.json`), so at cold start the table is empty ⇒ zero TRADE ⇒
board NO_TRADE — by design, not a stall.

## Endpoints

- `op=challenger` — public cached read; the four-outcome board.
- `op=challengerlog` — privileged (cron); logs TRADE+WAIT **point-in-time** to
  `shadow/<date>.json` and appends the hash-chained `challenger` immutable ledger (with deploy SHA).
- `op=challengerresolve` — privileged (cron); appends triple-barrier forward outcomes
  (SPY-excess net of costs) to matured predictions; append-only, never overwrites.
- `op=challengereval` — expensive; walk-forward validation + promotion check (cached).

## Shadow guarantees

- Returns a **new** structure; never mutates inputs or production payloads.
- Governs to `paper` ⇒ `weightFor == 0`; TRADE cards labeled "shadow — zero deployment weight".
- Predictions logged **before** outcome; outcomes **appended**, never overwritten.
- Zero TRADE when evidence is insufficient; missing data flagged, never fabricated.

## Validation & promotion

`op=challengereval` runs rank-IC, purged+embargoed walk-forward, net expectancy with bootstrap
CI, Brier calibration, tier monotonicity, regime/cap/event splits, leave-best-year-out,
leave-largest-winners-out, deflated Sharpe, a ridge trained-shadow compared OOS to the
interpretable baseline, and baselines (production/OMEGA/momentum/random). `promotionCheck`
reports 10 strict criteria (incl. positive live-forward), never auto-promotes, and caps its
recommendation at `probation`.

## Known limitations / deferrals

- Residual is **SPY-excess net of estimated costs**; sector-residual is wired in `labelEvent`
  but not yet in resolution.
- EOD data ⇒ next-session positioning only (labeled `eod-next-session`); no intraday precision.
- Event surprise uses mechanical proxies (flagged `degraded`) until a real
  earnings-surprise/analyst-revision feed is connected; the LLM path is isolated and not
  exercised by the offline suite.
</content>
