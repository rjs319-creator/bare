# Master Screener Pipeline (refactored)

Ranks/enriches screener picks. Fully autonomous: zero-arg run auto-discovers the
latest `stocks/options/catalysts` CSVs (or falls back to demo) and writes a dated
`outputs/ranked_picks_*.csv`. Cron/CI-safe.

## Layout (many small files, per coding-style rules)

```
run.py                  thin entry point
pipeline/
  config.py             all weights/thresholds (no magic numbers)
  scoring.py            pure scoring functions (immutable, fully unit-tested)
  discovery.py          autonomous latest-file discovery
  loader.py             CSV load + boundary validation (ScreenerInputError)
  ranker.py             immutable score+rank orchestration (df.assign)
  sample_data.py        deterministic demo data
  cli.py                argparse + orchestration
tests/                  27 tests (pytest), AAA pattern
REVIEW.md               review of the original script (severity-tagged)
INTEGRATION.md          honest map onto market-news-app + research findings
```

## Usage

```bash
python run.py                      # autonomous: discover latest CSVs, else demo
python run.py --demo --top 20      # forced demo
python run.py --stocks s.csv --options o.csv --catalysts c.csv
python run.py --regime-gate        # push risk-off (regime_ok=False) below aligned
python -m pytest -q                # 27 tests
```

## What changed vs the original (see REVIEW.md)

- Confluence normalised to a true 0–100 (was saturating 8 names at 100).
- Final-score blend rescales boosts to 0–100 so the 55/25/20 weights are honest
  (max final was ~65, now reaches 100).
- Removed dead `ghost is True` branch; robust `_truthy`/`_to_float` coercion.
- Fixed latent `int(nan)` crash on `days_until`.
- Immutable (`df.assign`, no in-place mutation) + split into focused modules.
- Typed errors, narrow excepts, validation at the boundary.
- Added `--regime-gate` — elevates the one lever the research validated.

## Integration

This is best kept as a **standalone offline triage tool**. See INTEGRATION.md —
the app already has backtested versions of #1/#3/#4, and the options/catalyst
boosts (#2/#3) are unvalidated or known-dead on the free/Starter tier. Do not
ship the boosts into any ledgered score without passing the purged-WF gates.
```
```
