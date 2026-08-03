# Pattern Intelligence (pattern-v2)

A **stateful, evidence-gated technical-setup engine**. It finds family-specific chart
structures, freezes each one into a persistent episode with structural trigger /
invalidation / target, tracks it through a real state machine as new bars arrive, grades
outcomes fill-aware, and only ever issues actionable language for a family that has
independently passed leakage-safe validation. **Shadow / weight-0**: nothing here feeds a
live ranking.

## The correctness contract (v2 rewrite)

1. **t−1 / t separation.** Every structural level is built from formation bars 0..t−1
   (`structure.splitFormation`); the bar at t is only ever evaluated AGAINST the frozen
   level (`assessBarVsLevel`, which distinguishes intraday penetration, gap-through, and
   closing confirmation). A candle can never define the trigger it is tested against —
   the v1 defect that made closing confirmation structurally unreachable.
2. **Family-specific structure.** Each family has a dedicated detector
   (`lib/patterns/families.js`): flags need a qualifying pole + bounded retracement;
   doubles need two comparable pivots + an intervening reaction + a neckline; VCP needs a
   progressively-shrinking contraction sequence; cup-and-handle measures rims, depth,
   bottom shape, and a shallow upper-half handle; triangles/wedges need fitted boundaries
   that actually bound the tape, touch counts, and convergence; breakout-retest /
   failed-breakout reference a frozen historical breakout event; undercut-reclaim needs a
   prior low, an undercut, and a reclaim close. Missing required features score ZERO (no
   renormalization) and fail the pattern; each result carries `featureCoverage`,
   `missingRequiredFeatures`, `violatedFeatures`, `structuralValidity`.
3. **Structural trade plans.** Trigger/invalidation/target come from the structure
   (neckline, boundary-at-t, final-contraction pivot, measured moves…). Reward:risk is
   computed, never forced; degenerate risk (< 0.25 ATR) marks the plan `invalid`; poor
   R:R plans are downgraded (AVOID), not dressed up.
4. **The 5d timeframe was removed** (it supplied fewer bars than any detector minimum —
   an unusable window is deleted, not displayed). Active windows: `session` (intraday),
   `20d`, `60d`, `120d`.

## Episodes (`lib/patterns/episodes.js`)

Detection → episode with FROZEN levels + provenance (source pivot/bar identifiers), a
unique key `ticker|family|direction|timeframe|patternStart|triggerType@price|modelVersion`,
and the state machine

```
EMERGING → FORMING → READY → TRIGGERED_PENDING_CONFIRMATION → CONFIRMED
        → RETESTING ⇄ CONFIRMED → MANAGING → TARGET_REACHED | STOPPED | EXPIRED
   any pre-entry state → FAILED (invalidation close) | EXPIRED (aged out)
```

