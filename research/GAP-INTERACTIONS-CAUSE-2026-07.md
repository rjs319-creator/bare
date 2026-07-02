# Gap & Go meta-label — interaction models + gap-cause de-lumping (2026-07-02)

Two follow-ups on the ONE deflation-surviving edge (unscheduled ≥5% gap + ORB,
exp08 PF 1.47 / DSR 0.99), both asking whether we can beat the **shipped**
meta-label — `lib/gapgo.js` `continuationScore` (0.42·gapN + 0.28·relVolN +
0.30·regimeN) and the opt-in `skipFadeCauses` gate — on its own terms. Both are
**NULL / no-ship.** Backtested on the survivorship-corrected event set (19,326
non-earnings ORB-triggered gap events, 2021-09..2026-06; build: `research/36-gap-events.js`).

Scripts: `research/37-gap-interactions.py`, `research/38-gap-cause-join.js`,
`research/39-gap-cause-eval.py`; pure helpers `research/intraday/src/intraday/metalabel.py`
(JS-pinned `continuationScore` port + purged-WF + cluster-bootstrap + lumpiness,
20 unit tests). Outputs: `research/data/gap-interactions.json`, `gap-cause-eval.json`.

---

## E1 — Do INTERACTIONS beat the shipped linear heuristic? ❌ NULL

The shipped score is linear/additive and was validated univariately. The one lens
that misses: interactions (gap×relVol×regime, extension×regime, …). Tested three
rankers against the shipped `continuationScore` baseline under **purged expanding
walk-forward** (half-year folds 2023H1..2026H1, 7-calendar-day purge > the 3-session
outcome window), pre-registered configs (no tuning, no variant search):

- **LOGIT-MAIN** — logistic on the 5 z-scored mains (a calibration control)
- **LOGIT-INT** — same + all 10 pairwise products (explicit interactions)
- **GBM** — shallow HistGradientBoosting (free-form interactions)

**Pooled OOS top-third expR** (n=4,752 test events per ranker):

| ranker | expR | PF | top-decile expR | Δ top-third vs baseline (cluster-boot CI) | folds beaten |
|---|---|---|---|---|---|
| **BASELINE (shipped)** | **+0.0604** | **1.35** | +0.0591 | — | — |
| LOGIT-MAIN | +0.0365 | 1.25 | +0.0339 | −0.0239 [−0.090, +0.046] | 1/7 |
| LOGIT-INT | +0.0412 | 1.26 | +0.0460 | −0.0192 [−0.080, +0.034] | 3/7 |
| GBM | +0.0263 | 1.18 | +0.0478 | −0.0341 [−0.094, +0.018] | 2/7 |

Mean per-fold OOS **rank-IC**: baseline **+0.0115** (4/7 folds positive) vs
LOGIT-MAIN −0.0152, LOGIT-INT +0.0045, GBM −0.0109. Selection overlap with the
baseline's top-third: 0.43–0.58 — the refit models genuinely pick *different*
trades, and those trades are *worse* OOS.

**Verdict: NULL.** Every refit model — including the linear control on the identical
features — underperforms the fixed shipped weights out-of-sample. Not only is there
no interaction alpha; **refitting parameters *loses* signal** vs the pre-registered
prior-based weights. This is the classic small-signal regime where fixed economic
priors beat estimated coefficients (fitting noise into a right-skewed ~50%-hit edge).

