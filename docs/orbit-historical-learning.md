# Historical-Learning Pipeline — PIT Contract + Negative Controls

This layer adds the leakage/survivorship/overfitting SAFETY infrastructure on top of
the already-merged ORBIT + ORBIT-ML historical-learning system. It does **not** add a
new screener — it hardens and audits the existing one (see `docs/orbit-audit.md`,
`docs/orbit-ml-audit.md` for the full pipeline map: features, factor model, labels,
walk-forward, calibration, router, ledger, promotion gates).

## What already exists (reused, not rebuilt)
| Phase | Component |
|---|---|
| 1 Audit | `docs/orbit-audit.md`, `docs/orbit-ml-audit.md` |
| 4 Labels (5/21/63, residual, triple-barrier, MFE/MAE, severe-loss, costs) | `lib/orbit-labels.js` |
| 5 Features + registry (causal, leakage-guarded) | `lib/orbit-features.js`, `lib/orbit-ml-features.js` |
| Factor model (trailing-only rolling ridge) | `lib/orbit-factor-model.js` |
| 6 Models (ranker + prob + severe + GBM adapter) | `lib/orbit-model.js`, `lib/orbit-ml-model.js` |
| 7 Purged/embargoed walk-forward + OOF | `lib/orbit-walkforward.js`, `rankWalkForward` |
| 8 Calibration (Platt/beta/isotonic, null-when-unsupported) | `lib/orbit-calibration.js` |
| 10 Router (shadow) | `lib/algorithm-router.js` |
| 12 Loop (immutable ledger, manifest, promotion gates) | `lib/immutable-ledger.js`, `lib/run-manifest.js`, `lib/orbit-monitor.js` |

## What this layer adds
| Phase | New component | Purpose |
|---|---|---|
| 2 | `lib/pit-contract.js` (`pit-v1`) | Versioned record contract, strict **as-of joins** (reject future info), integrity-check battery, dataset-suitability gate, deterministic fingerprint |
| 9 | `lib/orbit-controls.js` (`orbit-controls-v1`) | **Negative-controls / leakage-detection** battery: shuffled-label, future-feature, random-ranker, doubled-cost, drop-best-year |
| — | `op=orbitcontrols` route | Runs backfill → controls → suitability on real data |
| — | `research/orbit_ml/controls.js` | Reproducible local runner |

### PIT contract (`lib/pit-contract.js`)
- `asOfJoin(records, decisionTs)` — keep only records knowable (publicationTs, else observationTs) ≤ decisionTs. **Rejects future-dated and not-yet-published info.**
- `pointInTimeValue(records, field, decisionTs)` — latest knowable value.
- `checkIntegrity(records, {asOf})` — flags: duplicate security/date, future observation/fundamental, fundamental-before-period, adjustment-factor mismatch, before-listing / after-delisting, ticker reuse, missingness-by-year, late-starting features.
- `suspiciousForwardCorrelation(rows, labelField)` — a feature near-perfectly correlated with the forward label = leak signature.
- `datasetSuitability({hasRejectedCandidates, hasDelisted, pointInTimeUniverse})` — **old picks ⇒ eval-only, not train-ready; promotion blocked.**
- `fingerprint(records)` — deterministic dataset hash for immutable manifests.

### Negative controls (`lib/orbit-controls.js`)
`runControls(samples)` → verdict ∈ `FAIL-LEAKAGE` / `NO-EDGE` / `FRAGILE-COST` / `FRAGILE-REGIME` / `ROBUST`:
- **shuffled-label**: destroy the feature→label link (deterministic rotation); IC must collapse. Non-zero ⇒ leakage/overfit.
- **future-feature**: any feature |corr| ≥ 0.9 with the label.
- **random-ranker**: fixed pseudo-random score; IC must be ~0 (eval sanity floor).
- **doubled-cost**: top-decile net at 2× cost; fragile edge flips negative.
- **drop-best-year**: edge must not depend on one year.
- Not yet implemented (documented hooks): one-bar-delay (needs candle re-resolution), worst-regime-alone (needs regime tags on samples).

## Operator commands
```
# Local negative-controls run on real data (survivorship-biased, research grade):
node research/orbit_ml/controls.js [limit] [range] [outerBlocks]     # e.g. 24 5y 6

# Deployed (shadow, EXPENSIVE — rate-limited):
GET /api/tracker?op=orbitcontrols&limit=24&range=5y&horizon=days21

# Existing pipeline ops (already deployed):
GET /api/tracker?op=orbitwalkforward     # ORBIT backfill → train → walk-forward
GET /api/tracker?op=orbitmlwalkforward   # ORBIT-ML ranker walk-forward
GET /api/tracker?op=orbithealth          # health + grade
GET /api/tracker?op=orbitmlhealth        # ORBIT-ML health + marginal contribution
```

## Data status (honest)
- **Usable now:** Yahoo daily bars (split-adjusted) for the current-survivor universe → sufficient to EVALUATE the existing algorithms and RUN the controls.
- **Blocks training a production-grade ranker:** no point-in-time universe, no delisted securities / delisting returns, no PIT sector membership, no timestamp-safe fundamentals feed. `datasetSuitability` therefore returns `evalOnly:true, survivorshipSafe:false`, and **promotion is blocked**.
- **Exact next data step:** populate `lib/security-master.js` with PIT membership + listing/delisting dates + delisting returns (the interface exists; the data does not), then re-run `op=orbitcontrols` — if the controls pass on a survivorship-safe universe AND prospective shadow evidence accrues, the promotion gate (`docs/orbit-ml-promotion.md`) can be evaluated.

## Promotion criteria (unchanged, enforced)
No live promotion until: survivorship-safe PIT universe · nested outer-OOS positive after doubled costs · calibrated · positive marginal ensemble contribution · prospective shadow confirmation · negative-controls verdict `ROBUST` · explicit promotion record. Current status: controls run clean but the honest verdict is **NO-EDGE** (nothing to promote), and the universe is survivorship-unsafe — so promotion is doubly blocked.
