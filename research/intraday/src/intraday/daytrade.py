"""Faithful Python port of the app's lib/daytrade.js (the live Day Trade screener).

Kept line-for-line equivalent so the backtest selects EXACTLY the names the live
screener would, then we measure their real intraday outcome. Candles are dicts with
keys: date, open, high, low, close, volume (ascending).
"""
from __future__ import annotations

from typing import Optional

AVG_VOL_WINDOW = 20

SCANS = {
    "momentum_liquid": dict(
        key="momentum_liquid", label="🚀 Momentum & Liquid",
        priceMin=5, priceMax=50, minAvgVol=1_000_000, minDollarVol=10_000_000,
        minRelVol=1.5, minPct=5.0,
    ),
    "explosive_small": dict(
        key="explosive_small", label="💥 Explosive Small-Cap",
        priceMin=1, priceMax=20, minAvgVol=500_000, minDollarVol=2_000_000,
        minRelVol=2.0, minPct=8.0,
    ),
}


def day_metrics(candles: list, spy_by_date: Optional[dict] = None,
                avg_window: int = AVG_VOL_WINDOW) -> Optional[dict]:
    if not candles or len(candles) < avg_window + 1:
        return None
    i = len(candles) - 1
    last, prev = candles[i]["close"], candles[i - 1]["close"]
    if not (last > 0) or not (prev > 0):
        return None

    today_vol = candles[i].get("volume") or 0
    avg_vol = sum((candles[k].get("volume") or 0) for k in range(i - avg_window, i)) / avg_window
    if not (avg_vol > 0):
        return None

    today_open = candles[i]["open"]
    gap_pct = (today_open - prev) / prev * 100 if today_open > 0 else None

    spy_pct = None
    if spy_by_date:
        d, dp = candles[i]["date"], candles[i - 1]["date"]
        if spy_by_date.get(d) is not None and spy_by_date.get(dp):
            spy_pct = (spy_by_date[d] / spy_by_date[dp] - 1) * 100
    pct_change = (last - prev) / prev * 100

    return {
        "last": round(last, 2),
        "avgVol": round(avg_vol),
        "avgDollarVol": round(avg_vol * last),
        "relVol": round(today_vol / avg_vol, 2),
        "pctChange": round(pct_change, 2),
        "gapPct": round(gap_pct, 2) if gap_pct is not None else None,
        "excessPct": round(pct_change - spy_pct, 2) if spy_pct is not None else None,
    }


def passes_scan(m: dict, params: dict) -> bool:
    return (m["last"] >= params["priceMin"] and m["last"] <= params["priceMax"]
            and m["avgVol"] >= params["minAvgVol"]
            and m["avgDollarVol"] >= params["minDollarVol"]
            and m["relVol"] >= params["minRelVol"]
            and m["pctChange"] >= params["minPct"])


def rank_score(m: dict) -> float:
    rv = min(m["relVol"], 10)
    return round(rv * 10 + m["pctChange"] + (m["gapPct"] or 0) * 0.5, 1)


def atr(candles: list, period: int = 14) -> float:
    n = len(candles)
    if n < 2:
        return 0.0
    s, cnt = 0.0, 0
    for i in range(max(1, n - period), n):
        h, l, pc = candles[i]["high"], candles[i]["low"], candles[i - 1]["close"]
        s += max(h - l, abs(h - pc), abs(l - pc))
        cnt += 1
    return s / cnt if cnt else 0.0


def ema(values: list, period: int) -> Optional[float]:
    n = len(values)
    if not n:
        return None
    k = 2 / (period + 1)
    start = max(0, n - period * 4)
    e = values[start]
    for i in range(start + 1, n):
        e = values[i] * k + e * (1 - k)
    return e


def trade_levels(candles: list, stop_atr_mult: float = 1.5, rr: float = 2.0,
                 pullback_frac: float = 0.4) -> Optional[dict]:
    i = len(candles) - 1
    entry = candles[i]["close"]
    a = atr(candles)
    if not (a > 0) or not (entry > 0):
        return None
    today_low = candles[i]["low"]

    def plan(e: float) -> Optional[dict]:
        stop = max(today_low - 0.1 * a, e - stop_atr_mult * a)
        risk = e - stop
        if not (risk > 0):
            return None
        return {"entry": round(e, 2), "stop": round(stop, 2),
                "target": round(e + rr * risk, 2), "rr": rr,
                "riskPct": round(risk / e * 100, 1)}

    breakout = plan(entry)
    if not breakout:
        return None
    e9 = ema([c["close"] for c in candles], 9)
    retrace = entry - pullback_frac * (entry - today_low)
    pb = max(e9 if e9 is not None else retrace, retrace)
    pb = min(max(pb, today_low), entry * 0.999)
    pullback = plan(round(pb, 2))
    return {**breakout, "atr": round(a, 2), "pullback": pullback}
