"""Configuration constants for the screener pipeline.

All tunables live here so the scoring math has no magic numbers.
Weights are intentionally split into the three score families
(confluence / options / catalyst) and each family is normalised to a
0-100 scale before blending, so the BLEND weights are honest.
"""

from __future__ import annotations

from types import MappingProxyType

# --- Confluence model (multi-screener agreement) ---------------------------
# Each weight is the number of points a passing screener contributes.
# The raw sum is normalised to 0-100 (see scoring.confluence_score), so
# these are relative importances, NOT absolute points capped at 100.
CONFLUENCE_WEIGHTS = MappingProxyType({
    "breakout": 25.0,
    "ghost_accum": 30.0,
    "opportunities": 20.0,
    "core_momentum": 10.0,
    "adaptive_momentum": 15.0,
    "regime": 10.0,
})

# Thresholds that turn a continuous screener column into a pass/fail.
GHOST_ACCUM_PASS = 50.0
OPPORTUNITIES_PASS = 60.0

# --- Options-flow boost (smart-money confirmation) -------------------------
OPTIONS_BOOST_MAX = 25.0
OPTIONS_PREMIUM_STRONG = 50_000.0
OPTIONS_PREMIUM_HUGE = 100_000.0
OPTIONS_REPEAT_MIN = 2
OPTIONS_BULLISH_REPEAT_MIN = 3
OPTIONS_PTS = MappingProxyType({
    "aggressive_or_strong_premium": 12.0,
    "repeat": 8.0,
    "huge_premium": 5.0,
    "bullish_repeat": 5.0,
})

# --- Catalyst boost (event-driven edge) ------------------------------------
CATALYST_BOOST_MAX = 20.0
CATALYST_STRENGTH_BASELINE = 70.0  # strength that yields a 1.0 multiplier
CATALYST_PROXIMITY_PTS = (  # (max_days, points) — first match wins
    (7, 10.0),
    (21, 6.0),
    (42, 3.0),
)
CATALYST_TYPE_PTS = (  # (keywords, points) — first matching group wins
    (("fda", "pdufa", "readout", "phase", "clinical"), 8.0),
    (("earnings",), 5.0),
    (("partnership", "acquisition", "buyback", "13d", "insider"), 6.0),
)

# --- Final blend (each family already on a 0-100 scale) --------------------
BLEND_WEIGHTS = MappingProxyType({
    "confluence": 0.55,
    "options": 0.25,
    "catalyst": 0.20,
})

# --- Recommendation thresholds ---------------------------------------------
CONFLUENCE_HIGH = 70.0
CONFLUENCE_STRONG = 55.0
OPTIONS_STRONG = 15.0
OPTIONS_CONFIRM = 8.0
CATALYST_HIGH = 10.0
CATALYST_BACK = 5.0

# --- Autonomous file discovery ---------------------------------------------
STOCKS_PATTERNS = (
    "stocks*.csv", "screener*.csv", "latest_stocks*.csv", "export*.csv",
    "breakout*.csv", "momentum*.csv", "confluence*.csv",
)
OPTIONS_PATTERNS = ("options*.csv", "options_flow*.csv", "unusual_options*.csv", "flow*.csv")
CATALYSTS_PATTERNS = ("catalysts*.csv", "catalyst*.csv", "events*.csv", "calendar*.csv")
SEARCH_DIRS = (".", "./data", "./exports", "./artifacts", "./inputs")