- Prior state is restored from storage every scan; the trigger never moves.
- Pre-entry invalidation is judged on the CLOSE (a wick can't kill a setup); post-entry
  stops fill on a touch; gaps fill/exit at the open (worse price).
- Amendments (target/invalidation only, never the trigger) are versioned, reasoned, and
  pre-entry only. Every transition records its rule.
- Overlapping detections of the same structure dedupe; a sliding window re-detecting a
  tracked structure updates the episode instead of duplicating it.
- **Failed Today** strictly means the transition into FAILED happened today
  (`failedOn`). Failed/expired episodes are retained with the rule that killed them.

## Confirmation & actions

- `confirm.technicalStatusDaily` (daily close → next-session execution intent) and
  `confirm.technicalStatusIntraday` (VWAP/relative-volume/remaining-R:R live check,
  fail-closed on unknowns) are built in the REAL runtime path (`op=patternsearch`,
  `op=patternlog`) — swing setups do not require a live feed.
- `technicalStatus` (what the chart did) is never blended with
  `recommendationEligibility` (whether the family has validated edge). Eligibility reads
  ONLY the versioned evidence artifact; no artifact → research-only, always.
- Actions are position-aware (`actions.js`): `LONG/SHORT_ENTRY_READY`,
  `LONG/SHORT_TRIGGERED`, `HOLD_*`, `TRIM_LONG`, `COVER_SHORT`, `EXIT_LONG`, `AVOID`,
  `WATCH`, `RESEARCH_ONLY`, `FAILED`, `EXPIRED`. A short can never read "Buy"; entering a
  short is explicitly distinguished from exiting a long. Tests assert the wording.

## Grading (`lib/patterns/grade.js`)

Fill-aware and leakage-safe: locate the exact first fill (gap-through-entry fills at the
open), evaluate barriers only from the fill onward — **a stop that printed before the
entry filled is never counted**. On a fill bar that opened pre-trigger, range extremes may
be pre-fill, so post-entry stop evidence is the close. Same-bar target+stop resolves as a
conservative STOP labeled `ambiguous`. Outcomes are distinct: `no-fill | target | stop |
timeout | ambiguous | data-unavailable`, each with entry/exit time+price, costs and the
assumption list. Records key on the full episode key (collision-free).

## Research & the proven gate (`lib/patterns/research.js`)

Offline PIT pipeline: anchored per-as-of replay (`buildResearchRecords`) with same-ticker
overlap purging; **matched non-pattern controls** (same mechanical plan on days no family
fired); purged/embargoed chronological split (train 60% / calibration 20% / untouched
final 20%); per family×direction×timeframe cells with target-rate + cost-net lift vs
controls, Wilson CIs, Brier vs baseline, by-year stability, and **Benjamini–Hochberg FDR
across cells**. `provenGate` requires ALL of: enough final-period fills, enough
calibration fills, positive cost-net lift, CI clear of the control rate, calibration
beating baseline, FDR survival, multi-year stable record. `analog.sufficient` has no
vote anywhere. The output is the versioned evidence artifact (`pattern/evidence.json`)
that `recommendationEligibility` reads. **Probabilities are null until a cell is proven**,
and the UI states why; barrier-model numbers are labeled model estimates and are never
shown as probabilities.

## Universe scan (`lib/patterns/scan.js`)

Two-stage, resumable, observable. Stage 1 (cheap): history ≥ 80 bars, price ≥ $3, avg
dollar volume ≥ $1M, near a 60d high/low within 6 ATR or contracting. Stage 2: full
family detection. The cursor persists across cron ticks over the full LARGE + SMALL +
MICRO universe (hundreds of names, replacing the 16-stock shortlist); the scan state
records universe size, cursor, eligible/scanned/rejected (with reasons), data failures
and per-band coverage — shown on the radar so partial coverage is never silent.

## Ops (folded into `api/tracker.js`, warm chain `pattern`)

| op | access | role |
|---|---|---|
| `op=patternsearch&ticker=` | public | live multi-timeframe analysis + intraday confirmation + persisted episodes + chart payload |
| `op=patterns` | public | the radar action board from persisted episodes + scan observability + evidence status |
| `op=patternlog` | cron | advance episodes with the new bar, continue the resumable scan, create episodes (immutable first-detection ledger `pattern-episode`), refresh the day snapshot |
| `op=patterngrade` | cron | fill-aware grading of matured episodes → `pattern/resolved/index.json` |
| `op=patternresearch&mode=collect|evaluate` | cron/manual | build PIT research shards, then evaluate → the evidence artifact |

Storage: `pattern/episodes.json`, `pattern/scan-state.json`, `pattern/resolved/index.json`,
`pattern/evidence.json`, `pattern/research/shard-*.json`, refreshable `pattern/day/<date>.json`.

## UI

Pattern Radar (subtab `patternradar`) is an action board: Triggered Now · Ready/Near
Trigger · Retests & Pullbacks · Developing · Manage · Failed Today · Expired · Resolved ·
Failed Earlier (collapsed) · Research-Only Families (evidence status per family). One
primary bucket per episode. Cards carry the full spec field set (frozen levels + types,
distance to trigger in % and ATR, remaining R:R, age, eligibility, null-or-calibrated
probability, downgrade reason, freshness) with a novice line and an expert `<details>`
(transition history, amendments, rules) plus an annotated canvas chart
(`public/js/pattern-chart.js`: candles, volume, pivots, frozen levels, confirmation bar).
The evidence banner is Pattern Radar's OWN record via maturity id `chartpattern` — the
old mapping that displayed Coil's record as pattern evidence is removed.

## Honest status

- **Shadow-only: yes.** No production weight anywhere; promotion requires the proven
  gate, then an explicit registry maturity flip with caps/correlation checks (Phase 9 of
  the redesign spec) — none of which is earned yet.
- **Evidence: none yet.** No resolved episodes, no evidence artifact, zero proven
  families. Every trigger is research-only until `op=patternresearch` + accrued episodes
  say otherwise.
- **Not built (declared, not faked):** learned-shape challengers (shapelets/MiniRocket,
  gradient-boosted ranking, regime-conditioned ensembles) remain future challengers to
  the structural rules; chart-image CNNs deliberately out of scope; `embeddingSimilarity`
  stays an honest null.
