# Counterfactual Opportunity & Forecastability Lab (CFL)

Version `cfl-v1` · Status: **SHADOW / weight-0** · Audit record: `research/CFL-PIPELINE-AUDIT-2026-08.md`

CFL is measurement infrastructure, not a screener. It answers four questions the
app previously could not:

1. Which large, executable moves did the pipeline **miss** — market-wide, not
   just among its own picks?
2. Which **stage** was responsible for each miss (universe, data, candidate
   generation, ranking, timing, risk veto, alerting, display, execution) — and
   which misses were **genuinely unforecastable** from information available
   beforehand?
3. Which selected picks became **duds**, and why (deterministic categories)?
4. Is a given name, now, **forecastable at all** — or should the system abstain?

## Architecture

```
                       lib/swing-replay-v3 (production-parity replay)
                                    │ exact selectCandidates + reason-coded rejections
   candles/<scope>.json ──▶ lib/cfl/reconstruct ──▶ episodes + traces + attribution
   (candle cache)                   │                     │
                                    ▼                     ▼
                        lib/cfl/labels            lib/cfl/taxonomy
                 (vol-adjusted barriers,       (precedence classifier,
                  gap classification,           13 miss + 13 dud
                  cross-sectional ranks)        categories, evidence-first)
                                    │
   picks/<date>.json ──▶ lib/cfl/duds (resolveTrade contract)      lib/cfl/forecastability
   /api/screener warm ──▶ lib/cfl/capture (decision snapshots)     (evidence dispositions,
                                    │                               true abstention)
                                    ▼
                        lib/cfl/store  →  Blob cfl/v1/*
                                    │
                        lib/cfl-routes (ops) + public/js/cfl-lab.js (Research Lab tab)
```

Reused (never duplicated): `swing-screener-engine` (one selection path),
`swing-replay-v3` (PIT slicing + parity), `execution-policy` exec-v1 (next-open
entries), `outcome.resolveTrade` (the Scoreboard's own grading contract),
`stats.wilson`, `atlasx-utility.conformalInterval`, `orbit-controls` +
`pit-contract` (prosecutor battery), `strategy-registry`/`maturity`/`governance`
(promotion machinery, untouched).

## Storage (`cfl/v1/`)

| Key | Writer | Content |
|---|---|---|
| `decisions/<scope>-<date>.json` | `/api/screener` warm hook | full decision snapshot: every name's status/rank/score + EVERY reason-coded rejection (the response truncates to 50; this doesn't) |
| `day/<scope>-<horizon>-<date>.json` | `op=cfltick` / `op=cflbackfill` | one checkpoint's episodes, missed-winner traces + attributions, replay summary |
| `duds.json` | `op=cfltick` | graded picks ledger (first-appearance dedup) |
| `summary.json` | `op=cfltick` | funnels per horizon, dud digest, integrity block |
| `state.json` | jobs | last tick, backfill cursors |

Idempotency: every day doc is keyed by (scope, horizon, date) — a re-run
overwrites itself. No shared read-modify-write doc exists anywhere in CFL.

## Opportunity definitions (versioned in `lib/cfl/config.js`)

- **Horizons**: `h5`/`h21`/`h63` trading sessions. `intraday` is **delegated**
  to the existing day-trade miss audit (`op=largemoveraudit`) — EOD candles
  cannot support sub-day path labels and CFL refuses to fabricate them.
- **Path labels**: volatility-adjusted barriers (kUp/kDown × decision-time ATR% ×
  √sessions, floored), resolved from the **next-session fill** (exec-v1, slippage
  charged); outcomes `target-before-stop` / `stop-before-target` /
  `neither-stagnant` / `pending` / `no-fill`; MFE, MAE, time-to-barrier, closing,
  benchmark-, sector-relative returns. Same-bar ambiguity → stop (conservative).
- **Cross-sectional labels**: benchmark-residual rank/percentile, top-decile
  flag, largest-liquid-winners, and an **executability** flag — a `gap-dominant`
  move (>60% of the return earned overnight) is never a "missed opportunity".
- Changing any definition requires bumping `LABEL_VERSION`; `opportunityId`
  embeds the version so records from different definitions cannot mix.

## Failure taxonomy (precedence-ordered, deterministic)

Missed winners (first firing check wins):
`UNIVERSE_EXCLUSION → DATA_UNAVAILABLE → DATA_STALE_OR_FAILED →
CANDIDATE_GENERATION_FAILURE → RANKING_FAILURE → LATE_DETECTION → RISK_VETO →
ALERT_FAILURE → PRESENTATION_FAILURE → LIQUIDITY_OR_EXECUTION_FAILURE →
INFORMATION_ARRIVED_AFTER_MOVE → OUT_OF_DISTRIBUTION → NO_PREMOVE_EVIDENCE`

The last three are marked **not preventable** — the honest "no reasonable system
would have caught this" bucket. A generation/ranking rejection on a name with no
supported pre-move evidence resolves to `NO_PREMOVE_EVIDENCE`, so the screener
is never blamed for an unforecastable move. Every verdict carries its
deterministic evidence rows; no LLM participates in classification.

