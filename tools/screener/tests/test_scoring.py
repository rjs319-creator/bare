"""Unit tests for pure scoring functions (AAA pattern).

Each fix from the original script has a named regression test.
"""

import math

import pytest

from pipeline import config as C
from pipeline import scoring


# --- confluence_score ------------------------------------------------------

def test_confluence_full_agreement_scores_exactly_100():
    # Arrange: a name that passes every screen
    row = {
        "breakout_pass": True, "ghost_accum_score": 90, "opportunities_score": 90,
        "core_momentum": True, "adaptive_momentum": True, "regime_ok": True,
    }
    # Act
    score = scoring.confluence_score(row)
    # Assert: normalised, NOT clipped at 100 by saturation
    assert score == 100.0


def test_confluence_does_not_saturate_for_partial_agreement():
    # Regression: original summed to 110 and clipped, so strong-but-not-perfect
    # names also hit 100. Here a near-perfect name must score BELOW 100.
    full = {"breakout_pass": True, "ghost_accum_score": 90, "opportunities_score": 90,
            "core_momentum": True, "adaptive_momentum": True, "regime_ok": True}
    minus_core = {**full, "core_momentum": False}
    assert scoring.confluence_score(minus_core) < scoring.confluence_score(full) == 100.0


def test_confluence_string_flags_are_interpreted():
    # Arrange: CSV often yields "True"/"true" strings, not bools
    row = {"breakout_pass": "true", "ghost_accum_score": "80", "regime_ok": "True"}
    # Act / Assert: string flags counted
    assert scoring.confluence_score(row) > 0


def test_confluence_missing_regime_defaults_to_aligned():
    row = {"breakout_pass": True}
    # regime weight should be credited when regime_ok is absent
    assert scoring.confluence_score(row) == round(
        100.0 * (C.CONFLUENCE_WEIGHTS["breakout"] + C.CONFLUENCE_WEIGHTS["regime"])
        / sum(C.CONFLUENCE_WEIGHTS.values()), 1)


# --- options_boost ---------------------------------------------------------

def test_options_boost_caps_at_max():
    row = {"flow_type": "aggressive_bullish_call_sweep", "premium": 200000,
           "repeat_days": 5, "aggressive": True}
    assert scoring.options_boost(row) == C.OPTIONS_BOOST_MAX


def test_options_boost_zero_when_flow_missing():
    assert scoring.options_boost({"flow_type": float("nan")}) == 0.0
    assert scoring.options_boost({}) == 0.0


def test_put_sweep_gets_no_call_boost():
    row = {"flow_type": "put_sweep", "premium": 200000, "repeat_days": 5}
    assert scoring.options_boost(row) == 0.0


# --- catalyst_boost --------------------------------------------------------

def test_catalyst_boost_handles_nan_days_without_crashing():
    # Regression: int(nan or 999) raised ValueError in the original.
    row = {"catalyst_type": "fda_readout", "days_until": float("nan"),
           "catalyst_strength": 80}
    boost = scoring.catalyst_boost(row)
    assert boost >= 0.0 and not math.isnan(boost)


def test_catalyst_boost_zero_when_type_missing():
    assert scoring.catalyst_boost({"catalyst_type": float("nan")}) == 0.0


def test_imminent_fda_scores_higher_than_distant_earnings():
    imminent = {"catalyst_type": "fda_pdufa", "days_until": 5, "catalyst_strength": 90}
    distant = {"catalyst_type": "earnings", "days_until": 60, "catalyst_strength": 50}
    assert scoring.catalyst_boost(imminent) > scoring.catalyst_boost(distant)


# --- final_score -----------------------------------------------------------

def test_final_score_reaches_100_for_perfect_name():
    # Regression: original maxed at ~65 because boosts were not rescaled.
    assert scoring.final_score(100.0, C.OPTIONS_BOOST_MAX, C.CATALYST_BOOST_MAX) == 100.0


def test_final_score_blend_weights_are_honest():
    # With pure confluence and no boosts, final == confluence * 0.55
    assert scoring.final_score(100.0, 0.0, 0.0) == round(100.0 * C.BLEND_WEIGHTS["confluence"], 1)


# --- recommendation --------------------------------------------------------

def test_recommendation_monitor_when_nothing_fires():
    assert scoring.recommendation(10.0, 0.0, 0.0, True) == "Monitor - Moderate Setup"


def test_recommendation_stacks_reasons():
    rec = scoring.recommendation(80.0, 20.0, 12.0, True)
    assert "High Multi-Model Confluence" in rec
    assert "Strong Bullish Options Flow" in rec
    assert "High-Impact Imminent Catalyst" in rec


@pytest.mark.parametrize("value,expected", [
    (True, True), (False, False), (1, True), (0, False),
    ("yes", True), ("false", False), (None, False),
])
def test_truthy_interpretation(value, expected):
    assert scoring._truthy(value) is expected
