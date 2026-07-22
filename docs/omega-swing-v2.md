# OMEGA-SWING v2 — Evidence-Driven Swing Decision System

**Status:** SHADOW (weight-0). Registered in `lib/strategy-registry.js` as `omega`, enforced by
`lib/strategy-gate.js`. It MUST NOT originate or boost a live trade. It surfaces *ranked research
candidates*, not buy signals, until it clears the promotion gate on purged + prospective evidence.

This document describes what shipped in the v2 vertical slice, the honesty guarantees it enforces,
and the trained-model work that remains. It is deliberately conservative: **nothing here claims an
edge the frozen validation has not shown.**

---

## 1. What changed (v1 → v2)

v1 was an honest *interpretable ranker + entry layer*, but it had several validity defects shared
with the wider app's early screeners. v2 fixes the ones that mattered and adds the research/data/
governance infrastructure a trained challenger will need.

| # | Defect (v1) | Fix (v2) |
|---|---|---|
| 1 | Ledger + backfill entered at the **signal-day close** (un-tradeable) | Executable next-open / conditional fills via canonical `lib/execution-policy.js` (`lib/omega-execution.js`) |
| 2 | Handcrafted `pPositive` / `p3pct` / `p5pct` / "model confidence" shown as **calibrated outputs** | `lib/omega-calibration.js` gate → uncalibrated ⇒ **evidence bands, never percentages**; "model confidence" removed |
| 3 | Reconstructed history and live picks shared **one storage namespace** | Physically separate `omega/live/` vs `omega/research/` ledgers + provenance stamps (`lib/store.js`, `lib/omega-contract.js`) |
| 4 | Scoreboard validated OMEGA with a **generic momentum proxy** | `lib/sectionscore.js` scores OMEGA on its **actual logged point-in-time score** (`method: omega-logged`) |
| 5 | OMEGA absent from the **strategy registry / governance** | Registered `maturity: shadow`; `strategy-gate.isTradeEligible('omega') === false` |
| 6 | Walk-forward could **pass on mean-IC alone**, ignore truncation, tier order | Predeclared fail-closed gates (`evaluateGates`): ≥3 positive blocks, meanOOS>margin, **not deadline-truncated**, **tier monotone on cost-net residual**, **beats every simple baseline** |
| 7 | No candidate/model **provenance** | Every observation carries strategy/feature/exec/cost versions, source funnel rank, provenance |
| 8 | Sizing could imply **~100% of equity** on one name | `lib/omega-sizing.js` — HARD caps (≤20% position, ADV capacity, gap-loss, vol-target) + evidence haircuts |
| 9 | Replay scanned a **static present-day universe** with no honesty flag | `survivorshipSafe:false`, `historicalLiveParity:false` stamped ⇒ **promotion structurally blocked** |

---

## 2. Data contract (Phase 1)

`lib/omega-contract.js` — `makeOmegaObservation()` returns a **frozen, versioned** record. It is a
superset of the canonical research `Prediction`/`ExecutableOutcome` (`lib/research/schemas.js`)
specialized to OMEGA. Key guarantees, enforced by `validateOmegaObservation()`:

- **Provenance is required** and must be a known value (`prospective_live`, `historical_reconstruction`,
  `paper_trade`, `migrated_legacy`, `synthetic_test`). No default to "live".
- **Signal price ≠ fill.** `signalReferencePrice` (T close) and `assumedFillPrice`/`assumedFillDate`
  (T+1 fill) are distinct fields. The old conflated `entry` is gone.
- **Causal guarantee.** A filled non-MOC observation must fill strictly *after* the signal date.
- Every record carries `strategyVersion`, `featureVersion`, `modelVersion`, `calibrationVersion`,
  `executionPolicyVersion`, `costModelVersion`, the **source-funnel** fields (source screener, raw
  score, rank, percentile), regime, feature vector + quality flags, tier/setup/stage, entry policy,
  max acceptable entry price + gap, model outputs, calibration maturity, episode id, label-end
  dates, and outcomes.

## 3. Ledgers & provenance (Phase 2)

Physically separate Blob prefixes in `lib/store.js`:

- `omega/live/<date>.json` — **prospective** picks (`writeOmegaLiveDay`, provenance `prospective_live`).
- `omega/research/<date>.json` — **reconstructed** history (`writeOmegaResearchDay`, `historical_reconstruction`).
- `omega/<date>.json` — pre-v2 mixed days, read as `migrated_legacy` (never silently relabeled).

`readAllOmega({ track: 'live' })` returns **only** live-track-eligible records
(`prospective_live` / `paper_trade`). The Scoreboard consumes this — so reconstructed history and
mixed legacy days are **excluded from the displayed live track**.

## 4. Execution (Phase 3)

`lib/omega-execution.js` maps OMEGA's entry intent to the canonical fill model:

