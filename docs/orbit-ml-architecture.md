# ORBIT-ML — Architecture

ORBIT-ML is a shadow EVOLVE specialist (`idiosyncraticPersistence`) that ranks stocks
cross-sectionally by future net residual return over 5/21/63 sessions. It REUSES the merged
ORBIT engines and adds a rank objective + EVOLVE framing + marginal-contribution measurement.

```
PIT universe + daily bars + factor proxies (SPY/sector-ETF/IWM/^VIX)
        │
        ▼  REUSED
lib/orbit-factor-model  rolling ridge residualization
lib/orbit-state         causal Kalman drift
lib/orbit-features      leakage-guarded ORBIT snapshot
        │
        ▼  NEW
lib/orbit-ml-features   + specialist-evidence features (breakout/RS/VCP/dry-up/pocket-pivot/
                          freshness/frac-move-consumed) — candle-derivable, PIT-safe
        │
        ▼  NEW
lib/orbit-ml-model      date-grouped pairwise RankNet (cross-sectional rank objective)
                        + GBM JSON-tree adapter (explicit not-installed status)
                        + rankWalkForward (reuses orbit-walkforward purge/embargo/blocks)
        │
        ▼  REUSED
lib/orbit-labels        next-open + triple-barrier + costs (train/serve parity)
lib/orbit-calibration   OOF calibrator select (null-when-unsupported)
        │
        ▼  NEW
lib/orbit-ml-evolve     specialist adapter → EVOLVE (idiosyncraticPersistence, UNMAPPED = shadow)
lib/orbit-ml-ensemble   marginal contribution: redundancy credit + leave-one-out rank-IC
lib/orbit-ml-monitor    reuses orbit-monitor (health + A–F grade) + incremental value
lib/orbit-ml-routes     op=orbitml / orbitmltick / orbitmlresolve / orbitmlwalkforward / orbitmlhealth
```

## Shadow guarantee (two firewalls)
1. `idiosyncraticPersistence` has **no `SOURCE_SPECIALIST` mapping** in `lib/evolve.js` → it
   never fires on a live candidate (verified in `test/orbit-ml-evolve.test.js`).
2. The decision engine (`buildToday`/`rankSignals`) never imports EVOLVE at all.
Every payload carries `shadow:true, affectsLiveRank:false, routerWeight:0`.

## Prediction schema (per `predictionId`)
`{ ticker, securityId, decisionTs, dataCutoffTs, eligibleEntryTs, universeSnapshotId,
featureVersion, modelVersion, calibrationVersion, horizon:{ days5|21|63: { rankScore, pRawUp,
pResidualUp, pUpperBarrier, pLowerBarrier, pTimeout, expectedGrossReturn, expectedNetReturn,
expectedResidualReturn, interval } }, latentState, severeLossProbability, expectedUtility,
confidence, topDrivers, warnings, classification, state, rejectionReasons, researchValidity }`.
`pRawUp`/`pResidualUp` are `null` unless OOF-calibrated (contract enforced).

## Integration points
`lib/evolve.js` (SPECIALISTS + SPECIALIST_META, no source map), `lib/strategy-registry.js`
(`core:false`), `api/tracker.js` (5 ops + PRIVILEGED/EXPENSIVE gating), `lib/store.js`
(`orbit-ml/` prefix), `lib/warm-chains.js` (reprime + ticks3), `immutable-ledger` stream `orbit-ml`.

## Versions
`orbit-ml-features-v1`, `orbit-ml-model-v1`, `orbit-ml-evolve-v1`, `orbit-ml-ensemble-v1`,
`orbit-ml-monitor-v1`, `orbit-ml-artifact-v1`.
