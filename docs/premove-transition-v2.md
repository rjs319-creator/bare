# Pre-Move Transition Inventory v2 (ATLAS-X v2)

Evidence-first redesign for identifying swing opportunities BEFORE the move,
strictly separating three questions that the app previously blended:

1. **Primed** — is a stock statistically primed for an upside transition?
2. **Trigger** — has a valid, objectively-defined, executable trigger arrived?
3. **Expectancy** — after entry costs, slippage and uncertainty, is there
   positive expectancy *left*?

Companion docs: `quant-redesign-3.md` (governance substrate this builds on),
`validation-protocol.md`, `model-promotion-policy.md`.

> **Reality constraint (binding).** Nothing in this redesign claims new alpha.
> No probabilities, calibration results, training artifacts or validation
> results were fabricated; where data or dependencies are missing the feature
> is marked unavailable and fails closed. **No incremental edge has been
> demonstrated** — every new model surface is shadow / weight-zero.

Baseline at start: suite 2435/0 on top of the uncommitted quant-redesign-3
working tree (preserved, integrated, not reverted).
End state: **suite 2489 pass / 0 fail** (54 new tests), `npm run check` clean,
Day Trade byte-identical.

---

## 1. Findings confirmed in the current code (pre-fix)

| # | Finding | Evidence |
|---|---|---|
| 1 | `ghostTop` (full-cross-section quiet-accumulation scan) was stranded: no normalizer read it, `op=ghostlog` observed only `results` | `api/screener.js:486` built it; `lib/decision-normalizers.js` had no adapter; `lib/apex-routes.js` ghostlog iterated `d.results` only → the Ghost ledger graded a breakout-filtered population |
| 2 | Lead-time v1 used raw `+8% in 63 bars` (rewards high-vol names), took `pick.entry` (a future breakout price) as the detection anchor, scored truncated windows as failures, and kept only the first ticker/tier occurrence forever | `lib/leadtime.js:21-56`, `lib/leadtime-routes.js:40-47` |
| 3 | Coil prospective ledger captured only the top-15 small/large picks — no controls, no micro/expanded, no trade-plan fields | `lib/screener-routes.js` `COIL_TICK_SCOPES/COIL_TICK_TOPN` |
| 4 | ATLAS-X "universe" was op=today candidates + 60 plain-momentum near-misses (momentum consumed the whole deep-analysis budget) | `lib/atlasx-universe.js:105-113` |
| 5 | Compression expert coerced continuous `expansionNow` (ratio, default 1) and `wasCompressed` (percentile, default 0.5) with `!!` — both permanently truthy | `lib/atlasx-experts.js:112-113` |
| 6 | `ctx.catalyst` was NEVER populated → catalystDrift dead (applicability 0 always); `ctx.asOf` never populated → freshness always unknown; additionally `null >= 0` made an unknown surprise read as **bullish** | `lib/atlasx-universe.js:52-55` dropped `event`; `lib/atlasx-engine.js:46`; routes ctx |
| 7 | `ctx.riskOff` never populated → redTapeReversal permanently `disabled`, AND in risk-off regimes `regimePermittedFor` required exactly that expert → **every** candidate abstained `regime-not-permitted` | `lib/atlasx-experts.js:286-287`, `lib/atlasx-engine.js:185` |
| 8 | Non-Today candidates (near-miss/episode) had `sector/sectorEtf/price/company` undefined → silently market-only residual + null capture control keys | `lib/atlasx-engine.js:149-153` |
| 9 | Unknown liquidity mapped to the **cheapest** cost tier (unknown → 'large' → 'liquid', 16 bps) | `lib/atlasx-engine.js:191-195` |
| 10 | Transition sigmoid gains/offsets were unauditable inline literals | `lib/atlasx-transition.js:161-195` |

## 2. Architecture implemented

