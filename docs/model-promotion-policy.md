# Model Promotion Policy

Governs champion/challenger lifecycle for any ranker/model that could influence live selection.
Complements `docs/validation-protocol.md`. The live rank today is a heuristic composite
(`lib/decision.js`); every fitted/shadow model is currently **research or shadow** and none is
promoted.

## Artifact metadata (required)

Each artifact records: model ID + version; **status** ∈ `research | shadow | eligible | champion |
retired | rejected`; dataset + feature hashes; training cutoff; fold definitions; primary metric
(declared before evaluation); full validation results; known limitations; promotion decision;
rejection reason; prospective evidence; code commit. The `ExperimentManifest`
(`lib/research/schemas.js`) captures the reproducibility subset.

## Status ladder

```
research ──(passes validation-protocol on survivorship-SAFE data)──▶ eligible
eligible ──(prospective shadow confirms)──▶ champion
champion ──(a challenger beats it OOS + shadow)──▶ retired
any ──(fails a gate / unexplained extraordinary result)──▶ rejected
```

## Promotion requirements (ALL must hold)

1. Improvement on the **predeclared primary metric** (default: mean daily OOS rank-IC, purged).
2. No unacceptable **calibration** degradation (out-of-fold Brier / reliability).
3. No unacceptable **tail-risk / drawdown** degradation (ES, max DD).
4. Positive results across **enough independent outer blocks** (prefer ≥ ¾ of 8–12 blocks positive).
5. Passes **leakage checks** (purge/embargo exact; no look-ahead; feature cutoff enforced).
6. Passes **train/serve parity** (identical feature vector from one implementation).
7. Passes **execution & cost sensitivity** (survives realistic next-open fills + cost scenarios).
8. **Prospective shadow confirmation** over adequate duration and independent dates.
9. **No unexplained extraordinary performance** — an outsized result is treated as suspected
   leakage/survivorship/overfitting until explained, and blocks promotion until it is.

## Hard blockers (auto-reject / refuse-to-promote)

- **Survivorship-unsafe data** (`survivorshipSafe:false`) — the current state of this repo. No
  amount of in-sample or synthetic performance overrides this. `harness.runExperiment` stamps such
  runs **PROVISIONAL** and they are ineligible.
- Challenger fails to beat the residual-momentum baseline OOS (e.g. the ridge-linear ranker in the
  current slice — **rejected**, it inverts OOS).
- Missing manifest / non-reproducible run.

## Worked example (this slice)

| Candidate | Status | Reason |
|---|---|---|
| residual-momentum | **research** | best OOS on synthetic self-test, but data is survivorship-unsafe → cannot advance to `eligible` |
| ridge-linear | **rejected** | inverts OOS (IC −0.049, CI excludes 0); fails requirement #1 and #4 |
| production-composite | **champion (live, ungoverned)** | the incumbent heuristic; not validated on survivorship-safe data — flagged for backfill once PIT data exists |

## Path to a real promotion

Nothing here can be promoted until: (a) real point-in-time constituents + delisting returns exist,
(b) `security-master.universeAt` is wired into the backtest, (c) a challenger clears all nine
requirements on survivorship-safe outer blocks, and (d) prospective shadow confirms. Until then the
honest status of every fitted model is **research/shadow**, never "demonstrated alpha."
