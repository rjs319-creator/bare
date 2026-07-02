"""Unit tests for intraday.metalabel (pure helpers behind research/37-39).

The continuation_score fixtures are PINNED from the shipped JS
(`node -e "require('./lib/gapgo').continuationScore(...)"`) so any drift between
lib/gapgo.js and this study's baseline port fails loudly.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from intraday.metalabel import (  # noqa: E402
    cluster_bootstrap_delta,
    continuation_score,
    fold_bounds,
    half_key,
    lumpiness,
    purged_walk_forward,
    spearman_ic,
    top_fraction_idx,
    trade_stats,
)

# (gapPct, relVol, jsRegime, expected) — generated from lib/gapgo.js continuationScore
JS_PINNED = [
    (3, 1, "neutral", 17), (5, 2, "risk-on", 43), (15, 6, "risk-on", 100),
    (8, 3, "risk-off", 29), (4.2, 1.7, "neutral", 25), (10, 4, "risk-off", 41),
    (3.5, 1.2, "risk-on", 33), (20, 10, "risk-on", 100), (6.5, 2.5, "neutral", 37),
    (7, 1, "risk-off", 14), (0, 0, "neutral", 17), (5.55, 3.33, "risk-on", 52),
]
_REG = {"risk-on": "on", "risk-off": "off", "neutral": "neu"}


@pytest.mark.parametrize("gap,rv,reg,expected", JS_PINNED)
def test_continuation_score_matches_shipped_js(gap, rv, reg, expected):
    assert continuation_score(gap, rv, _REG[reg]) == expected


def test_half_key_and_fold_bounds():
    assert half_key("2024-03-15") == "2024H1"
    assert half_key("2024-07-01") == "2024H2"
    assert fold_bounds("2023H1") == ("2023-01-01", "2023-07-01")
    assert fold_bounds("2023H2") == ("2023-07-01", "2024-01-01")


def test_purged_walk_forward_purges_leading_edge():
    dates = ["2022-06-01", "2022-12-27", "2022-12-30", "2023-02-01", "2023-08-01"]
    splits = purged_walk_forward(dates, ["2023H1", "2023H2"], purge_days=7)
    by_fold = {s["fold"]: s for s in splits}
    # 2023H1: train must exclude 2022-12-27/30 (within 7d of 2023-01-01) and any 2023 data
    assert list(by_fold["2023H1"]["train_idx"]) == [0]
    assert list(by_fold["2023H1"]["test_idx"]) == [3]
    # 2023H2: expanding window — everything before 2023-06-24 trains
    assert list(by_fold["2023H2"]["train_idx"]) == [0, 1, 2, 3]
    assert list(by_fold["2023H2"]["test_idx"]) == [4]


def test_purged_walk_forward_skips_empty_folds():
    dates = ["2023-02-01", "2023-03-01"]
    assert purged_walk_forward(dates, ["2023H1"], purge_days=7) == []


def test_top_fraction_idx_selects_highest_scores():
    idx = top_fraction_idx([0.1, 0.9, 0.5, 0.7, 0.2, 0.8], 1 / 3)
    assert sorted(idx.tolist()) == [1, 5]


def test_trade_stats_basic():
    s = trade_stats([2.0, -1.0, 2.0, -1.0])
    assert s == {"n": 4, "win": 0.5, "expR": 0.5, "pf": 2.0}
    assert trade_stats([])["n"] == 0


def test_lumpiness_topk_share():
    r = [10.0] + [0.1] * 9 + [-1.0] * 10
    out = lumpiness(r, k=1)
    # top-1 winner holds 10 / 10.9 of gross positive P&L
    assert out["topk_share"] == round(10.0 / 10.9, 3)
    assert out["median"] is not None and out["winsor_mean"] is not None


def test_cluster_bootstrap_delta_sign_and_ci():
    rng = np.random.default_rng(1)
    dates = [f"2024-01-{d:02d}" for d in range(1, 11) for _ in range(20)]
    a = (rng.normal(0.5, 1.0, 200)).tolist()
    b = (rng.normal(0.0, 1.0, 200)).tolist()
    out = cluster_bootstrap_delta(a, dates, b, dates, n_boot=500, seed=2)
    assert out["delta"] > 0
    assert out["lo95"] < out["delta"] < out["hi95"]
    assert out["p_gt0"] > 0.9


def test_wilson_lb_matches_known_values():
    from intraday.metalabel import wilson_lb
    # 50/100 at z=1.96 -> ~0.404 (standard Wilson LB)
    assert wilson_lb(50, 100) == pytest.approx(0.404, abs=0.001)
    assert wilson_lb(0, 0) is None
    assert wilson_lb(10, 10) < 1.0


def test_spearman_ic_perfect_rank():
    assert spearman_ic([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
    assert spearman_ic([1, 2], [1, 2]) is None
