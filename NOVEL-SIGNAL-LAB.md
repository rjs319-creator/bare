# Novel Signal Lab (`nsl-v1`)

An **additive, shadow-only** research lab that tests whether genuinely *different* information
adds predictive value **beyond everything the app already computes**. It changes **no production
recommendation**, writes **no production ledger**, and is behind a global kill-switch
(`NSL_DISABLED=true`). Every engine returns the same envelope and — critically — a missing data
source yields **`UNAVAILABLE` (score `null`)**, never a neutral zero.

## Why most of this is a thin delta

The app already contains the leakage/PIT spine (`lib/pit-contract.js`), negative controls
(`lib/orbit-controls.js`), matched-control estimation (`lib/component-lab.js`), purged group-aware
harnesses (`lib/research/*`), a security master and immutable ledger. The Novel Signal Lab
**reuses** those and only adds what was genuinely missing: the nine new signal *hypotheses* and
the incremental-value / invariance evaluators that judge them.

## The nine engines

| # | Engine | File | Data | Status here |
|---|--------|------|------|-------------|
| 1 | Securities-lending & short pressure | `lib/nsl/short-pressure.js` | **FINRA short interest (free)**; borrow-fee/utilization/FTD-history = **licensed** | **Usable (degraded)** — level + DTC real; informed/covering/borrow sub-signals `UNAVAILABLE` |
| 2 | Opportunistic insider conviction | `lib/nsl/insider-conviction.js` | **SEC EDGAR Form 4 (free)** | **Usable** — routine-vs-opportunistic classifier, cluster/dormancy detection |
| 3 | Predictable mechanical flow | `lib/nsl/mechanical-flow.js` | dividends/lockups feasible; index-recon & buyback = **licensed** | **Usable/experimental** — dividend & lockup flow; index/buyback `UNAVAILABLE` |
| 4 | Operating-activity nowcast | `lib/nsl/operating-nowcast.js` | job/app/web panels = **licensed** | **`UNAVAILABLE`** — clean provider interface only |
| 5 | Capital-structure divergence | `lib/nsl/capital-structure.js` | bond/CDS/ratings = **licensed** | **`UNAVAILABLE`** — clean provider interface + staleness gate |
| 6 | Accounting-transition forensics | `lib/nsl/accounting-forensics.js` | **SEC XBRL company-facts (free)** | **Usable** — accrual/revenue-quality/cash-conversion transitions, original vintage |
| 7 | Self-supervised representation | `lib/nsl/representation.js` | existing features | **Experimental** — frozen, cutoff-respecting linear autoencoder; no proven value |
| 8 | Counterfactual historical twins | `lib/nsl/twin.js` | existing resolved pool | **Usable** — k-NN analogs, out-of-support & sensitivity diagnostics |
| 9 | Invariant-mechanism selector | `lib/nsl/invariance.js` | resolved samples | **Usable** — cross-environment consistency, heterogeneity, fragility |

Contract & wiring: `lib/nsl/registry.js` (envelope + signal registry), `lib/nsl/providers.js`
(availability/licensing), `lib/nsl/incremental.js` (incremental-value evaluator),
`lib/nsl/stats.js` (rank-IC), `lib/nsl/lab.js` (orchestrator), `lib/nsl-routes.js` (route).

## The standard envelope

Every engine returns `makeEnvelope(...)`: `signal`, `signalVersion`, `engine`, `ticker`,
`securityId`, `asOf`, `inputs`, `sourceTimestamps`, `score`, `direction`, `confidence`,
`coverage`, `staleness`, `expectedDecay`, `historicalSupport`, `warnings`, `restrictions`,
`status` (`usable` | `unavailable` | `experimental`).

## Shadow API (read-only)

```
GET /api/tracker?op=nsl                       # lab status: engine/provider availability
GET /api/tracker?op=nsl&view=registry         # the nine-engine registry
GET /api/tracker?op=nsl&view=evidence&ticker=AAPL[&asOf=YYYY-MM-DD][&sharesOut=N]
```

`evidence` is the only view that touches the network (bounded to one ticker: SEC EDGAR + XBRL,
FINRA). Disable everything with `NSL_DISABLED=true`.

## Evaluating a signal (the decisive test)

A signal earns activation **only** if it improves the existing composite on untouched
cross-sections — never on a strong standalone result:

```js
const { evaluateIncremental } = require('./lib/nsl/incremental');
// samples: [{ date, baseline (existing composite), signal (new signal), outcome }]
const r = evaluateIncremental(samples, { variantsTested: N });
// r.baseline / r.augmented / r.alone / r.incremental  (per-date rank-IC + t)
// r.deltaIC, r.incrementalSignificant (Bonferroni over variantsTested), r.verdict
```

- `adds-incremental-value` → advance to prospective shadow (never straight to prod).
- `redundant-with-existing` → strong alone, adds nothing orthogonal → reject.
- `no-edge` / `inconclusive` → reject / observe.

Then require invariance (`evaluateInvariance`) across independently-chosen environments **before**
any promotion. Environments are supplied by the operator, chosen without viewing the final
holdout.

## Guarantees (enforced by tests — `test/nsl.test.js`, 21 tests)

- Missing provider ⇒ `UNAVAILABLE` (score `null`), never zero.
- Form 4 filed after `asOf` is invisible; short interest respects a ~12-day publication delay.
- XBRL restatements (later `filed`) never overwrite the original reported vintage.
- Twins use only pre-decision, already-resolved states; out-of-support is flagged.
- Invariance flags effects confined to one environment as fragile.
- Representation trains only on pre-cutoff rows, freezes, and hashes deterministically.
- Production recommendations are untouched; the whole lab disables via one env var.

## What would activate an engine

- **Engine 1 (full):** a securities-lending licence (Ortex/S3/IBKR) for borrow fee/utilization,
  plus SEC FTD file ingestion for covering/threshold status.
- **Engine 4:** a licensed alt-data panel (Revelio/LinkUp jobs, data.ai/Sensor Tower, Similarweb).
- **Engine 5:** issuer-level fixed-income pricing (TRACE/ICE, Markit CDS) + a ratings feed.
- **Engines 2/6/8/9:** already run on free data — they need only **prospective shadow evidence**
  of incremental value before any weight, which the evaluators above are built to produce.
