# momentum-wiki-2014-2018 — One-Shot Confirmatory Result (2026-08-04)

**VERDICT: NOT-CONFIRMED.** The free-data branch of the Era-A momentum question
is closed with a preregistered null.

## Provenance chain (each link hash-verified)

| Link | Value |
|---|---|
| Preregistration | `research/PREREGISTRATION-MOMENTUM-WIKI-2026-08.md`, sealed at merge `a592dc8` (PR #267), BEFORE the panel existed |
| Source | Kaggle WIKI mirror, csv sha256 `ca7fb174c7948db8…` (frozen 2018-03-27) |
| Adapter | wiki-source-v1: 3,199 symbols → 854 Form-25 real deaths attached, 337 unknown enders (fail-closed), 30 ticker-reuse zombies + 101 adjustment-disagreement symbols excluded |
| Panel | `panel-v3.2-wiki`, datasetHash `9e4038f0209ea045…`, 91,206 name-months / 48 cohorts / 2,984 names / **839 confirmed-delisted names included**, built clean at `a592dc8` (**confirmatory-reproducible**) |
| Audit | `audit-research-data` **PASS**, zero criticals, hash-matched (independent m121 recompute spot-check passed) |
| Evaluation | `research/66-wiki-confirmatory.js`, ONE run, evidence record `7d56387ef59ceb72…` (`research/data/wiki-era/evidence-momentum-wiki-2014-2018.json`), BH trials = 12 |

## Results (per preregistered gates — ALL six required per horizon)

| Gate | 63 sessions | 126 sessions |
|---|---|---|
| Eligible dates (≥30 names) | 47 | 42 |
| Mean per-date rank IC | **0.007** | **0.006** |
| Newey-West HAC t | 0.26 | 0.19 |
| q ≤ 0.10 (trials=12) | **FAIL** (q = 1) | **FAIL** (q = 1) |
| ESS ≥ 30 | **FAIL** (20) | **FAIL** (8) |
| Beats shuffled control | pass | pass |
| Dominant-date < 0.5 | **FAIL** | **FAIL** |
| Cost gate (base/doubled/stressed > 0) | **FAIL** (stressed −0.18%) | pass (+1.7%/+1.4%/+0.9%) |

Both horizons fail decisively. The point estimates are economically zero; the
126s cost-gate pass is a positive point estimate with no statistical support
behind it (ESS 8).

## What this does and does not conclude

- **Concludes:** 12-1 momentum had no rankable cross-sectional edge in the
  liquid WIKI universe over 2014-2017 decision cohorts, on a survivorship-aware
  panel (839 dead names, bankruptcies haircut per outcome-v3), cost-aware,
  preregistered, one shot. This matches every other survivorship-aware result
  in this program and the post-2010 academic decay of momentum.
- **Does not conclude:** anything about 2010-2013 (absent at the source), the
  full-cap-spectrum universe (WIKI is a liquid curated list), or the sealed
  `momentum-historical-2010-2021` era — that holdout REMAINS SEALED. But the
  prior for paying to run the true Era A is now weaker: this was the
  most-likely-to-work slice (liquid names, the era momentum literature still
  half-defends), and it is flat zero.

## Ledger effects

- Holdout `momentum-wiki-2014-2018-era`: OPENED 2026-08-04 — never untouched
  again; no re-runs under any circumstances (the runner refuses on all three
  locks: entry status, holdout, existing evidence record).
- Registry entry `momentum-wiki-2014-2018`: `open → no-edge`.
- swing-ranking family: 12 registered trials, 0 confirmed.
- Sharadar decision: now a pure preference with a weakened prior, not a
  research necessity. The pre-committed structure (monthly + cancel-if-no-edge)
  still applies if chosen.
