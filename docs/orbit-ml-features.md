# ORBIT-ML — Feature Dictionary

ORBIT-ML's feature vector = the **reused** ORBIT snapshot (`docs/orbit-features.md`:
returns, residual momentum, demand pressure, latent drift, relative strength — all
leakage-guarded) **plus** the specialist-evidence features below. All are causal (read only
bars ≤ asOfIdx; proven in `test/orbit-ml-features.test.js`) and dependency-light.

## Added specialist-evidence features (`lib/orbit-ml-features.js`, `orbit-ml-features-v1`)
| Feature | Formula | Lookback | Missingness |
|---|---|---|---|
| `distFrom52wHighAtr` | (close − 252-session high) / ATR14 | 252 | ATR fallback 2% |
| `distFromSma50Atr` / `distFromSma200Atr` | (close − SMA) / ATR14 | 50 / 200 | null if SMA unavailable |
| `breakout20` / `breakout50` | close > prior 20/50-session high (excl. today) → 1/0 | 20 / 50 | null if too few bars |
| `volDryUp` | mean vol(5) / mean vol(50) (<1 = drying, VCP hallmark) | 50 | null if vol missing |
| `pocketPivot` | up day on volume > max down-day volume of last 10 → 1/0 | 10 | 0 if none |
| `rangeCompression` | mean TR(5) / mean TR(20) (<1 = tightening) | 20 | null if too few |
| `signalFreshness` | sessions since last 252-session closing high (0 = new high) | 252 | null if none |
| `fracMoveConsumed` | 21-session move / (ATR%·√21), clamped ±3 | 21 | null if ATR unknown |
| `relStrength63` | stock 63-session ratio − market 63-session ratio | 63 | null if market missing |

Every added feature carries a formula, lookback, availability (as-of the last bar of the
sliced window), missingness behavior, and a version tag (`ML_FEATURES_VERSION`).

## Evidence deliberately NOT reconstructed (flagged, not faked)
`unavailableEvidence: ['ghostInsider', 'optionsFlow', 'peadSurprise', 'fundamentals']` — these
need external point-in-time feeds (EDGAR insider, option chains, earnings estimates, fundamentals)
that are thin/absent historically. Reconstructing them from a survivorship-biased scorer replay
would be leakage-prone, so ORBIT-ML omits them and records the omission rather than inventing
values. See `docs/orbit-ml-audit.md §6`.

## Model feature set
The ranker trains on `[...orbit-model FEATURE_SET, ...ML_FEATURE_NAMES]` — the residual/demand/
drift/relative-strength core plus the specialist evidence — with winsor+standardise fit **in-fold
only** (reused from `lib/orbit-model`).
