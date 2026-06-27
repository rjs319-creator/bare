import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from intraday.regime import sma, efficiency_ratio


def test_sma():
    assert sma([1, 2, 3, 4], 2) == 3.5
    assert sma([1, 2], 5) is None          # not enough history


def test_efficiency_ratio_trend_vs_chop():
    trend = list(range(1, 30))             # straight line -> ER ~ 1
    chop = [10 + (1 if i % 2 else -1) for i in range(30)]  # zig-zag -> ER ~ 0
    assert efficiency_ratio(trend, 15) > 0.95
    assert efficiency_ratio(chop, 15) < 0.2


def test_efficiency_ratio_insufficient():
    assert efficiency_ratio([1, 2, 3], 15) is None
