"""Event-driven intrabar execution — the capability the app's daily harness lacks.

The daily backtest can only see a bar's close, so it cannot tell whether a stop or a
target was hit FIRST inside a session. The app's own "exits" study found structure
stops are a leak precisely because of this intrabar path. Here we replay the actual
intraday bars to resolve stop-vs-target ordering honestly, with realistic fills.

Conservative assumptions (bias AGAINST the strategy, never for it):
  • If both stop and target fall within a single bar's [low, high], assume the STOP
    filled first (worst case — we can't see tick order on bar data).
  • Entry/exit fills take slippage in the unfavourable direction.
  • Commission charged on both legs.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class CostModel:
    slippage_bps: float = 5.0      # per fill, unfavourable
    commission_bps: float = 2.0    # per leg


@dataclass
class TradeResult:
    filled: bool
    exit_reason: str               # 'target' | 'stop' | 'time' | 'no_fill'
    entry_price: float
    exit_price: float
    bars_held: int
    r_multiple: float              # realised return / initial risk
    net_return_pct: float          # after slippage + commission, both legs


def simulate_long(session_bars: list, planned_entry: float, stop: float, target: float,
                  cost: CostModel, entry_mode: str = "next_open") -> TradeResult:
    """Simulate a long trade over a flat list of intraday bars (already trimmed to the
    holding window, ascending). `stop`/`target` are absolute price levels.

    entry_mode:
      'next_open'  -> market entry at the first bar's open (executable; what you'd
                      actually get the morning after an EOD signal).
      'pullback'   -> limit entry: fill only if price trades down to `planned_entry`
                      within the window; otherwise no_fill.
    """
    if not session_bars:
        return TradeResult(False, "no_fill", 0, 0, 0, 0, 0)

    slip = cost.slippage_bps / 1e4
    comm = cost.commission_bps / 1e4

    # ---- entry ----
    if entry_mode == "pullback":
        fill_idx = next((i for i, b in enumerate(session_bars) if b["low"] <= planned_entry), None)
        if fill_idx is None:
            return TradeResult(False, "no_fill", 0, 0, 0, 0, 0)
        entry = planned_entry * (1 + slip)      # pay up slightly even on a limit
        start = fill_idx + 1
    else:  # next_open
        entry = session_bars[0]["open"] * (1 + slip)
        start = 1

    risk = entry - stop
    if risk <= 0:
        return TradeResult(False, "no_fill", entry, 0, 0, 0, 0)

    # ---- manage ----
    held = 0
    for b in session_bars[start:]:
        held += 1
        hit_stop = b["low"] <= stop
        hit_target = b["high"] >= target
        if hit_stop:                            # conservative: stop checked first
            exit_px = stop * (1 - slip)
            return _result("stop", entry, exit_px, held, risk, comm)
        if hit_target:
            exit_px = target * (1 - slip)
            return _result("target", entry, exit_px, held, risk, comm)

    # ---- time exit at last close ----
    exit_px = session_bars[-1]["close"] * (1 - slip)
    return _result("time", entry, exit_px, held, risk, comm)


def _result(reason: str, entry: float, exit_px: float, held: int, risk: float,
            comm: float) -> TradeResult:
    gross = exit_px - entry
    net_ret = gross / entry - 2 * comm
    r = gross / risk if risk > 0 else 0.0
    return TradeResult(True, reason, round(entry, 4), round(exit_px, 4), held,
                       round(r, 3), round(net_ret * 100, 3))
