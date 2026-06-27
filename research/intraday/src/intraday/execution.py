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


def simulate_long(session_bars: list, planned_entry: float, stop: Optional[float] = None,
                  target: Optional[float] = None, cost: CostModel = CostModel(),
                  entry_mode: str = "next_open") -> TradeResult:
    """Simulate a long trade over a flat list of intraday bars (already trimmed to the
    holding window, ascending). `stop`/`target` are absolute price levels, or None to
    disable that exit (e.g. a no-stop, hold-to-time-exit policy — the exits study's
    "don't use a tight stop" hypothesis).

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

    risk = (entry - stop) if stop is not None else None
    if risk is not None and risk <= 0:          # T+1 gapped below the stop -> untradeable
        return TradeResult(False, "no_fill", entry, 0, 0, 0, 0)

    # ---- manage ----
    held = 0
    for b in session_bars[start:]:
        held += 1
        if stop is not None and b["low"] <= stop:    # conservative: stop checked first
            return _result("stop", entry, stop * (1 - slip), held, risk, comm)
        if target is not None and b["high"] >= target:
            return _result("target", entry, target * (1 - slip), held, risk, comm)

    # ---- time exit at last close ----
    return _result("time", entry, session_bars[-1]["close"] * (1 - slip), held, risk, comm)


def simulate_at(window: list, entry_price: float, start_idx: int, stop: Optional[float] = None,
                target: Optional[float] = None, cost: CostModel = CostModel()) -> TradeResult:
    """Manage a position whose entry has ALREADY been decided (price + the bar index
    after which management begins) — used by entry-timing rules (entries.py). `window`
    is the full flattened hold window; `start_idx` is the first management bar."""
    slip = cost.slippage_bps / 1e4
    comm = cost.commission_bps / 1e4
    entry = entry_price * (1 + slip)
    risk = (entry - stop) if stop is not None else None
    if risk is not None and risk <= 0:
        return TradeResult(False, "no_fill", entry, 0, 0, 0, 0)

    mgmt = window[start_idx:]
    if not mgmt:                              # entered on the final bar — nothing to manage
        return _result("time", entry, window[-1]["close"] * (1 - slip), 0, risk, comm)

    held = 0
    for b in mgmt:
        held += 1
        if stop is not None and b["low"] <= stop:
            return _result("stop", entry, stop * (1 - slip), held, risk, comm)
        if target is not None and b["high"] >= target:
            return _result("target", entry, target * (1 - slip), held, risk, comm)
    return _result("time", entry, mgmt[-1]["close"] * (1 - slip), held, risk, comm)


def _result(reason: str, entry: float, exit_px: float, held: int, risk: Optional[float],
            comm: float) -> TradeResult:
    gross = exit_px - entry
    net_ret = gross / entry - 2 * comm
    r = gross / risk if (risk and risk > 0) else 0.0
    return TradeResult(True, reason, round(entry, 4), round(exit_px, 4), held,
                       round(r, 3), round(net_ret * 100, 3))
