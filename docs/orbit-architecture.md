# ORBIT — Architecture

ORBIT (*Orthogonal Residual Bayesian Idiosyncratic Trend*) ranks stocks by a calibrated
probability of rising over 5 / 21 / 63 trading sessions, driven by company-specific pressure
that survives after market / sector / size / vol / momentum effects are removed. Shadow-only.

## Data flow

```
daily bars (fetchDailyHistory, split-adjusted)
   + factor proxies: SPY (market), sector ETF, IWM−SPY (size), ^VIX (vol)
        │
        ▼
lib/orbit-factor-model.js   rolling scale-invariant RIDGE → factor betas + residual return series (causal)
        │
        ▼
lib/orbit-state.js          causal Kalman drift over residuals → drift / persistence / P(+) / changeProb
        │
        ▼
lib/orbit-features.js       PIT feature snapshot (returns / residual / demand / drift / relative-strength)
        │                   — leakage-guarded: appending future bars never changes an earlier snapshot
        ├───────────────► lib/orbit-labels.js   next-open fill + triple-barrier (5/21/63) + costs (shared train/serve)
        ▼
lib/orbit-model.js          logistic sub-models (residualUp / rawUp / severe / barrier) — preprocessing fit in-fold
        │
        ▼
lib/orbit-calibration.js    OOF calibrator select (none/platt/beta/isotonic) by held-out Brier — null when unsupported
        │
        ▼
lib/orbit-scenarios.js      soft scenario vector (macro) → robustUp = min P(up) over plausible scenarios
        │
        ▼
lib/orbit-decision.js       classify (EARLY/SWING/COMPOUNDER/ALIGNED/WATCH/ABSTAIN) — shadow:true, weight 0
```

Validation & lifecycle:
- `lib/orbit-backfill.js` — PIT sample reconstruction (pure builder + network wrapper).
- `lib/orbit-walkforward.js` — nested outer folds, purge-by-label-end, embargo, purged-vs-leaky.
- `lib/orbit-monitor.js` — multi-window OOS health + A–F grade.
- `lib/algorithm-router.js` — conservative focus allocation (shrinkage/caps/hysteresis/abstain).
- `lib/orbit-math.js` — shared pure numerics (ridge, MAD, winsor, logistic, normCdf, Brier).

## Reuse (not re-implemented)

`execution-policy` (next-open+slippage), `costs` (cost-v1), `outcome` (triple-barrier resolve),
`evolve.fitCalibrator` (isotonic/PAV), `rankquality` (IC/reliability), `evolve-dsr` (deflated
Sharpe), `redundancy` (incremental credit), `macro` (PIT scenario state), `store` (Blob),
`immutable-ledger` (`orbit` stream), `run-manifest`, `security-master`, `market-data`,
`strategy-registry`, `maturity`. See `docs/orbit-audit.md §2`.

## Shadow integration (never touches live rank)

- Storage: `orbit/` prefix in `store.js` (mirrors `shadow/`). Ledger stream `orbit`.
- Registry: one `core:false` entry, `section:'Orbit'`.
- Routes (via `api/tracker.js`, Hobby 12-fn cap): `op=orbit` (read), `op=orbitlog` /
  `op=orbitresolve` (cron writes, PRIVILEGED), `op=orbitwalkforward` (EXPENSIVE train+eval),
  `op=orbithealth`, `op=algorithmrouter`.
- Cron: `op=orbitlog` on the `reprime` chain (after today+ensemble); `op=orbitresolve` on the
  candle-heavy `ticks3` chain.
- Every payload carries `shadow:true`, `affectsLiveRank:false`, `deploymentWeight:0`,
  `governanceStatus:'paper'`, `productionGrade:false`.

## Versions

`orbit-features-v1`, `orbit-factor-v1`, `orbit-state-v1`, `orbit-labels-v1`,
`orbit-scenario-v1`, `orbit-model-v1`, `orbit-calib-v1`, `orbit-wf-v1`, `orbit-decision-v1`,
`orbit-monitor-v1`, `orbit-router-v1`, `orbit-backfill-v1`, `orbit-artifact-v1`.
