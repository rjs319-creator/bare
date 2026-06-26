"""Integration tests for the ranker + loader (AAA pattern)."""

import pandas as pd
import pytest

from pipeline import loader, ranker, sample_data


def test_rank_does_not_mutate_input():
    # Arrange
    stocks, _, _ = sample_data.build_frames()
    before = stocks.copy(deep=True)
    # Act
    ranker.rank(stocks)
    # Assert: immutability — input frame untouched
    pd.testing.assert_frame_equal(stocks, before)


def test_rank_orders_by_final_score_desc():
    stocks, _, _ = sample_data.build_frames()
    ranked = ranker.rank(stocks)
    scores = ranked["final_score"].tolist()
    assert scores == sorted(scores, reverse=True)
    assert ranked["rank"].tolist() == list(range(1, len(ranked) + 1))


def test_top_tier_is_differentiated_not_saturated():
    # The whole point of the confluence fix: strong names must not tie at 100.
    stocks, options, catalysts = sample_data.build_frames()
    ranked = ranker.rank(stocks)
    top5 = ranked["confluence_score"].head(5).tolist()
    assert len(set(top5)) > 1, "top-tier confluence scores should be differentiated"


def test_regime_gate_pushes_risk_off_below_aligned():
    # Arrange: a high-scoring risk-off name vs a mediocre risk-on name
    stocks = pd.DataFrame({
        "ticker": ["RISKOFF", "RISKON"],
        "breakout_pass": [True, False],
        "ghost_accum_score": [95, 10],
        "opportunities_score": [95, 10],
        "core_momentum": [True, False],
        "adaptive_momentum": [True, False],
        "regime_ok": [False, True],
    })
    # Act
    gated = ranker.rank(stocks, regime_gate=True)
    # Assert: the risk-off name is ranked last despite a higher raw score
    assert gated.iloc[-1]["ticker"] == "RISKOFF"
    assert "RISK-OFF (gated)" in gated.iloc[-1]["recommendation"]


def test_missing_optional_feeds_degrade_gracefully(tmp_path):
    # Arrange: only a stocks file, no options/catalysts
    stocks, _, _ = sample_data.build_frames()
    path = tmp_path / "stocks.csv"
    stocks.to_csv(path, index=False)
    # Act
    df = loader.load_stocks(str(path))
    df = loader.merge_optional(df, None, "options")
    ranked = ranker.rank(df)
    # Assert: still ranks everything, boosts simply zero
    assert len(ranked) == len(stocks)
    assert (ranked["options_boost"] == 0).all()


def test_loader_rejects_missing_ticker_column(tmp_path):
    path = tmp_path / "bad.csv"
    pd.DataFrame({"symbol": ["AAPL"]}).to_csv(path, index=False)
    with pytest.raises(loader.ScreenerInputError):
        loader.load_stocks(str(path))
