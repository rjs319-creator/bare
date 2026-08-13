# Market Intelligence Redesign — Market Pulse · Trade Alerts · Unusual Options

Implements `CLAUDE-CODE-MARKET-INTELLIGENCE-REDESIGN.md`. Every change is **additive and
reversible**: existing routes, storage keys, and payload shapes still work, and each new
layer sits behind either a feature flag or a null-safe field.

---

## 1. Truth and safety (Milestone 1)

### Trade Alerts — the four P0 defects

| # | Defect (before) | Fix (after) | Module |
|---|---|---|---|
| P0-1 | `execRef` was the intended alert-price slot but **nothing on the ingest path ever set it** — every card rendered `priceAtAlert: null`, so "how much of the move is already gone" could not be shown. | Immutable capture at ingest: price **+ provider quote timestamp + market session + source**. No timestamp ⇒ `UNAVAILABLE` (never server time). Once `CAPTURED` it cannot be overwritten. Legacy episodes report `LEGACY_NOT_CAPTURED` and are **never backfilled**. | `lib/alerts-price-at-alert.js` |
| P0-2 | Staleness existed **only** inside `foldEpisodes` (6-day gap ⇒ EXPIRED). Nothing re-checked age between folds, so decision cards showed no age and full actionability. | Freshness assessed on **every decision build**: originating age, corroboration age, decision-price age, horizon-scaled TTL, `expiresAt`, and a visible `ageLabel`. `STALE`/`EXPIRED`/`UNKNOWN` are never actionable. | `lib/alerts-freshness.js` |
| P0-3 | `alerts-score.js:83` awarded **0.7 of the execution weight when liquidity evidence was absent** (`liquidityOk === null` missed the `false` branch), so an unmeasurable name scored like a mega-cap. | Per-component evidence with **no favourable default**. `creditFraction` is capped by `coverage`, so unmeasured evidence cannot be borrowed against. Below the coverage floor ⇒ `UNKNOWN` ⇒ `WAIT`. Borrow is **required** for shorts, `NOT_APPLICABLE` for longs. | `lib/alerts-execution.js` |
| P0-4 | One scalar `regimeFrac` and a `regime.riskOff` WAIT veto applied to **both sides** — a valid short was vetoed by exactly the tape that supports it. | Side-aware market **and** sector alignment (`TAILWIND`/`NEUTRAL`/`HEADWIND`/`UNKNOWN`). Only a headwind *for that side* vetoes. Unavailable regime data is `UNKNOWN` — neither a pass nor a veto. | `lib/alerts-regime.js` |
| P0-5 | The card led with `score`/100 beside an action badge, which reads as a confidence. | Leads with a **research-priority band** (P1–P4 + label). Gate outcomes dominate the component sum. `score` stays in the payload as the auditable tally, with `scoreIsProbability: false` and the disclaimer on the record itself. | `lib/alerts-score.js` |

### Legacy options — quarantined

`lib/optionsflow.js` (v1) is now **raw delayed-chain diagnostics**, not a decision surface:

- `bullishPct` → `callPremiumSharePct`; `net` → `premiumSkew` (`call-dominant`/`put-dominant`/`balanced`). The misleading names are **removed**, not aliased.
- Grade bands `Very Bullish … Very Bearish` → `Heavily call-weighted … Heavily put-weighted`, with `isDirectional: false` and a note on every grade.
- `flowSummary.lean` → `premiumSkew`.
- `sentimentOf` survives **only** as `ledgerSignOf` — the historical `optionsflow/log.json` sign convention, so the accumulated prospective record stays gradeable. It is documented as a ledger sign, never a directional claim, and is excluded from the CSV export.
- `lib/decision-normalizers.js` `mapOptionsFlowRows` no longer keys a trade **side** off call/put dominance; it requires the honest `directionState` (which is usually `UNKNOWN`/`MIXED`, and those produce no signal). The `isTradeEligible('optionsflow')` shadow gate is unchanged.
- UI: quarantine banner, no ▲/▼ direction arrows, contract-type badges (`CALL`/`PUT`) on a neutral palette, filter relabelled "Calls only / Puts only", and `flow-badge.js` badges carry no direction.

