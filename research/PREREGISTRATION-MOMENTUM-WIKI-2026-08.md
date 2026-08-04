# Preregistration — `momentum-wiki-2014-2018`

Registered 2026-08-04, BEFORE any outcome, IC, or return statistic was computed
from the WIKI-mirror panel (which does not yet exist at registration time).
Status at registration: OPEN. The seal is this document's commit hash; any
post-hoc edit shows in git history.

This is a NEW hypothesis, not an amendment: `momentum-longer-horizons` §5
declares any deviation a separately preregistered hypothesis, and this deviates
in era, universe, and survivorship class. Its `momentum-historical-2010-2021`
holdout REMAINS SEALED and is not touched by anything here. This registration
widens the `swing-ranking` family denominator — the accepted cost of asking the
momentum question again on free data.

## 1. Motivation and what this can and cannot conclude

The motivating observation is the SAME spent exploratory read as
`momentum-longer-horizons` (2022-2026 panel `b361e861…`: 63s IC 0.0316 t 5.48
ESS 24; 126s IC 0.0451 t 7.09 ESS 18) — permanently excluded from any verdict.

The data is the frozen Quandl WIKI mirror
(`kaggle:marketneutral/quandl-wiki-prices-us-equites`,
sha256 `ca7fb174c7948db85638917d25ff65d438e27d5cb23675da784c54db01e3d003`),
measured in `research/data/wiki/coverage-report.json`: 3,199 tickers,
raw + split/dividend columns, frozen 2018-03-27; EDGAR Form-25 real-death join
shows 94% end-date agreement (±45d) for the 400 era deaths present in WIKI, but
**~1/3 of the era's 879 verified real deaths were never in WIKI at all, and no
ticker in the dataset ends before 2014** (pre-2014 deaths absent at source).

Therefore, BY CONSTRUCTION and declared now:

- The panel's survivorship contract is `survivorship-reduced`, always.
- **Verdict ceiling: `pass-provisional (survivorship-reduced)`.** No result of
  this study can promote a live strategy, claim survivorship-safe evidence, or
  substitute for the sealed Era-A study. A pass justifies (at most) buying the
  authoritative data to run Era A properly; a fail closes the free-data
  question.

## 2. Hypothesis (fixed)

`m121` — the 12-1 skip-month momentum ratio on the total-return index, computed
EXACTLY as by `research/15-panel-features-v3.js` (`ratio(ps, i, 252, 21)`) —
positively ranks 63-session and 126-session forward total return on fully
observed monthly cohorts of the WIKI-mirror universe, decision dates
2014-01..2017-12. Two horizons, one registry entry, per the
`momentum-longer-horizons` convention; the BH denominator is
`familyTrials('swing-ranking')` at evaluation time (it can only have grown).

## 3. Fixed design — no free parameters at evaluation time

**Source artifacts** (`research/lib/wiki-source.js`, wiki-source-v1):

- Bars: derived split-adjusted basis — raw WIKI bars ÷ suffix product of
  `split_ratio` (volume ×), NEVER WIKI's own `adj_*` columns (they embed
  dividends; feeding them to the TR builder would double-count). Every symbol's
  derived basis is cross-checked against WIKI `adj_close` day-over-day ratios on
  non-dividend days; mismatch fraction > 1% (≥50 pairs) excludes the symbol.
- Corporate actions: synthesized from `split_ratio` (numerator/denominator) and
  `ex-dividend` (adjDividend on the adjusted scale); the standard
  `verifySplitAdjustment` / `decisionTimeQualityAudit` run unchanged.
- Identity: `listingId = wiki:<ticker>`. WIKI has no permaticker, so the
  **zombie rule** applies: a ticker whose bars continue > 45 days past a
  Form-25-verified real death is a ticker-reuse collision and is excluded
  entirely (the measured set is ~20 names, e.g. ALTR Altera→Altair).
- Delistings: attached ONLY from the verified Form-25 real-death join
  (`delisting.reasonCategory` present; acquisition→carry, bankruptcy→haircut per
  outcome-v3's frozen reason treatment). A name whose bars end mid-era with no
  verified death carries `status: unknown` and resolves `unresolved` (fail
  closed) — policed by the cohort coverage minimum.

**Panel** (`research/64-wiki-era-build.js`, panel-v3.2-wiki — the UNCHANGED
v3.2 builder with preregistered parameters):

- Decision grid: month-ends 2014-01..2017-12 (48 cohorts).
- Universe band: **ADV20 ≥ $3M only.** WIKI carries no shares outstanding, so
  the frozen cap band is REPLACED, not approximated. No upper bound (an
  untuned choice, declared).
- Horizons [21, 63, 126] sessions on the observed-union session calendar;
  `labelObservationCutoff` derived from the data (the 2018-03-27 freeze edge);
  cohort eligibility = the standard ledger (window elapsed ∧ pending 0 ∧
  coverage ≥ 95%). 21s rides along as panel furniture; the hypothesis tests
  63s and 126s ONLY.
- Labels `f63`/`f126` = fwd-outcome-v3 on the TR index, `unknownReasonPolicy:
  'exclude'`; structural poisons and x-flag sensitivity semantics unchanged.
- The panel must pass `verifySnapshotManifest` at build and the UNCHANGED
  `audit:research` (`RESEARCH_DATA_DIR=research/data/wiki-era`) with zero
  criticals before any evaluation.

**Evaluation** (`research/66-wiki-confirmatory.js`, ONE run ever):

- Per-date Spearman rank IC of `m121` vs `f{h}` over rows of ELIGIBLE cohorts
  only, minimum 30 names per date (dates below the floor are dropped and
  counted).
- Success criteria, ALL required, per horizon:
  1. Newey-West HAC t > 0 (lags = horizon−1 sessions) with multiple-testing
     bound q ≤ 0.10 at trials = `familyTrials('swing-ranking')` at evaluation.
  2. ESS ≥ 30.
  3. Beats a shuffled control (labels permuted within date) on the same rows.
  4. Dominant-date fraction < 0.5.
  5. Holds in BOTH sensitivity views (include-all vs exclude-x{h}-flagged).
  6. Economic gate: exec-engine-v1, top-decile long by `m121`,
     next-session-open entry on the WIKI raw-basis bars, net > 0 under base,
     doubled, and stressed-liquidity costs.
- The runner refuses to run without the panel + clean audit artifact; refuses
  to run twice (an existing evidence record is terminal); writes ONE
  append-only evidence record; the `momentum-wiki-2014-2018-era` holdout is
  then opened via a reviewed diff — irreversibly.

## 4. Prohibitions

No threshold or parameter tuning; no subgroup, sector, band or regime selection
for the verdict; no additional horizons; no universe changes; no era extension
(pre-2014 is survivorship-biased at the source; post-2018-03 does not exist in
this data); no winsorization changes; no early or repeated verdict attempts; no
reuse of the 2022-2026 exploratory window; no promotion claim under ANY result
(§1 ceiling). Any deviation is a NEW hypothesis that must be preregistered
separately and widens the family denominator.

## 5. Relationship to the Sharadar decision

This study exists to close the free-data branch of the Era-A question.
Pre-committed interpretations:

- **Fail** → the free question is closed; the remaining options are buying the
  authoritative universe for the true Era A, or accepting the standing no-edge
  verdicts.
- **Pass (provisional, survivorship-reduced)** → evidence that the purchase has
  positive expected information value; it is NOT itself deployable evidence.
