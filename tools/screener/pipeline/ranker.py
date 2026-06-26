"""Ranking orchestration: scores + ranks a stocks frame immutably.

Returns a NEW DataFrame (via .assign / .sort_values); the input frame is
never mutated, per the immutability rule.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np
import pandas as pd

from . import config as C
from . import scoring


def _regime_ok(row) -> bool:
    val = row.get("regime_ok", True)
    return scoring._truthy(val) if "regime_ok" in row else True


def rank(stocks: pd.DataFrame, regime_gate: bool = False) -> pd.DataFrame:
    """Score, optionally regime-gate, and rank.

    regime_gate reflects this project's single most-validated finding
    (see smallcap-edge-project): going long in macro risk-off has negative
    expectancy. When enabled, risk-off names (regime_ok == False) are kept
    but flagged and pushed below all regime-aligned names instead of merely
    losing a small confluence bonus.
    """
    rows = stocks.to_dict("records")

    confluence = [scoring.confluence_score(r) for r in rows]
    options = [scoring.options_boost(r) for r in rows]
    catalyst = [scoring.catalyst_boost(r) for r in rows]
    regime = [_regime_ok(r) for r in rows]
    final = [scoring.final_score(c, o, k) for c, o, k in zip(confluence, options, catalyst)]
    recs = [
        scoring.recommendation(c, o, k, rk)
        for c, o, k, rk in zip(confluence, options, catalyst, regime)
    ]

    scored = stocks.assign(
        confluence_score=confluence,
        options_boost=options,
        catalyst_boost=catalyst,
        final_score=final,
        regime_ok=regime,
        recommendation=recs,
        run_date=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )

    sort_keys = ["final_score"]
    ascending = [False]
    if regime_gate:
        risk_off = ~scored["regime_ok"].to_numpy(dtype=bool)
        gated_rec = np.where(
            risk_off, "RISK-OFF (gated) — " + scored["recommendation"], scored["recommendation"]
        )
        scored = scored.assign(regime_gated=risk_off, recommendation=gated_rec)
        sort_keys = ["regime_ok", "final_score"]
        ascending = [False, False]

    ranked = scored.sort_values(sort_keys, ascending=ascending).reset_index(drop=True)
    return ranked.assign(rank=range(1, len(ranked) + 1))


OUTPUT_COLUMNS = (
    "rank", "ticker", "final_score", "confluence_score", "options_boost",
    "catalyst_boost", "regime_ok", "recommendation",
    "breakout_pass", "ghost_accum_score", "opportunities_score",
    "core_momentum", "adaptive_momentum",
    "flow_type", "premium", "repeat_days",
    "catalyst_type", "days_until", "catalyst_strength",
    "run_date",
)


def select_output(ranked: pd.DataFrame) -> pd.DataFrame:
    cols = [c for c in OUTPUT_COLUMNS if c in ranked.columns]
    return ranked[cols].copy()
