# ORBIT — Feature Dictionary (`orbit-features-v1`)

Every feature is a pure function of daily bars + factor proxies at indices ≤ `asOfIdx`.
Snapshots are causal (proven: appending or mutating future bars cannot change an earlier
snapshot — `test/orbit-features.test.js`). Raw features are emitted here; winsorization and
standardisation are fit **inside training folds** by `lib/orbit-model.js`, never here.

Factor inputs are close series aligned to the stock's dates via `alignByDate` (last factor
bar on/before each date — no lookahead). Missing features impute to the training mean (z=0)
at model time; a `missing` map flags absent market/sector/size/vol/residual/state inputs.

## Return & residual (lookback in sessions)
| Feature | Formula | Lookback |
|---|---|---|
| `ret{1,2,5,10,21,42,63,126,252}` | trailing simple return | k |
| `mktRelRet21/63`, `secRelRet21/63` | stock return − benchmark return | 21/63 |
| `residMom21/63` | Σ factor-residual returns | 21/63 |
| `residConsistency` | fraction of positive residual days | window |
| `residPosFrac` | positive residual fraction | 21 |
| `residAccel` | mean(resid[-10:]) − mean(resid[-20:-10]) | 20 |
| `residAutocorr` | lag-1 autocorrelation of residuals | window |
| `residDownDev` | downside deviation of residuals | window |
| `residDrawdown` | max drawdown of cumulative residual | window |
| `recoveryAfterMktDown` | mean stock return the day after a market-down day − unconditional mean | full |
| `returnPathStability` | 1/(1+σ_daily·100) | 21 |

## Demand pressure (robust)
| Feature | Formula | Lookback |
|---|---|---|
| `udDollarImbalance` | (up-day $vol − down-day $vol)/total $vol | 21 |
| `demandAsymmetry` | median(pos residual per log$vol) − |median(neg residual per log$vol)| | window |
| `obvSlope`, `obvAccel` | OLS slope of OBV; recent−prior slope | 21 / 10 |
| `volSurprise`, `dollarVolSurprise` | robust-z (median/MAD) of latest vol / $vol | 63 |
| `closeLocation` | mean close-location-value in range | 10 |
| `accumOnMktDown` | mean CLV on market-down sessions | 21 |
| `avgDollarVol` | mean close·volume | 21 |
| `missingVol`, `suspiciousVol` | missing / negative volume indicators | 21 |

## Latent persistence (from `orbit-state.js`)
`drift`, `driftSlope`(acceleration), `driftZ`, `driftPersistence`, `driftHalfLife`,
`driftUncertainty`(observation variance), `driftProbPositive`, `stateChangeProb`.

## Scenario / context (name-level; cross-sectional dispersion/breadth added by the route)
`marketTrend`, `sectorTrend` (signed SMA50/200 read), `volState` (robust-z of ^VIX).

## Model feature set (`orbit-model.js` FEATURE_SET)
A deliberately residual/demand/drift/relative-strength subset — **raw ret21/ret63 momentum
features are excluded** so ORBIT stays orthogonal to the momentum engines (Stable Core,
OMEGA, Ignition). Sector membership is current-approximate (not PIT) — flagged, see
`docs/orbit-audit §D3`.
