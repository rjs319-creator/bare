# Market-Regime Router & Algorithm Effectiveness Monitor

Companion to `docs/quant-system-audit.md` (the predictive-power audit) and
`docs/algorithm-catalog.md`. Describes the **shadow** system that answers "which algorithms
are working *now*, which are degrading, and how much focus each deserves" — Objective 2 of
the quant mandate.

> **Status: shadow / diagnostic.** Surfaced at `op=router`. It reads only cached artifacts
> and the live forward ledger and emits a diagnostic payload. It does **not** touch the live
> rank (`lib/decision.js`). Nothing here sizes a real position; promotion into the live path
> is governed by `docs/model-promotion-policy.md`.

## Modules

| Module | Kind | Purpose |
|---|---|---|
| `lib/algo-health.js` | pure | The **Effectiveness Monitor**. Classifies one algorithm's health from its resolved OOS record. |
| `lib/algo-router.js` | pure | The **conservative Router**. Turns health verdicts into cautious emphasis weights. |
| `lib/algo-router-routes.js` | I/O | `op=router` — assembles inputs from cached artifacts, runs both, emits the unified payload, advances hysteresis state. |

Both engines are clock-free and I/O-free, so every verdict and weight is deterministic and
unit-tested (`test/algo-health.test.js`, `test/algo-router.test.js`,
`test/algo-router-routes.test.js`).

## What it reuses (never reimplements)

- **Long-term skill** ← `lib/maturity.classifyStrategies` over `scoreboard/summary.json` — the
  same Wilson-lower-bound track record the Evidence board already trusts. A "STRONG" here is
  the same statistical object as a "Validated" there, not a second notion of significance.
- **Confidence intervals** ← `lib/stats.wilson`.
- **Independence** ← the cached measured redundancy model (`apex/redundancy.json`,
  `lib/redundancy.creditFor`): correlated siblings (ghost×screener ≈ 0.96) share an evidence
  budget instead of double-counting one momentum factor.
- **Regime** ← `lib/macro.fetchMacro` (VIX + credit) for the current state, and
  `buildMacroLookup` for the per-date regime buckets used to score regime compatibility.
- **Recent series** ← `lib/redundancy-routes.buildRows` (trusted/force only — it refetches
  candles, exactly like `op=redundancy`).

## The Effectiveness Monitor (`lib/algo-health.js`)

For each algorithm it computes rolling/expanding statistics over **distinct decision dates**
(never raw picks — two picks on one day share the day's market shock and are not two
independent bets), in four windows (`veryRecent 20 · recent 60 · medium 126 · long 252`).

`classifyAlgo({ id, series, longTerm, regimeCompatibility, calibration, independence })`
returns a verdict on the seven-state ladder, each carrying an estimate, a Wilson CI, an
effective sample size, a drift verdict, and a plain reason:

| State | When |
|---|---|
| `STRONG` | long-term beat-rate interval clears breakeven over ≥20 independent dates, recent not degrading, calibration acceptable |
| `SUPPORTED` | positive long-term edge and compatible with current conditions, but not yet strong enough |
| `WATCH` | positive signs but the interval straddles breakeven |
| `DEGRADING` | recent window fell **clearly** below breakeven while the long record was positive (not a short losing streak) |
| `INCOMPATIBLE` | worked historically, but the current regime resembles its successful conditions < 35% |
| `BROKEN` | persistent negative OOS edge (interval below breakeven) **or** calibration failure |
| `UNKNOWN` | fewer than 8 independent decision dates — can't tell |

Drift is deliberately conservative: `DEGRADING` fires only when the recent independent-date
interval sits clearly below breakeven **and** the long-term interval was clearly above it, so
noise and a small losing streak do not trip it.

## The conservative Router (`lib/algo-router.js`)

```
weight = positiveValidatedSkill      (shrunk toward zero: w = effN/(effN+10))
       × regimeCompatibility          (how much now looks like where it worked)
       × healthMultiplier             (STRONG 1.0 … WATCH 0.3 … BROKEN/UNKNOWN 0)
       × calibrationMultiplier
       × independenceMultiplier        (correlated siblings share an evidence budget)
       × executionMultiplier
       × uncertaintyMultiplier         (wide CI ⇒ small weight)
```

`positiveValidatedSkill` is zero unless **both** the average excess is positive **and** the
beat-rate is above the coin-flip line — a lucky average on a losing hit-rate earns nothing —
and it is shrunk toward zero by the effective sample size.

Then, in order:

1. **Per-algorithm cap** — no single algorithm exceeds 25% of the emphasis.
2. **Normalise survivors** to a target vector summing to 1 (only after allowing every
   algorithm to receive zero).
3. **Per-family cap** — no correlated cluster exceeds 50%. The weight a family loses to its
   cap becomes **unallocated (cash / abstain)**, never redistributed back to that cluster —
   the one-directional haircut philosophy of `lib/allocation.js`. (Renormalising would
   re-inflate the capped family and defeat the cap.)
4. **Turnover-limited hysteresis** — the actual weight moves toward its target by ≤10%/run up
   and ≤20%/run down (reductions may move faster than increases). Focus shifts *gradually*, so
   the router never chases whichever algorithm happened to win a few recent trades.
5. **Cooldowns** — after a `DEGRADING`/`BROKEN` verdict an algorithm may hold or fall but not
   increase for 3 runs.
6. **Emergency disable** — a `BROKEN` verdict, or an explicit `?emergency=` flag (trusted),
   snaps the weight to 0 immediately (faster reduction permitted when demonstrably harmful).
7. **Abstention** — if no algorithm has a positive conservative estimate, `abstain:true` and
   every weight is 0. Weights are never renormalised to 1 after hysteresis: the remainder is
   honest "sit in cash", and `unallocated` reports it.

## `op=router` payload (shadow)

```
{
  currentMarket: { states:[{name,probability}], dominant, confidence, changedRecently, evidence, note },
  algorithms:  [{ id,label,horizon, health, currentWeight,targetWeight, effectiveSampleSize,
                  recentRankIC,longTermRankIC, expectedNetEdge, calibrationQuality,
                  regimeCompatibility, independentContribution, reason, weightNote, limitations }],
  focus:       { favoredAlgorithms, reducedAlgorithms, disabledAlgorithms, abstain,
                 totalWeight, unallocated, explanation },
  validity:    { survivorshipSafe:false, pointInTimeSafe:true, prospective:true, seriesBuilt, limitations }
}
```

Hysteresis state (`router/latest.json`: current weights + cooldowns + last regime) advances
**only on a trusted/force run**, so it progresses once per cron tick; anonymous reads display
the last persisted state recomputed against fresh health.

## Honest limitations (carried in `validity.limitations`)

- Long-term skill is measured on the **live forward ledger over a present-day universe** —
  genuinely prospective and point-in-time at the decision, but **survivorship-unsafe** (see the
  audit's §3/§6). The router therefore stamps `survivorshipSafe:false`.
- The current regime is a **coarse VIX+credit proxy**, not the full 13-axis regime vector
  (`lib/evolve-regime.buildRegimeVector`) — enriching it needs index+sector fetches; a next step.
- The live forward ledger carries **no per-pick probability**, so `calibration` and `rankIC`
  are unmeasured (`null`) until a scored ledger exists.
- Recent-window drift requires the per-date series, which is trusted/force-only; a public read
  without a fresh series falls back to long-term-only health and says so (`seriesBuilt:false`).