Duds: `IMMEDIATE_FAILURE, SLOW_DETERIORATION, STAGNATION, FAILED_BREAKOUT,
EXHAUSTED_MOVE, CATALYST_REVERSAL, MARKET_REVERSAL, SECTOR_REVERSAL,
LIQUIDITY_FAILURE, DATA_FAILURE, OUT_OF_DISTRIBUTION,
SEVERE_LOSS_MODEL_FAILURE, EXIT_OR_RETENTION_FAILURE`.

## Forecastability & abstention

`lib/cfl/forecastability.assessForecastability` scores countable evidence only
(analogue count, calibration-bin support, missingness, freshness, distribution
shift vs the cohort, liquidity, provider health) → dispositions `ACTIONABLE /
WATCH / INSUFFICIENT_EVIDENCE / OUT_OF_DISTRIBUTION / DATA_STALE / ABSTAIN`.
Probabilities are structurally withheld (`displayProbability:false`) until a
calibration bin has ≥40 resolved samples; the conformal block reports
`available:false` unless real OOF residuals are supplied. Abstention is real:
nothing forces a name into buy/hold/sell.

## Jobs

- **Nightly**: warm-chain root `cfl` → `op=cfltick` (privileged). Reconstructs
  the latest **matured** checkpoint per horizon (idempotent skip if built),
  grades the picks ledger, refreshes `summary.json`. Time-boxed 45 s; budget
  skips are reported, never silent.
- **Backfill** (manual, caller-cursor — the `fundbuild` pattern):

```bash
# one bounded call (≤12 checkpoints, 45s budget); returns nextStart
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<host>/api/tracker?op=cflbackfill&scope=large&horizon=h21&start=0&limit=6"
# loop until done=true / nextStart=null; re-running is idempotent
```

- Decision snapshots are captured automatically by the warm screener run.

## Reading the results

- `op=cfl` — summary: funnels (stage counts, miss-by-category histogram,
  preventable split, median warning time, recall), dud digest, integrity.
- `op=cflmissed&scope=large&horizon=h21` — attributed missed winners.
- `op=cflduds` — graded picks + categories.
- `op=cfltrace&symbol=X&date=YYYY-MM-DD&horizon=h21` — one episode's full
  trace + attribution.
- `op=cflforecast` — dispositions for the latest decision snapshot.
- UI: **Research Lab → 🔭 Counterfactual Lab** (novice guide included; expert
  columns behind the global expert toggle).

Interpretation guide: `discovery.opportunityRecall` measures whether ANY stage
surfaced the winner (high-recall question); `selection.opportunityCaptureRate`
measures end-to-end capture (high-precision question). The gap between them,
read against `missByStage`, names the bottleneck.

## Learning loop & promotion contract

1. Decisions recorded at decision time (snapshots freeze features + versions).
2. Outcomes mature (per horizon); `cfltick` closes episodes.
3. Misses/duds attributed deterministically; completed episodes accrue in
   `cfl/v1/day/*` as the training-eligible pool.
4. Any model/gate derived from CFL findings (e.g. a forecastability gate) must
   be registered as a SEPARATE shadow strategy, evaluated on untouched forward
   periods, and pass:
   - the prosecutor battery (`lib/cfl/prosecutor.prosecuteClaim` — label
     shuffle, future-feature leak, placebo ranker, doubled costs,
     drop-best-year, best-trade excision, concentration), and
   - the standard governance ladder (`lib/maturity` gates + promotion artifact).
   The prosecutor can only downgrade (`canPromote:false` structurally).
5. **Nothing was promoted in this implementation.** Production rankings are
   untouched; the registry entry `cfl` is `informational`/`shadow`.
6. Any *confirmatory* evaluation must first preregister its trials in
   `lib/research/hypothesis-registry.js` (BH denominator) — and must not quote
   sealed HOLDOUTS.

## Honesty constraints (stamped on every artifact)

- `survivorshipSafe:false` on all retrospective sweeps: the candle cache is an
  as-of-today fetch — delisted names are absent, so historical missed-winner
  rates are upper bounds and dud rates lower bounds. The clean lane is the
  prospective decision-snapshot record accruing from today forward.
- Price adjustment basis is `as-of-fetch`, not PIT vintages.
- The macro (VIX/credit) overlay has no PIT history — historical RISK_VETO
  attribution covers only the replayable regime gate.
- `ALERT_FAILURE` for the swing lane reflects a structural fact: no alert layer
  exists there (documented pipeline gap), so qualifying names literally cannot
  notify.
- The intraday horizon delegates to `large-mover-audit` rather than inventing
  intraday paths from daily bars.

## Tests

`test/cfl-*.test.js` (72 tests): barrier calculations, target-before-stop
ordering + same-bar ambiguity, gap classification, PIT invariants (future
features and same-day entries THROW), taxonomy precedence, dud categories,
forecastability ladder + calibration fallback + conformal honesty, end-to-end
synthetic reconstruction (determinism, attribution, refusal of non-session
dates and intraday), funnel math, prosecutor invariants, and source-text
contracts (op registration, privilege classes, warm-chain wiring, capture-hook
ordering, UI registration). All offline; no keys.