```
PIT liquid universe (cached candles, 4 scopes)
  → PASS A cheap features + HARD fail-closed eligibility        lib/atlasx-scan.js
  → PASS B specialist-balanced shortlists (per-specialist +
    per-liquidity-band caps, near-threshold, deterministic
    controls; reasons preserved through dedup)                  lib/atlasx-scan.js
  → premove feature schema (versioned, masked)                  lib/premove-features.js
  → STAGE A competing-risk transition rank                      lib/premove-stage-a.js
  → persistent PRIMED/ARMED inventory                           lib/premove-inventory.js
  → objective executable trigger (premove-trigger-v1)           lib/premove-stage-b.js
  → STAGE B conditional barrier model + utility waterfall       lib/premove-stage-b.js
  → Swing Episode Supervisor lifecycle (reused, not forked)     lib/swing-* via atlasx episodes
  → immutable daily cross-section capture                       op=premovelog → premove/cross-section/<date>.json
  → censor-aware resolution + reliability                       lib/leadtime2.js, lib/coil-reliability.js
  → walk-forward validation vs mandatory baselines              scripts/premove-validate.js
```

**Feature flag** — `PREMOVE_V2_MODE=off|shadow|enforce` (`lib/premove-flags.js`),
default **shadow**. `enforce` fails closed: without a valid, current,
version-matched artifact (`kind/modelVersion/featureVersion/labelVersion/
executionPolicyVersion/universePolicy/trainedThrough/status='validated'`) it
behaves exactly as shadow and says so. A calibration artifact is invalidated by
any feature-schema / scoring / label / execution-policy / universe change.
Artifact paths: `premove/model-stage-a.json`, `premove/calibration.json`,
`premove/promotion.json` (none exist yet — deliberately).

### Phase 1 — stranded Ghost discovery (repaired)
- `mapGhostTopRows`/`fromGhostTop` in `lib/decision-normalizers.js`: standalone
  rows only (tier GHOST/STALKING, not in `results` — no self-double-counting),
  source `ghost`, section `Ghost`, swing/long, `volumeAccum`, scoringVersion
  stamped, premove provenance + universe scope. Fail-closed on missing
  price/liquidity; missing levels are explicit (`missing:['levels']`, cannot arm).
  **Not** added to the op=today merge — shadow inventory only.
- `api/screener.js` `ghostTop` rows now carry: decision price, levels, dollar
  volume + liquidity tier, status, pillars+score, feature snapshot (pct/quant/
  metrics), sector, data cutoff, universe scope+size, earnings metadata when
  genuinely present, explicit `missing` markers, `inBreakoutResults`.
- `op=ghostlog` observes `ghostTop` ∪ `results` across large/small/micro **and
  expanded** (when its cache is available), deterministic cross-scope dedup
  (higher score → fixed scope priority), legacy `ghost/` ledger shape preserved
  (additive fields only), plus a NEW immutable full-candidate record
  `ghostobs/<date>.json` (`lib/premove-capture.js`): selected standalone /
  also-in-breakout / near-threshold / rejected / excluded rows, decision +
  eligible-entry dates, feature version, universe snapshot id, trigger level,
  invalidation, `outcome.state='unresolved'` placeholder.

### Phase 2 — lead-time v2 (`lib/leadtime2.js`, op=leadtime2)
v1 kept unchanged at op=leadtime for comparison. v2: detection anchor = decision
close (plan entry is only the trigger BARRIER); vol-normalized versioned
barriers (`lt2-coilsigma-v1` baseline reusing Coil's 2.5σ abnormal-expansion
definition + preregistered `tight`/`wide` sensitivity variants); sector-then-
market residual outcomes (labeled `residualized:false` when no benchmark, never
pretended); full outcome taxonomy (censored / no-trigger / downside-first /
trigger-no-fill / target-before-stop / stop-before-target / timeout); censoring
excluded from every rate; recurring episodes via the contract cooldown engine
(`lib/scoreboard-episodes`); executable fills (gap-through at the worse open,
gap>5% refused, same-bar → stop); cost-net R via tier costs; horizons 5/10/21;
calibration-by-band + selected-vs-rejected + MAE-before-trigger + consumed-share
+ wait-cost metrics.

