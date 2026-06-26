"""
Small/mid-cap momentum scorer — Phase-3 validated (Dr. Hale review, 2026-06).

TWO DEPLOYABLE FORMS
    1. BROAD  : sector-neutral 12-1 momentum on the full liquid small/mid universe.
                The low-regret refinement of the raw 12-1 baseline (Phase-3a).
    2. STABLE-CORE (recommended concentrated sleeve, Phase-3b): the SAME signal but run
                ONLY on the pocket where momentum demonstrably concentrates —
                  cap $800M-5B  AND  exclude the top realized-vol tercile  AND  ex-Healthcare.
                This was the single configuration that cleared every robustness gate:
                positive IR AND IC in all three sub-periods (including the 2022 bear),
                block-bootstrap t ~3.6 with a 95% CI excluding zero, on a ~115-name book.

WHY THESE FILTERS (economic intuition — each is an INDEPENDENT, monotone effect, not a
data-mined cut):
    * cap $800M-5B   : momentum is an inverted-U in size — dead in micro (noise) and in
                       larger small-caps (efficiency); strongest in the mid band.
    * exclude hi-vol : momentum is monotone-decreasing in realized vol; high-vol names have
                       noisy, crash-prone "momentum" that does not persist.
    * exclude Healthcare : biotech moves on binary FDA/trial events, not trend persistence —
                       it was the worst major sector (IR 0.14, max drawdown -34%).

REBALANCE DISCIPLINE (matters as much as the signal)
    * QUARTERLY rebalance. Monthly over-trades a slow signal (Sharpe 0.72 vs 0.92, deeper DD).
    * RANK BUFFER (hysteresis): enter a name when it is in the top 20% by score; only drop it
      when it falls out of the top 40%. Cuts turnover/whipsaw, lifts IR, trims drawdown, and
      makes the book robust to 30-100bps costs. See `apply_rank_buffer`.
    * Equal-weight the held book. (Inverse-vol WEIGHTING hurt; vol-scaling the SIGNAL is a
      separate, optional choice — see ScoreConfig.vol_scaled.)

BRUTAL HONESTY (read before sizing up)
    The three STABLE-CORE filters were chosen after inspecting the slice analysis on this same
    ~5-year sample, so the in-sample IR (1.5-1.8) is OPTIMISTIC from filter selection. Realistic
    FORWARD expectation is IR ~0.8-1.2. The strongest evidence it is real (not recovery-fitted)
    is that it WORKED in the 2022 bear — the regime least like the rest. No pristine hold-out
    remains. Confirm live for ~8 quarters before trusting the magnitude; revert to passive if
    rolling IR < ~0.5 or live IC goes negative two quarters running.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Sequence
import numpy as np
import pandas as pd

# ---- shared constants ----
ADV_FLOOR: float = 3e6        # min 20-day average dollar volume (liquidity floor)
TOP_QUANTILE: float = 0.20    # enter the top 20% by score
HOLD_QUANTILE: float = 0.40   # rank-buffer: hold until out of the top 40%
MOM_LOOKBACK: int = 252       # 12-month lookback (trading days)
MOM_SKIP: int = 21            # skip the most recent month ("12-1")
VOL_LOOKBACK: int = 63        # realized-vol window
HIVOL_TERCILE: float = 2 / 3  # drop names with vol above this within-cross-section quantile


@dataclass(frozen=True)
class ScoreConfig:
    # universe
    cap_lo: float = 300e6
    cap_hi: float = 10e9
    adv_floor: float = ADV_FLOOR
    exclude_sectors: Sequence[str] = field(default_factory=tuple)
    exclude_high_vol_tercile: bool = False
    # signal
    sector_neutral: bool = True
    vol_scaled: bool = False
    top_quantile: float = TOP_QUANTILE

    @classmethod
    def broad(cls) -> "ScoreConfig":
        """Phase-3a low-regret refinement: sector-neutral 12-1 on the full liquid universe."""
        return cls(sector_neutral=True)

    @classmethod
    def stable_core(cls) -> "ScoreConfig":
        """Phase-3b recommended concentrated sleeve."""
        return cls(cap_lo=800e6, cap_hi=5e9, exclude_sectors=("Healthcare",),
                   exclude_high_vol_tercile=True, sector_neutral=True)


def compute_momentum(closes: pd.DataFrame, lookback: int = MOM_LOOKBACK,
                     skip: int = MOM_SKIP) -> pd.Series:
    """12-1 momentum per symbol from a (dates x symbols) ascending close-price frame:
    close[-1-skip] / close[-1-lookback] - 1. NaN where history is insufficient."""
    if len(closes) < lookback + 1:
        return pd.Series(dtype=float)
    end, start = closes.iloc[-1 - skip], closes.iloc[-1 - lookback]
    return (end / start - 1.0).where((start > 0) & (end > 0))


def realized_vol(closes: pd.DataFrame, lookback: int = VOL_LOOKBACK) -> pd.Series:
    """Annualized realized vol per symbol (daily returns clipped +/-50% for split/tick safety)."""
    if len(closes) < lookback + 1:
        return pd.Series(dtype=float)
    return closes.iloc[-lookback:].pct_change().clip(-0.5, 0.5).std(ddof=1) * np.sqrt(252)


def build_score(cross_section: pd.DataFrame, cfg: ScoreConfig = ScoreConfig.broad()) -> pd.DataFrame:
    """Score ONE rebalance-date cross-section -> ranked, universe-filtered names with a `score`.

    cross_section: one row per symbol; required columns:
        symbol, sector, momentum, market_cap, adv   (+ vol if vol_scaled or excl-hi-vol)
    Returns ALL in-universe names with their `score` (descending). Selection into the book is
    done by `select_book` / `apply_rank_buffer` so the hysteresis can see the full ranking.
    """
    required = {"symbol", "sector", "momentum", "market_cap", "adv"}
    missing = required - set(cross_section.columns)
    if missing:
        raise ValueError(f"cross_section missing columns: {sorted(missing)}")
    need_vol = cfg.vol_scaled or cfg.exclude_high_vol_tercile
    if need_vol and "vol" not in cross_section.columns:
        raise ValueError("config needs a 'vol' column (vol_scaled / exclude_high_vol_tercile)")

    df = cross_section.copy()
    df = df[(df["market_cap"] >= cfg.cap_lo) & (df["market_cap"] <= cfg.cap_hi) &
            (df["adv"] >= cfg.adv_floor) & df["momentum"].notna()]
    if cfg.exclude_sectors:
        df = df[~df["sector"].isin(cfg.exclude_sectors)]
    if need_vol:
        df = df[df["vol"].notna() & (df["vol"] > 0)]
    if cfg.exclude_high_vol_tercile and not df.empty:
        df = df[df["vol"] <= df["vol"].quantile(HIVOL_TERCILE)]
    if df.empty:
        return df.assign(score=pd.Series(dtype=float))

    df["score"] = df["momentum"] / df["vol"] if cfg.vol_scaled else df["momentum"]
    if cfg.sector_neutral:  # subtract the within-sector median (no-op inside a single sector)
        df["score"] = df["score"] - df.groupby("sector")["score"].transform("median")
    return df.sort_values("score", ascending=False).reset_index(drop=True)


def select_book(scored: pd.DataFrame, top_quantile: float = TOP_QUANTILE) -> pd.DataFrame:
    """Plain top-quantile equal-weight book (no hysteresis)."""
    if scored.empty:
        return scored.assign(weight=pd.Series(dtype=float))
    cutoff = scored["score"].quantile(1.0 - top_quantile)
    book = scored[scored["score"] >= cutoff].copy()
    book["weight"] = 1.0 / len(book)
    return book.reset_index(drop=True)


def apply_rank_buffer(scored: pd.DataFrame, held: set[str],
                      enter_q: float = TOP_QUANTILE, hold_q: float = HOLD_QUANTILE) -> pd.DataFrame:
    """Hysteresis selection (RECOMMENDED): keep currently-held names while they remain in the
    top `hold_q`; add any name in the top `enter_q`. Equal-weight the result. Returns the book
    with a `weight` column; pass `set(book.symbol)` back in as `held` next rebalance."""
    if scored.empty:
        return scored.assign(weight=pd.Series(dtype=float))
    enter_cut = scored["score"].quantile(1.0 - enter_q)
    hold_cut = scored["score"].quantile(1.0 - hold_q)
    keep = (scored["score"] >= enter_cut) | (scored["symbol"].isin(held) & (scored["score"] >= hold_cut))
    book = scored[keep].copy()
    if book.empty:
        return book.assign(weight=pd.Series(dtype=float))
    book["weight"] = 1.0 / len(book)
    return book.reset_index(drop=True)


# --------------------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(0)
    n = 1200
    cs = pd.DataFrame({
        "symbol": [f"S{i}" for i in range(n)],
        "sector": rng.choice(["Financial Services", "Healthcare", "Technology", "Industrials"], n),
        "momentum": rng.normal(0.1, 0.4, n),
        "vol": np.abs(rng.normal(0.5, 0.2, n)) + 0.05,
        "market_cap": rng.uniform(2e8, 1.2e10, n),
        "adv": rng.uniform(1e6, 5e7, n),
    })
    for label, cfg in (("broad", ScoreConfig.broad()), ("stable_core", ScoreConfig.stable_core())):
        scored = build_score(cs, cfg)
        plain = select_book(scored, cfg.top_quantile)
        buffered = apply_rank_buffer(scored, held=set())
        print(f"{label:12s}: universe {len(scored):4d} -> book {len(plain):3d} "
              f"(buffer {len(buffered):3d}); sectors {plain['sector'].nunique()}")
