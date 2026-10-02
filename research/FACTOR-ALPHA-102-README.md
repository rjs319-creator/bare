# 102 — Factor-adjusted Scoreboard: offline cross-check

Companion to `lib/factors/` (proposal #18, `docs/GITHUB-RESOURCE-SCAN-2026-10-02.md`) and the
registry row `factor-adjusted-scoreboard-alpha` (confirmatory, **open**, shadow until 2027-04-02).

`research/102-factor-alpha.py` is the *independent oracle* for the in-house ridge + HAC code in
`lib/factors/factor-alpha.js`: the same question asked with alphalens-reloaded, linearmodels and
statsmodels. It is research-only — it writes no Blob, feeds no grade.

## What it computes

| Step | Library | Question |
|---|---|---|
| lane alphaFF | statsmodels (`fit_regularized` ridge + `cov_type="HAC"`) | per lane × horizon: date-level cost-net return − RF window, regressed on FF5 + MOM window returns; Benjamini-Hochberg q across cells; gate `alpha ≥ 0 ∧ q ≤ 0.10`; **n ≥ 60 dates** or `insufficient` |
| parity | — | compares those alphas with the persisted `factorAlpha` block in `scoreboard/summary.json` (`source: "ff"` cells only); a gap > ~0.05 pp means one implementation is wrong |
| alphalens | alphalens-reloaded | IC decay (1/5/10/21d) and top-minus-bottom quintile return of the per-pick **score** (Session Board grade / screener score) — is the score informative at all? |
| Fama-MacBeth | linearmodels `FamaMacBeth(cov_type="kernel")` | per-date cross-sectional regression of pick returns on trailing-252-session FF betas; the intercept is the factor-neutral pick premium with Newey-West SE |

## Running it

```bash
python3 -m venv .venv-factor && . .venv-factor/bin/activate
pip install alphalens-reloaded linearmodels statsmodels pandas numpy scipy
python research/102-factor-alpha.py --picks picks.json --ff ff5mom-daily.json \
       --prices research/data/prices --summary summary.json
```

Verified 2026-10-02 on Python 3.9.6: `alphalens-reloaded 0.4.5`, `linearmodels 6.1`,
`statsmodels 0.14.6` install cleanly in a venv (≈2 min).

## Inputs and what is missing today

1. **`--picks`** — a JSON array of graded rows `{lane, date, ticker, horizon, bars, net, score?}`.
   `op=scoreboard` returns *summaries*, not rows, so this needs a one-off exporter run against
   the Blob ledgers with the Scoreboard's own grading loop (`lib/apex-routes.js runScoreboard`,
   the `r` objects pushed into `g.h[hk]` carry exactly these fields plus `fx`). **Not written** in
   this PR: it would be a bearer-gated op or a `scripts/` dump with Blob credentials, outside this
   proposal's modules. Until it exists the script cannot run.
2. **`--ff`** — `factors/ff5mom-daily.json`, written weekly by `op=factorsrefresh` after merge
   (or `--fetch-ff` pulls the two Dartmouth zips directly; verified live, 2,932 rows 2015→2026-08-31).
3. **`--prices`** — the research price cache (`research/data/prices/<TICKER>.csv`). The
   `research/data` symlink is **not present in this worktree** (it lives in the main checkout and
   is never committed), so the alphalens and Fama-MacBeth steps were not run here.
4. **`--summary`** — `scoreboard/summary.json` *after* the first nightly run that writes the
   `factorAlpha` block.

So: the script ships, deps install, but **no step was executed on real data** — inputs 1, 3 and 4
do not exist yet, and input 1 needs an exporter that is deliberately out of scope.

## What the prod read-only probe already says (2026-10-02)

From `GET /api/tracker?op=scoreboard` and `op=maturity` without a bearer:

- **0 lanes are graded Validated.** Grades: promising 4 (ghost@swing n=35, events@position n=34,
  crossasset@position n=25, screener@swing n=35), experimental 44, informational 8, disabled 6.
  The "how many Validated lanes lose significance" count is therefore **0 by construction**;
  the honest target population is the 4 promising lanes, none of which reaches 60 dates.
- **1 of 526 lane × horizon cells has ≥ 60 independent decision dates** (`screener:Setup:large`
  at 1d, n = 60, cost-net excess −0.22 %). Distribution: ≥60 → 1, 30–59 → 111, 10–29 → 250,
  <10 → 98. The n-guard will mark essentially every cell `insufficient` at launch; the block will
  fill in as the ledgers age (≈ 3 trading months per lane to cross 60). This is the preregistered
  threshold from the proposal and is not loosened here — a 7-regressor fit on 30 dates is noise.

## Frozen parameters (match the registry row and `lib/factors/factor-alpha.js`)

`MIN_DATES = 60`, ridge λ = 1 in standardised factor space (intercept unpenalised), HAC Bartlett
lags = `horizonBars − 1`, Student-t p at df = dates − factors − 1, BH q ≤ 0.10, proxy-vs-FF beta
correlation threshold 0.8 on ≥ 10 pooled pairs. Changing any of them is a new registry row.
