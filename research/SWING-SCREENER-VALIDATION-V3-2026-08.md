# Swing Screener Validation v3 — 2026-08

Study: `research/65-swing-replay-validation.js` (`swing-replay-validation-v3-2026-08`).
Architecture: `docs/swing-screener-replay-v3.md`.
Machine-readable artifacts: `research/data/swing-replay-v3/{manifest,per-date-metrics,verdicts}.json`.

## Headline verdict

**No swing strategy — including the current production screener — passed the
promotion gate. Production predictive weights are unchanged.** This is the
honest, expected result: it is consistent with the repo's standing evidence
(21-session 12-1 momentum IC ≈ +0.004, HAC t 0.37; nonlinear WF DSR ≈ 0.22;
OMEGA residual rank IC ≈ −0.027), and this study's own simple-momentum baseline
independently reproduced it (IC +0.0053, HAC t 0.36).

## Data versions and hashes

| item | value |
|---|---|
| engine | `swing-screener-engine-v1` (the exact live selection code) |
| datasetHash | `5796c5d526cc8cb2…` (sha256 of sorted member list + bar window) |
| members | 2,000 symbols (local research price cache; ≥280 bars; last-60-bar ADV ≥ $10M) |
| decision axis | 186 sessions, 2022-07-21 → 2026-03-30, every 5th SPY session |
| median cohort / eligible | 1,772 evaluated / 532 production-eligible per session |
| per-session candidate-set hashes | recorded in `per-date-metrics.json` (parity primitive) |
| run time | 42.6 s |

## Inspected variants (the FULL multiple-testing denominator: 4)

Frozen before running; nothing else was tried.

| trial | spec | p (HAC) | BH q (m=4) |
|---|---|---|---|
| A control | exact production selection, 21s | 0.343 | 0.457 |
| B sector-neutral vol-aware 21s | `1.0·z(sectorRelMom126) − 0.5·z(vol63) + 0.3·z(log10 $vol) + 0.2·hasStatus` | 0.044 | 0.175 |
| C 63s position | `volAdjMom` (mom63/ann. vol), separate position contract | 0.252 | 0.457 |
| D event revisions | **BLOCKED** — no PIT estimate history with verified publish timestamps (estimates-adapter is PIT_UNPROVEN); imputing timestamps is forbidden | — | — |

## Cohort and survivorship status

- Cohorts are fully observed per session: name-dates whose 21/63-session
  outcome is unobservable are excluded per name, never zero-filled; 1,638
  name-date outcomes with a |1-day| move > 50% were excluded as suspected
  unadjusted corporate actions (counted in the manifest).
- **Survivorship: PARTIAL, not proven-safe.** The cache contains many delisted
  names whose bars end; the per-date freshness gate then excludes them — but
  late listings and coverage gaps remain. `survivorshipProvenSafe=false` is a
  hard block in every gate below, by design.
- Macro overlay: no PIT VIX/credit series → replay ran `macroRiskOff:false`;
  the SPY-200DMA/breadth regime gate was replayed exactly.

## Parity results

- Live and replay run the SAME engine; per-session candidate IDs and
  candidate-set hashes are recorded, and `test/swing-replay-v3.test.js` proves
  exact live↔replay ID parity on frozen fixtures, input-order invariance, and
  that mutating future bars cannot change any historical selection or feature.
- The live route now publishes `selection.candidateSetHash` per response so any
  served session can later be replay-verified.

## Out-of-sample statistics (per-date series, Newey-West HAC, MBB 90% CI)

| metric | mean | HAC t | ESS | MBB 90% CI | chron blocks (+) |
|---|---|---|---|---|---|
| **A** eligible-cohort IC of the production quant score, 21s | +0.0099 | 0.95 | 60 | [−0.008, +0.026] | 2/3 |
| **A** selected-set (cap 20) excess vs SPY, 21s | +0.28% | 0.59 | 70 | [−0.51%, +0.97%] | 2/3 |
| **B** frozen challenger IC, 21s | **−0.0222** | −2.02 | 56 | [−0.042, −0.003] | 0/3 |
| **C** volAdjMom IC, 63s | −0.0130 | −1.15 | 40 | [−0.031, +0.007] | 0/3 |
| **C** top-10 mean excess, 63s | +3.2% | 0.96 | **19** | [−1.5%, +8.3%] | 2/3 |
| baseline: simple momentum IC 21s | +0.0053 | 0.36 | 51 | [−0.025, +0.024] | 2/3 |
| baseline: equal-weight eligible excess | −0.11% | −0.33 | 58 | — | 1/3 |
| baseline: placebo IC (shuffled outcomes) | +0.0007 | 0.25 | 186 | — | 2/3 |
| baseline: random score IC | −0.0088 | −2.79 | 186 | — | 0/3 |

