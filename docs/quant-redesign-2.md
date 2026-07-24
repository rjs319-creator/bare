# Quant Redesign — Part II (four-sleeve honesty pass)

Companion to `docs/quant-system-audit.md` and `docs/quant-redesign.md`. Records the change
set that reorganizes the screeners around four orthogonal specialist sleeves and fixes the
highest-value honesty defects — and states plainly, in dependency order, what remains.

> **Reality constraint (unchanged).** Infinite predictive power is impossible. Nothing here
> claims new alpha. Every fitted/shadow output is research/shadow until it clears
> `docs/model-promotion-policy.md` on survivorship-safe data — which this repo still lacks.

## What shipped in this pass (additive, tested, no live-rank change)

| Area | Module(s) | What changed | Status |
|---|---|---|---|
| **Canonical contract** | `lib/prediction-contract.js` (+test) | One schema that keeps rank ≠ probability ≠ confidence ≠ evidence separate; null-discipline (unknown probabilities are `null` **with a reason**, never fabricated); range/enum validators; frozen output. | **new** |
| **Coil semantics** (Specialist 2) | `lib/coil-executable.js`, `lib/coil.js`, `lib/screener-routes.js`, `public/js/app.js` (+tests) | Split the conflated number: `pAbnormalExpansion` (empirical, calibrated — the abnormal-EXCURSION rate) is now reported **separately** from executable `pTrigger` / `pTargetBeforeStopGivenFill` / `pProfitableNetGivenFill` / net-of-cost `expectedNetR`, computed by a transparent **uncalibrated** driftless-barrier model. The UI relabels the % as "chance of an abnormal move" and adds a distinct "trade-plan odds (uncalibrated model)" line. | **new** |
| **Gap-Down execution** (Specialist 4) | `lib/gapdown.js`, `lib/screener-routes.js`, `public/js/app.js` (+tests) | Fail-closed borrow gate: with no borrow feed, every short is `actionable:false` / `research-watch` with an explicit reason; a real borrow feed (`opts.borrow`) unlocks an actionable short only within a fee ceiling. UI shows a **WATCH ONLY** badge. | **new** |
| **Trend Core** (Specialist 1) | `lib/trend-core.js`, `lib/decision.js` (+test) | Completed the correlated-family map (`apex`/`ignition`/`trendrider`/`coremo` → `priceTrend`) so they can't count as independent confirmations; added a **shadow** consolidation that reads the 6 trend engines as **one price domain** via a robust median rank (not a redundancy-laundering average), reporting `independentEvidenceDomains` and disagreement-shaded confidence. | **new (shadow)** |
| **Confluence honesty** | `lib/confluence.js` | Corrected the stale header comment; scoring was already correlation-discounted (`CORR_DISCOUNT`). | doc-only |

### Verification
- New unit tests: `test/prediction-contract.test.js`, `test/coil-executable.test.js`,
  `test/trend-core.test.js`; extended `test/gapdown.test.js`.
- Full `node --test` suite: green (see the run recorded in the delivery summary).
- `node --check` passes on every touched `lib/`, `api/`, and `public/js/app.js` file.

## What was already built (verified, no work needed)
Confluence independent-family discount; Ignition acceleration-stage machine
(accelerating/maintaining/decelerating/exhausted); CERN per-event-type separation +
paper-only Thompson sampling; Down-Day red-tape-specific training; Fade hierarchical
partial pooling + risk-off gate; the 11-state opportunity lifecycle with append-only
history, false-retirement recording, and hysteresis revival; Gap & Go edge with the
logistic meta-model correctly gated OFF; purged/embargoed walk-forward, uniqueness
weighting, deflated Sharpe, out-of-fold calibration, PIT security-master schema,
immutable ledger, and the champion/challenger promotion policy.

## Remaining work — dependency-ordered (NOT done here)

