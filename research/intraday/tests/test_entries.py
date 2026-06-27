import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from intraday import entries
from intraday.execution import CostModel, simulate_at

ZERO = CostModel(slippage_bps=0, commission_bps=0)


def bar(o, h, l, c, v=1000):
    return {"open": o, "high": h, "low": l, "close": c, "volume": v}


def test_next_open():
    first = [bar(10, 10.2, 9.8, 10.1)]
    assert entries.next_open(first) == (10, 0)
    assert entries.next_open([]) is None


def test_orb_breakout_and_nofill():
    # first 6 bars range high = 10.5; bar 6 breaks it.
    first = [bar(10, 10.5, 9.9, 10.2) for _ in range(6)] + [bar(10.2, 10.8, 10.1, 10.7)]
    hit = entries.opening_range_breakout(first)
    assert hit == (10.5, 6)
    # OR high (first 6) = 10.5; later bars stay strictly below -> no breakout.
    flat = [bar(10, 10.5, 9.9, 10.1) for _ in range(6)] + [bar(10.0, 10.2, 9.8, 10.0) for _ in range(2)]
    assert entries.opening_range_breakout(flat) is None


def test_hold_30():
    green = [bar(10, 10.3, 9.9, 10.1) for _ in range(6)] + [bar(10.1, 10.4, 10.0, 10.3)]
    assert entries.hold_30(green) == (10.3, 6)
    red = [bar(10, 10.1, 9.5, 9.7) for _ in range(6)] + [bar(9.7, 9.8, 9.4, 9.6)]
    assert entries.hold_30(red) is None      # not green at 30-min mark


def test_vwap_pullback_fills():
    # rising then a dip back toward vwap should trigger.
    first = [bar(10, 10.5, 10.0, 10.4), bar(10.4, 10.6, 10.3, 10.5),
             bar(10.5, 10.5, 9.8, 9.9)]      # bar 2 dips below running vwap
    hit = entries.vwap_pullback(first)
    assert hit is not None and hit[1] == 2


def test_simulate_at_target():
    window = [bar(10, 10.1, 9.9, 10), bar(10, 10.2, 9.95, 10.1), bar(10.1, 12.2, 10.0, 11)]
    r = simulate_at(window, entry_price=10.1, start_idx=2, stop=9, target=12, cost=ZERO)
    assert r.exit_reason == "target"
    assert abs(r.entry_price - 10.1) < 1e-9


def test_simulate_at_entry_on_last_bar_time_exits():
    window = [bar(10, 10.1, 9.9, 10), bar(10, 10.2, 9.9, 10.15)]
    r = simulate_at(window, entry_price=10.15, start_idx=2, stop=9, target=12, cost=ZERO)
    assert r.exit_reason == "time"           # nothing left to manage
