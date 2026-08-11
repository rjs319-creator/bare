# Counterfactual Opportunity & Forecastability Lab — Pipeline Audit (Phase 1)

Date: 2026-08-09 · Status: implementation design record · System code name: **CFL** (`lib/cfl/`)

This is the Phase-1 audit behind the CFL build: a stage-by-stage map of the live swing
decision pipeline, what each stage records, what can be reconstructed historically, and
where the false-negative blind spots are. Architecture/operating doc:
`docs/counterfactual-opportunity-lab.md`.

## 1. Pipeline map (swing/breakout lane)

```
Data acquisition        lib/screener.js fetchDailyHistory (Yahoo v8, 10s timeout, no retry;
                        null if <60 bars) → lib/candle-cache.js candles/<scope>.json
Universe eligibility    lib/universe.js curated lists (NOT versioned, NOT point-in-time)
                        + auto-built `expanded` (universe-routes: MIN_DOLLAR_VOL 2M,
                        MIN_PRICE 3, MIN_BARS 200, cursor-scanned shards)
Feature construction    lib/screener.js screenTicker (pure; factors/metrics/criteria/
                        filters/levels; missing SPY ⇒ rs gate fails closed)
Candidate generation    lib/swing-screener-engine.js selectCandidates
+ ranking               (freshness gate → liquidity floor → percentiles → composite →
                        regime → admission → deterministic sort, cap+buffer)
Risk gates              engine: risk-off veto on emerging arm; board (op=today):
                        lib/eligibility.js fail-closed classes ACTIONABLE/QUALIFIED_LEAD/
                        RESEARCH + lib/governance.js gov-v3 clearedWeight
Alert decision          breakout screener: NONE (no alert layer). Tech Command: 11 rules.
                        Web push: day-trade lane only.
Displayed rec           client re-ranks (public/js/app.js: localStorage weights, regime
                        penalty 0.65/0.80, display caps) — diverges from server hash
Executable entry        lib/execution-policy.js exec-v1 NEXT_OPEN_PLUS_SLIPPAGE
                        (+ lib/costs.js cost-v2 tiers)
Outcome grading         lib/outcome.js resolveTrade (WIN/LOSS/EXPIRED, same-bar → STOP),
                        lib/apex-routes.js runScoreboard (1d..63d fwd returns, net/excess,
                        MFE/MAE), research/lib/outcome-v3.js (fail-closed delisting states)
```

Timestamps: decision cutoff is the adjudicated benchmark session close
(`lib/cohort-freshness.js`); earliest executable is the next session open (exec-v1 emits
`featureCutoffAt / signalGeneratedAt / earliestExecutableAt / assumedFillAt` explicitly).

## 2. What each stage persists today

| Stage | Persisted? | Where | Gap |
|---|---|---|---|
| Data acquisition | ✗ per-ticker failures | logs only | no fetch-failure ledger |
| Universe | partial | `universe/candidates.json` (current only) | no dated vintages for large/small/micro |
| Features | ✗ | — | replay-only |
| Candidate gen + rank | ✗ (live) | HTTP response only; `sel.rejections` capped at 50 then discarded | **the central gap** |
| Selections | thin | `picks/<date>.json` (9 fields: no features, no rank, no candidateId) | scoreboard evidence base is this |
| Risk gates | ✗ history | `governance/latest.json` overwritten daily | no eligibility vintages |
| Alerts | n/a (screener) | — | no alert layer exists for this lane |
| Display | ✗ | client-side only (localStorage weights/filters) | server hash ≠ what user saw |
| Entry | ✓ (replay/scoreboard) | pure exec-v1 | — |
| Outcomes | ✓ | scoreboard summary, swing ledgers | — |

## 3. Reconstructability

- **Reconstructable exactly**: features (`screenTicker` pure on sliced bars), candidate
  generation + ranking (`selectCandidates`, deterministic tie-break; parity proven via
  `candidateSetHash` published on every live response), regime (SPY 200DMA + breadth),
  entry model, outcome grading. Vehicle: `lib/swing-replay-v3.js` (~43 s for 2,000 names ×
  186 sessions, measured in `research/data/swing-replay-v3/manifest.json`).
