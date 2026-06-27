"""Point-in-time regime / tape features for gating. Built from index daily bars
(SPY, IWM, ^VIX) using only data up to each date — SMAs/efficiency are trailing, so
no lookahead. Gating these day-trades on the SMALL-CAP tape (IWM) matters more than
SPY, since the universe is small/mid-cap (SPY was bullish through 2024 while these
names bled — a SPY-only gate would miss it)."""
from __future__ import annotations

from typing import Optional

from . import fmp


def sma(vals: list, n: int) -> Optional[float]:
    return sum(vals[-n:]) / n if len(vals) >= n else None


def efficiency_ratio(closes: list, n: int = 15) -> Optional[float]:
    """Kaufman efficiency ratio over n bars: |net move| / sum|bar moves|. ~1 = clean
    trend, ~0 = chop."""
    if len(closes) < n + 1:
        return None
    seg = closes[-(n + 1):]
    direction = abs(seg[-1] - seg[0])
    vol = sum(abs(seg[i] - seg[i - 1]) for i in range(1, len(seg)))
    return direction / vol if vol > 0 else 0.0


def _series(candles: list) -> dict:
    closes = [c["close"] for c in candles]
    dates = [c["date"] for c in candles]
    out = {}
    for i in range(len(candles)):
        cl = closes[: i + 1]
        s50, s50p = sma(cl, 50), sma(cl[:-1], 50)
        out[dates[i]] = {
            "above200": sma(cl, 200) is not None and closes[i] > sma(cl, 200),
            "above50": s50 is not None and closes[i] > s50,
            "sma50_rising": s50 is not None and s50p is not None and s50 > s50p,
            "er": efficiency_ratio(cl, 15),
        }
    return out


def build_regime(start_fetch: str, end: str) -> dict:
    """date -> {spy, iwm, vix}. vix carries level + trailing-252d percentile (or None
    if FMP lacks ^VIX)."""
    spy = _series(fmp.daily("SPY", start_fetch, end))
    iwm = _series(fmp.daily("IWM", start_fetch, end))
    try:
        vraw = fmp.daily("^VIX", start_fetch, end)
    except Exception:
        vraw = []
    vix = {}
    vc = [c["close"] for c in vraw]
    for i, c in enumerate(vraw):
        w = vc[max(0, i - 251): i + 1]
        vix[c["date"]] = {"level": c["close"], "pctile": sum(1 for x in w if x <= c["close"]) / len(w)}

    reg = {}
    for d in spy:
        reg[d] = {"spy": spy[d], "iwm": iwm.get(d), "vix": vix.get(d)}
    return reg