**On the deflation number** (don't misread it): the GBM top-third series has PSR/DSR
≈ 1.0 — but that only says *a positive-expectancy subset of an already-positive edge
is real*, which is true of the baseline's subset too (PSR 1.0). The **decisive**
statistic is the delta vs baseline, and it is negative with a CI that reaches ≤0 for
all three models. DSR 1.0 is **not** a licence to ship GBM.

---

## E2 — Does GAP-CAUSE conditioning de-lump / sharpen the edge? ❌ NULL (and it HURTS)

Joined the **shipped** `classifyGapCause` (headline-only) onto every strategy event
in the news-available window (≥2025-10-15), then ran the shipped `GAP_CAUSE_FADE`
skip (offering + M&A) against a pre-registered de-lumping test.

### News coverage — the pilot's main caveat is resolved

**73% of events had news** (3,007 / 4,147), after a 3-pass mop-up drove fetch
failures 364 → 20 → **0**. This is **more than double the step-27 pilot's 32%** —
because this joins to the *strategy's* events (open-gap ≥3%, liquid, ORB-triggered)
rather than the pilot's close-close ≥7% drift sample. Coverage bias is no longer the
dominant caveat. Cause counts: OTHER 2188, NONE 1140, CONTRACT 247, MA 188, GUIDE
147, FDA 105, FADE_OFFERING 132.

### The FADE-drag hypothesis does NOT carry to the strategy outcome

The step-27 pilot (21-day drift) found offering/M&A gaps fade hard (−0.42% / −5.69%).
On the **strategy's own R-multiple outcome** (2.5×ATR / 1:2 ORB), that reverses or
vanishes:

| test | result |
|---|---|
| **FADE vs non-FADE expR** | +0.0132 vs +0.0197 · Δ −0.0065, cluster-boot CI **[−0.080, +0.060]**, p(Δ>0)=0.42 — **straddles 0** |
| **portfolio take-all vs skip-FADE** | +0.0192 → +0.0197 expR, PF 1.13 → 1.13, top-5 share 0.014 → **0.015** — no change, no de-lumping |
| **top-decile precision, ex-FADE** (ALL ≥3%) | +0.0544 → **+0.0251** (halved), winsor mean +0.028 → **−0.002** |
| **top-decile precision, ex-FADE** (STRONG ≥5%) | +0.0455 → **+0.0005** (killed), winsor mean +0.046 → **−0.022** |
| **stability by half** | FADE drag **flips sign**: 2025H2 +0.076 vs 2026H1 −0.036 |

By-class detail: **M&A is NOT the disaster the pilot's drift number implied** (ORB
expR +0.010, win 0.527) — the buyout target-pop is captured intraday before it
fades. FDA is the only strongly-positive class (+0.16 expR, PF 2.1) but n=105.
GUIDE is the worst (−0.072). The pilot's *cause ranking* simply does not survive on
the intraday-execution outcome.

**Verdict: NULL — do not enable the skip.** Cause conditioning does not de-lump
(top-5 concentration unchanged) and **removing FADE from the top decile actively
degrades precision and makes lumpiness worse** — because the FADE gaps that rank
into the top decile are high-gap/high-relVol names carrying positive expectancy;
replacing them with lower-`continuationScore` picks trades down. The FADE-drag is
unstable across the two halves and its pooled CI includes 0.

---

## Deflation stance

- E1: the comparison fails at the delta-CI stage (all three CIs reach ≤0), so the
  models never earn a deflation pass; the baseline itself is the incumbent and needs
  none. The GBM subset's DSR 1.0 is a within-edge artifact, not evidence for the model.
- E2: fails at the CI stage (delta straddles 0) — nothing to deflate. A single ~9-month,
  mostly-risk-on window with a hypothesis partly formed on the overlapping pilot means
  even a *positive* result here would have been a lead, not a confirmation.

## Ship / no-ship

**NO-SHIP for both.** Concrete outcomes:

1. **`continuationScore` stands as the meta-label** — it beat every refit alternative
   (linear and nonlinear) OOS. The parsimonious prior-weighted score is at the ceiling
   of these features. No change to `lib/gapgo.js`.
2. **`skipFadeCauses` should stay OFF by default** (it already is). This study is
   independent evidence *for* the current default: enabling the skip would have *hurt*
   top-decile precision. The forward `cause` ledger (already logging) remains the only
   path to ever revisiting it, and it would need a materially different (multi-regime,
   larger-per-class) result to flip the call.

No `gapgo.js` diff is proposed — the honest finding is that the shipped configuration
is already the better one. Nothing deployed; no prod.

## Reproduce

```
node --env-file=research/.env research/36-gap-events.js          # rebuild event set
research/intraday/.venv/bin/python research/37-gap-interactions.py
node --env-file=research/.env research/38-gap-cause-join.js       # 3x for full coverage
research/intraday/.venv/bin/python research/39-gap-cause-eval.py
research/intraday/.venv/bin/python -m pytest research/intraday/tests/test_metalabel.py
```
