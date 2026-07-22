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

## 8. Validation & promotion (Phase 15)

`op=omegawf` runs the purged walk-forward. `evaluateGates()` (pure, unit-tested) is the fail-closed
promotion logic:

- `passed` (statistical edge) requires: ≥3 blocks all positive · meanOOS > 0.02 · **not
  deadline-truncated** · **tier payoff monotone on cost-net residual** · **beats every simple
  baseline** (10d momentum, 52wk-high proximity, relVol).
- `promotable` additionally requires **live-funnel parity** *and* **survivorship-safe**.

Because the replay scans a **static present-day universe**, `historicalLiveParity` and
`survivorshipSafe` are `false` — so **`promotable` is structurally false**. A challenger can never
be promoted off this harness alone. `verdict` is `inconclusive-truncated` on any deadline hit.

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
- **Point-in-time candidate-funnel reconstruction** (Phase 4) — live snapshots of the `op=today`
  funnel must be logged going forward; the static-universe replay cannot reproduce it.
- **Survivorship-complete universe** — needs the research-side PIT security master; until then
  `survivorshipSafe:false` blocks promotion.
- **Setup state machines** (Phase 6) remain the v1 strength-score detectors, not full stateful
  machines with episode boundaries.

## External data still required

Point-in-time universe snapshots + delisted-name coverage (survivorship-complete security master),
and a prospective log of the exact `op=today` candidate funnel. Real-time quotes/spreads would
sharpen the execution model but are not required for the next-open honesty guarantee.

## Next highest-value phase

**Phase 4 — log the live `op=today` candidate funnel prospectively** (snapshot id, source score,
rank, eligibility, regime) each day. That is the single blocker that would let a future challenger
be *promotable*; everything else (execution, ledgers, calibration gate, sizing, governance) is now
in place to consume it.

## Test coverage

`test/omega-swing.test.js`, `omega-execution.test.js`, `omega-sizing.test.js`,
`omega-contract.test.js`, `omega-calibration.test.js`, `omega-gates.test.js`,
`omega-scoreboard.test.js`. Run: `node --test`.
