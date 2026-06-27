"""Shared pipeline: point-in-time Day Trade signal generation + per-signal intraday
hold-window retrieval. Used by every experiment so the selection logic lives in one
place (and stays identical to the live screener via daytrade.py)."""
from __future__ import annotations

from datetime import datetime, timedelta

from tqdm import tqdm

from . import fmp
from .daytrade import SCANS, day_metrics, passes_scan, rank_score, trade_levels


def _pad(d: str, days: int) -> str:
    return (datetime.strptime(d, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def date_plus(d: str, days: int) -> str:
    return (datetime.strptime(d, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def generate_signals(cfg) -> list:
    """Replay the live Day Trade screener point-in-time over the configured universe
    and window. Returns signal dicts carrying everything needed to build any exit
    policy: entry_close (T close), atr, today_low, plus the baseline structure levels.
    No lookahead — selection uses daily data through T's close only."""
    daily_start = _pad(cfg.start, cfg.daily_lookback_days + 20)
    spy = fmp.daily("SPY", daily_start, cfg.end)
    spy_map = {c["date"]: c["close"] for c in spy}

    signals = []
    for sym in tqdm(cfg.universe, desc="scan"):
        try:
            dc = fmp.daily(sym, daily_start, cfg.end)
        except Exception as e:
            print(f"  ! {sym} daily failed: {e}")
            continue
        last_idx = -10_000
        for i, c in enumerate(dc):
            if not (cfg.start <= c["date"] <= cfg.end):
                continue
            if i - last_idx < cfg.max_hold_sessions:        # no overlapping same-name trades
                continue
            m = day_metrics(dc[: i + 1], spy_map)
            if not m:
                continue
            for scan in SCANS.values():
                if passes_scan(m, scan):
                    lv = trade_levels(dc[: i + 1])
                    if lv:
                        signals.append(dict(
                            symbol=sym, date=c["date"], scan=scan["key"], rank=rank_score(m),
                            relVol=m["relVol"], pctChange=m["pctChange"],
                            entry_close=lv["entry"], atr=lv["atr"], today_low=c["low"],
                            base_stop=lv["stop"], base_target=lv["target"]))
                        last_idx = i
                    break
    return signals


def hold_window_sessions(cfg, signal: dict) -> list:
    """List of sessions (each a list of intraday bars) for the hold window — the next
    `max_hold_sessions` trading days after T. The first session is the entry day
    (T+1), which entry-timing rules act within. Cached per-month by fmp."""
    bars = fmp.intraday(signal["symbol"], cfg.interval, signal["date"], date_plus(signal["date"], 10))
    sessions = fmp.group_by_session(bars)
    future = sorted(d for d in sessions if d > signal["date"])[: cfg.max_hold_sessions]
    return [sessions[d] for d in future]


def hold_window_bars(cfg, signal: dict) -> list:
    """Flat list of all hold-window bars (sessions concatenated)."""
    return [b for sess in hold_window_sessions(cfg, signal) for b in sess]
