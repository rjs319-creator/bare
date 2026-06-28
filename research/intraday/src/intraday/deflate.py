"""Multiple-testing / overfitting control (Bailey & López de Prado).

We searched ~24 strategy variants and picked the best — so its in-sample Sharpe is
upward-biased by selection. These tools quantify how much to discount it:

  • Deflated Sharpe Ratio (DSR): P(true Sharpe > 0) AFTER accounting for the number of
    trials, the variance of Sharpes across trials, and the returns' skew/kurtosis.
  • Probability of Backtest Overfitting (PBO) via CSCV: across many train/test splits,
    how often the in-sample-best strategy lands BELOW the median out-of-sample. High
    PBO ⇒ the "winner" is likely a fluke of the search.
"""
from __future__ import annotations

import itertools
import math
from typing import List, Sequence, Tuple

import numpy as np
from scipy.stats import norm

EULER = 0.5772156649015329


def sharpe(returns: Sequence[float]) -> float:
    r = np.asarray(returns, float)
    if len(r) < 2:
        return 0.0
    sd = r.std(ddof=1)
    return float(r.mean() / sd) if sd > 0 else 0.0


def psr(returns: Sequence[float], sr_benchmark: float = 0.0) -> float:
    """Probabilistic Sharpe Ratio: P(true SR > sr_benchmark), skew/kurtosis-adjusted."""
    r = np.asarray(returns, float)
    T = len(r)
    if T < 3:
        return float("nan")
    sd = r.std(ddof=1)
    if sd == 0:
        return float("nan")
    sr = r.mean() / sd
    g3 = float(((r - r.mean()) ** 3).mean() / sd ** 3)          # skewness
    g4 = float(((r - r.mean()) ** 4).mean() / sd ** 4)          # kurtosis (normal = 3)
    denom = math.sqrt(max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr ** 2))
    return float(norm.cdf((sr - sr_benchmark) * math.sqrt(T - 1) / denom))


def expected_max_sharpe(var_sr: float, n_trials: int) -> float:
    """E[max Sharpe] across n independent trials with cross-trial Sharpe variance var_sr."""
    if n_trials < 2 or var_sr <= 0:
        return 0.0
    s = math.sqrt(var_sr)
    a = norm.ppf(1 - 1.0 / n_trials)
    b = norm.ppf(1 - 1.0 / (n_trials * math.e))
    return s * ((1 - EULER) * a + EULER * b)


def deflated_sharpe(returns: Sequence[float], trial_sharpes: Sequence[float]) -> Tuple[float, float]:
    """DSR for the selected strategy. trial_sharpes = per-trade Sharpe of EVERY variant
    searched. Returns (DSR, benchmark_expected_max_sharpe)."""
    n = len(trial_sharpes)
    var_sr = float(np.var(trial_sharpes, ddof=1)) if n > 1 else 0.0
    sr0 = expected_max_sharpe(var_sr, n)
    return psr(returns, sr0), sr0


def pbo_cscv(matrix: List[List[float]], n_splits: int = 8) -> Tuple[float, int]:
    """Probability of Backtest Overfitting via Combinatorially-Symmetric CV.
    matrix: rows = time periods, cols = strategies (per-period returns)."""
    M = np.asarray(matrix, float)
    T, N = M.shape
    S = n_splits - (n_splits % 2)
    if T < S or N < 2:
        return float("nan"), 0
    idx = np.array_split(np.arange(T), S)
    logits = []
    for c in itertools.combinations(range(S), S // 2):
        is_rows = np.concatenate([idx[i] for i in c])
        oos_rows = np.concatenate([idx[i] for i in range(S) if i not in c])
        n_star = int(np.argmax(M[is_rows].mean(axis=0)))          # IS-best strategy
        oos = M[oos_rows].mean(axis=0)
        rank = (int(np.where(oos.argsort() == n_star)[0][0]) + 1) / (N + 1)  # OOS rank in (0,1)
        logits.append(math.log(rank / (1 - rank)))
    lg = np.array(logits)
    return float((lg <= 0).mean()), len(lg)
