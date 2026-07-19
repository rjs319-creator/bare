# ORBIT-ML — Phase 1 Audit

**ORBIT-ML** = a multi-horizon **cross-sectional stock ranker** that plugs into the EVOLVE
ensemble as a new **shadow specialist**, `idiosyncraticPersistence`. It predicts the
future-net-**residual-return RANK** over 5 / 21 / 63 sessions.

Repo state at audit time: branch `feat/orbit-ml-specialist` off `main` (`e491bed`, which
already contains the merged **ORBIT** system, PR #143). Tests: `node --test`.

## 1. Relationship to the existing ORBIT system (the reuse decision)

ORBIT (merged) already implements — and unit-tests — the entire substrate this spec asks
for: point-in-time features (`lib/orbit-features.js`), rolling-ridge factor residualization
(`lib/orbit-factor-model.js`), a causal Kalman drift state (`lib/orbit-state.js`), shared
next-open triple-barrier labels (`lib/orbit-labels.js`), OOF probability calibration
(`lib/orbit-calibration.js`), nested purged walk-forward (`lib/orbit-walkforward.js`), a
PIT backfill (`lib/orbit-backfill.js`), and multi-window health + A–F grade
(`lib/orbit-monitor.js`).

Per this spec's own directive ("reuse existing strengths… do not add another disconnected
system") and the repo's DRY rules, ORBIT-ML **reuses those engines verbatim** rather than
cloning them. ORBIT-ML's genuinely-new surface is only:

| New in ORBIT-ML | File |
|---|---|
| Specialist-evidence features (breakout/RS/VCP/dry-up/pocket-pivot/freshness/move-consumed) on top of the ORBIT snapshot | `lib/orbit-ml-features.js` |
| Date-grouped cross-sectional **RANK** objective (pairwise RankNet) + a **GBM JSON-tree adapter** with explicit status | `lib/orbit-ml-model.js` |
| EVOLVE **specialist adapter** (`idiosyncraticPersistence`, shadow) | `lib/orbit-ml-evolve.js` |
| **Marginal ensemble contribution** (redundancy credit + leave-one-out rank-IC) | `lib/orbit-ml-ensemble.js` |
| Monitor composition + shadow routes | `lib/orbit-ml-monitor.js`, `lib/orbit-ml-routes.js` |

This is the difference between ORBIT (a standalone shadow *board*) and ORBIT-ML (a shadow
*EVOLVE specialist* measured for incremental value): the **rank objective**, the **EVOLVE
framing**, and the **marginal-contribution measurement**.

## 2. Production ranking path (traced)

`api/tracker.js op=today` → `lib/decision-routes.js buildToday` (`:51`) → normalizes a fixed
source list → `D.rankSignals` → horizon buckets → `lib/decision-portfolio.js` selection. **The
decision engine never imports EVOLVE** — `grep` across `decision.js`, `decision-normalizers.js`,
`decision-routes.js`, `decision-portfolio.js`, `decision-sources.js` returns zero `evolve`
references. EVOLVE consumes `op=today`; `op=today` never consumes EVOLVE.

## 3. Where ORBIT-ML enters — and why it is structurally shadow

EVOLVE's specialists are three coupled structures in `lib/evolve.js`: `SPECIALISTS` (`:36`),
`SPECIALIST_META` (`:41`), and `SOURCE_SPECIALIST` (`:51`, decision-engine `source` →
specialist). `sourceToSpecialists(sources)` (`:61`) only ever returns specialists that appear
in `SOURCE_SPECIALIST`.

ORBIT-ML is added to `SPECIALISTS` + `SPECIALIST_META` **with no `SOURCE_SPECIALIST` mapping**.
Consequences, all verified by test (`test/orbit-ml-evolve.test.js`):
- `sourceToSpecialists` can never return `idiosyncraticPersistence` → it never fires on a live
  candidate → it contributes no `contrib`, no weight, no `effN` to `ensembleProbability` → it
  cannot change any candidate's ensemble P, `decideState`, or `evolveScore`.
- Because the decision engine never imports EVOLVE anyway, there is a **second** firewall.

**The absence of a source mapping IS the `affectsLiveRank:false` flag** — EVOLVE has no such
boolean. ORBIT-ML accrues its own resolved ledger (`orbit-ml/` prefix) and is measured via
redundancy; promotion (adding a source mapping) is gated, see `docs/orbit-ml-promotion.md`.

## 4. Current algorithms & live/shadow status (unchanged by this work)

Live-in-`op=today`: breakout screener, ghost, ignition, stable-core, coil, gap-go, biotech,
confluence, read-through, etc. (via `decision-sources`). Shadow/decoupled: EVOLVE (`op=evolve`),
failure-model, challenger (`shadow/`), ORBIT (`orbit/`), and now ORBIT-ML (`orbit-ml/`). None of
the shadow systems feed `buildToday`.

## 5. Reused infrastructure (exact APIs)

Execution/labels: `lib/orbit-labels.js` (reuses `execution-policy planFill`, `outcome
resolveTrade`, `costs`). Calibration: `lib/orbit-calibration.js` (reuses `evolve.fitCalibrator`
isotonic). Rank quality: `lib/rankquality.js`. Redundancy (marginal value): `lib/redundancy.js
buildRedundancyModel` — pairs carry `overlapRate`, `returnCorr`, `confirmation.lift`, `credit`
(`:200`). Deflated Sharpe: `lib/evolve-dsr.js`. Uniqueness: `lib/evolve-uniqueness.js`. Storage:
`lib/store.js` (new `orbit-ml/` prefix mirroring `orbit/`). Ledger: `immutable-ledger` stream
`orbit-ml`. Cron: `lib/warm-chains.js` (`op=orbitmltick` on `reprime`, `op=orbitmlresolve` on
`ticks3`).

## 6. Point-in-time & survivorship (confirmed defects, inherited)

Same as ORBIT (`docs/orbit-audit.md §3–6`): the backfill universe is the **current survivor
lists** (`lib/universe.js`); the PIT security master (`security-master.universeAt`) is
unpopulated and used by no backtest; sector membership is current, not PIT. Therefore every
ORBIT-ML result carries `researchValidity: { productionGrade:false, survivorshipSafe:false,
pointInTimeSafe:false }` and **no production-grade alpha claim is made**.

## 7. Build plan → executed

Reuse the ORBIT engines; add the rank objective + specialist adapter + marginal-contribution +
routes; register `idiosyncraticPersistence` as an unmapped (shadow) EVOLVE specialist; validate
honestly and report the weaker truth. See `docs/orbit-ml-validation.md`.
