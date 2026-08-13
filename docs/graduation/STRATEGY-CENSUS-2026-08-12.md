# Non-Day-Trade Strategy Census — Shadow Strategy Graduation League (2026-08-12)

Produced by the graduation-league audit (7 read-only specialist passes: strategy-census,
data-lineage, quant-methodology, execution-accounting, baseline-falsification,
portfolio-redundancy, governance-red-team). This is the canonical inventory of every
non-Day-Trade algorithm, its runtime state, and its graduation disposition.

**Ground truth**: `lib/strategy-registry.js` — 58 entries: 3 `production`
(`screener`, `daytrade` [DT, out of scope], `ignition` — see disposition below),
49 `shadow`, 6 `informational`. `PROMOTION_CEILING` caps every non-DT strategy at
grade `promising` (no intraday-verified fill pipeline). Enforcement spine (verified
binding, fail-closed): strategy-registry → strategy-gate → eligibility (enforce
default) → maturity (FDR demote-only, noHistory ceiling) → governance (gov-v3,
artifact-gated) → governance-transitions (hash-chained ledger).

Registry ghosts (entries with no code): **none**. Orphans (code with no registry
entry): **EVOLVE, govdemand** — registered as part of this pass.

## Disposition legend

`retain-shadow` · `repair-as-new-version` · `baseline-only` · `retire-duplicate`
· `retire-harmful` · `insufficient-data` · `eligible-for-probation`.
Dispositions marked **(rec)** are recommendations that require an explicit
human-reviewed registry transition; nothing in this pass auto-promotes or
auto-retires. `production*` = outside the league (already promoted policy cohort),
listed for completeness.

## Census

