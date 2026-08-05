# Non-Day-Trade Signal Inventory (generated)

> **Generated** by `node scripts/build-signal-inventory.js` from the registry, the outcome
> contracts, the presentation roles and the eligibility rules. Do not hand-edit — regenerate.
> Day Trade appears once for completeness and is FROZEN (excluded from the redesign).

Signal strategies: **43** (non-Day-Trade: **42**).
Static production: **6**
(non-Day-Trade: **5**) ·
shadow/research: **37**.
Formal outcome contracts: **28**.
Pipelines with DERIVED verified fills: **0**.

## 1. Identity, contract and execution

| id | scoring version | side | horizon | metric | policy cohort | decision basis | entry contract | stop / target / time exit | benchmark |
|---|---|---|---|---|---|---|---|---|---|
| screener | screener-v1 | long | swing | 5d | Breakout / Setup / Early | EOD close of the signal session | next-session-open | published stop / published target / 63s | SPY+sector |
| momentum | momentum-v2 | long | intraday | 1d | momentum | EOD close of the signal session | next-session-open | daily swing stop (display context) / daily swing resistance (display context) / 1s | SPY+sector |
| ghost | ghost-v1 | long | swing | 5d | GHOST / STALKING | EOD close of the signal session | next-session-open | structure stop / none / 63s | SPY+sector |
| gapgo | gapgo-v1 | long | intraday | 1d | TAKE | EOD post-close (nightly ledger tick; dataCutoffSession = signal session) | stop-through-trigger (gap-through = worse fill) | below opening range low / measured-move target / 1s | SPY |
| daytrade | daytrade-v2 | long | intraday | 1d | (all non-research tiers) | EOD close of the signal session | per Day Trade engine | per Day Trade engine / per Day Trade engine / 1s | SPY |
| coil | coil-v1 | long | swing | 5d | high | EOD close of the signal session | conditional on trigger | published stop / published target / 21s | SPY+sector |
| custom | apex-v3 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | next-session-open | structure stop / model target / 63s | SPY+sector |
| biotech | biotech-v1 | long | swing | 5d | Hot | EOD close of the signal session | lead-only | none / none / 21s | XBI+SPY |
| downday | downday-v1 | both | swing | 3d | WATCH / EMERGING / CONFIRMED | EOD close of the signal session | next-session-open | published stop / published target / 3s | SPY+sector |
| ignition | ignition-v1 | long | swing | 5d | IGNITION | EOD close of the signal session | next-session-open | trailing structure / none / 10s | SPY+sector |
| coremo | coremo-v1 | long | portfolio | 3m | (all non-research tiers) | EOD close of the signal session | quarterly rebalance at open | none (rebalance drop) / none / 63s | SPY |
| emergingleader | emergingleader-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| trendrider | trendrider-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | next-session-open | none published (book grades a naked 21-session hold) / none / 21s | SPY+sector |
| aligned | aligned-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | next-session-open | published stop (display only — NOT graded) / published measured-move target (display only — NOT graded) / 21s | SPY+sector |
| confluence | confluence-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | pullback-limit (displayed) / next-session-open (graded intent) | published ATR stop (display only — NOT graded) / published 2R target (display only — NOT graded) / 21s | SPY+sector |
| chartpattern | pattern-decision-v2 | both | swing | 5d | (all non-research tiers) | EOD close of the signal session | conditional stop-entry (fill-aware episode grading) | frozen episode invalidation level / frozen measured-move target / 21s | SPY+sector |
| fade | fade-v1 | short | swing | 5d | (all non-research tiers) | EOD close of the signal session | next-session-open | published stop / published target / 5s | SPY |
| gapdown | gapdown-v1 | short | intraday | 1d | (all non-research tiers) | EOD close of the signal session | stop-through-trigger | above opening range high / measured move / 1s | SPY |
| events | cern-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | next-session-open | none / decay-curve exit / 42s | SPY |
| readthrough | ReadThrough-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | lead-only | none / none / 42s | SPY+sector |
| anomaly | Anomaly-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | lead-only | none / none / 42s | SPY+sector |
| secondwave | SecondWave-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | lead-only | none / none / 42s | SPY+sector |
| crossasset | CrossAsset-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | lead-only | none / none / 42s | SPY+sector |
| toneshift | ToneShift-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | lead-only | none / none / 42s | SPY+sector |
| tone | tone-v1 | long | position | 1m | (all non-research tiers) | EOD close of the signal session | lead-only | none / none / 42s | SPY+sector |
| attention | attention-v1 | long | swing | 5d | (all non-research tiers) | EOD close of the signal session | lead-only | none / none / 21s | SPY |
| thesis | evidence-v1 | — | position | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| xalerts | alerts-v2 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| challenger-decision | challenger-decision-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| orbit | orbit-decision-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| orbit-ml | orbit-ml-model-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| gridlock | gridlock-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| omega | omega-swing-v2 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| atlasx | atlasx-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| premove | premove-stage-a-v1 | long | swing | 5d | (all non-research tiers) | EOD close of the signal session | conditional stop-entry (exec-v1 semantics; gap-through at the worse open) | invalidation level (plan stop or vol-scaled) / plan target or vol-scaled abnormal level / 21s | SPY+sector |
| rlt | rlt-v1 | long | swing | 5d | (all non-research tiers) | EOD close of the signal session | conditional stop-entry (exec-v1; gap-through at the worse open; no-fill honest) | pivot minus 1 ATR (leadership-structure invalidation) / pivot plus 1.5 ATR (barrier geometry shared with ATLAS-X) / 10s | SPY+sector |
| peerlab | peerprop-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| underreaction | underreaction-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| expgap | expgap-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| confluence-marginal | confluence-marginal-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| posterior-rank | posterior-rank-v1 | — | swing | — | (all non-research tiers) | EOD close of the signal session | — | — | — |
| optionsflow | optionsflow-v1 | both | swing | 5d | (all non-research tiers) | EOD close of the signal session | lead-only | none / none / 21s | SPY |
| putsell | putsell-v1 | — | position | — | (all non-research tiers) | EOD close of the signal session | — | — | — |

