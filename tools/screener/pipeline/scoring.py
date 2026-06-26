"""Pure scoring functions.

Every function takes a read-only mapping (one row) and returns a number.
Nothing is mutated; callers build new structures from the results.
This is the heart of the pipeline and the most heavily tested module.
"""

from __future__ import annotations

import math
from typing import Mapping

from . import config as C


def _is_number(value) -> bool:
    """True for real numbers, excluding bool (bool is a subclass of int)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _to_float(value, default: float = 0.0) -> float:
    """Coerce possibly-missing / NaN / blank values to a float safely."""
    if value is None:
        return default
    if _is_number(value):
        return default if (isinstance(value, float) and math.isnan(value)) else float(value)
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        text = str(value).strip()
        return float(text) if text else default
    except (TypeError, ValueError):
        return default


def _is_missing(value) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    return isinstance(value, str) and not value.strip()


def _truthy(value) -> bool:
    """Interpret a screener flag that may be a bool, number, or string."""
    if isinstance(value, bool):
        return value
    if _is_number(value):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"true", "t", "1", "yes", "y", "pass"}
    return False


def confluence_score(row: Mapping, weights: Mapping = C.CONFLUENCE_WEIGHTS) -> float:
    """Multi-screener agreement, normalised to a true 0-100 scale.

    FIX vs original: the raw weight sum (110) used to be clipped at 100,
    saturating every strong name and destroying ranking inside the top
    tier. We normalise by the total available weight instead, so a name
    passing every screen scores exactly 100 and partial agreement spreads
    across the full range.
    """
    earned = 0.0
    if _truthy(row.get("breakout_pass")):
        earned += weights["breakout"]
    if _to_float(row.get("ghost_accum_score")) > C.GHOST_ACCUM_PASS:
        earned += weights["ghost_accum"]
    if _to_float(row.get("opportunities_score")) > C.OPPORTUNITIES_PASS:
        earned += weights["opportunities"]
    if _truthy(row.get("core_momentum")):
        earned += weights["core_momentum"]
    if _truthy(row.get("adaptive_momentum")):
        earned += weights["adaptive_momentum"]
    if _truthy(row.get("regime_ok", True)):
        earned += weights["regime"]

    total = sum(weights.values())
    return round(100.0 * earned / total, 1) if total else 0.0


def options_boost(row: Mapping, max_boost: float = C.OPTIONS_BOOST_MAX) -> float:
    """Bullish options-flow confirmation, 0..max_boost."""
    if _is_missing(row.get("flow_type")):
        return 0.0
    flow = str(row.get("flow_type", "")).lower()
    premium = _to_float(row.get("premium"))
    repeat = int(_to_float(row.get("repeat_days")))
    aggressive = _truthy(row.get("aggressive"))

    boost = 0.0
    if "call" in flow and ("sweep" in flow or "block" in flow):
        if aggressive or premium > C.OPTIONS_PREMIUM_STRONG:
            boost += C.OPTIONS_PTS["aggressive_or_strong_premium"]
        if repeat >= C.OPTIONS_REPEAT_MIN:
            boost += C.OPTIONS_PTS["repeat"]
        if premium > C.OPTIONS_PREMIUM_HUGE:
            boost += C.OPTIONS_PTS["huge_premium"]
    if "bullish" in flow and repeat >= C.OPTIONS_BULLISH_REPEAT_MIN:
        boost += C.OPTIONS_PTS["bullish_repeat"]

    return round(min(max_boost, boost), 1)


def catalyst_boost(row: Mapping, max_boost: float = C.CATALYST_BOOST_MAX) -> float:
    """Event-driven boost, 0..max_boost, scaled by catalyst strength."""
    if _is_missing(row.get("catalyst_type")):
        return 0.0
    cat_type = str(row.get("catalyst_type", "")).lower()
    days = _to_float(row.get("days_until"), default=10_000.0)
    strength = _to_float(row.get("catalyst_strength"), default=C.CATALYST_STRENGTH_BASELINE)

    boost = 0.0
    for max_days, pts in C.CATALYST_PROXIMITY_PTS:
        if days <= max_days:
            boost += pts
            break
    for keywords, pts in C.CATALYST_TYPE_PTS:
        if any(k in cat_type for k in keywords):
            boost += pts
            break

    boost *= strength / C.CATALYST_STRENGTH_BASELINE
    return round(min(max_boost, max(0.0, boost)), 1)


def final_score(confluence: float, options: float, catalyst: float,
                weights: Mapping = C.BLEND_WEIGHTS) -> float:
    """Blend three families that are ALL on a 0-100 scale.

    FIX vs original: the boosts (max 25 / 20) used to be blended directly
    against a 0-100 confluence, so their 0.25 / 0.20 weights were a fiction
    (max final ~65, boosts barely mattered). We rescale each boost to 0-100
    by its own ceiling first, so a perfect name can reach 100 and the blend
    weights mean what they say.
    """
    options_pct = 100.0 * options / C.OPTIONS_BOOST_MAX if C.OPTIONS_BOOST_MAX else 0.0
    catalyst_pct = 100.0 * catalyst / C.CATALYST_BOOST_MAX if C.CATALYST_BOOST_MAX else 0.0
    blended = (
        confluence * weights["confluence"]
        + options_pct * weights["options"]
        + catalyst_pct * weights["catalyst"]
    )
    return round(blended, 1)


def recommendation(confluence: float, options: float, catalyst: float,
                   regime_ok: bool) -> str:
    """Human-readable rationale string built from the component scores."""
    reasons = []
    if confluence >= C.CONFLUENCE_HIGH:
        reasons.append("High Multi-Model Confluence")
    elif confluence >= C.CONFLUENCE_STRONG:
        reasons.append("Strong Confluence")

    if options >= C.OPTIONS_STRONG:
        reasons.append("Strong Bullish Options Flow (Repeat/Aggressive)")
    elif options >= C.OPTIONS_CONFIRM:
        reasons.append("Options Flow Confirmation")

    if catalyst >= C.CATALYST_HIGH:
        reasons.append("High-Impact Imminent Catalyst")
    elif catalyst >= C.CATALYST_BACK:
        reasons.append("Catalyst Backing")

    if regime_ok and confluence > C.CONFLUENCE_STRONG:
        reasons.append("Regime-Aligned")

    return " + ".join(reasons) if reasons else "Monitor - Moderate Setup"
