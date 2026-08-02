# Migration — Forward-Outcome Contract (fwd-outcome-v2), 2026-08

## Root cause

`research/lib/pit.js::fwdReturn` (v1) returned the last available **partial** return with
`delistedWithin=true` whenever the requested target bar ran past the cached series. That flag was
not a delisting signal — it was a "ran out of cached bars" signal — so it conflated:

1. a genuine delisting inside the horizon,
2. an **active** stock whose outcome simply hadn't matured yet,
3. a stale / incomplete / unknown series.

Effect on the panel (`research/14-panel-features.js`, which wrote the flag straight through as
`d21/d63/d126` with **no** active-guard): with the panel generated 2026-06-26 over a grid ending
2026-05, roughly the last 1 month of rows was mislabeled "delisted" at 21d, ~3 months at 63d, and
~6 months at 126d — and their truncated partial returns leaked into labels.

Measured after the fix (panel-v2 rebuild, same cache):

| | v1 panel | v2 panel |
|---|---|---|
| rows | 78,443 (2022-06..2026-05) | 76,674 (2022-06..2026-04) |
| "delistings" @21d | entire final month (~1,769 rows) flagged | **345 genuine** |
| @126d non-labels | truncated partials kept as labels | **8,499 pending + 42 unresolved → null (fail closed)** |
| genuine delistings @126d | indistinguishable | 1,938 (Shumway-adjusted) |

## The v2 contract

`pit.forwardOutcome(series, dateMs, bars, opts)` always returns an object with explicit status:

- **mature** — full horizon observed; `adjustedReturn === rawReturn`, `delistingAdjustment = 0`.
- **delisted** — the name verifiably stopped trading inside the horizon (last bar ≥ 30 days before
  the data cutoff 2026-04-01); `rawReturn` = partial path, `adjustedReturn` = Shumway −30% applied.
- **pending** — still trading at the cutoff (last bar within 10 days of it) and horizon not elapsed;
  `adjustedReturn = null`. **Never usable as a label.**
- **unresolved** — ambiguous tail (10–30 days before cutoff), stale entry bar, no forward bars, bad
  prices, bad input; `adjustedReturn = null`. **Fail closed.**

Provenance carried on every outcome: `status, horizonBars, observedBars, entryDate, entryIndex,
expectedExitIndex, expectedExitDate, actualExitDate, rawReturn, adjustedReturn,
delistingAdjustment, reason, dataCutoff, securityMasterVersion, outcomePolicyVersion`.

The legacy `pit.fwdReturn` shape survives but is now **fail-closed**: it returns a value only for
`mature` and `delisted` (with the full outcome attached at `.outcome`); `pending`/`unresolved`
return `null`. This automatically fixes every legacy caller that treated `delistedWithin` as a
delisting signal. `secmaster.ACTIVE_CUTOFF_MS` now aliases `pit.DATA_CUTOFF_MS` (single source).

Tests: `test/pit-forward-outcome.test.js` (all four statuses, boundaries, fail-closed wrapper,
provenance fields, custom cutoff/haircut).

## Contaminated artifacts and disposition

### Producer

- `research/14-panel-features.js` → **rewritten (panel-v2)**. `f{h}` = label-ready return (raw when
  mature, Shumway-adjusted when delisted) or null; `d{h}` = 1 only for genuine delistings; new
  `s{h}` status char. Header records `panelVersion / outcomePolicyVersion / securityMasterVersion /
  dataCutoff`. `research/data/panel-features.json` **regenerated** (gitignored, not committed).

### Panel consumers (all research-side; no live-app reader exists)

| Script | v1 defect | Disposition |
|---|---|---|
| 15-sweep, 16-robustness, 17-additions, 18-validation, 19-subuniverse, 20-concentrated, 21-rebal-ensemble | dropped every `d*==1` row (survivor-bias for genuine delistings; silently truncated recent months) | filter flipped to "f != null" — genuine delistings now included at their adjusted return |
| 23-resolution-harness | ignored `d63`; fed truncated partials into live `aggregatePerformance()` (console-only) | finite-f63 guard; v2 nulls drop pending automatically |
| 28-mlrank.py | comment falsely claimed labels were delisting-aware; truncated partials in f21 | claim now true under panel-v2; isfinite filter drops nulls; **rerun against v2 panel** |
| 30-sizing.py / 31-multisleeve.py / 32-hardened.py | same f21 contamination | finite-filter verified; rerun required before citing |
| 24-sue.js / 26-si.js (direct fwdReturn callers) | no delisting handling at all; truncated partials in IC | now consume `outcome.adjustedReturn`; pending/unresolved drop |
| 53-omega-survivorship-free.js (own `fwdResidual`) | latent same-class bug (no active-guard) | active names with unelapsed windows now return null (pending), never a haircut |

### Data artifacts invalidated (regenerate before citing; all gitignored)

`sweep.json`, `subuniverse.json`, `sizing.json`, `multisleeve.json`, `hardened.json`, `sue.json`,
`reversal.json`, `sector-momentum.json`, `residual-momentum.json`, `construction.json`, plus the
corresponding `.log` files from steps 05/06/08/15–21. `panel-200.json` / `panel-all.json` have zero
readers (dead, superseded). **Clean:** `survivorship-bias.json` (04 had a correct active-guard +
Shumway), everything under `research/intraday/`, and all NSL/ATLAS-X/RLT/PeerProp harness outputs
(they use the app-side `lib/research/` PIT slice, not `pit.fwdReturn`).

### Reports

- `research/ALPHA-RESEARCH-2026-07.md` — contamination banner added. Affected: N1 (28-mlrank), S1
  (30-sizing), S2 (31-multisleeve), S3 (32-hardened), F1 (24-sue), and the short-interest numbers
  (26-si), plus the biased-panel composite row. The mom_12_1 control was already superseded by
  `MOMENTUM-SURVIVORSHIP-FREE-2026-07.md` (clean — 52 had the correct guard).
- All other research reports verified clean (see audit list in this doc's git history).

### Live app

**No live code path reads any panel-derived artifact.** `pcarry-model.json` and
`timing-weights.json` do not descend from `fwdReturn`. The one research→live file
(`lib/omega-research-verdict.json`, written by 53) is regenerated under the fixed guard on next run.

## Related redesign work in this change (objectives 3–10)

- **12–1 momentum benchmark**: `momentum-12-1` is a required benchmark ranker auto-appended by
  `lib/research/harness.runExperiment` (new `mom121` PIT feature in `lib/research/features.js`,
  never proxied on short history); research-side scripts (28/30/31/32) already carry a raw
  mom_12_1 baseline. Benchmark status does not make momentum a live winner — its own measured
  edge on this universe is ≈0, and promotion always goes through the prospective evidence gates.
- **Gap & Go ORB**: execution realism fixed (stop-through-trigger fills at the trigger bar's open
  when it gaps through; conservative entry-bar stop check); app-side contract label aligned with
  what the ledger actually measures (daily-close proxy) until fills are verified.
- **Nonlinear ML**: 28-mlrank rerun on the clean panel decides whether GBM stays; the bar is
  incremental OOS economic lift over Ridge **and** 12–1 momentum (IC delta significant, DSR).
- **Sector-peer model**: shadow isolation asserted by regression test (no peerprop branch in
  decision sources; `isTradeEligible('peerlab') === false`).
- **Self-learning**: timing/dualread/calibration loops now learn only from matured, cost-net
  outcomes; maturity/governance can't grade "validated"/production off gross-only records.
- **Regime routing**: regime-specific evidence gates raised to statistically sufficient samples;
  the older `algorithm-router.js` flattering defaults removed (fail-closed nulls).
