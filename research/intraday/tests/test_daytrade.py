import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from intraday.daytrade import (SCANS, day_metrics, passes_scan, rank_score,
                               atr, ema, trade_levels)


def _candles(n=22, close=10.0, vol=1_000_000):
    return [{"date": f"2024-01-{i+1:02d}", "open": close, "high": close + 0.5,
             "low": close - 0.5, "close": close, "volume": vol} for i in range(n)]


def test_day_metrics_known_values():
    c = _candles(22)
    c[21] = {"date": "2024-01-22", "open": 10.5, "high": 11.2, "low": 10.4,
             "close": 11.0, "volume": 2_000_000}  # today: +10%, gap +5%, 2x vol
    m = day_metrics(c)
    assert m["last"] == 11.0
    assert m["avgVol"] == 1_000_000
    assert m["avgDollarVol"] == 11_000_000
    assert m["relVol"] == 2.0
    assert m["pctChange"] == 10.0
    assert m["gapPct"] == 5.0


def test_day_metrics_insufficient_history():
    assert day_metrics(_candles(5)) is None


def test_passes_scan():
    m = {"last": 11.0, "avgVol": 1_000_000, "avgDollarVol": 11_000_000,
         "relVol": 2.0, "pctChange": 10.0, "gapPct": 5.0}
    assert passes_scan(m, SCANS["momentum_liquid"]) is True
    assert passes_scan(m, SCANS["explosive_small"]) is True
    weak = {**m, "relVol": 1.2, "pctChange": 2.0}
    assert passes_scan(weak, SCANS["momentum_liquid"]) is False


def test_rank_score_caps_relvol():
    a = rank_score({"relVol": 50, "pctChange": 0, "gapPct": 0})  # capped at 10 -> 100
    assert a == 100.0


def test_trade_levels_structure():
    c = _candles(22, close=10.0)
    c[21] = {"date": "2024-01-22", "open": 9.8, "high": 10.6, "low": 9.5,
             "close": 10.5, "volume": 2_000_000}
    lv = trade_levels(c)
    assert lv["stop"] < lv["entry"] < lv["target"]
    risk = lv["entry"] - lv["stop"]
    reward = lv["target"] - lv["entry"]
    assert abs(reward - 2 * risk) < 0.02     # 1:2 reward:risk
    assert lv["pullback"]["entry"] < lv["entry"]


def test_atr_and_ema():
    c = _candles(22, close=10.0)
    assert atr(c) > 0
    assert abs(ema([10.0] * 30, 9) - 10.0) < 1e-6   # flat series -> same value
