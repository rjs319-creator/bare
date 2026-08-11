# PSRL — Persistent Staircase Relative Leadership (design, 2026-08)

`engineVersion: persistent-staircase-relative-leadership-v1` · SHADOW, weight-0 · family `swing-ranking`

## What this is

A longer-horizon **continuity and relative-leadership layer** over the existing residual stack:
multi-horizon absolute trend, raw + beta-adjusted relative strength, return-path continuity
(information discreteness, efficiency, robust fit, concentration), jump-then-plateau
classification, leadership quadrants, persistent episode ledger with arrows/hysteresis, and a
Persistent Trends lab UI. It is a **shadow challenger to OMEGA** — weight 0 everywhere, annotation
only, no production ranking change.

A follow-on **predictive addendum** extends it with trend-episode survival (right-censored,
competing risks), fast/intermediate/slow speed states, a causal change-point detector, sector
breadth, PIT catalyst confirmation, independent failure vetoes, forecastability/abstention and
per-horizon economic ranking. Base modules are episode-shaped from day one so the addendum
extends without rebuild.

## Prior art audited (do-not-duplicate map)

There is no prior "Persistent Staircase" module, but this is the **third** system in the repo
touching residual/relative leadership. Decisions:

| Concern | Verdict | Source of truth |
|---|---|---|
| Beta/residual model (mkt + sector-orthogonalized, shrinkage, PIT) | REUSE | `lib/atlasx-residual.residualize` |
| Daily residual series / rolling sums / percentiles | REUSE | `lib/rlt-residual.js` |
| Peer universe, eligibility fail-closed, sector-missing-as-mask | REUSE | `lib/rlt-universe.js` via `lib/rlt-routes.loadUniverseRows` |
| Benchmarks (SPY + 11 XL ETFs, live fetch) | REUSE | `lib/rlt-routes.loadBenchmarks`, `lib/readthrough.benchFor` (the ONLY sector→ETF map to use) |
| Theil–Sen robust slope | REUSE | `lib/patterns/structure.fitLine` |
| Path spike/decay/gap features + archetypes | REUSE/extend | `lib/atlasx-path.js` |
| Forward grading vs benchmarks | REUSE | `lib/evolve-labels.sliceForward`, `lib/omega-swing.residualForward` |
| Costs, next-open execution, purge/embargo | REUSE | `lib/costs.js`, `lib/research/execution.js`, `lib/research/label-purge.js` |
| Calibration posture (fail-closed, no % until earned) | REUSE | `lib/omega-calibration.assessCalibration`, `lib/prediction-contract.prob` |
| Walk-forward comparison on identical folds | REUSE | `lib/rlt-research.runRltComparison` (extraRankers) |
| Multi-horizon continuity/ordering, information discreteness, jump/plateau states, leadership quadrants, dwell-time hysteresis, episode ledger | **NEW** (nothing exists) | `lib/psrl/*` |

**RLT context (binding):** RLT's two walk-forwards were **negative** — rank-level,
rank-acceleration and residual-momentum rankers were all indistinguishable from the random
control on this universe (`docs/relative-leadership-transition.md`), and that window may not be
re-sliced. PSRL's only honest incremental claim is the axis RLT never tested: **continuity /
persistence / jump-vs-plateau structure**. Experiments are registered accordingly; the default
expectation is that a superset of RLT features inherits the null.

## Module layout (CFL conventions)

```
lib/psrl/config.js       frozen versioned constants (horizons, weights, penalties, hysteresis, store keys)
lib/psrl/trend.js        absolute multi-horizon trend + SMA ladder + HH/HL + horizon agreement (pure)
lib/psrl/continuity.js   information discreteness, efficiency, concentration, gap stats, robust fit (pure)
lib/psrl/jump.js         jump/plateau detection + post-event path + 9-state classifier + reason codes (pure)
lib/psrl/leadership.js   RS lines, residual index, quadrants, speed states (pure; consumes atlasx/rlt residual)
lib/psrl/score.js        PTS / RLS / combined evidence + penalties + support grade + deterministic rank (pure)
lib/psrl/arrows.js       5 arrow families + entry state + hysteresis vs previous snapshot (pure)
lib/psrl/engine.js       orchestrator: rows+benchmarks+prev → snapshot (pure, injectable clock/asOf)
lib/psrl/episodes.js     immutable episode ledger: statuses, terminal events, right-censoring, reasons (pure)
lib/psrl/store.js        Blob namespace psrl/v1/ (latest, ledger, day docs keyed by date — idempotent)
lib/psrl-routes.js       HTTP: op=psrl|psrldetail|psrlhealth (reads), op=psrltick (PRIVILEGED writer),
                         op=psrlresearch (EXPENSIVE, cached)
public/js/psrl-lab.js    Persistent Trends board (lab subtab `psrl`, inserted BEFORE 'peerlab')
```