- **NOT reconstructable**: macro risk-off overlay (no PIT VIX/credit series → replay pins
  `macroRiskOff:false`, documented), universe membership vintages for curated scopes
  (survivorship — candles fetched today, delisted names absent), governance/eligibility
  state (mutable singleton), client display filters.
- **Consequence for CFL**: retrospective miss attribution is valid for stages
  features→ranking; universe/data attributions on historical dates carry a
  `survivorshipSafe:false` caveat and are reported as RESEARCH evidence only.
  Prospective attribution (from live decision snapshots captured at decision time)
  is clean for all stages.

## 4. Recorded-rejection gaps closed by CFL

1. Live screener rejections (reason-coded per name in the engine) were discarded after the
   HTTP response → CFL captures a full decision snapshot at warm time
   (`cfl/v1/decisions/<scope>-<date>.json`) before any truncation.
2. `picks/` has no rank/features/cohort context → decision snapshot carries per-name
   status, rejection code, rank, score, percentile and the cohort hash.
3. No market-wide false-negative scan for the swing lane (the day-trade lane has
   `lib/large-mover-audit.js`; nothing equivalent exists at 5/21/63-session horizons) →
   `lib/cfl/reconstruct.js`.
4. No deterministic failure taxonomy for swing misses/duds → `lib/cfl/taxonomy.js`.
5. No forecastability/abstention layer decoupled from EVOLVE's ensemble →
   `lib/cfl/forecastability.js`.

## 5. Existing infrastructure CFL reuses (no duplicates built)

- Selection + replay: `lib/swing-screener-engine.js`, `lib/swing-replay-v3.js`
  (`sliceAsOf`, `replayDate`), `lib/swing-candidate-schema.js` (REJECT vocabulary,
  candidateId).
- Entry/costs: `lib/execution-policy.js` (exec-v1), `lib/costs.js` (cost-v2),
  `lib/research/execution.js` (executableOutcome).
- Outcomes: `lib/outcome.js` resolveTrade (dud grading of the historical picks ledger).
- Stats: `lib/stats.js` (wilson), `lib/evidence-stats.js`, `lib/research/stats-v3.js`.
- Controls/prosecution: `lib/orbit-controls.js` battery + `lib/pit-contract.js`
  forward-leak detector + `lib/evolve-dsr.js` (composed by `lib/cfl/prosecutor.js`).
- Conformal: `lib/atlasx-utility.js` conformalInterval (honest fallback when OOF
  residuals are thin).
- Governance: `lib/strategy-registry.js` (CFL registered shadow, weight 0),
  `lib/maturity.js` / `lib/governance.js` promotion machinery (untouched).
- Storage/jobs: `lib/store.js` readJSON/writeJSON, warm-chains root-chain pattern,
  fundbuild caller-cursor backfill pattern, `lib/auth.js` PRIVILEGED_OPS gating.
- Reference miss taxonomy (intraday lane): `lib/large-mover-audit.js`,
  `lib/runner-capture.js`; warning-time semantics: `lib/leadtime2.js` (censoring rules).

## 6. Known survivorship / leakage hazards CFL must expose (not paper over)

- Candle cache = split-adjusted **as of fetch date**, not PIT adjustment vintages.
- Curated universes contain only currently-listed names → historical universe membership
  is optimistic; delisted losers absent → missed-winner *rates* on historical dates are
  upper bounds and dud rates lower bounds. Flagged `survivorshipSafe:false` in every
  retrospective artifact.
- Macro overlay not replayable → RISK_VETO attribution on historical dates only covers
  the replayable regime gate.
- Intraday (sub-day) opportunity labels are NOT supported by EOD data; CFL v1 declares
  the intraday horizon `dataSupport:'delegated'` and points at the existing
  `large-mover-audit` lane instead of fabricating intraday paths from daily bars.