### Phase 3 — Coil coverage (`lib/coil-capture.js`, `lib/coil-reliability.js`)
Scoring/ranking untouched (incl. the removed inverted Expected-R ranking).
`op=coiltick` now captures small/large/micro/expanded (when caches exist):
top-15 selected + **deterministic** 2-per-decile stratified controls, each row
with decision price, decision-time vol, dollar volume, trade plan, calScope
stamp (micro/expanded → pooled 'small' per the existing convention — recorded),
universe snapshot, data cutoff. `op=coilbook` adds a `reliability` battery:
predicted-vs-realized abnormal expansion, trigger conversion, target-before-stop
given fill, cost-net R (expanded charged small-cap tier, never cheapest), by
scope + band + selected-vs-controls + chronological halves; censored windows
excluded everywhere.

### Phases 4–5 — ATLAS-X universe + corrections
Two-pass funnel (`lib/atlasx-scan.js`, active when `PREMOVE_V2_MODE≠off`;
legacy funnel preserved under `off`): Pass A cheap PIT features for every
cached name with hard fail-closed eligibility (history/freshness/min-price/
observed liquidity/adjusted-history/bad-bar anomaly; unknown ⇒ ineligible with
reason); Pass B bounded specialists (momentum, compression-transition,
absorption, turnover-confirmed residual-inflection, first-pullback,
sector-diffusion, structured-catalyst, near-threshold, open episodes,
hash-deterministic stratified controls) with per-specialist AND per-band caps;
dedup preserves every selection reason; full funnel disclosure (pool, eligible,
ineligible-by-reason, per-specialist counts, duplicates merged, cap truncation,
missing/stale scopes, control coverage, residualization basis, complete/partial).

Corrections (each with a regression test): continuous compression values with
explicit versioned thresholds (`EXPERT_PARAMS`); structured catalyst + `asOf`
threaded to the catalyst expert (dateless/missing ⇒ abstain; **unknown surprise
⇒ neutral, reduced applicability — never bullish**); `riskOff` threaded (red-
tape expert live again; risk-off no longer abstains everything); sector via
`SECTOR_OF` + pool stats for non-Today candidates (unknown sector stays a
LABELED market-only residual); unknown liquidity → **micro** tier (most
expensive); transition sigmoid gains/offsets moved to versioned
`TRANSITION_PARAMS` (values byte-identical — no eyeball retune; overridable
only through the harness); scores remain non-probabilities pre-calibration;
conformal fail-closed abstention preserved.

### Phases 6–7 — Stage A/B
- `lib/premove-features.js` (premove-features-v1): 38-key versioned schema
  across all six groups; explicit missingness masks; decision-cutoff enforced;
  catalyst features from structured records only.
- `lib/premove-stage-a.js`: labels = LT2 competing-risk outcomes (censored
  excluded from training); deterministic ridge-logistic baseline (byte-identical
  refits, ≥20-row floor); `stageACrossSection` emits `preMoveRank` percentile +
  evidence band; a probability appears ONLY behind a valid calibration artifact.
  Gradient-boosted challenger = external blocker (no deps in runtime); harness
  accepts any `{fit,score}` challenger. No deep nets.
- `lib/premove-stage-b.js`: objective trigger (`premove-trigger-v1`: pivot break
  with close acceptance OR range-expansion + turnover confirmation; wick-tag
  rejected; gap>5% refused); conditional barrier probabilities from
  `coil-executable` (extended additively with `pTargetFirst/pStopFirst/
  pTimeout`), all labeled `model-estimate`; severe-loss, timeout, remaining
  opportunity, expected net R given fill; inspectable utility waterfall
  (reward − loss − transaction costs − slippage − uncertainty − opportunity −
  concentration = expected net utility). **No trigger ⇒ watch/wait.**