## 2. Evidence, status and reach

| id | evidence source | fill verification | static status | identity class | display lane | may originate? | may size? | on the Today board? | presentation role |
|---|---|---|---|---|---|---|---|---|---|
| screener | Scoreboard section `screener` | no (derived — fails closed) | production | CANONICAL | executable (if plan + liquidity + fresh data) | yes (subject to governance + data gates) | yes (subject to plan + liquidity) | yes | Candidate prioritization / watchlist |
| momentum | Scoreboard section `momentum` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Baseline / research |
| ghost | Scoreboard section `Ghost` | no (derived — fails closed) | production | CANONICAL | executable (if plan + liquidity + fresh data) | yes (subject to governance + data gates) | yes (subject to plan + liquidity) | yes | Overlay (annotation on another strategy) |
| gapgo | Scoreboard section `GapGo` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | yes | Research challenger (prospective) |
| daytrade | Scoreboard section `daytrade` | no (derived — fails closed) | production | CANONICAL | executable (if plan + liquidity + fresh data) | yes (subject to governance + data gates) | yes (subject to plan + liquidity) | yes | Baseline / research |
| coil | Scoreboard section `coil` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | yes | Watchlist detector |
| custom | own ledger / not in the Scoreboard | no (derived — fails closed) | production | CANONICAL | executable (if plan + liquidity + fresh data) | yes (subject to governance + data gates) | yes (subject to plan + liquidity) | no (own tab only) | Baseline / research |
| biotech | Scoreboard section `Biotech` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | yes | Lead (information, not a trade plan) |
| downday | Scoreboard section `DownDay` | no (derived — fails closed) | production | CANONICAL | executable (if plan + liquidity + fresh data) | yes (subject to governance + data gates) | yes (subject to plan + liquidity) | yes | Conditional sleeve |
| ignition | Scoreboard section `Ignition` | no (derived — fails closed) | production | CANONICAL | executable (if plan + liquidity + fresh data) | yes (subject to governance + data gates) | yes (subject to plan + liquidity) | no (own tab only) | Baseline / research |
| coremo | Scoreboard section `CoreMomentum` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | yes | Baseline / research |
| emergingleader | Scoreboard section `EmergingLeader` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | yes | Baseline / research |
| trendrider | own ledger / not in the Scoreboard | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Baseline / research |
| aligned | own ledger / not in the Scoreboard | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Baseline / research |
| confluence | own ledger / not in the Scoreboard | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Baseline / research |
| chartpattern | Scoreboard section `Pattern` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Lead (information, not a trade plan) |
| fade | Scoreboard section `Fade` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Baseline / research |
| gapdown | Scoreboard section `GapDown` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | yes | Baseline / research |
| events | Scoreboard section `CERN` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Baseline / research |
| readthrough | Scoreboard section `ReadThrough` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | yes | Lead (information, not a trade plan) |
| anomaly | Scoreboard section `Anomaly` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | yes | Baseline / research |
| secondwave | Scoreboard section `SecondWave` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | yes | Baseline / research |
| crossasset | Scoreboard section `CrossAsset` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | yes | Baseline / research |
| toneshift | Scoreboard section `ToneShift` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | yes | Baseline / research |
| tone | Scoreboard section `Tone` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | no (own tab only) | Baseline / research |
| attention | Scoreboard section `Attention` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | no (own tab only) | Baseline / research |
| thesis | Scoreboard section `Evidence` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| xalerts | own ledger / not in the Scoreboard | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| challenger-decision | Scoreboard section `Challenger` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| orbit | Scoreboard section `Orbit` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| orbit-ml | Scoreboard section `OrbitMl` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| gridlock | Scoreboard section `Gridlock` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| omega | Scoreboard section `OMEGA` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| atlasx | Scoreboard section `AtlasX` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| premove | Scoreboard section `PreMove` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Baseline / research |
| rlt | Scoreboard section `Rlt` | no (derived — fails closed) | shadow | CANONICAL | research | NO | NO | no (own tab only) | Baseline / research |
| peerlab | Scoreboard section `PeerProp` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| underreaction | Scoreboard section `Underreaction` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| expgap | Scoreboard section `ExpGap` | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| confluence-marginal | own ledger / not in the Scoreboard | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| posterior-rank | own ledger / not in the Scoreboard | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |
| optionsflow | Scoreboard section `OptionsFlow` | no (derived — fails closed) | shadow | CANONICAL | qualified lead / research | NO | NO | yes | Lead (information, not a trade plan) |
| putsell | own ledger / not in the Scoreboard | no (derived — fails closed) | shadow | LEGACY_CONTEXT | research | NO | NO | no (own tab only) | Baseline / research |

