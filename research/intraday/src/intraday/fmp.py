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


def _get(url: str, cache_name: str, retries: int = 4) -> object:
    cp = _cache_path(cache_name)
    if cp.exists():
        return json.loads(cp.read_text())
    last = None
    for attempt in range(retries):
        time.sleep(_THROTTLE_S * (attempt + 1))          # linear backoff
        try:
            resp = requests.get(url, timeout=30)
        except requests.exceptions.RequestException as ex:  # transient network reset/timeout
            last = ex
            continue
        if resp.status_code == 200:
            data = resp.json()
            cp.write_text(json.dumps(data))
            return data
        if resp.status_code in (429, 500, 502, 503, 504):   # transient server/rate-limit
            last = RuntimeError(f"FMP {resp.status_code}: {resp.text[:120]}")
            continue
        raise RuntimeError(f"FMP {resp.status_code}: {resp.text[:120]}")  # hard error, don't retry
    raise RuntimeError(f"FMP request failed after {retries} attempts: {last}")


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


def earnings(symbol: str) -> list:
    """Historical earnings events for one symbol via stable/earnings — the announcement
    DATES (retained ~5y on Starter; only the estimate DEPTH is capped ~12mo, which we
    don't rely on here) plus epsActual/epsEstimated when present.

    Returns [{date, epsActual, epsEstimated, revActual, revEstimated}] ascending,
    dates only (YYYY-MM-DD). Cached like everything else. Empty list on failure.
    """
    url = f"{BASE}/earnings?symbol={symbol}&apikey={_key()}&limit=80"
    try:
        rows = _get(url, f"earn_{symbol}")
    except Exception:
        return []
    out = []
    for r in (rows or []):
        d = str(r.get("date") or "")[:10]
        if len(d) != 10:
            continue
        out.append({
            "date": d,
            "epsActual": r.get("epsActual"),
            "epsEstimated": r.get("epsEstimated"),
            "revActual": r.get("revenueActual"),
            "revEstimated": r.get("revenueEstimated"),
        })
    out.sort(key=lambda e: e["date"])
    return out