### Phases 8–9 — hierarchy, states, UI
Outputs stay separate and named (`preMoveRank`, `pTriggerBeforeInvalidation`,
`pFillGivenTrigger`, `pTargetBeforeStopGivenFill`, `expectedNetRGivenFill`,
`severeLossProbability`, `remainingOpportunity`, `expectedNetUtility`) — no
collapsed confidence anywhere. `lib/premove-inventory.js` derives
PRIMED/ARMED/TRIGGERED/ACCEPTED/WEAKENING/INVALIDATED/EXPIRED/COMPLETED from
the existing Swing Episode Supervisor lifecycle (no second state machine; the
supervisor's union + displacement codes already guarantee nothing disappears
silently). Cards carry a novice view (state/action/reason/invalidation/
timeframe) and an expert view (contributions, gated probabilities, waterfall,
costs, trigger+fill assumptions, missing features, displacement, versions,
shadow label). New 📡 Pre-Move tab (`public/js/premove.js`, swing-hub) renders
the server-authoritative board; probability display gated server-side via
`displayNumber` + `premoveGate`. **Day Trade UI untouched.**

### Phases 10–11 — learning loop + validation
- `op=premove` (read, cached) + `op=premovelog` (cron-only, on the `atlasx`
  warm chain after the episode ledger): IMMUTABLE write-once daily cross-section
  `premove/cross-section/<date>.json` — selected + rejected + control rows with
  full feature values, missingness masks, states, versions, eligible entry date.
  Cadence: daily capture (warm chain); weekly/monthly/quarterly follow the
  existing `validation-protocol.md` / `model-promotion-policy.md` (automatic
  demotion allowed; promotion ONLY by explicit artifact + review — the gate
  makes auto-promotion structurally impossible).
- `scripts/premove-validate.js`: exact-label-end purge + 3-bar embargo +
  date-grouped walk-forward (`lib/research/harness`) comparing the Stage-A
  challenger against mandatory baselines (residual momentum, compression,
  absorption); block-bootstrap CIs; ExperimentManifest with multiple-testing
  accounting (rankers × preregistered barrier variants); cost stress 1×/2× with
  an explicit honesty note (rank-IC is scale-invariant on the ±1 label — the
  BINDING cost stress is the net-R battery in leadtime2/coil-reliability);
  verdicts: `INSUFFICIENT DATA` / `NO EDGE` / `PROMISING BUT NOT SIGNIFICANT` /
  `CANDIDATE` (which still requires prospective sample + parity + an explicit
  promotion artifact).

## 3. Files changed

New lib: `premove-capture.js`, `premove-flags.js`, `premove-features.js`,
`premove-stage-a.js`, `premove-stage-b.js`, `premove-inventory.js`,
`premove-routes.js`, `leadtime2.js`, `leadtime2-routes.js`, `coil-capture.js`,
`coil-reliability.js`, `atlasx-scan.js`.
New scripts: `scripts/premove-validate.js`.
New UI: `public/js/premove.js`.
New tests: `ghost-standalone` (9), `leadtime2` (12), `coil-coverage` (5),
`premove-universe` (12), `premove-stages` (13), `premove-contracts` (3) — 54 tests.
Modified: `api/screener.js` (ghostTop PIT fields), `api/tracker.js` (op
registration), `lib/decision-normalizers.js` (+fromGhostTop),
`lib/apex-routes.js` (ghostlog), `lib/store.js` (ghostobs helpers),
`lib/screener-routes.js` (coiltick/coilbook), `lib/atlasx-universe.js`,
`lib/atlasx-engine.js`, `lib/atlasx-experts.js`, `lib/atlasx-transition.js`,
`lib/atlasx-routes.js`, `lib/atlasx-config.js`, `lib/coil-executable.js`
(additive fields), `lib/strategy-registry.js` (+premove shadow),
`lib/strategy-contracts.js` (+premove contract), `lib/warm-chains.js`
(+op=premovelog), `public/js/app.js`, `public/index.html`.

## 4. Feature and label definitions

