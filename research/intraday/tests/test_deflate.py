import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import random
from intraday import deflate


def test_psr_higher_for_better_returns():
    good = [0.02] * 50 + [-0.005] * 50      # positive drift
    weak = [0.005] * 50 + [-0.005] * 50     # ~zero drift
    assert deflate.psr(good) > deflate.psr(weak)
    assert 0 <= deflate.psr(good) <= 1


def test_expected_max_sharpe_grows_with_trials():
    a = deflate.expected_max_sharpe(0.04, 5)
    b = deflate.expected_max_sharpe(0.04, 50)
    assert b > a > 0


def test_deflated_le_psr():
    rets = [0.01] * 60 + [-0.004] * 40
    trials = [0.1, 0.15, 0.2, 0.25, 0.3]
    dsr, sr0 = deflate.deflated_sharpe(rets, trials)
    assert sr0 > 0
    assert dsr <= deflate.psr(rets, 0.0) + 1e-9   # deflation never raises confidence


def test_pbo_range_and_noise_is_high():
    # Single-seed PBO has wide sampling variance, so test the property that actually
    # holds: averaged over many noise panels, PBO centres on ~0.5 (no edge persists).
    T, N, seeds = 32, 10, 25
    pbos = []
    for sd in range(seeds):
        random.seed(sd)
        noise = [[random.gauss(0, 1) for _ in range(N)] for _ in range(T)]  # no real edge
        pbo, n = deflate.pbo_cscv(noise, n_splits=8)
        assert 0.0 <= pbo <= 1.0 and n > 0
        pbos.append(pbo)
    assert 0.4 < (sum(pbos) / len(pbos)) < 0.6   # pure noise -> overfits ~half the time


def test_pbo_consistent_winner_is_low():
    # One strategy always best by a clear margin -> not overfit -> low PBO.
    T, N = 32, 6
    m = [[0.0] * N for _ in range(T)]
    for t in range(T):
        for j in range(N):
            m[t][j] = (1.0 if j == 0 else 0.0) + 0.01 * ((t + j) % 3 - 1)
    pbo, _ = deflate.pbo_cscv(m, n_splits=8)
    assert pbo < 0.3
