"""CSV loading + boundary validation.

Never trust external data: every load validates the 'ticker' key exists
and normalises it. Optional feeds merge left so a missing feed degrades
gracefully rather than dropping names.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import pandas as pd


class ScreenerInputError(ValueError):
    """Raised when an input CSV is missing or malformed."""


def _normalise_ticker(df: pd.DataFrame, source: str) -> pd.DataFrame:
    if "ticker" not in df.columns:
        raise ScreenerInputError(f"{source} CSV must contain a 'ticker' column")
    # Return a NEW frame (immutability): do not mutate the caller's df.
    return df.assign(ticker=df["ticker"].astype(str).str.upper().str.strip())


def load_stocks(path: str) -> pd.DataFrame:
    try:
        df = pd.read_csv(path)
    except FileNotFoundError as exc:
        raise ScreenerInputError(f"stocks file not found: {path}") from exc
    except (pd.errors.EmptyDataError, pd.errors.ParserError) as exc:
        raise ScreenerInputError(f"could not parse stocks file {path}: {exc}") from exc
    if df.empty:
        raise ScreenerInputError(f"stocks file {path} has no rows")
    return _normalise_ticker(df, "stocks")


def merge_optional(stocks: pd.DataFrame, path: Optional[str], label: str) -> pd.DataFrame:
    """Left-merge an optional feed on ticker. Missing/bad feed is a no-op."""
    if not path or not Path(path).exists():
        return stocks
    try:
        feed = pd.read_csv(path)
        feed = _normalise_ticker(feed, label)
    except (ScreenerInputError, pd.errors.EmptyDataError, pd.errors.ParserError):
        return stocks  # graceful degradation; caller logs the warning
    return stocks.merge(feed, on="ticker", how="left")
