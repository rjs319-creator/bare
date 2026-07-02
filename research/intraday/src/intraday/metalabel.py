"""Pure helpers for the Gap & Go meta-label INTERACTION study (research/37) and the
gap-cause de-lumping study (research/38/39). Network-free and side-effect-free so
they are unit-testable; the experiment scripts own I/O.

The baseline to beat is the SHIPPED heuristic (lib/gapgo.js `continuationScore`) —
`continuation_score` below is an exact port and is pinned by tests so drift between
the JS and this study would be caught.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

GAP_MODERATE = 3.0          # mirrors lib/gapgo.js
PURGE_DAYS = 7              # calendar days > (entry ≤ gap+3 sessions + resolution)


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


def regime_norm(reg: str) -> float:
    """'on' | 'neu' | 'off' -> the shipped regN component (risk-off is the down-gate)."""
    if reg == "on":
        return 1.0
    if reg == "off":
        return 0.0
    return 0.55


def continuation_score(gap_pct: float, rel_vol: float, reg: str) -> int:
    """Exact port of lib/gapgo.js continuationScore(gapPct, relVol, regime)."""
    gap_n = _clip01(((gap_pct or 0.0) - GAP_MODERATE) / 12.0)
    rv_n = _clip01(((rel_vol if rel_vol is not None else 1.0) - 1.0) / 5.0)
    reg_n = regime_norm(reg)
    # math.floor(x + 0.5) == JS Math.round (Python's round() is banker's rounding)
    return int(math.floor(100.0 * (0.42 * gap_n + 0.28 * rv_n + 0.30 * reg_n) + 0.5))


def half_key(date: str) -> str:
    """'2024-03-15' -> '2024H1' (calendar half-year fold key)."""
    return f"{date[:4]}H{1 if int(date[5:7]) <= 6 else 2}"


def fold_bounds(key: str) -> Tuple[str, str]:
    """Fold key -> (inclusive start date, exclusive end date)."""
    year = int(key[:4])
    if key.endswith("H1"):
        return f"{year}-01-01", f"{year}-07-01"
    return f"{year}-07-01", f"{year + 1}-01-01"


def _minus_days(date: str, days: int) -> str:
    from datetime import datetime, timedelta

    return (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def purged_walk_forward(dates: Sequence[str], test_folds: Sequence[str],
                        purge_days: int = PURGE_DAYS) -> List[Dict]:
    """Expanding-window purged walk-forward splits over date-stamped events.

    For each fold key (e.g. '2023H1'): train = events strictly BEFORE fold start
    minus a `purge_days` embargo (drops trades whose ≤3-session outcome window could
    leak into the fold), test = events inside the fold. Returns a new list of
    {fold, train_idx, test_idx} dicts (numpy int arrays), skipping folds with an
    empty side.
    """
    d = np.asarray(dates)
    out: List[Dict] = []
    for key in test_folds:
        start, end = fold_bounds(key)
        cutoff = _minus_days(start, purge_days)
        train = np.where(d < cutoff)[0]
        test = np.where((d >= start) & (d < end))[0]
        if len(train) == 0 or len(test) == 0:
            continue
        out.append({"fold": key, "train_idx": train, "test_idx": test})
    return out


def top_fraction_idx(scores: Sequence[float], frac: float) -> np.ndarray:
    """Indices of the top `frac` of `scores` (ties broken by position, descending)."""
    s = np.asarray(scores, float)
    k = max(1, int(len(s) * frac))
    return np.argsort(-s, kind="stable")[:k]


def trade_stats(r: Sequence[float]) -> Dict:
    """Summary of an R-multiple series: n, win rate, expR, PF."""
    a = np.asarray(r, float)
    if len(a) == 0:
        return {"n": 0, "win": None, "expR": None, "pf": None}
    wins = a[a > 0]
    losses = a[a <= 0]
    gross_w = float(wins.sum())
    gross_l = float(abs(losses.sum()))
    return {
        "n": int(len(a)),
        "win": round(float((a > 0).mean()), 3),
        "expR": round(float(a.mean()), 4),
        "pf": round(gross_w / gross_l, 2) if gross_l > 0 else None,
    }


def lumpiness(r: Sequence[float], k: int = 5) -> Dict:
    """Right-skew / concentration diagnostics: top-k share of gross positive P&L,
    median, and 5%-winsorized mean. (Top-k share uses gross wins as denominator —
    robust when net P&L is near zero.)"""
    a = np.asarray(r, float)
    if len(a) == 0:
        return {"topk_share": None, "median": None, "winsor_mean": None}
    wins = np.sort(a[a > 0])[::-1]
    gross_w = float(wins.sum())
    topk = float(wins[:k].sum()) / gross_w if gross_w > 0 else None
    lo, hi = np.percentile(a, [5, 95])
    return {
        "topk_share": round(topk, 3) if topk is not None else None,
        "median": round(float(np.median(a)), 4),
        "winsor_mean": round(float(np.clip(a, lo, hi).mean()), 4),
    }


def cluster_bootstrap_delta(r_a: Sequence[float], dates_a: Sequence[str],
                            r_b: Sequence[float], dates_b: Sequence[str],
                            n_boot: int = 2000, seed: int = 0) -> Dict:
    """Bootstrap CI for mean(r_a) − mean(r_b), resampling whole DATE clusters (events
    on the same day are cross-sectionally correlated, so i.i.d. resampling would
    understate the variance). Returns {delta, lo95, hi95, p_gt0}."""
    rng = np.random.default_rng(seed)

    def _groups(r, dates):
        g: Dict[str, List[float]] = {}
        for x, d in zip(r, dates):
            g.setdefault(d, []).append(float(x))
        return list(g.values())

    ga, gb = _groups(r_a, dates_a), _groups(r_b, dates_b)
    if not ga or not gb:
        return {"delta": None, "lo95": None, "hi95": None, "p_gt0": None}
    deltas = np.empty(n_boot)
    for i in range(n_boot):
        sa = [ga[j] for j in rng.integers(0, len(ga), len(ga))]
        sb = [gb[j] for j in rng.integers(0, len(gb), len(gb))]
        fa = [x for grp in sa for x in grp]
        fb = [x for grp in sb for x in grp]
        deltas[i] = float(np.mean(fa)) - float(np.mean(fb))
    delta = float(np.mean(np.asarray([x for g in ga for x in g]))
                  - np.mean(np.asarray([x for g in gb for x in g])))
    lo, hi = np.percentile(deltas, [2.5, 97.5])
    return {"delta": round(delta, 4), "lo95": round(float(lo), 4),
            "hi95": round(float(hi), 4), "p_gt0": round(float((deltas > 0).mean()), 3)}


def wilson_lb(wins: int, n: int, z: float = 1.96) -> Optional[float]:
    """Wilson score interval lower bound for a win rate (mirrors lib/stats.js)."""
    if n <= 0:
        return None
    p = wins / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
    return (centre - margin) / denom


def spearman_ic(scores: Sequence[float], outcomes: Sequence[float]) -> Optional[float]:
    """Spearman rank correlation (score vs realized R)."""
    from scipy.stats import spearmanr

    if len(scores) < 3:
        return None
    rho = spearmanr(scores, outcomes).statistic
    return None if (rho is None or math.isnan(rho)) else float(rho)
