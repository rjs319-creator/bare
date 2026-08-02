# Alpha Foundry — the swing-signal discovery discipline

**Purpose.** One documented, enforced path for discovering swing signals without
promoting overfit results. The Foundry is not a place where models get promoted —
it is where they earn the *right to keep being tested*. Nothing in this pipeline
can claim proven alpha, output probabilities, or touch a production ranking.

## The loop (all pieces exist; this page is the contract that binds them)

```
1. PREREGISTER   lib/research/hypothesis-registry.js   (reviewed diff, BEFORE any run)
2. DATA          research/data/panel-features-v3.json  (fwd-outcome-v3 labels only)
3. RUN           lib/research/harness-v3.runExperimentV3
4. RECORD        lib/research/evidence-log.js          (append-only, hash-keyed)
5. STATUS        evidence-log.deriveStatus             (registry status is a VIEW)
6. PROMOTION     lib/strategy-gate PROMOTION_GATE      (human, prospective, cost-net)
```

### 1. Preregistration — every attempt counts as a trial

A hypothesis enters `HYPOTHESES` **before** its first confirmatory run, with:
mechanism, primary metric, baseline, universe, costs, expected direction, and a
stopping rule. Every model, formula, threshold, feature set, filter, and
portfolio rule inspected during the run is declared as `variantsInspected` in
the experiment meta. `harness-v3` floors its Benjamini–Hochberg denominator at
`familyTrials(familyId)` — the registry family count — so forgotten trials
still widen the correction, never narrow it. Rejected ideas go to the graveyard
(status `no-edge`/`retired`) and stay findable so they are never re-run as new.

### 2. Data — panel-v3 or nothing

- Labels come only from `research/lib/outcome-v3.js` (`fwd-outcome-v3`):
  `mature` and `confirmed_delisted` may train; `pending`/`unresolved`/`no_fill`
  are null. `assertTrainable` throws at the training boundary.
- Delistings require the authoritative security master
  (`research/16-secmaster-v3.js` → `secmaster-v3.json`: pitdata-v3 prospective
  records ⊕ FMP/EDGAR historical reconstruction). A stale price tail is NEVER
  a delisting. Unverified delisting reasons withhold the label (an unidentified
  acquisition must not be haircut).
- **Open-ended searches against panel-v2 are prohibited** (its inferred-
  delisting labels are the documented defect — `research/PANEL-V2-REVALIDATION.md`).
  The AlphaGen-style generator stays unrun until it preregisters against
  panel-v3 (`hypothesis alphagen-compact-formulas` records this).
- Known panel-v3 limitations ride in its header (`coverageLimitations`,
  `sectorBasis`) and must be disclosed by any result that depends on them.

### 3. The harness — dependence-aware or invalid

`runExperimentV3` enforces: shared comparable populations (no ranker scores a
row the benchmark can't), auto-appended `control-random` and `momentum-12-1`
benchmarks (neither can be champion), Newey–West HAC t-stats, moving-block
bootstrap CIs, effective-sample-size floors, chronological folds, outlier-
dependence checks, and BH-corrected paired verdicts. Its best possible verdict
is **PASS-PROVISIONAL**; `productionGrade` is structurally `false`.

### 4–5. Evidence and status

Evidence records are append-only and keyed by
`(hypothesis, datasetHash, period, horizon, codeVersion, manifestHash)` — the
same run re-appended is a no-op; any change forks a new record; nothing is ever
rewritten. Registry status must follow `deriveStatus` over the records:
≥2 distinct confirmatory pass periods with zero fails → at most `provisional`.
`confirmed` requires prospective live evidence through the promotion gate —
no backtest can produce it.

The benchmark yardstick on clean labels is recorded at
`research/data/evidence/momentum-12-1-swing/` (step
`research/40-foundry-benchmark.js`): mean IC ≈ 0.008, HAC t ≈ 0.8, CI90
spanning zero. **That is the ruler. A candidate that cannot beat it — after BH,
on identical rows — is noise by definition.**

### 6. Promotion — the only door to live influence

- `lib/strategy-registry.js` maturity is fail-closed: unknown ids and
  `shadow`/`experimental`/`rejected` are never trade-eligible
  (`test/research-isolation.test.js` asserts this, plus a source-scan proving
  no live code path reads research artifacts).
- Promotion needs the strategy-gate PROMOTION_GATE: prospective, cost-net,
  leakage-resistant evidence on the live ledger — a reviewed data change,
  never a wording edit.
- Backtest average returns are never converted into probabilities; calibrated
  probabilities require a prospective calibration record.

## Standing verdicts this discipline preserves (do not relitigate without new data)

| Claim | Verdict | Where |
|---|---|---|
| 12-1 momentum as live edge | no-edge (benchmark only) | `momentum-12-1-swing` |
| GBM/Qlib-style learned rankers | not-confirmed, shadow-only | `nonlinear-ml-panel` |
| Volume/sector-residual/peer additions to momentum | no-edge | `momentum-volume-composite`, `sector-residual-momentum-v2`, `peer-underreaction-formula` |
| Standardized earnings surprise (SUE) | no-edge (reduces composite IC) | `pead-sue` |
| Unscheduled ≥5% gap ORB | **forward-tracked challenger**, not proven alpha | `unscheduled-gap-orb` |
| Any swing ranker qualifying for live promotion | **none** | registry: zero `confirmed` |

The Gap & Go challenger runs with frozen parameters on its own prospective
ledger (`gap/` + `op=gapgobook`); re-evaluation happens only on a fresh
prospective sample with zero parameter changes.
