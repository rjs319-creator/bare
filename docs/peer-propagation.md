# Peer Propagation Engine (peerprop-v1)

**Status: SHADOW.** Weight-0 in every live rank. Registered in `lib/strategy-registry.js`
(`id: peerlab`, section `PeerProp`) with explicit promotion criteria. Nothing in this
document claims validated alpha; the engine exists to accrue falsifiable prospective
evidence.

## What it does

Models each stock as a node in point-in-time peer networks and asks whether
information has begun propagating from related names toward it **before its own
tape makes that obvious**. This is not sector-relative strength (a stock vs its
sector ETF) and not RLT (a stock's own peer-rank *change*): the discovery object
here is the **gap between what a stock's peers/leaders have done and what the
stock itself has done** — `unreflectedPeerStrength`.

```
peerStrength            = robust (median/MAD) residual condition of the peer group
withinPeerPosition      = tie-aware percentile of the stock inside its peers
unreflectedPeerStrength = peerStrength − the stock's own normalized reaction
```

## Networks (Phase-3 order, honest availability)

| Network | Status | Source |
|---|---|---|
| Sector × liquidity-band peers | **live** | `lib/rlt-universe.buildPeerUniverse` (curated present-day sector map) |
| Statistical directed leader→follower graph | **live** | `lib/peerprop/graph.js` — residual lead/lag, PIT |
| Industry/subindustry peers | unavailable | no industry data source in the repo (no FMP profile feed wired) |
| Customer–supplier | **disabled flag** | no PIT relationship feed (LLM read-through exists separately, `lib/readthrough.js`) |
| Shared analyst coverage | **disabled flag** | historical coverage not on current data tier |
| 13F holdings similarity | **disabled flag** | Ultimate-tier gated |

Disabled networks are declared in `lib/peerprop/config.js NETWORKS` and reported in
every snapshot — never simulated.

## Directed graph (`lib/peerprop/graph.js`)

For ordered pairs inside one peer group (never market-wide all-to-all), on
**market/sector-residual** daily returns (betas from `lib/atlasx-residual`, series
from `lib/rlt-residual`) so shared beta cannot masquerade as propagation:

- lead correlation `corr(A residual at t−lag, B residual at t)`, lags 1..3;
- Fisher-z shrinkage toward 0 by `n/(n+60)` — short windows cannot mint edges;
- `minObs 60` aligned pairs or the edge does not exist;
- **antisymmetric gate**: `lead − follow` must clear a floor — the directional
  component is the alpha-relevant part; symmetric co-movement is rejected;
- top-8 edges per follower; group pairwise capped at 60 names by liquidity.

Per follower the engine reports weighted leader pressure, confirming-leader count,
impulse age, propagation decay, and a stage:
`EARLY → CONFIRMING → MATURE → LATE` (LATE demotes — chasing guard), `INVALID`
when the data basis is missing.

## PIT contract

Every observation carries `featureObservedAt` (= asOf data cutoff) and
`decisionTime`; bars are as-of sliced before every computation (test:
`peerprop-engine.test.js` proves a distorted future changes nothing). Ineligible
rows land in `excluded[]`/`invalid[]` with stable reasons (fail-closed
`rlt-universe` eligibility). The engine reuses the repo's existing PIT spine
(`lib/pit-contract.js`, `lib/research/schemas.js`) rather than duplicating it.

## Probabilities

**Withheld.** `probabilities` is null-with-reason until empirical out-of-fold
calibration on matured PeerProp ledger outcomes reaches
`CALIBRATION.minSamplesForPercent = 200` (then via `lib/orbit-calibration` +
`lib/omega-calibration.assessCalibration` display gates). A hand-written
score→probability map is forbidden by design.

## Validation & falsification (op=peerpropwf)

Purged walk-forward (`lib/research/harness`, exact label-end purge, embargo 5)
comparing on identical folds:

- `peer-propagation` (the engine score)
- `residual-momentum` (the generic-momentum null)
- `control-random`
- `peerprop-reversed-edges` — every leader edge flipped; a genuine directed signal must weaken
- `peerprop-random-peers` — deterministic group permutation; economically meaningless peers must be weaker

Verdict is **NO VALIDATED INCREMENTAL EDGE** unless the engine beats *all four*.
All runs stamp `survivorshipSafe:false` (present-day universe/sector map) → at
best PROVISIONAL, never production-eligible from backtests alone. The prospective
`PeerProp` Scoreboard section (EARLY/CONFIRMING picks, episode-deduped, cost- and
sector-benchmarked) is the deciding evidence.

## Companions shipped with it

- **Target factory** (`lib/research/target-factory.js`) — central challenger-target
  definitions on top of `lib/research/multi-horizon.js` rungs: raw / market-residual /
  sector-residual / cost-adjusted-residual / **rank-cost-residual** (preferred, to be
  validated, not assumed) / hybrid / target-before-stop (fails closed without a real
  path-dependent barrier).
- **Volume forecast** (`lib/volume-forecast.js`, op=volforecast) — next-session
  dollar volume, relative volume, empirical abnormal-session probability, capacity
  band and forecast cost tier from **volume+calendar features only** (structurally
  direction-blind; the repo measured volume-surge at rank-IC ≈ −0.004). Execution
  context only; annotated on peerprop candidates, never a rank input.
- **News underreaction** (`lib/underreaction.js`, op=underreaction) — prospective-only
  gap between LLM-structured semantic impact and the market/sector-adjusted reaction
  since the ORIGINAL publish timestamp (now persisted on evidence events with source
  records + extractor model/prompt version). No backfill path exists; events without
  timestamps report INSUFFICIENT_DATA.

## Known limitations

- Sector map is present-day and static; no PIT sector history exists (disclosed in
  every snapshot's caveats).
- Universe is survivorship-unsafe; candle cache caps history at ~14 months.
- Expanded-universe names without a sector become market-only observations and get
  no peer group.
- The RLT walk-forwards recorded NO EDGE twice for peer-rank-level features on this
  window — peer *propagation* is a different mechanism, but the prior is skeptical
  and the gate stays closed until the evidence says otherwise.
