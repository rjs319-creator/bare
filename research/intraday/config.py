"""Backtest configuration. Plain dataclasses (KISS) + .env for the API key.

Pydantic/YAML can be layered on later if config grows; for one validated strategy a
dataclass is enough and dependency-light.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import List

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


@dataclass
class BacktestConfig:
    # Candidate universe (the Day Trade scans filter WHICH days qualify). ~50 names
    # that live in the scans' price bands ($1–50): liquid mid-price + speculative
    # small-caps, the natural Day Trade hunting ground. Survivorship-free via FMP
    # stable (delisted names retain bars); a few SPAC/IPO names have partial early
    # history — they simply don't signal before they existed.
    universe: List[str] = field(default_factory=lambda: [
        # liquid mid-price ($5–50)
        "F", "SOFI", "INTC", "CCL", "NCLH", "AAL", "BAC", "WFC", "T", "PFE",
        "KMI", "KEY", "SNAP", "PINS", "HOOD", "AFRM", "UPST", "DKNG", "PLTR",
        "LYFT", "U", "RBLX", "WBD", "PARA", "CLF", "X", "VALE", "GOLD", "KGC",
        # speculative small-caps ($1–20)
        "MARA", "RIOT", "PLUG", "NIO", "RIVN", "LCID", "CHPT", "RUN", "FCEL",
        "BBAI", "SOUN", "AMC", "GME", "IONQ", "RGTI", "CLSK", "HUT", "NKLA",
        "MULN", "OPEN", "DNA", "GEVO",
    ])
    start: str = "2022-01-01"
    end: str = "2025-06-30"
    interval: str = "5min"
    max_hold_sessions: int = 3        # mirrors the live screener's DAYTRADE_H = 3
    daily_lookback_days: int = 60     # enough for 20-day avg vol + ATR before `start`
    entry_mode: str = "next_open"     # 'next_open' (executable) | 'pullback' (limit)