| Intent | Policy | Executable state |
|---|---|---|
| BUY_NOW | `NEXT_OPEN_PLUS_SLIPPAGE` | `ELIGIBLE_NEXT_OPEN` |
| BUY_ON_BREAKOUT | `BREAKOUT_STOP` (trigger = pivot) | `BUY_ABOVE` |
| BUY_ON_FIRST_PULLBACK | `PULLBACK_LIMIT` (trigger = support) | `BUY_ON_PULLBACK` |
| WAIT_FOR_CLOSE_CONFIRMATION | next-open after confirmation | `WAIT_CONFIRMATION` |
| WATCH / SKIP | — | `AVOID` |

It models the opening gap, rejects a fill that **gaps past positive utility**
(`GAP_TOO_LARGE_SKIP`) or exceeds the **max acceptable entry** (`NO_POSITIVE_UTILITY`), and
recomputes **reward/risk at the fill**. Live scoring returns the *plan* (`fillStatus: pending`);
the backfill resolves the real T+1 fill or an honest no-fill. Same-bar stop/target ambiguity is
resolved conservatively (to the stop) in `lib/outcome.js`.

## 5. Labels (Phase 7)

Residual return (stock − weighted market − sector), **cost-net** (`residual10Net` /`residual5Net`
via `lib/costs.roundTripCostPct`), for 5- and 10-session horizons, plus MFE/MAE and ≥3%/≥5% target
hits. Point-in-time correct (`residualForward` uses only bars strictly after the signal date).

## 6. Calibration (Phase 9)

`lib/omega-calibration.js` — a probability is **displayed as a percent only** when it is out-of-fold
calibrated, has ≥200 samples, beats the base-rate predictor (Brier skill > 0), is the current
version, and is within drift tolerance. **No calibrated artifact ships in this run**, so every
current OMEGA probability returns `display:false` → the UI shows a qualitative evidence band and
"probability unavailable — insufficient calibration evidence." This is the correct, honest state.

## 7. Sizing (Phase 11)

`lib/omega-sizing.js` — never suggests 100% of equity. Binding = the smallest of: risk-budget
(0.75%), max position (20%), gap-loss cap, volatility target, ADV participation (≤2% of ADV), and
sector/cluster headroom. Then an **evidence haircut** shrinks it for shadow status, uncalibrated
probabilities, binary events, and fat tails. Output is labeled an **educational estimate**, not a
broker-ready order; portfolio-aware sizing activates only when the caller supplies exposures.

## 7b. Live candidate-funnel capture (Phase 4)

`lib/omega-funnel.js` + `omega/funnel/<date>.json` (write-once). Every day the cron
(`op=omegalog`) and the on-demand `op=omegafunnel` capture an **immutable, versioned snapshot**
of the exact `op=today` candidate funnel OMEGA re-ranked:

- The **complete** candidate set (eligible *and* ineligible), each with its source strategy
  family, raw score, and **within-strategy-and-date normalized** rank/percentile (raw scores from
  unrelated screeners are not comparable, so they are percentile-ranked *within* each family
  before the union is OMEGA-ranked).
- The eligibility filter + candidate cap that were applied, the regime, the universe id, and what
  OMEGA ultimately **selected** and **ranked** (tier + OMEGA rank per candidate).

`assessFunnelParity(cohortDates, snapshotDates)` is **fail-closed**: `historicalLiveParity` is
true only when *every* cohort date has a captured funnel. `op=omegawf` reads the captured dates
and flips parity automatically once a replay range is fully covered; `op=omegamodel` and
`op=omegafunnel` surface the accrual (`capturedSnapshots`, first/last date). This is the machinery
that will let a future challenger become *promotable* — it accrues going forward, from now.

## 8. Validation & promotion (Phase 15)

`op=omegawf` runs the purged walk-forward. `evaluateGates()` (pure, unit-tested) is the fail-closed
promotion logic:

- `passed` (statistical edge) requires: ≥3 blocks all positive · meanOOS > 0.02 · **not
  deadline-truncated** · **tier payoff monotone on cost-net residual** · **beats every simple
  baseline** (10d momentum, 52wk-high proximity, relVol).
- `promotable` additionally requires **live-funnel parity** *and* **survivorship-safe**.

Because the *app-side* replay (`op=omegawf`) runs on the free survivor-biased Yahoo feed and a
static present-day universe, `historicalLiveParity` and `survivorshipSafe` are `false` there — so
its `promotable` is structurally false. A challenger can never be promoted off that harness alone.
`verdict` is `inconclusive-truncated` on any deadline hit.

### 8b. Survivorship-free evidence (research side) — the flag discharged

`survivorshipSafe` cannot be earned on the app's free feed (delisted names return nothing from
Yahoo). It is discharged the way NSL #7/#8 discharged it — **research-side**, by re-running the
*identical* OMEGA scorer, executable-fill model, cost model, and `evaluateGates()` over a
survivorship-**complete** cross-section from the `pit-secmaster-v1` master (delisted names included
up to their last trading day, with a Shumway −30% delisting haircut):