---

## 2. Shared decision workflow (Milestone 2)

| Module | Responsibility |
|---|---|
| `lib/decision-contract.js` | Versioned record (`decision-contract-v1`). Three **separate** confidence dimensions; `modelReliability` cannot be LOW/MEDIUM/HIGH without a calibration record matching the record's own event-family × regime × horizon cohort; `decisionReadiness` is a **minimum**, downgraded once per unresolved dissent; legal-transition table for `WATCH→ARMED→TRIGGERED→MANAGE→INVALIDATED→EXPIRED` (terminal states are terminal). |
| `lib/decision-queue.js` | Auditable utility: `materiality × novelty × evidenceQuality × regimeFit × reactionGap × portfolioRelevance × liquidity − crowding − eventRisk − executionCost`, combined as a **geometric mean** so the conjunctive semantics survive without collapsing every score to zero. Missing multiplicative components score at an `UNKNOWN` floor (0.35), **not** neutral; unmeasured penalties are charged at half rate rather than assumed absent. Bet clustering; transition-only alerting with dedup + cooldown. |
| `lib/decision-adapters.js` | Maps Pulse / Alerts / Options v2 into the contract. Adapters may only *map* — never compute a new level or upgrade a confidence. |
| `lib/decision-queue-routes.js` | `op=decisionqueue`, strictly read-only: owns no storage, starts no LLM call, hits no provider. |
| `lib/decision-queue-flags.js` | `DECISION_QUEUE_MODE` = `off` (default) / `shadow` / `on`. |

Ceilings preserved: the SHADOW alerts layer can never reach `ACT_NOW`; an unconfirmed Pulse narrative can only be `INVESTIGATE`; options without an independent price trigger carry no trade gate.

---

## 3. Expert analytics (Milestone 3)

### Market Pulse

- **`lib/pulse2-regime-stack.js`** — intraday / tactical (1–4w) / strategic (1–6m). Each layer reports state, previous state, transition time, persistence, supporting **and** contradicting observations, coverage, and a falsifiable `whatWouldFlipIt`. There is deliberately **no composite regime score**, and `horizonConflicts` names the cases where horizons disagree. Side-aware `regimeFitFor`.
- **`lib/pulse2-cross-asset.js`** — 17 legs (2Y/10Y, curve, real yields/breakevens, dollar, HY/IG/credit spread, oil, copper, gold, VIX level/term/skew, realized-vs-implied, small-cap and equal-weight participation). Every row **names the ETF proxy it actually used**; the confirmation ratio exposes its denominator; unmeasurable legs are `UNAVAILABLE` with reasons and are excluded from the ratio rather than counted neutral.

Written by `op=pulse2statetick`, served on `op=pulse2` as `regimeStack` / `crossAsset`, rendered by `renderRegimeStack` / `renderCrossAsset`.

### Options

- **`lib/options-hypotheses-v2.js`** — the false-positive ledger: closing, roll, spread, hedge, overwrite, event-volatility, corporate action, stale/crossed quotes. Verdicts are `SUPPORTED` / `UNRESOLVED` / `REFUTED` / `NOT_TESTABLE`; **only actively REFUTED counts as ruled out**, and every unresolved one is preserved as dissent. `evidenceStrength` replaces the numeric directional confidence with an ordinal band + component coverage, hard-capped at `MODERATE` on delayed chains.
- **`lib/options-execution-v2.js`** — contract-level executable liquidity for the *selected* contract and *requested size* (no size ⇒ capacity explicitly **unevaluated**, not passed), a concrete limit rule and max-spread ceiling, full-chain strike concentration that **refuses to compute from retained display rows**, IV rank/percentile (refused below 60 sessions), expected-vs-realized move, surface/skew change (requires a prior snapshot), spot-relative strike map, volatility-crush + theta stress, and a Greeks capability disclosure that estimates nothing.