Wiring: lazy-require dispatch in `api/tracker.js`; `psrltick` in `PRIVILEGED_OPS`,
`psrlresearch` in `EXPENSIVE_OPS`; own root warm chain `psrl: ['op=psrltick']` (single in-process
step — Blob read-back lag rule); `lib/psrl/*.js` appended to `npm run check`;
`STRATEGY_REGISTRY` entry `{ id:'psrl', maturity:'shadow', kind:'signal', section:null }`;
weight-0 `evidenceFamilies.psrl` annotation in `runOmega` (fail-soft try/catch, mirrors peerprop);
hypothesis-registry entries + `research/PREREGISTRATION-PSRL-2026-08.md`.

## Honesty constraints carried into every output

- No probability is displayed as a percentage anywhere: numeric utility/probability slots carry
  `calibrationStatus: 'uncalibrated'` / `prob(null, reason)` and the UI shows **evidence scores,
  bands and support grades** only, labeled BASELINE_UNCALIBRATED.
- Sector classification is current-vendor, **not point-in-time** — stamped on every
  sector-conditioned artifact; missing sector = mask + market-only support downgrade, never zero.
- Historical evaluation inherits the panel's `survivorship-reduced` grade; `promotionEligible`
  stays false; the 2022-2026 exploratory window is spent and is never confirmatory.
- 252-session features on 300-bar cache docs are marginal: computed only when ≥253 bars,
  else marked unavailable (support downgrade), never imputed from shorter history.
- Beta-model support below floor ⇒ market-only fallback with explicit downgrade
  (`atlasx-residual` semantics: missing benchmark ⇒ null/partial, never 0).
- Production OMEGA weights untouched; promotion requires the preregistered contract
  (PIT lineage, untouched positive walk-forward, cost survival, calibration, breadth of regimes,
  continuity value beyond momentum, residual value beyond raw RS, registry approval).

## Experiments registered (new trials, family `swing-ranking`)

- **A `psrl-continuity-conditional`** — within momentum deciles, do continuous paths outperform
  jump-driven paths? (continuity/ID/jump-state as conditioning variable)
- **B `psrl-residual-vs-raw`** — raw return vs SPY-rel vs sector-rel vs market-residual vs
  market+sector-residual ranking ladder.
- **C `psrl-incremental-omega`** — OMEGA / OMEGA+continuity / OMEGA+residual-leadership /
  OMEGA+both / full challenger; incremental rank IC, Precision@K, target-before-stop,
  stagnation and severe-loss deltas, cost-net utility.

All exploratory-mode until a sealed confirmatory design is declared; they widen the family
denominator; spent windows disclosed; runners go through `runRltComparison` folds and the
research harness with purge/embargo.

## Addendum (phase 2, extends the above)

Episode ledger → discrete-time hazard baselines (Kaplan-Meier-style, right-censored, competing
risks) with insufficient-sample abstention · fast/intermediate/slow states (already in base) ·
causal CUSUM change-point detector (BOCPD documented as not implemented) · sector breadth via
`rlt-sector-state` · PIT catalyst confirmation via existing `fmp-client`/8-K/insider archives
(plan-gated feeds disclosed; quarterly estimate history 402 on current plan — estimate-revision
features marked unavailable, never reconstructed from current estimates) · independent
stagnation/breakdown vetoes · forecastability/abstention (CFL pattern) · OpportunityValue(h) per
horizon with disagreement exposed, never averaged. Trained gradient boosting is out of scope for
this runtime (plain-CJS serverless, no Python); the in-repo standard is deterministic ridge
logistic (`rlt-stage-a` pattern) trained in-process with versioned artifacts — anything heavier
is an offline artifact, documented as such.