- `research/53-omega-survivorship-free.js` → `research/OMEGA-SURVIVORSHIP-FREE-2026-07.md`.
- Universe: 1006 in-band names (600 active + **406 since-delisted**), 25 month-ends 2022–2024,
  5,053 scored name-dates. `survivorshipSafe = true`.
- **Result:** score→10d-residual rank-IC **−0.027** (t −1.30) survivorship-free — **below** the 10d
  momentum baseline (+0.029); tiers not monotone; gates do **not** pass ⇒ verdict **`no-edge`**.
  Survivorship return bias +0.36%/10d (survivor-only flatters), echoing NSL #8's level-not-ordering
  finding. `promotable` remains false (live-funnel parity still false).

Reading: OMEGA has **no durable selection edge even once survivorship is removed** — consistent with
the app's whole edge-hunt. That is the honest, expected outcome, not a bug. The flag is now
*discharged* (we know the answer isn't a survivorship artifact), but the answer is "no edge here".

## 9. Governance (Phase 13)

`lib/strategy-registry.js` registers `omega` as `maturity: shadow`, `section: OMEGA`. Promotion is
a deliberate data change gated by `strategy-gate.PROMOTION_GATE` (50 resolved episodes, 20
independent dates, incremental excess, calibration beats base rate, cost-aware, regime-robust, CI
excludes zero). It can never happen by editing UI wording.

## 10. UI (Phase 12)

`public/js/omega-swing.js` — shadow research candidates (not "Prime"/buy styling): *High-ranked
research candidate / Conditional candidate / Watch*. The shadow evidence status sits next to the
action. Executable-state labels replace "Buy now". Probabilities render as bands. Sizing shows the
cap and the "educational" note. "Model confidence" is gone.

---

## How to interpret "no edge"

The app's multi-session research found **no durable regime-robust selection edge** on EOD/free data;
the one validated lever is standing down in risk-off. A walk-forward verdict of `no-edge` or
`inconclusive` is a **valid, expected outcome**, not a failure of the code. OMEGA's value is a
smaller number of timely, executable, explainable candidates whose incremental value *would have to
survive* realistic fills, costs, regime changes, and prospective monitoring before any promotion.

## What remains unproven / not built

- **No trained challenger.** The LambdaRank / failure-hazard / regime-ensemble models (Phase 8) are
  **not built** — the vanilla-JS + serverless stack has no ML runtime, and no promotable data
  (parity + survivorship) exists to train on responsibly. The interpretable formula remains the
  shipped ranker.
- **No calibrated probabilities.** Requires a trained model + out-of-fold calibration + ≥200 samples.
- **Live candidate-funnel capture (Phase 4) is now BUILT** (`lib/omega-funnel.js`,
  `omega/funnel/`), but it accrues **going forward** — a walk-forward over historical cohorts still
  has `historicalLiveParity:false` until enough prospective funnel has been captured to cover a
  replay range.
- **Survivorship — DISCHARGED (research side).** OMEGA's edge test has now been run
  survivorship-free over the `pit-secmaster-v1` master (§8b) — `survivorshipSafe:true`, verdict
  `no-edge`. The *app-side* replay stays `survivorshipSafe:false` by construction (free Yahoo feed
  can't see delisted names); the survivorship-complete verdict lives research-side, which is the
  honest place for it. Net: survivorship is no longer an *open* blocker — but the survivorship-free
  answer is "no edge", so there is nothing to promote regardless.
- **Setup state machines** (Phase 6) remain the v1 strength-score detectors, not full stateful
  machines with episode boundaries.

## External data still required

Point-in-time universe snapshots + delisted-name coverage (survivorship-complete security master),
and a prospective log of the exact `op=today` candidate funnel. Real-time quotes/spreads would
sharpen the execution model but are not required for the next-open honesty guarantee.

## Next highest-value phase

Phase 4 funnel capture is built and accruing; survivorship is discharged research-side (verdict
`no-edge`). The honest state is now: **the infrastructure is complete, and OMEGA has no demonstrable
edge to promote.** The remaining possibilities, in order of value:

1. **Keep accruing prospective evidence** — the live funnel + prospective picks + Scoreboard track
   record. If a genuine edge ever appears in the prospective record (not the survivorship-free
   research replay, which says no-edge), *then* a challenger becomes worth training.
2. **A trained challenger + out-of-fold calibration** (Phase 8/9) — only worth building if (1)
   surfaces something; on current evidence there is nothing to fit that beats simple momentum.
3. **Setup state machines** (Phase 6) — a code-quality improvement, not an edge lever.

The disciplined conclusion: OMEGA stays **shadow, weight-0, indefinitely** unless prospective
evidence contradicts the survivorship-free `no-edge` finding. That is the correct outcome.

## Test coverage

`test/omega-swing.test.js`, `omega-execution.test.js`, `omega-sizing.test.js`,
`omega-contract.test.js`, `omega-calibration.test.js`, `omega-gates.test.js`,
`omega-scoreboard.test.js`. Run: `node --test`.
