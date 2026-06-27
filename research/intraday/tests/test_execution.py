import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from intraday.execution import CostModel, simulate_long

ZERO = CostModel(slippage_bps=0, commission_bps=0)


def bar(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c}


def test_target_hit():
    bars = [bar(10, 10.1, 9.9, 10), bar(10, 12.1, 9.9, 11)]  # bar1 reaches target 12
    r = simulate_long(bars, 10, 9, 12, ZERO, "next_open")
    assert r.exit_reason == "target"
    assert r.r_multiple > 0
    assert abs(r.entry_price - 10) < 1e-9       # entered at bar0 open


def test_stop_hit():
    bars = [bar(10, 10.1, 9.9, 10), bar(10, 10.2, 8.5, 9)]   # bar1 breaks stop 9
    r = simulate_long(bars, 10, 9, 12, ZERO, "next_open")
    assert r.exit_reason == "stop"
    assert r.r_multiple < 0


def test_stop_checked_first_when_both_in_bar():
    bars = [bar(10, 10.1, 9.9, 10), bar(10, 12.5, 8.5, 10)]  # bar straddles both
    r = simulate_long(bars, 10, 9, 12, ZERO, "next_open")
    assert r.exit_reason == "stop"               # conservative: stop wins ties


def test_time_exit():
    bars = [bar(10, 10.1, 9.9, 10), bar(10, 10.3, 9.7, 10.2)]  # neither level hit
    r = simulate_long(bars, 10, 9, 12, ZERO, "next_open")
    assert r.exit_reason == "time"
    assert abs(r.exit_price - 10.2) < 1e-9


def test_pullback_no_fill():
    bars = [bar(10, 10.5, 10.0, 10.3)]           # never trades down to 9.5
    r = simulate_long(bars, 9.5, 9.0, 11.0, ZERO, "pullback")
    assert r.filled is False
    assert r.exit_reason == "no_fill"


def test_pullback_fills_then_targets():
    bars = [bar(10, 10.1, 9.4, 9.6),             # dips to 9.4 -> fills limit 9.5
            bar(9.6, 11.2, 9.5, 11.0)]           # then hits target 11
    r = simulate_long(bars, 9.5, 9.0, 11.0, ZERO, "pullback")
    assert r.filled is True
    assert r.exit_reason == "target"


def test_no_stop_holds_to_time_exit():
    # A deep dip that WOULD trigger a stop, but no stop is set -> hold to time exit.
    bars = [bar(10, 10.1, 9.9, 10), bar(10, 10.2, 8.0, 9.5)]
    r = simulate_long(bars, 10, stop=None, target=None, cost=ZERO, entry_mode="next_open")
    assert r.filled is True
    assert r.exit_reason == "time"
    assert abs(r.exit_price - 9.5) < 1e-9


def test_no_stop_with_target():
    bars = [bar(10, 10.1, 9.9, 10), bar(10, 12.5, 8.0, 11)]   # target 12 hit; no stop
    r = simulate_long(bars, 10, stop=None, target=12, cost=ZERO, entry_mode="next_open")
    assert r.exit_reason == "target"


def test_costs_reduce_return():
    bars = [bar(10, 10.1, 9.9, 10), bar(10, 12.1, 9.9, 11)]
    free = simulate_long(bars, 10, 9, 12, ZERO, "next_open")
    costly = simulate_long(bars, 10, 9, 12, CostModel(slippage_bps=20, commission_bps=10), "next_open")
    assert costly.net_return_pct < free.net_return_pct