## 3. Central control points (no strategy may bypass these)

| Stage | Module | What it enforces |
|---|---|---|
| source data → freshness | `lib/data-gates.js` | required bar, information cutoff, universe coverage, reference feeds, liquidity coverage — BEFORE ranking |
| score comparability | `lib/score-normalize.js` | within-source percentile / neutral shrink; frozen source priors; dependence-discounted, capped merge |
| eligibility | `lib/eligibility.js` | three-class taxonomy, borrow gate, conditional-context gate, lead-only, reduce-only, sizing discipline |
| ranking | `lib/decision.js` | cost-net expectancy tilt, regime fit, execution quality, evidence breadth, score decomposition |
| sizing set | `lib/decision-routes.js` + `lib/decision-portfolio.js` | portfolio, Book and opportunity density are built from ACTIONABLE + sizing-eligible rows ONLY |
| evidence identity | `lib/evidence-identity.js` | 11-axis canonical key; incomplete identity ⇒ LEGACY_CONTEXT (cannot govern) |
| statistics | `lib/evidence-stats.js` | one deduplicated date series, HAC, block bootstrap, effective sample size, block stability, FDR |
| grade | `lib/maturity.js` | cost-net + sector + sample + effective-sample + block gates; derived fill verification |
| clearance | `lib/governance.js` + `lib/promotion-artifact.js` | semantic artifact validation, identity binding, grandfather reduce-only + expiry |
| episodes | `lib/episode-ledger.js` | one executable-episode schema, attrition by reason, leakage refusal, reconciliation |
| learning | `lib/champion-challenger.js` | automatic demotion allowed; automatic promotion structurally impossible |

## 4. Known bypass risks (checked)

- **Own-tab books** (Trend Rider, Dual Confirmed, Confluence, and every shadow engine) keep their
  own ledgers. They are registered, contracted and weight-0; they cannot reach the Today board
  (`onBoard: no`), so they cannot originate or size a live position.
- **Day Trade** is pinned in `lib/eligibility.js` and `lib/score-normalize.js` by user directive:
  static production status only, scores passed through untouched, excluded from the data gate.
- **Informational surfaces** (sectors, rotation, news, pulse, game plan, forecast) are `kind:
  'informational'` — never graded, never sized, never in the lab.

## 5. Maturity gate constants (single source)

| Gate | Value |
|---|---|
| resolved episodes for Validated | 50 |
| independent decision dates | 20 |
| EFFECTIVE (autocorrelation-adjusted) dates | 12 |
| positive chronological blocks (of 4) | 3 |
| sample for a protective Disabled verdict | 20 |
