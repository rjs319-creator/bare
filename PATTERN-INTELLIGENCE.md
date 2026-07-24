# Chart Pattern Intelligence

A shadow, fail-closed layer that detects classic chart structures by **objective geometry**,
measures how closely a chart matches them, decides an honest **action**, and is built to
learn from **leakage-safe forward outcomes** — without ever changing a live screener ranking
until a pattern family is individually validated.

> **Honesty contract.** Chart patterns are not certainty. This layer separates *descriptive
> similarity* (does the chart look like a bull flag?) from *validated predictive value* (does
> that bull flag actually pay, versus matched controls?). A score is only called a probability
> when it is properly calibrated. Nothing here is calibrated yet — every prediction is a
> labeled `model-estimate`, and every match tier is `descriptive` until enough forward
> outcomes resolve.

## Where it lives

All new code is additive and namespaced under `lib/patterns/` + `lib/pattern-routes.js`.
No existing file's behavior changed except additive wiring (tracker op dispatch, warm chain,
package `check` script, frontend tab/search injection).

| File | Role |
|---|---|
| `lib/patterns/geometry.js` | Scale-invariant, ATR-adaptive shape primitives: normalized paths, ATR zigzag/pivots, geometry & volume feature vectors. Reuses `lib/signal.calcATR`. |
| `lib/patterns/templates.js` | 14 objectively-defined pattern templates (geometry ranges + idealized normalized paths + context). |
| `lib/patterns/similarity.js` | The **separated** measures: `pathCorrelation`, `dtwSimilarity`, `geometrySimilarity`, `volumeSimilarity`, `contextSimilarity`, a combined similarity, and an honest `matchTier`. |
| `lib/patterns/phases.js` | Structural pattern phase (EMERGING…FAILED), distinct from the actionability lifecycle. |
| `lib/patterns/detectors.js` | Runs every template over a window → detection with similarity, phase, derived plan, invalidation. |
| `lib/patterns/predict.js` | Barrier outcome estimates via `lib/coil-executable` (`model-estimate`), plus empirical analog rate + **incremental lift vs baseline** when available. |
| `lib/patterns/analog.js` | Point-in-time historical nearest-neighbour engine with three hard leakage guards + effective-sample-size de-overlap. |
| `lib/patterns/decision.js` | Feeds the **existing** `opportunity-lifecycle` engine an `ev` and maps to explicit actions, fail-closed. |
| `lib/patterns/schema.js` | Canonical pattern-prediction object + layered novice/expert explanations. |
| `lib/patterns/index.js` | Multi-timeframe orchestrator (`analyzeTicker`): context, per-timeframe detection, primary/secondary/conflicting reconciliation, timeframe alignment. |
| `lib/pattern-routes.js` | The four `?op=` handlers (folded into `api/tracker.js`, no new serverless function). |

## Server ops (all in `api/tracker.js`)

- `op=patternsearch&ticker=XYZ` — public cached read; full multi-timeframe analysis for one ticker. **Powers the search bar.**
- `op=patterns[&view=all|bullish|bearish|actionable]` — public cached read; the Pattern Radar, served from the last logged snapshot (a live request never brute-forces the universe).
- `op=patternlog` — privileged cron writer; scans a bounded pool, records the immutable first-detection ledger + write-once radar snapshot.
- `op=patterngrade` — privileged cron writer; resolves matured matches using **only bars strictly after detection**.

Wired into the warm cron as its own root chain `pattern: ['op=patternlog','op=patterngrade']`.

## What each tier means (be precise)

- **Fully implemented (shadow):** geometry, 14 detectors, separated similarity, phases, the
  barrier prediction, the decision→action mapping on the real lifecycle engine, the canonical
  schema, the multi-timeframe orchestrator, the four ops, the search-bar section, the Pattern
  Radar tab, and the immutable log/grade writers. All working, all tested (32 unit tests).
- **Implemented but shadow-only:** everything above is weight-0. It does **not** feed
  `op=today` or any live ranking. `decidePattern` can only reach `ACTIONABLE_NOW` when a
  family's edge is *proven* (calibrated/sufficient) — which cannot happen until the ledger
  matures — so today it tops out at `RESEARCH_ONLY`.
- **Scaffolded honestly (not trained):** the analog *engine* is complete and leakage-safe, but
  it needs a precomputed corpus/index to produce calibrated rates; `analogs` are empty until
  `op=patternlog`/`op=patterngrade` accrue resolved outcomes. `embeddingSimilarity` is a real
  schema field returned as `null` (no learned-shape model in v1).
- **Planned / not built:** learned-shape challenger (shapelets/MiniRocket), the CNN
  chart-image challenger, and the versioned analog *index* over the full archive. No fake model
  artifact was created. Champion/challenger promotion governance reuses the app's existing
  pattern (pre-registered bars) and is documented, not yet run.

## Leakage & correctness guarantees (enforced in code, tested)

- Scale invariance: `logPath` of a series and 100× that series are bit-identical.
- ATR normalization: depth measures transfer across price regimes.
- No lookahead: analog records must strictly predate the query; a stock can't match its own
  overlapping/future window; overlapping windows collapse to one **effective** sample.
- Fail-closed decisions: daily-only ⇒ never `ACTIONABLE_NOW`; stale ⇒ `NO_ACTION_STALE`;
  invalidation ⇒ `FAILED`; over-extended ⇒ `DO_NOT_CHASE`; strong-but-unproven ⇒ `RESEARCH_ONLY`.
- HIMS guard: a prior-session bullish pattern on a name now collapsing is never actionable.
- Grading uses only post-detection bars; intrabar target+stop straddle resolves conservatively to stop.

## Prerequisite (satisfied)

The Day Trade live-freshness fix (the "stale bullish bar shown as a live buy" defect) shipped
as PR #201 and is binding. This layer reuses that same freshness + lifecycle gate, so it
cannot amplify a stale recommendation.

## Data / deployment limitations

- Live analysis needs the daily-candle feed (Yahoo via `screener.fetchDailyHistory`); it fails
  closed (`insufficient-history`) when unavailable.
- Radar coverage is a **bounded shortlist** (`DEFAULT_UNIVERSE`, ≤40/run) — not the full
  universe — to stay inside the serverless wall budget. Search covers any ticker on demand.
- Persistence needs `BLOB_READ_WRITE_TOKEN`; without it the radar/ledger degrade to
  `ready:false` and search still works.
- No Python runtime is introduced; all math is deterministic JS.
