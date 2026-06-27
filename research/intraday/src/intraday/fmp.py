"""FMP data client — daily and intraday OHLCV, cached to disk.

Both endpoints on FMP's `stable/` family RETAIN delisted names (verified: SIVB/FRC
intraday bars exist up to their collapse), so backtests built on this client are
survivorship-free — the key reason this domain is feasible on the Starter tier.

  daily(symbol, start, end)    -> stable/historical-price-eod/full
  intraday(symbol, iv, s, e)   -> stable/historical-chart/{1min|5min}

Responses are cached under data/cache/ keyed by (kind, symbol, interval, range) so
re-runs are free and reproducible.
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import requests

BASE = "https://financialmodelingprep.com/stable"
CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "cache"
_THROTTLE_S = 0.25  # be polite to the Starter rate limit


def _key() -> str:
    k = os.environ.get("FMP_API_KEY")
    if not k:
        raise RuntimeError("FMP_API_KEY not set (put it in research/intraday/.env)")
    return k


def _cache_path(name: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / (name + ".json")


def _get(url: str, cache_name: str) -> object:
    cp = _cache_path(cache_name)
    if cp.exists():
        return json.loads(cp.read_text())
    time.sleep(_THROTTLE_S)
    resp = requests.get(url, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"FMP {resp.status_code}: {resp.text[:120]}")
    data = resp.json()
    cp.write_text(json.dumps(data))
    return data


def _norm_daily(rows: list) -> list:
    out = []
    for r in rows:
        out.append({
            "date": r["date"][:10],
            "open": float(r["open"]), "high": float(r["high"]),
            "low": float(r["low"]), "close": float(r["close"]),
            "volume": float(r.get("volume") or 0),
        })
    out.sort(key=lambda c: c["date"])
    return out


def daily(symbol: str, start: str, end: str) -> list:
    """Daily candles [{date,open,high,low,close,volume}] ascending, inclusive range."""
    url = f"{BASE}/historical-price-eod/full?symbol={symbol}&from={start}&to={end}&apikey={_key()}"
    data = _get(url, f"daily_{symbol}_{start}_{end}")
    rows = data.get("historical", data) if isinstance(data, dict) else data
    return _norm_daily(rows or [])


def _month_ranges(start: str, end: str):
    s = datetime.strptime(start, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date()
    cur = s
    while cur <= e:
        nxt = (cur.replace(day=1) + timedelta(days=32)).replace(day=1)
        yield cur.isoformat(), min(nxt - timedelta(days=1), e).isoformat()
        cur = nxt


def intraday(symbol: str, interval: str, start: str, end: str) -> list:
    """Intraday bars [{datetime,date,open,high,low,close,volume}] ascending.

    interval in {'1min','5min'}. Fetched month-by-month (FMP caps long ranges) and
    concatenated; each month is cached independently.
    """
    bars: list = []
    for ms, me in _month_ranges(start, end):
        url = f"{BASE}/historical-chart/{interval}?symbol={symbol}&from={ms}&to={me}&apikey={_key()}"
        rows = _get(url, f"intra_{interval}_{symbol}_{ms}_{me}")
        for r in (rows or []):
            bars.append({
                "datetime": r["date"],
                "date": r["date"][:10],
                "open": float(r["open"]), "high": float(r["high"]),
                "low": float(r["low"]), "close": float(r["close"]),
                "volume": float(r.get("volume") or 0),
            })
    bars.sort(key=lambda b: b["datetime"])
    return bars


def group_by_session(bars: list) -> "dict[str, list]":
    """Group intraday bars by trading day (date string)."""
    out: dict = {}
    for b in bars:
        out.setdefault(b["date"], []).append(b)
    return out
