# Swing Screener Replay v3 — Architecture & Contracts

2026-08-03. Companion study: `research/SWING-SCREENER-VALIDATION-V3-2026-08.md`.

## Why this exists

The legacy `/api/backtest` replays the raw per-ticker pattern evaluator
(`evalSetupAt`) — no RS-vs-SPY gate, no 50/200 trend eligibility, no same-date
cohort percentiles, no quant composite, no cap/buffer, no liquidity floor, no
regime admission, no dedup. It validates a **different strategy** than
production selects, so its responses are now stamped
`historicalLiveParity:false, promotionBlocked:true` with the explicit mismatch
list. Replay v3 is the production-parity harness that replaces it for any
validation claim.

## Architecture

```
api/screener.js  (live route: fetch/cache, enrichment, ghost, response)
      │  calls
      ▼
lib/swing-screener-engine.js       ← ONE shared selection implementation
  1. cohort freshness gate          (lib/cohort-freshness — defect #3)
  2. liquidity floor / scope rules  (SCOPE_CONFIG — exact live thresholds)
  3. same-date cohort percentiles + quant composite (DEFAULT_WEIGHTS)
  4. market regime (SPY 200-DMA + breadth)
  5. admission: status gate + regime/macro-gated emergingLeader arm
  6. deterministic buffer selection (composite desc, ticker asc)
  7. reason-coded rejection for EVERY evaluated name
      ▲  calls (same code, point-in-time inputs)
lib/swing-replay-v3.js             ← date-first historical replay
  • PIT slice per ticker (bars ≤ decision session; future bars unreachable)
  • full contemporaneous cohort: selected + near-miss + rejected + controls
  • candidate-set hash per session (parity primitive)
  • next-open + slippage fills (lib/execution-policy) — the signal-day close
    is never an executable fill
  • base / doubled-cost / stressed-liquidity nets (lib/research/execution),
    participation guard, gap-through-stop graded stop-first (conservative)
  • raw + SPY-excess, MAE, MFE, target-before-stop at 5/10/21/63 sessions

lib/swing-candidate-schema.js      ← stable schema + deterministic identity
research/65-swing-replay-validation.js ← immutable artifact-writing study
```

Per-ticker features come from `lib/screener.screenTicker` (pure) in both paths.

## Live/replay contract

- `candidateId = sha256(strategyId|scoringVersion|universeScope|ticker|decisionCutoff|side|horizon)` (24 hex chars).
- `candidateSetHash = sha256(sorted candidateId list)` — order-independent.
- The live route publishes `selection.candidateSetHash` on every `/api/screener`
  response; replay publishes the same hash per session. **Any mismatch on a
  frozen session fails parity** (`test/swing-replay-v3.test.js`).
- Known replay limitation (stated, never imputed): the live macro (VIX/credit)
  overlay has no PIT history, so replay runs `macroRiskOff:false` unless a PIT
  series is supplied. The SPY-200DMA/breadth regime gate **is** replayed exactly.
  A parity comparison must feed both sides the same macro input.

## Candidate schema (`swing-candidate-v3`)

Every evaluated candidate — selected, near-miss, rejected, control — becomes a
frozen observation: identity fields, `status`, canonical `rejectionCode`,
decision price + cutoff, decision-time `features` + `missing` mask, `plan`
(entry/stop/target/rr), `rankScore` + cohort percentile, `displayed`/`displayRank`,
regime + sector context, `sourceFreshness`, `modelVersions`, `evidenceClass`.

Canonical rejection codes: `stale-data, future-dated-data, missing-history,
missing-benchmark, liquidity, live-trend-gate, relative-strength-gate,
below-selection-cap, risk-off, event-risk, invalid-trade-plan, governance,
duplicate, deadline-truncated, missing-scope-cache, no-qualifying-setup`.

## Freshness contract (defect #3)

- Shards stamp **per-entry provenance** (`p`: sourceFetchedAt, shardGeneratedAt,
  sourceScope, priceBasis, adjustment). Compile (`lib/universe-routes
  mergeShards`) is deterministic (newer last bar wins; tie → newer fetch) and
  can only ever carry a shard's own attestation forward — **compilation can
  never upgrade an entry's freshness**. Legacy entries decode with
  `lastBarDate` derived from their final candle.
- Every cross-sectional scan resolves ONE authoritative decision session from
  the benchmark calendar (`lib/cohort-freshness`); classes: `current`,
  `prior-session`, `stale`, `future-dated`, `missing`. Only `current` rows enter
  percentiles/selection; the rest are retained as reason-coded diagnostics with
  counts on the response (`freshness` block). No benchmark axis → the scan is
  flagged `adjudicated:false` instead of guessing.

## Evidence identity (defect #5)

`lib/evidence-identity.js`: realized-outcome evidence keys on
`strategyId + scoringVersion + universeScope + setupTier + horizon + side`
(+ summary-level executionPolicyVersion/labelVersion). The Scoreboard groups and
episodes now carry `scope`; `scoreboard/summary.json` declares
`evidenceKeyVersion: 'scoped-v1'`, and `expectancyFor` enforces the scoped join —
a large-cap record can never tilt a small/micro/expanded candidate. Legacy
(pre-contract) summaries resolve as before and are context only. Pooling across
scopes is off **as data** (`MAY_POOL_SCOPES=false`) pending a formally validated
hierarchical model.

## Shadow vs production rules

- **Standalone Emerging Leaders** (defect #1): captured via
  `mapEmergingLeaderRows` into the op=today `swingResearch` lane and logged to a
  scoped `EmergingLeader` Scoreboard identity; the live-merge adapter
  (`fromEmergingLeader`) consults only the strategy registry
  (`emergingleader`, shadow) — no UI flag can promote it. A name that also
  carries a production status is represented by the one screener signal
  (`alsoEmergingLeader` metadata; no extra family, no confidence boost).
- **Micro/expanded scopes** (defect #4): observed into the same research lane,
  one deduplicated inventory (authority large > small > biotech > micro >
  expanded), duplicates and board overlaps retained with reason codes; they
  cannot change production ranks before promotion.
- **Confluence** (defect #6): live per-strategy weights frozen at equal; the
  full-credit EWMA is a diagnostic; the shadow marginal learner
  (`lib/confluence-marginal.js`, `op=confluencemarginal`) needs a `PASS`
  artifact AND a registry flip of `confluence-marginal` before learned weights
  can return.
- **Probabilities** (defect #7): `lib/rank-semantics.describeRank` — probability
  is null unless out-of-fold calibrated for one named outcome with an artifact
  version and validated sample; scores structurally cannot populate probability
  fields; the UI shows “Probability unavailable — evidence building”.
- Promotion for anything here is a strategy-registry maturity flip gated by
  `PROMOTION_GATE` — never a wording, UI, or script change. Self-learning may
  demote/reduce (router cooldown, governance) but can never auto-promote.

## Reproduce

```
npm test                                  # full suite (incl. the 20 audit tests)
node research/65-swing-replay-validation.js --step 5 --maxNames 2000
# artifacts → research/data/swing-replay-v3/{manifest,per-date-metrics,verdicts}.json
```
