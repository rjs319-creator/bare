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
    # Candidate universe (the Day Trade scans filter WHICH days qualify). Names that
    # live in the scans' price bands ($1–50). Survivorship-free via FMP stable.
    universe: List[str] = field(default_factory=lambda: [
        "F", "SOFI", "RIOT", "MARA", "PLUG", "RIVN", "NIO", "INTC",
        "CCL", "AAL", "SNAP", "PINS", "HOOD", "LCID", "AFRM",
    ])
    start: str = "2024-10-01"
    end: str = "2024-12-31"
    interval: str = "5min"
    max_hold_sessions: int = 3        # mirrors the live screener's DAYTRADE_H = 3
    daily_lookback_days: int = 60     # enough for 20-day avg vol + ATR before `start`
    entry_mode: str = "next_open"     # 'next_open' (executable) | 'pullback' (limit)