---

## 4. Multi-agent synthesis (Milestone 4)

`lib/agents-contract.js` + `lib/agents-adapters.js`. Ten roles exchanging typed JSON.
Enforced **mechanically at the boundary**, not by prompt wording:

- Forbidden fields per role reject the whole output (the setup agent cannot emit a trigger; the options agent cannot emit Greeks or a spread; the execution agent cannot invent an ADV or slippage).
- A stated probability or an asserted numeric level — including inside nested structures and inside prose — rejects the output.
- The calibration agent has **no `PROMOTE` recommendation available**.
- The synthesis agent cannot set state, lifecycle, levels, or readiness.
- Schema violations are **not retried** (retrying a fabricating model just re-rolls the dice); they degrade the lane visibly.
- `applyAgentsToDecision` copies deterministic levels and the governance block through unchanged, can only **lower** readiness, and refuses directional promotion when intake reports language ambiguity.
- No aggregate agent-agreement score is produced. Champion/challenger both run; only the champion is applied.

`AGENTS_MODE` = `off` (default) / `shadow`. Provider-neutral: `lib/agents-adapters.js` is the only file that names a vendor.

---

## 5. Migration and rollback

**No destructive migration.** No storage key is rewritten or deleted; no existing route changes shape (only additive fields).

| Change | Rollback |
|---|---|
| Decision Queue | `DECISION_QUEUE_MODE` unset/`off` (**the default**). `op=decisionqueue` returns `{disabled:true}`; the three tabs render exactly as before. |
| Multi-agent layer | `AGENTS_MODE` unset/`off` (**the default**). Every lane reports `NO_ADAPTER` and the panel reads DEGRADED. |
| Pulse regime stack / cross-asset | Additive fields on the market-state doc. Revert `lib/pulse2-ticks.js` `buildRegimeLayers` and the two `lib/pulse2-routes.js` fields; the renderers degrade to honest empty states when the fields are absent (test-locked). `PULSE2_MODE=off` remains the whole-layer lever. |
| Options evidence layers | Attached in `attachEvidenceLayers`, wrapped in try/catch and null on carried-forward events. Remove the call and the radar reverts. `OPTIONS_V2_MODE=off` remains the whole-layer lever. |
| Trade Alerts P0 fixes | Behavioural and intentionally **not** flagged — they are the safety fixes. `git revert` of `lib/alerts-{score,pipeline,routes,episodes}.js` plus deletion of the four new modules restores prior behaviour, including the defects. |
| Legacy options renames | `bullishPct`/`net`/`lean` were removed rather than aliased, so a revert must cover `lib/optionsflow.js`, `lib/optionsflow-fable.js`, `lib/decision-normalizers.js`, `public/js/app.js`, and `public/js/flow-badge.js` together. |

**Forward migration note.** New Trade Alerts episodes gain `priceAtAlert` from the next
ingest. Episodes created before this release keep `priceAtAlert: null` and render
`LEGACY_NOT_CAPTURED` — this is intentional; backfilling would manufacture a flattering
prospective record. The first `pulse2statetick` after deploy writes the regime stack and
cross-asset matrix; until then `op=pulse2` reports both in `unavailable[]` with reasons.

---

## 6. Governance — unchanged

Every layer touched here stays **SHADOW / weight 0**. Nothing in this work can change a
strategy's maturity, weight, or trade eligibility; those remain governed solely by
`lib/strategy-gate.js` and a deliberate human promotion. Test-locked in
`test/decision-contract.test.js`, `test/agents-contract.test.js`,
`test/alerts-p0-defects.test.js`, and the pre-existing governance suites.

## 7. Tests

`test/alerts-p0-defects.test.js` (36) · `test/decision-contract.test.js` (46) ·
`test/pulse2-regime-stack.test.js` (26) · `test/options-hypotheses-v2.test.js` (39) ·
`test/agents-contract.test.js` (42) · `test/pulse2-render-regime.test.js` (12).
