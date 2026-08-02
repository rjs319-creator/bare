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


def test_orb_gap_through_fills_at_open_not_trigger():
    # OR high = 10.5, but the trigger bar OPENS at 10.9 — a buy-stop at 10.5 cannot
    # fill at 10.5; it fills at the (worse) open. The old always-at-trigger fill was
    # optimistic on exactly these strongest-momentum days.
    first = [bar(10, 10.5, 9.9, 10.2) for _ in range(6)] + [bar(10.9, 11.2, 10.8, 11.0)]
    assert entries.opening_range_breakout(first) == (10.9, 6)
    # Open exactly AT the trigger also fills at the open (stop is already elected).
    at_level = [bar(10, 10.5, 9.9, 10.2) for _ in range(6)] + [bar(10.5, 10.9, 10.4, 10.8)]
    assert entries.opening_range_breakout(at_level) == (10.5, 6)


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


def test_simulate_at_entry_bar_stop_check_is_conservative():
    # Entry bar (idx 1) reverses to 8.9 <= stop 9 AFTER the 10.1 fill. Without the
    # check the reversal is invisible and the trade rides to the 12 target; with it,
    # the stop is charged on the entry bar (bias against the strategy).
    window = [bar(10, 10.1, 9.9, 10), bar(10.05, 10.2, 8.9, 9.2), bar(9.2, 12.5, 9.1, 12)]
    loose = simulate_at(window, entry_price=10.1, start_idx=2, stop=9, target=12, cost=ZERO)
    assert loose.exit_reason == "target"     # old optimistic path
    tight = simulate_at(window, entry_price=10.1, start_idx=2, stop=9, target=12, cost=ZERO,
                        entry_bar_stop_check=True)
    assert tight.exit_reason == "stop"
    assert tight.bars_held == 0
    # Entry bar holds above the stop -> the check changes nothing.
    calm = [bar(10, 10.1, 9.9, 10), bar(10.05, 10.2, 9.8, 10.1), bar(10.1, 12.5, 10.0, 12)]
    same = simulate_at(calm, entry_price=10.1, start_idx=2, stop=9, target=12, cost=ZERO,
                       entry_bar_stop_check=True)
    assert same.exit_reason == "target"