| strategyId | aliases / version | family | registry | runtime (schedule / surface) | user-facing weight | disposition | reasons |
|---|---|---|---|---|---|---|---|
| screener | Breakout, screener-v2; promoted cohort = Early:large only | breakout/trend | production | api/screener 4 scopes, warmed; op=track ledger; Breakout tab; sole non-DT op=today originator candidate | highest non-DT (governance-conditional) | production* | Promoted cohort with prospective cost-net ledger (n=24 dates — thin); falsification gaps: no delisted-inclusive live replay, no excision/doubled-cost on live cohort |
| ignition | Momentum Ignition, ignition-v1 (swing; distinct from DT ignition-live) | early momentum | production → **shadow (this pass)** | op=ignitionlog/ignition (postdecision chain); Candidates tab | own tab only; not an op=today source | repair-as-new-version | Production maturity with future-tense criteria, no promotion artifact, no stored evidence (F-13/RT-09/F3, 3 agents) — demoted to shadow for registry consistency |
| ghost | Ghost Accumulation, ghost-v1 | volume-accumulation | **rejected (RETIRED 2026-08-13, owner decision, disposition cycle 1)** | historical ledger + Ghost tab remain as record; standalone op=ghostlog tick removed from the nightly chain | 0 everywhere; reads render as labeled context only | **retired-duplicate (EXECUTED)** | Measured independence credit 0.248 vs screener (corr 0.96); standalone hypothesis no-edge; insider-pillar history invalidated by filing-date look-ahead (F-1); accumulation evidence already on screener rows via evidenceOrigins.volumeAccum |
| custom (apex) | Adaptive Momentum, apex-v3 | learned momentum rank | shadow (demoted 2026-08-12, frozen benchmark) | op=apexlog/drift/model; Candidates tab | 0 (sizing suppressed; Prime badge gated this pass) | baseline-only | Frozen zero-weight benchmark; unledgered 625-trial weight search disqualifies historical evidence; no benchmark record (section:null); hand-synced client twin is a drift hazard |
| conviction | conviction-v1 | regime-gated ghost-pillar rank | shadow (frozen benchmark) | computed every screener scan; Edge Book Sleeve A | **was** 0.16 of Opportunities rank + badge (RT-01, fixed) | baseline-only | Registry forbids user-facing consumption; retained only as a logged shadow benchmark |
| downday | Down-Day Bounce, downday-v1 (+vreversal sub-study) | conditional mean-reversion | shadow (demoted 2026-08-11) | op=downdaytick; tab; op=today research lane | 0 | retain-shadow | Exact-contract experiment NOT PROMOTED (−0.04 matched-control); V-Reversal cell the only positive sub-claim, but its supporting report is missing (F-08 — downgraded to open) |
| gapgo | Gap & Go, gapgo-v1 / gapgo-orb-verify-v2 | event (gap continuation) | shadow | op=gapgotick/gapgoverify; tab; op=today research lane | 0 (suggestedRiskPct gated this pass — RT-03) | retain-shadow | Provisional hypothesis downgraded to open (missing evidence report, F-08); intraday-verified lane (gapgoverify) is the promotion venue |
| gapdown | gapdown-v1 | event short | shadow | ticks1; tab; op=today research lane | 0; shorts fail-closed NO_BORROW | retire-duplicate (rec) | Exact mirror of gapgo on shared primitives — parameterize side instead of a second engine |
| coil | Coil Radar, coil-v1 (+coil-reliability Stage-B) | compression | shadow | op=coiltick; tab; op=today research lane | 0 | retain-shadow | Provisional hypothesis downgraded to open (F-08); historical conviction rankers inverted → removed; trigger-basis delayed-fill stress never run |
| biotech | Biotech Radar, biotech-v1 | event/catalyst | shadow, lead-only contract | op=biotechtick/biotechgrade; tab; op=today research lane | 0; LEAD_ONLY | retain-shadow | Distinct catalyst data; XBI-benchmarked episode lane is the promotion venue; sector-control degeneracy (F-02) repaired this pass |
| coremo | Core Momentum, "stablecore" (ops corebuild/core/corelog/coredrift/coreperf) | 12-1 momentum book | shadow | ticks3; Portfolio tab + coreperf proof tab | 0 | repair-as-new-version | Accounting defects repaired this pass (resolved-only → MTM lane, gross → net, no delisting counter, retracted hardcoded baseline: EA-1..4, F-06); underlying signal falsified by survivorship-free research (IC≈0) — candidate for baseline-only after repair beds in |
| momentum | momentum-v2 (api/momentum.js) | intraday technical momentum | shadow | warmed endpoint; Portfolio-group tab | 0 (imperative gated) | retain-shadow | Universe fed by DT discovery (documented crossing #2 — isolation candidate); no benchmark separation from trend family |
| emergingleader | emergingleader-v1 | fresh-RS leadership | shadow | inside screener payload; shadow swingResearch lane | 0 | retain-shadow | Promotion = registry flip only; dedup vs screener enforced |
| trendrider | trendrider-v1 | trend posterior | shadow | ticks1; Candidates tab | 0 | insufficient-data | section never produces scoreboard rows → experimental forever until wired |
| aligned | Dual Confirmed, aligned-v1 | dual-horizon agreement | shadow | aligned chain; Candidates tab | 0 | retain-shadow | Composition of lookup reads; no independent evidence family |
| confluence | confluence-v1 (+confluence-marginal learner) | multi-strategy vote | shadow | ticks1; tab; leaderboard source | 0 (weights frozen) | retain-shadow | 4/5 voters one trend family; marginal learner's "cost-net" verdict never applied cost margin (PR-01, open) |
| fade | Overheated, fade-v1 | mean-reversion short / avoid filter | shadow | op=fadetick; tab | 0; avoid-only posterior | retain-shadow | Short-side avoid signal validated as filter only; API tradePlan language repaired this pass (RT-05) |
| events (CERN) | cern-v1 (+firesale feeder) | forced-flow event | shadow | op=cerntick (capture chain); lab tab | 0 | retain-shadow | Only positive research cell historically (forced-flow); 29% ungradeable-pick rate now measurable again (F-01 fix); family-map gap fixed (PR-02) |
| readthrough / anomaly / secondwave / crossasset / toneshift | *-v1 AI screeners | narrative/accumulation (LLM+tape) | shadow | nightly AI ticks; lab tabs; op=today research lanes | 0 | retain-shadow (consolidate anomaly+secondwave scaffolding, rec) | Near-identical pipelines differing in thresholds; micro-cap picks were costed at liquid tier (F-05, fixed); sector-control degeneracy (F-02, fixed) |
| tone / attention | tone-v1, attention-v1 | earnings tone / attention | shadow | ticks3 | 0 (attention annotates momentum/ignition) | retain-shadow | Ledgered, benchmarked, no separation yet |
| thesis | evidence-v1 | news→thesis engine | shadow | GH Action 22:30 UTC | 0 | retain-shadow | Distinct evidence family (news chains) |
| xalerts | alerts-v2 | social-alert leads | shadow | external pinger → op=alertsingest; capture chain grading | 0 | retain-shadow | Distinct source; fade-the-loudest short-side finding already governance-encoded as AVOID |
| challenger-decision | challenger-decision-v1 | 4-outcome meta | shadow | reprime + ticks3; API-only | 0 | insufficient-data | Eval harness defects (QM-2/QM-3: unapplied embargo, IID bootstrap CI) must be repaired before its evidence counts |
| orbit / orbit-ml | orbit-decision-v1, orbit-ml-model-v1 | residual drift / learned rank | shadow | reprime + ticks3; lab tab | 0 | baseline-only (rec) | Honest no-edge verdicts with negative controls (promo-v1); factor model is the repo's only cross-sectional residualizer — keep as infrastructure, not an alpha claim |
| omega | OMEGA-Swing, omega-swing-v2 | momentum continuation re-rank | shadow | postdecision; Candidates tab | 0 (educational size string — flagged PR-11) | baseline-only (rec) | Artifact-backed survivorship-free no-edge verdict (IC −0.027 vs momentum +0.029); the model citation pattern to copy |
| omega-ensemble | (orphan view; registered this pass) | ensemble projection | — → registered | op=ensemble; home tab | composition of ACTIONABLE-only inputs | retain-shadow | Pure view; "production (measured redundancy)" mode-string relabeled this pass (QM lead B) |
| EVOLVE | evolve meta-ensemble | meta | **unregistered → registered this pass** | own warm root; Markets tab | 0 (abstains on population) | retain-shadow | Was a user-visible orphan with TRADE/WATCH labels and no registry identity (F2); DSR-gated, uniqueness-weighted post-#332 |
| atlasx + premove | atlasx-v1, premove-stage-a-v1 | transition/survival ensemble | shadow | atlasx chain; tabs | 0 | retain-shadow | Active engineering (PRs #324/#327/#330/#331); own residualizer; section never produces scoreboard rows — wire before judging |
| rlt | rlt-v1 | leadership transition | shadow | rlt chain; lab tab | 0 | retain-shadow | Walk-forward no-edge so far; shares residual/barrier geometry with atlasx (declared overlap) |
| peerprop (peerlab) / underreaction | peerprop-v1, underreaction-v1 | graph / news-underreaction | shadow | peerprop chain | 0 | retain-shadow | Live WF no-edge; distinct graph data keeps it in the pool |
| gridlock | gridlock-v1 | physical-constraint vertical | shadow | gridlock chain; lab tab | 0 | retain-shadow | Genuinely distinct data (PJM/EIA/NWS) — least redundant family member |
| govdemand | USAspending vertical | gov-demand event | **unregistered → registered this pass** | govdemand chain nightly | 0 (API-only) | retain-shadow | Distinct data; was scheduled nightly with no registry identity (F2) |
| expgap | expectation-gap, expgap-v1 | macro reduce-only | shadow | expgap chain | 0 (annotation) | repair-as-new-version | Grading harness scores SPY against SPY (F-14) — structurally negative record; needs contract-metric grading before evidence accrues |
| cfl | cfl-v1 | counterfactual measurement | informational | cfl chain; lab tab | 0 (output-free) | retain-shadow | Measurement infrastructure; prosecutor battery has zero production callers (F-11, open) |
| psrl | persistent-staircase-v1 | continuity/leadership | shadow | psrl chain; lab tab | 0 | retain-shadow | Single evidence domain (price/volume), self-declared |
| chartpattern | pattern-decision-v2, Pattern Radar | structural patterns | shadow | pattern chains; tab; lookup panel | 0 | retain-shadow | Stateful episodes + fill-aware grading; section never produces scoreboard rows |
| volforecast | volfc-v1 | liquidity forecast | informational | on demand | 0, never directional | retain-shadow | Utility, not alpha |
| optionsflow | optionsflow-v1 | options positioning | shadow | warm PATHS | 0 | retire-duplicate (rec) | Superseded by v2 stack behind OPTIONS_V2_MODE; two options universes is one too many |
| optionsflow-v2 / putsell | v2 stack, putsell-v1 | options positioning / income | shadow | optionsv2 chain; lab + Portfolio tabs | 0 | retain-shadow | OI-confirmed episodes, immutable ledgers; VRP prereg pending reproducible evidence (F-08 residual) |
| lookup-intraday / lookup-swing / lookup-longterm | signal-v1 / swing-v1 / longterm-v1 | single-ticker reads | shadow (registered PR #323) | api/chart; lookup UI; dualread ledger grading | 0 (research vocabulary) | retain-shadow | Governance-aware since #323; graded via dualread |
| transparent | transparent-v1 | fixed-sign composite | shadow | ablation-only | 0 | baseline-only | Best falsification coverage in repo; full arm fails at top-book; residualMomentumOnly arm is the exposure-matched baseline of record |
| posterior-rank | posterior-rank-v1 | meta rank-influence | shadow | apply-sites in trend/confluence/downday | 0 boost while shadow; avoid-veto sanctioned | retain-shadow | Registry-contracted safety-veto pattern, correctly implemented |
| algo-router / algorithm-router | algo-router-v1, orbit-router-v1 | budget router | shadow | router chain / op=algorithmrouter | 0 (bindingReady false) | retire-duplicate (rec: keep algo-router-v1) | Two implementations, drifted constants (PR-08) |
| baselines / trend-core / techstrats | display scorecard / consolidator / detectors | baseline / meta | shadow-informational | op=baselines etc. | 0 | baseline-only; techstrats retire-duplicate (rec) | techstrats consumed only by apex-routes; equal-weight & random baselines are asserted, never measured (F-12, open) |
| nsl (9 engines) | novel-signal lab | various | closed arc | op=nsl, kill switch | 0 | retired (already) | All no-edge; arc closed |
| ephemeral / vrp / alphabook / edge book / timing / whynow / horizon-synthesis / brief / crowd / tape / alertfeed / predmarkets | research & composition surfaces | meta/informational | mostly unregistered minor surfaces (F5) | various ops | 0 / annotation | retain-shadow | Presentation-honest; registration backlog noted |
| one-shot studies: pead, pcarry, longshort, exits, firesale, moverstudy, congress, revisions, vreversal | research ops | various | n/a (EXPENSIVE_OPS) | on demand | 0 | insufficient-data | op=exits / op=longshort lack honesty stamps (EA-14, open); revisions vendor-PIT unproven (F-4 lineage) — blocked as promotion evidence |
| Market Pulse | pulse (v1 legacy) + pulse2 3-speed | informational | informational | pulse/pulse2 chains + GH Action | 0 | retain-shadow | v2 freshness/provenance verified honest; v1 fallback + sitewide 4h footer repaired this pass (F-6/F-7) |
| sectors / rotation / news / gameplan / forecast | informational | — | informational | various | 0 | retain-shadow | Never graded/sized |

## Duplicate / correlated family map

- **Price-trend cluster** (one family, measured): screener ⊃ {ghost 0.96-corr, apex,
  conviction, techstrats, trendrider, emergingleader, momentum, coremo, ignition,
  omega re-rank, confluence 4/5 voters, trend-core}. Only screener carries live weight.
- **Compression**: coil, chartpattern, psrl (single evidence domain).
- **Event/mean-reversion**: gapgo ≡ gapdown (mirrors), downday ⊃ vreversal, fade,
  cern ⊂ firesale feeder, biotech, expgap-events.
- **LLM narrative**: anomaly ≈ secondwave (same pipeline), crossasset, readthrough
  (seeds off gapgo movers), underreaction, toneshift, tone.
- **Graph/relational**: atlasx ~ rlt (shared residualizer + barrier geometry),
  peerprop (imports rlt universe), gridlock, govdemand (distinct data).
- **Options**: optionsflow-v1 (superseded) → optionsflow-v2, putsell.
- **Meta**: evolve, omega-ensemble, challenger-decision, algo-router ≡
  algorithm-router (duplicate), cfl, adaptive-layers (FREEZE), posterior-rank.
- Four family vocabularies coexist (SOURCE_FAMILY, STRATEGY_FAMILY,
  SOURCE_SPECIALIST, confluence map) — drift between them caused the CERN
  family-credit gap (PR-02, fixed this pass for SOURCE_FAMILY coverage).

## Known DT → non-DT influence crossings (reported, NOT modified — DT untouched)

1. op=today merges the pinned `daytrade` source (decision-routes.js:87,525).
2. momentum-v2 universe from DT CUSUM discovery (api/momentum.js:133).
3. EVOLVE specialist mapping `daytrade:'momentumIgnition'` (evolve.js:62).
4. pulse2 market state uses intraday-features (pulse2-market-state.js:14).
5. Shared DT feature helpers (dayMetrics/atr/ema/orbLevels) imported by gapgo,
   gapdown, confluence, moverstudy, anomaly/biotech/crossasset/readthrough/
   secondwave routes, sectionscore.
6. DT infra as shared plumbing (lowfloat-config/store, runner-dud HORIZONS,
   daytrade-config FRESHNESS, intraday-schema/capture) in float-data,
   tradable-universe, mover-discovery, position-sizing, catalyst-context,
   supply-risk, large-mover-audit, outcome-grade, freshness, microstructure,
   capture-routes.
7. tech-command consumes the frozen DT engine read-only.

Isolation of (2) — giving momentum-v2 its own discovery universe — is the one
crossing whose removal would change non-DT behavior without touching DT code;
deferred to a future pass with its own test plan.
