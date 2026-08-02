"""Intraday entry-timing rules — the rig's UNIQUE capability (the daily harness can
only ever 'enter at the open'). Each rule looks at the entry day's (T+1) intraday bars
and returns (entry_price, bar_index) — management then starts on the NEXT bar — or
None if the rule never triggers that day (a no-fill, which is itself informative: a
selective entry that skips bad days can beat a fill-everything entry).

K_30M = number of 5-min bars in the first 30 minutes (the opening range)."""
from __future__ import annotations

from typing import Optional, Tuple

K_30M = 6  # 6 x 5min


def next_open(first: list) -> Optional[Tuple[float, int]]:
    """Baseline: market order at the first bar's open (buys the gap)."""
    if not first:
        return None
    return (first[0]["open"], 0)


def opening_range_breakout(first: list, k: int = K_30M) -> Optional[Tuple[float, int]]:
    """Wait out the first 30 min; enter only if price breaks the opening-range high
    (momentum confirmation). Realistic stop-through-trigger fill: a resting buy-stop
    at the OR high fills AT the trigger only when the bar trades through it from
    below; if the trigger bar OPENS at/above the level (gap-through), the stop fills
    at that bar's open — a strictly worse price. The old behaviour (always fill at
    the OR high) was optimistic on exactly the strongest-momentum days."""
    if len(first) <= k:
        return None
    or_high = max(b["high"] for b in first[:k])
    for i in range(k, len(first)):
        b = first[i]
        if b["open"] >= or_high:
            return (b["open"], i)
        if b["high"] >= or_high:
            return (or_high, i)
    return None


def vwap_pullback(first: list, min_i: int = 2) -> Optional[Tuple[float, int]]:
    """Buy the first pullback to intraday VWAP (a better price than chasing the open);
    no fill if price never trades back to VWAP."""
    if len(first) <= min_i:
        return None
    cum_pv = cum_v = 0.0
    for i, b in enumerate(first):
        tp = (b["high"] + b["low"] + b["close"]) / 3
        cum_pv += tp * b["volume"]
        cum_v += b["volume"]
        vwap = cum_pv / cum_v if cum_v > 0 else b["close"]
        if i >= min_i and b["low"] <= vwap:
            return (vwap, i)
    return None


def hold_30(first: list, k: int = K_30M) -> Optional[Tuple[float, int]]:
    """Enter at the 30-min mark only if the stock is still GREEN vs the open
    (continuation confirmation); skip the day otherwise."""
    if len(first) <= k:
        return None
    if first[k]["close"] > first[0]["open"]:
        return (first[k]["close"], k)
    return None


RULES = {
    "next_open": next_open,
    "orb_30": opening_range_breakout,
    "vwap_pull": vwap_pullback,
    "hold_30": hold_30,
}