- Features: `premove-features-v1` — 38 keys listed in
  `lib/premove-features.js FEATURE_KEYS`; all decision-cutoff-safe; missing
  masked, never imputed.
- Stage-A label: `premove-labels-v1` — per horizon H∈{5,10,21}, competing-risk
  event ∈ {up, down, timeout, censored} from LT2 barriers
  (`lt2-coilsigma-v1`: trigger = plan entry or vol-scaled; invalidation = plan
  stop or 1.25σ_H below; abnormal marker = 2.5σ_H residual).
- Stage-B label: actual execution policy (exec-v1 semantics: next-session
  stop-entry, gap-through at the worse open, no-fill on gap>5%, same-bar → stop),
  tier costs charged.

## 5. Current status: everything is SHADOW

| Surface | Status |
|---|---|
| Standalone Ghost inventory | shadow — observed + logged, never on the board |
| Lead-time v2 | measurement only (op=leadtime2); v1 preserved |
| Coil capture/reliability | observation expansion; ranking untouched |
| ATLAS-X two-pass universe + fixes | shadow system (registry `atlasx: shadow`) |
| Stage A / Stage B / inventory / tab | shadow, weight-zero, registry `premove: shadow` |
| Probabilities | none displayable — no calibration artifact exists |
| op=today / production ranks / Day Trade | byte-identical (tested under all modes) |

## 6. Test results

- Targeted suites: all new test files green (54 new tests).
- Full `node --test`: **2489 pass / 0 fail** (was 2435/0 at baseline, which
  already included the 26 uncommitted quant-redesign-3 tests).
- `npm run check`: clean. `node --input-type=module --check` on new/modified
  frontend modules: clean.
- No existing assertion weakened; Day Trade golden tests untouched and green.

## 7. Validation results actually obtained

- `node scripts/premove-validate.js --fixture` — the machinery detects a
  planted synthetic signal (challenger IC 0.156 vs best baseline 0.151 on
  identical exact-purged folds) → verdict `FIXTURE-POSITIVE — … says NOTHING
  about the market`. This validates the pipeline, not an edge.
- Live mode: **INSUFFICIENT DATA** (the immutable cross-section store starts
  accruing with the next warm-chain run). **No incremental edge over the simple
  baselines has been demonstrated. Nothing was promoted.**

## 8. Data limitations & remaining external blockers

- **Survivorship**: live paths replay present-day universe lists; the research
  PIT security master is not wired into the premove path yet — any future
  positive result stays PROVISIONAL until it is.
- **Gradient-boosted challenger** (CatBoost/LightGBM): no native deps in the
  serverless runtime — train offline, load via the artifact contract.
- **Earnings surprise / estimate revisions**: no point-in-time feed — the
  features exist in the schema and stay masked-missing.
- **Borrow/locate**: unchanged (fail-closed, longs-only here anyway).
- **History depth**: candle caches hold ~300 bars; deep training data must come
  from the research rig, not the live caches.

## 9. Commands

```
node --test                                   # full suite
node --test test/premove-*.test.js test/leadtime2.test.js test/coil-coverage.test.js test/ghost-standalone.test.js
npm run check
node scripts/premove-validate.js --fixture    # deterministic machinery proof
node scripts/premove-validate.js              # live (needs BLOB_READ_WRITE_TOKEN; INSUFFICIENT DATA until capture accrues)
# ops (deployed): op=premove · op=premovelog (cron) · op=leadtime2 · op=coiltick · op=coilbook · op=ghostlog
```

## 10. Explicit statement

**No new alpha was proven.** The redesign delivers discovery coverage,
measurement validity, fail-closed governance and a shadow learning loop. A
model may affect live recommendations only after it beats the mandatory
baselines on identical purged folds, cost-net, across regimes and cap bands,
survives doubled costs, passes calibration, accrues an independent prospective
sample with live-funnel parity, and receives an explicit, reviewable promotion
artifact. Until then: shadow, weight zero.
