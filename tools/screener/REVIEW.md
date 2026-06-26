# Code Review — original `master_screener_pipeline.py`

Severity per your code-review.md rubric.

## HIGH (bugs — fixed in refactor)

1. **Confluence saturation (ranking bug).** Weights sum to 110 then
   `min(100, …)` clips. Every strong name pins at 100, so ranking inside the
   high-conviction tier is decided *only* by the boosts — the opposite of the
   stated 55% confluence weighting. *Demo proof:* 8 names tied at Conf 100.0.
   **Fix:** normalise by total available weight → true 0–100, no saturation.

2. **Dishonest blend scale.** `final = conf*0.55 + opt*0.25 + cat*0.20` mixes a
   0–100 confluence with 0–25 / 0–20 boosts, so max `final ≈ 65` and the boosts
   contribute ≤6.25 / ≤4 absolute — the 0.25/0.20 weights are fiction.
   **Fix:** rescale each boost to 0–100 by its own ceiling before blending.

3. **Dead code branch.** `elif ghost is True:` is unreachable —
   `isinstance(True,(int,float))` is `True` in Python, so the prior `if` already
   catches bools. **Fix:** explicit `_truthy()` helper; bool handled first.

## MEDIUM

4. **`int(nan)` latent crash.** `int(row.get("days_until",999) or 999)` raises
   `ValueError` if `days_until` is NaN (only avoided because `catalyst_type` NaN
   returns early). Fragile coupling. **Fix:** `_to_float` with NaN guard.

5. **Mutation throughout (violates immutability rule).** `stocks["x"] = …`
   repeatedly mutates the frame in place. **Fix:** `df.assign(...)` returns a new
   frame; ranker proven non-mutating by `test_rank_does_not_mutate_input`.

6. **Monolith (violates many-small-files rule).** ~450 lines, one file, mixed
   concerns (discovery + IO + scoring + CLI). **Fix:** 6 focused modules
   (config / scoring / discovery / loader / ranker / sample_data / cli), each
   <130 lines, plus tests.

7. **Magic numbers everywhere** (50, 60, 70, 12, 8, premium thresholds…).
   **Fix:** all in `config.py` as named constants.

8. **Silent error swallowing.** Bare `except Exception: pass` on weights JSON and
   broad merge `except`. **Fix:** typed `ScreenerInputError`, narrow excepts,
   stderr reporting, graceful optional-feed degradation.

## LOW

9. `np.random.seed(42)` set but sample data is fully hardcoded — dead line.
10. `import glob, os` unused. `mode` string `"EXPLICIT or AUTO"` conflates two
    different paths.

## What was already good (kept)
- Autonomous discovery + demo fallback design (cron-friendly) — sound; preserved.
- Per-row pure scoring shape — preserved and made genuinely pure/testable.
- Graceful left-merge of optional feeds — preserved and hardened.