Caveat on the random baseline: a seeded random score drawing t≈−2.8 across 186
dates is a reminder that |IC| magnitudes near 0.01 in this design are within
the noise floor — which is exactly the magnitude of every "positive" number
above.

## Execution assumptions

Entry = next-session open + adverse slippage (`exec-v1`), never the signal-day
close; participation capped at 2% of ADV (research engine); gap-through stops
graded stop-first on the fill bar; cost stress = base (`lib/costs` liquid
round-trip), doubled, and small-tier ×1.5 (stressed).

Control economics (A, selected cap-20, 21s): gross +0.275% → net base +0.115% →
**net doubled −0.045% → net stressed −0.625%**. The production selection does
not survive cost stress even before significance is considered.

## Calibration results

No challenger produced (or was allowed to produce) a probability: nothing here
is out-of-fold calibrated, so every `probability` field is null with
`calibrationStatus: 'uncalibrated'` (defect #7 contract). Brier/ECE/reliability
are therefore NOT APPLICABLE this cycle — running them on uncalibrated scores
would itself be a semantics violation.

## Failure / abstention analysis

- B failed with a *negative* IC in every chronological block — the exploratory
  diagnostic that motivated it did not survive a frozen, purged re-test. It
  stays weight-0 shadow; its registry entry is unchanged.
- C's shortlist ESS (19) is far below the ≥30 bar; the overall 63s IC is
  negative. The `position` horizon remains a research contract only.
- D correctly **abstained**: blocked on missing PIT timestamps rather than
  imputing them.
- The router stack's abstention behavior was verified separately
  (`test/regime-router-constraints.test.js`): thin cells stay neutral,
  all-negative skill → all-zero weights (cash), unmeasured inputs never boost.

## Promotion verdict (per strategy)

Full 15-check gates in `verdicts.json`. Summary:

| strategy | FDR | ESS≥30 | 3+ blocks | abs. OOS IC>0 | cost-net (all stress) | survivorship | prospective | verdict |
|---|---|---|---|---|---|---|---|---|
| A control (production) | ✗ | ✓ (60) | ✗ (2/3) | ✓ (t<1) | ✗ | ✗ | ✗ | **NOT PROMOTED — no confirmed edge; keep serving as-is, weights unchanged** |
| B sector-neutral 21s | ✗ (q 0.17, wrong sign) | ✓ | ✗ (0/3) | ✗ | n/a | ✗ | ✗ | **REJECTED for promotion; remains shadow** |
| C 63s position | ✗ | ✓/✗ (IC 40, top-10 19) | ✗ | ✗ | ✓ (point est. only) | ✗ | ✗ | **INSUFFICIENT — stays shadow research** |
| D event revisions | — | — | — | — | — | — | — | **BLOCKED (PIT data inadequate)** |

No strategy cleared every gate ⇒ **no registry change, no weight change, no new
probabilities.** Deterministic engineering corrections (defects 1–7) shipped to
production; every predictive artifact stays SHADOW.

## Unresolved data limitations

1. Survivorship not proven-safe (partial delisting coverage only) — blocks any
   absolute-edge promotion from this harness; Sharadar (user decision pending)
   or the pitdata v3 spine would be needed to lift it.
2. No PIT macro (VIX/credit) series for replay → the macro arm of emerging
   admission is not replayable yet.
3. No PIT estimate/revision timestamps → challenger D blocked.
4. Local cache covers 162/528 of the live LARGE list; the study universe is the
   liquidity-floored full cache instead (broader, partially de-survivorshiped,
   but not the literal live list).
5. FMP price basis assumed split-adjusted; suspected unadjusted actions were
   excluded (1,638 name-dates), not corrected.

## Reproduce

```
npm test
node research/65-swing-replay-validation.js --step 5 --maxNames 2000
node --test test/swing-replay-v3.test.js          # live↔replay parity proofs
curl '…/api/tracker?op=confluencemarginal'        # shadow marginal report
```
