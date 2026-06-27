"""Summary statistics for a set of trade results. Honest, sample-aware: reports n and
a Wilson lower bound on the win rate so a small lucky sample can't masquerade as edge
(the same discipline the app uses elsewhere)."""
from __future__ import annotations

import math
from typing import List

from .execution import TradeResult


def wilson_lb(wins: int, n: int, z: float = 1.64) -> float:
    """Wilson 90% lower bound on a win rate."""
    if n == 0:
        return 0.0
    p = wins / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return round((centre - margin) / denom * 100, 1)


def summarize(results: List[TradeResult]) -> dict:
    filled = [r for r in results if r.filled]
    n = len(filled)
    if n == 0:
        return {"n": 0}
    # Classify by net return (universal — R is undefined for no-stop policies).
    wins = [r for r in filled if r.net_return_pct > 0]
    losses = [r for r in filled if r.net_return_pct <= 0]
    rs = [r.r_multiple for r in filled]
    rets = [r.net_return_pct for r in filled]
    gross_win = sum(r.net_return_pct for r in wins)
    gross_loss = -sum(r.net_return_pct for r in losses)
    reasons: dict = {}
    for r in filled:
        reasons[r.exit_reason] = reasons.get(r.exit_reason, 0) + 1
    return {
        "n": n,
        "win_rate": round(len(wins) / n * 100, 1),
        "win_rate_wilson_lb": wilson_lb(len(wins), n),
        "avg_R": round(sum(rs) / n, 3),
        "expectancy_pct": round(sum(rets) / n, 3),
        "avg_win_pct": round(gross_win / len(wins), 3) if wins else 0.0,
        "avg_loss_pct": round(-gross_loss / len(losses), 3) if losses else 0.0,
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else float("inf"),
        "total_return_pct": round(sum(rets), 1),
        "exit_reasons": reasons,
    }
