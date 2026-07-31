# GRIDLOCK — Methodology

**Module:** `gridlock-v1` · **Status:** SHADOW / weight-0 / research-only · **First domain:** AI-data-center electricity demand · **First region:** PJM

## The question GRIDLOCK asks

Not *"which company was mentioned?"* but:

1. What physical or contractual event occurred? (`PhysicalConstraintEvent`, `lib/gridlock-schema.js`)
2. Which constraint changed — supply, demand, transmission, fuel, equipment, regulation? (`CONSTRAINT_OF_EVENT`)
3. Which geographic market? (deterministic state→ISO map; the LLM never assigns regions)
4. Which companies have **verified** exposure? (`lib/gridlock-exposure.js` — hand-curated, cited, effective-dated)
5. Which beneficiaries have not yet repriced? (`lib/gridlock-readthrough.js`, measured, not guessed)
6. Which companies face cost pressure? (`COST_HEADWIND` is a first-class outcome)
7. Is the effect 5–10-day-swing relevant? (`horizonDays ≤ 21` gate)
8. Does price action confirm? (deterministic tape read vs sector bench)
9. What invalidates it? (every causal chain carries invalidating evidence)
10. Has this event type historically paid? (unknown until the prospective ledger matures — **no history is invented**)

## Architecture (per module)

| Stage | Module | Nature |
|---|---|---|
| Schemas / enums / dedup | `gridlock-schema.js` | pure |
| Lifecycle machine | `gridlock-lifecycle.js` | pure, deterministic-evidence transitions |
| Extraction | `gridlock-events.js` | deterministic regex first; bounded Haiku tool-call second, **grounded** afterwards |
| Curated seeds | `gridlock-seed.js` | static, cited |
| Source adapters | `gridlock-sources.js` | PJM / EIA / NWS, fail-soft |
| Region state + CPS | `gridlock-region.js` | pure given inputs; per-region/per-season norms |
| Exposure graph | `gridlock-exposure.js` | static, cited, verified-vs-inferred |
| Causal engine | `gridlock-causal.js` | pure role×constraint matrix + gates |
| NYR / tape | `gridlock-readthrough.js` | pure; reuses Read-Through `benchFor` |
| Opportunity score + gate | `gridlock-score.js` | pure, decomposed, penalty-explicit |
| Scenarios | `gridlock-scenario.js` | pure arithmetic (LLM may explain, never calculate) |
| Orchestration / ops | `gridlock-routes.js` | I/O; bounded fan-out |

## Constraint-pressure score (`gridlock-cps-v1`)

Weights (hypotheses, not validated alpha): reserve-margin 20 · load surprise/growth 15 · outages 15 · transmission/congestion 15 · fuel sensitivity 10 · interconnection friction 10 · weather 10 · market structure 5.
Normalization anchors are per-region **and per-season** (`REGION_NORMS`); an unsupported region's score is **withheld**, never mis-normalized. Missing components are listed and the remaining weights renormalized; all-missing → total `null`, not 0.

## Opportunity score (`gridlock-score-v1`)

Weights: event magnitude 15 · constraint pressure 15 · verified exposure 20 · durability 10 · freshness 10 · price/volume confirmation 15 · not-yet-repriced 10 · liquidity 5. Explicit penalties (points, listed on every candidate): unfinanced announcement, far-future start, single source, contradictory evidence, inferred exposure, crowding, stale region data, no primary source, sparse inputs. **No probability is ever emitted** — nothing is calibrated.

## Causal/timing separation (no double-counting)

The opportunity score contains **zero** momentum/RS/volume-trend features. All market timing — relative strength, momentum, volume, volatility, regime fit, entry class, stop/target/R:R, sizing caps, earnings risk — is `omega-swing.evaluateCandidate`, reused verbatim. `priceVolumeConfirm` is direction-aware thesis confirmation (a move *against* the thesis scores low — the opposite of a momentum ranker), asserted by test. In the OMEGA payload, `evidenceFamilies.physical_constraint` is an annotation with `weight: 0, status: 'SHADOW', probability: null, portfolioEligible: false` — it can never re-rank.

## ACTIONABLE_RESEARCH gate (ordered; first failure explains itself)

beneficial classification → swing-relevant horizon → regional data current → price data available → regime permits (risk-off blocks longs) → liquidity floor ($3M ADV) → OMEGA timing exists → not extended/exhausted → entry/stop/target defined → price confirms. A pass is still SHADOW.

## Lifecycle

Market Pulse vocabulary (NEW/EMERGING/BUILDING/CROWDED/FADING) + project terminals (COMPLETED/DELAYED/CANCELLED/INVALIDATED). Transitions require a deterministic evidence kind (`EVIDENCE_KINDS`) and are kept in `lifecycleHistory` forever.

## Non-negotiables enforced in code (each with a test)

- LLM proposals are grounded against source text — ungrounded MW/$/dates are nulled (`groundExtraction`).
- Duplicate articles merge into one event; publishers dedupe the independence count (`mergeEvent`).
- Grounded values are never overwritten by later articles; conflicts are recorded (`fieldConflicts`).
- Missing data is surfaced (`unresolvedFields`, `staleFields`, `missing`), never hidden in a score.
- Weak/inferred non-movers are **not** "hidden opportunities" (NYR returns null with a note).
- Rejections are recorded with reasons, not discarded.
- Shadow isolation: the live decision engine contains no gridlock reference (source-scanned test).