Each item is genuinely missing or partial per the subsystem audit. None is blocked by the
code changes above; several are blocked by **external data** and cannot be honestly closed
in-repo.

1. **Contract adoption breadth.** Only Coil, Gap-Down and Trend Core emit
   `lib/prediction-contract.js` today. Roll it through Gap & Go, Down-Day/V-Reversal, Fade,
   Apex, and the decision composite via thin adapters (keep native fields for back-compat).
   *Prereq for:* uniform novice/expert cards (#6).

2. **Validation-suite completeness** (`lib/research/*`, `lib/walk-forward.js`).
   Add: a **delisting outcome** to the label engine (`exitReason:'delist'` is enumerated but
   no engine computes it); an explicit **realized R-multiple** on the unified trade record;
   **rolling-window** folds (only anchored/expanding exist); **IC-decay** (IC vs horizon);
   **PBO/CSCV**; and a **persisted append-only experiment registry** that auto-counts every
   tested feature/threshold/model for honest multiple-testing deflation (today only
   `makeExperimentManifest` + per-grid DSR exist).

3. **Momentum universe de-biasing** (`api/momentum.js`). It still defines its universe
   solely from StockTwits trending names — social IS the universe. Scan the broad liquid
   point-in-time universe as the primary pool and demote the social list to a **labeled
   attention overlay** ("attention-selected"). *Touches a live surface — stage behind a
   flag and shadow-compare first.*

4. **Intraday genuine discovery** (`lib/daytrade.js`, `lib/lifecycle-routes.js`). 5-minute
   data currently only **validates** top EOD picks; it never **discovers** names absent from
   the daily scan. Add a broad intraday 5-minute discovery pass feeding the lifecycle board.
   Also add the missing candidate features: VWAP slope, sector (not just market) residual,
   spread/liquidity, halt risk, verified catalyst.

5. **Router regime vector** (`lib/algo-router-routes.js`). Routing mechanics are complete
   and shadow, but the regime input is a coarse 3-state VIX+credit vector. Extend to the
   documented axes (term structure, breadth, dispersion, rates, dollar, liquidity,
   concentration, cap leadership, event density). Keep shadow.

6. **Dual-layer novice/expert lifecycle card + wiring** (`public/js/*`). The `op=lifecycle`
   state board is not fetched by the frontend. Wire it, and render a dual-layer card
   (novice: state / setup / why-now / trigger / stop / target / hold / one risk / validated
   flag; expert: percentile, calibrated probs, CIs, expected net R, residual forecast,
   regime probs, evidence domains, feature contributions, fill/borrow assumptions, sample
   size, validation window, OOS metrics, DSR status, versions, provenance, lifecycle
   history). Depends on #1.

7. **AI-screen provenance write-through** (`lib/readthrough.js`, `secondwave.js`,
   `anomaly.js`, `crossasset.js`, `toneshift.js`). They are correctly labeled research-only
   and forward-logged, but discard source citations. Persist per feature: source URLs,
   source publication time, retrieval time, decision-time availability, entity/ticker
   mapping, extraction confidence, and a historically-reconstructable flag — writing through
   the existing `lib/research/schemas.js` PIT fields (`decisionTs`/`dataCutoffTs`).

### External-data blockers (cannot be closed in-repo — do not claim resolved)
- **Point-in-time constituents + delisting returns across all cap bands.** The one hard
  blocker for a survivorship-safe backtest. `?pit=1` de-survivorships **large-cap only**
  (S&P-500 scrape, ≤5yr); small/micro delistings — the bulk of survivorship risk — remain
  uncovered. Every result stays `survivorshipSafe:false` until a real PIT feed exists.
- **Name-level short borrow availability + fees.** Required to turn Gap-Down / Fade shorts
  from research/watch into actionable. Absent → fail-closed (implemented).
- **Real-time consolidated tape / LULD / halts.** Required for true intraday halt-risk and
  no-fill modeling beyond the current conservative approximations.
