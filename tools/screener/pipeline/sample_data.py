"""Deterministic sample data for demo / tests."""

from __future__ import annotations

from pathlib import Path
from typing import Tuple

import pandas as pd


def build_frames() -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    stocks = pd.DataFrame({
        "ticker": ["CRSP", "EDIT", "PATH", "ACHR", "RXRX", "SOUN", "TEM", "VKTX",
                   "SMCI", "ARM", "IONQ", "RKLB", "ASTS", "PLTR", "COIN", "MSTR",
                   "XBI", "IBB", "QQQ", "SPY"],
        "breakout_pass": [True, True, False, True, True, False, True, True,
                          False, False, True, True, False, False, True, False,
                          False, False, False, False],
        "ghost_accum_score": [85, 78, 45, 92, 88, 55, 70, 95, 40, 30, 82, 75, 60, 50, 68, 35, 25, 20, 15, 10],
        "opportunities_score": [75, 82, 50, 88, 79, 48, 65, 90, 35, 25, 70, 68, 55, 45, 60, 30, 20, 18, 12, 8],
        "core_momentum": [False, True, True, False, True, True, False, True,
                          True, True, False, False, False, True, True, True,
                          False, False, True, True],
        "adaptive_momentum": [True, True, False, True, True, False, True, True,
                              False, True, True, True, False, False, True, False,
                              False, False, True, True],
        "regime_ok": [True] * 16 + [False, False, True, True],
    })
    options = pd.DataFrame({
        "ticker": ["CRSP", "EDIT", "ACHR", "VKTX", "ASTS", "PLTR", "COIN", "RXRX", "TEM"],
        "flow_type": ["bullish_call_sweep", "call_block", "bullish_call_sweep",
                      "aggressive_call_sweep", "call_sweep", "bullish_call_block",
                      "call_sweep", "put_sweep", "bullish_call_sweep"],
        "premium": [125000, 87500, 210000, 95000, 45000, 150000, 78000, 32000, 68000],
        "repeat_days": [3, 1, 4, 2, 1, 2, 1, 0, 2],
        "aggressive": [True, True, True, True, False, True, False, False, True],
    })
    catalysts = pd.DataFrame({
        "ticker": ["CRSP", "VKTX", "EDIT", "ACHR", "RXRX", "ASTS", "TEM"],
        "catalyst_type": ["fda_readout", "phase_2_data", "clinical_trial_update",
                          "partnership", "earnings", "fda_pdufa", "acquisition_rumor"],
        "days_until": [5, 12, 8, 25, 3, 18, 40],
        "catalyst_strength": [90, 75, 82, 65, 70, 85, 55],
    })
    return stocks, options, catalysts


def write_sample_files(output_dir: Path) -> Tuple[str, str, str]:
    stocks, options, catalysts = build_frames()
    paths = (
        output_dir / "sample_stocks.csv",
        output_dir / "sample_options_flow.csv",
        output_dir / "sample_catalysts.csv",
    )
    for frame, path in zip((stocks, options, catalysts), paths):
        frame.to_csv(path, index=False)
    return tuple(str(p) for p in paths)
