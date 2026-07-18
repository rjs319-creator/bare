# Challenger Decision System (`challenger-decision-v1`) — Plan & Gap Analysis

A **shadow-only** challenger that composes existing infrastructure into a cross-sectional
residual-return ranker, a competing-risk survival/timing layer, a structured event-surprise
engine, and one four-outcome decision function (TRADE / WAIT / AVOID / NO_TRADE).

It **never** alters production ranks, recommendations, allocation, or governance weight.
It is registered through the existing maturity/governance machinery with status `paper`
(deployment weight `0`) and is promotable only after strict OOS + live-forward validation.

## Gap analysis (inspected the full repo first)

| Requested capability | Already exists (reuse) | Genuinely new (build) |
|---|---|---|
| PIT forward return / cross-sectional excess vs SPY & sector | `evolve-labels.labelEvent` (`spyRelReturn`,`sectorRelReturn`), `sliceForward` (strictly-after guard), `benchmarkReturn` | — |
| Triple-barrier target/stop/timeout | `evolve-labels.tripleBarrier` (conservative same-bar=loss, pending vs timeout) | — |
| Empirical-Bayes shrinkage | `evolve.pooledRate` | Hierarchical **competing-risk** table over horizon→family→regime→cap→stage→event |
| Cross-sectional ranker | `decision.rankSignals` (multiplicative composite), `evolve.scoreCandidate` (P of barrier hit) | **Residual-return** cross-sectional percentile ranker with the required output schema |
| Failure probability | `failure-model.assessSignal` (`shadow:true`) | — |
| Remaining edge | `remaining-edge.computeRemainingEdge` + origins | — |
| Execution / next-open+slippage | `execution-policy.planFill`, `costs.roundTripCostPct` | — |
| Regime PIT | `evolve-regime.buildRegimeVector`, `macro.js` | — |
| Board-level no-trade / density | `opportunity-density.computeOpportunityDensity` (`no-trade` cause+reasons) | Wire as the NO_TRADE cause |
| Event awareness | `decision-normalizers.classifyEarnings`, news/tone/options/insider feeds | **Strict structured event-surprise schema + normalized score** (`event-surprise-v1`) |
| Four-outcome decision | *none* — closest are EVOLVE `TRADE_CANDIDATE/WATCH/PROBE/ABSTAIN` and density `normal/…/no-trade` | **TRADE/WAIT/AVOID/NO_TRADE** canonical function with WAIT trigger/invalidation/expiry |
| Validation harness | `evolve-walkforward` (purged+embargoed), `evolve-dsr` (deflated Sharpe), `evolve-uniqueness`, `rankquality` (IC/Brier/monotonicity/verdict) | Challenger-specific orchestration + baselines + leave-year/leave-winners-out + ridge trained-shadow |
| Maturity / governance | `maturity.gradeStrategy`, `governance.governStrategy` (`paper` status = weight 0) | Register `challenger-decision`; it inherits shadow gating for free |
| Immutable PIT storage | `immutable-ledger.append` (hash-chained, write-once), `store.readJSON/writeJSON`, daily-ledger + `resolved` map patterns, `run-manifest`, `security-master` | New `shadow/` daily ledger + `challenger` immutable stream + append-only resolution |

**Net:** ~70% is reuse. The genuinely new work is (1) the residual-return cross-sectional ranker,
(2) the competing-risk survival/timing layer, (3) the structured event-surprise engine,
(4) the four-outcome decision composition, (5) a thin challenger eval/promotion orchestration,
(6) shadow storage + routes + an action-first UI section — all additive, none replacing production.

## New files
- `lib/challenger-rank.js` — `challenger-rank-v1` residual-return cross-sectional ranker (pure).
- `lib/challenger-survival.js` — `challenger-survival-v1` competing-risk timing (pure).
- `lib/challenger-events.js` — `event-surprise-v1` structured event schema + score (pure; optional LLM w/ fallback).
- `lib/challenger-decision.js` — `challenger-decision-v1` four-outcome composition (pure).
- `lib/challenger-eval.js` — `challenger-eval-v1` validation + promotion check (pure over resolved events).
- `lib/decision-sources.js` — `gatherRankedSignals(fetchImpl)` independent source gather+rank (testable, injected fetch).
- `lib/challenger-routes.js` — `op=challenger` (read), `op=challengerlog` (privileged PIT log), `op=challengereval` (expensive), `op=challengerresolve` (privileged).
- `test/challenger-*.test.js` — unit + integration.

## Modified (additive only)
- `lib/store.js` — `shadow/` daily ledger helpers + shadow resolved map.
- `lib/strategy-registry.js` — register `challenger-decision` (core:false → Research Lab / paper until validated).
- `api/tracker.js` — dispatch the four new ops (privileged/expensive sets).
- `lib/warm-chains.js` — best-effort `op=challengerlog` tick after the board is scored.
- `public/js/today.js` — action-first shadow section (guarded; renders `''` on old payload).

## Shadow guarantees
- `challenger-decision.js` returns a **new** structure; it never mutates input signals or production payloads.
- Governance status `paper` ⇒ `weightFor==0`; TRADE cards are labeled "shadow — zero deployment weight".
- Predictions are logged **point-in-time before outcome**; outcomes are **appended**, never overwritten.
- Zero TRADE when evidence is insufficient; missing data is flagged, never fabricated.
</content>
</invoke>
