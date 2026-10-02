"""
102 — Offline factor-alpha cross-check for the Scoreboard (proposal #18).

Independent oracle for lib/factors/factor-alpha.js: the SAME question ("does a lane's
cost-net forward return survive a Fama-French 5 + momentum adjustment?") asked with
battle-tested Python libraries instead of the in-house ridge/HAC code.

    1. alphalens-reloaded  — IC decay / quantile forward returns of a per-pick SCORE
                             (Session Board grade or screener score) against forward returns.
    2. linearmodels        — Fama-MacBeth (per-date cross-sectional regressions on true FF
                             betas) and a pooled time-series OLS with Newey-West (HAC) SE of the
                             lane's date-level return on the factor window returns — the direct
                             analogue of alphaFF.
    3. parity              — recompute alphaFF per lane × horizon with plain statsmodels ridge/
                             OLS + HAC and compare with the persisted `factorAlpha` block.

INPUTS (all local files; nothing is fetched by default — the French zips are pulled only
with --fetch-ff):
    --picks   JSON export of graded Scoreboard rows:
              [{"lane": "section:tier:scope", "date": "YYYY-MM-DD", "ticker": "...",
                "horizon": "5d", "bars": 5, "net": 1.23, "score": 71.0}, ...]
              (op=scoreboard does not export rows — see README for the one-off exporter.)
    --prices  directory of per-ticker daily CSVs (date,open,high,low,close) — the research
              price cache (research/data/prices/<TICKER>.csv) or any equivalent.
    --ff      factors/ff5mom-daily.json (the Blob cache doc) OR the two Dartmouth CSVs.
    --summary scoreboard/summary.json (for the parity step; optional).

OUTPUT: research/data/evidence/factor-alpha/<run-id>.json + a Markdown table on stdout.

Everything here is RESEARCH-ONLY. It writes no Blob, touches no live score, and its verdict
is an oracle for the shadow block — not a promotion input (registry row
factor-adjusted-scoreboard-alpha, sealed until 2027-04-02).
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd

FF_KEYS = ["mktRf", "smb", "hml", "rmw", "cma", "mom"]
FF_URLS = {
    "ff5": "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Research_Data_5_Factors_2x3_daily_CSV.zip",
    "mom": "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Momentum_Factor_daily_CSV.zip",
}
COLUMN_MAP = {"Mkt-RF": "mktRf", "SMB": "smb", "HML": "hml", "RMW": "rmw", "CMA": "cma", "RF": "rf", "Mom": "mom"}
MIN_DATES = 60          # frozen with the registry row — do not loosen here
FDR_Q = 0.10
MISSING = {-99.99, -999.0}


# ── Fama-French loading (mirrors lib/factors/ken-french.js) ──────────────────────────────
def parse_french_csv(text: str) -> pd.DataFrame:
    lines = text.splitlines()
    header = next(i for i, l in enumerate(lines) if l.lstrip().startswith(",") and any(c.isalpha() for c in l))
    rows = []
    for line in lines[header + 1:]:
        if not line.strip():
            break
        cells = [c.strip() for c in line.split(",")]
        rows.append(cells)
    cols = [COLUMN_MAP.get(c.strip(), c.strip()) for c in lines[header].split(",")[1:]]
    df = pd.DataFrame([r[1:] for r in rows], columns=cols, dtype=float)
    df.index = pd.to_datetime([r[0] for r in rows], format="%Y%m%d")
    return df.where(~df.isin(MISSING))


def load_ff(path_or_none: str | None, fetch: bool) -> pd.DataFrame:
    """Daily FF5 + MOM + RF in percent, indexed by date."""
    if path_or_none and path_or_none.endswith(".json"):
        doc = json.loads(Path(path_or_none).read_text())
        df = pd.DataFrame([r[1:] for r in doc["rows"]], columns=doc["factors"], dtype=float)
        df.index = pd.to_datetime([r[0] for r in doc["rows"]])
        return df
    if not fetch:
        sys.exit("need --ff <factors/ff5mom-daily.json> or --fetch-ff")
    import urllib.request
    frames = []
    for key, url in FF_URLS.items():
        with urllib.request.urlopen(url, timeout=30) as r:  # noqa: S310 — fixed, documented URLs
            z = zipfile.ZipFile(io.BytesIO(r.read()))
        frames.append(parse_french_csv(z.read(z.namelist()[0]).decode("latin1")))
    return frames[0].join(frames[1], how="inner")


def factor_window_returns(ff: pd.DataFrame, date: pd.Timestamp, bars: int) -> pd.Series | None:
    """Compounded factor return (%) over the `bars` sessions after `date` (close→close)."""
    pos = ff.index.searchsorted(date, side="right") - 1
    if pos < 0 or pos + bars >= len(ff):
        return None
    win = ff.iloc[pos + 1: pos + bars + 1]
    return ((1 + win / 100).prod() - 1) * 100


# ── Prices → forward returns for alphalens ──────────────────────────────────────────────
def load_prices(prices_dir: Path, tickers: Iterable[str]) -> pd.DataFrame:
    closes = {}
    for t in sorted(set(tickers)):
        f = prices_dir / f"{t}.csv"
        if not f.exists():
            continue
        df = pd.read_csv(f, parse_dates=["date"]).set_index("date").sort_index()
        closes[t] = df["close"]
    return pd.DataFrame(closes)


# ── Step 1: alphalens tearsheet numbers ─────────────────────────────────────────────────
def alphalens_ic(picks: pd.DataFrame, prices: pd.DataFrame, periods=(1, 5, 10, 21)) -> dict:
    import alphalens as al

    factor = picks.dropna(subset=["score"]).set_index(["date", "ticker"])["score"]
    factor = factor[~factor.index.duplicated()]
    data = al.utils.get_clean_factor_and_forward_returns(factor, prices, periods=periods, quantiles=5, max_loss=0.6)
    ic = al.performance.factor_information_coefficient(data)
    mean_ic = ic.mean()
    t_ic = ic.mean() / ic.std() * np.sqrt(len(ic))
    q_ret, _ = al.performance.mean_return_by_quantile(data, by_date=False)
    spread = q_ret.loc[5] - q_ret.loc[1]
    return {
        "nObs": int(len(data)),
        "meanIC": {str(k): float(v) for k, v in mean_ic.items()},
        "tIC": {str(k): float(v) for k, v in t_ic.items()},
        "topMinusBottomQuintile": {str(k): float(v) for k, v in spread.items()},
    }


# ── Step 2: Fama-MacBeth on true FF betas ───────────────────────────────────────────────
def rolling_betas(prices: pd.DataFrame, ff: pd.DataFrame, window: int = 252) -> pd.DataFrame:
    """Per (date, ticker) trailing-window OLS betas on FF5+MOM; point-in-time (window ends at date)."""
    import statsmodels.api as sm

    rets = prices.pct_change() * 100
    rows = []
    X = sm.add_constant(ff[FF_KEYS])
    for t in rets.columns:
        y = (rets[t] - ff["rf"]).dropna()
        idx = y.index.intersection(X.index)
        y, Xt = y.loc[idx], X.loc[idx]
        for end in range(window, len(idx), 21):
            fit = sm.OLS(y.iloc[end - window:end], Xt.iloc[end - window:end]).fit()
            rows.append({"date": idx[end - 1], "ticker": t, **{k: fit.params[k] for k in FF_KEYS}})
    return pd.DataFrame(rows).set_index(["date", "ticker"])


def fama_macbeth(picks: pd.DataFrame, betas: pd.DataFrame, horizon: str) -> dict:
    from linearmodels import FamaMacBeth

    sub = picks[picks["horizon"] == horizon].copy()
    sub["date"] = pd.to_datetime(sub["date"])
    # as-of join: the newest beta estimate at or before the decision date
    sub = sub.sort_values("date")
    b = betas.reset_index().sort_values("date")
    merged = pd.merge_asof(sub, b, on="date", by="ticker", direction="backward").dropna(subset=FF_KEYS + ["net"])
    if merged["date"].nunique() < MIN_DATES:
        return {"horizon": horizon, "insufficient": True, "dates": int(merged["date"].nunique())}
    panel = merged.set_index(["ticker", "date"])
    y = panel["net"]
    X = panel[FF_KEYS].assign(const=1.0)
    res = FamaMacBeth(y, X).fit(cov_type="kernel")   # Newey-West across the per-date estimates
    return {
        "horizon": horizon, "dates": int(merged["date"].nunique()), "picks": int(len(merged)),
        "alpha": float(res.params["const"]), "alphaT": float(res.tstats["const"]), "alphaP": float(res.pvalues["const"]),
        "lambdas": {k: float(res.params[k]) for k in FF_KEYS},
    }


# ── Step 3: lane × horizon alphaFF with statsmodels (parity with lib/factors/factor-alpha.js) ──
@dataclass(frozen=True)
class Cell:
    lane: str
    horizon: str
    n: int
    alpha: float | None
    se: float | None
    t: float | None
    p: float | None


def lane_alpha(picks: pd.DataFrame, ff: pd.DataFrame) -> list[Cell]:
    import statsmodels.api as sm

    out: list[Cell] = []
    picks = picks.assign(date=pd.to_datetime(picks["date"]))
    for (lane, hk), grp in picks.groupby(["lane", "horizon"]):
        bars = int(grp["bars"].iloc[0])
        rows = []
        for d, day in grp.groupby("date"):
            fx = factor_window_returns(ff, d, bars)
            if fx is None or fx[FF_KEYS].isna().any():
                continue
            rows.append({"date": d, "y": day["net"].mean() - fx["rf"], **{k: fx[k] for k in FF_KEYS}})
        df = pd.DataFrame(rows)
        if len(df) < MIN_DATES:
            out.append(Cell(lane, hk, len(df), None, None, None, None))
            continue
        X = sm.add_constant(df[FF_KEYS])
        # ridge-shrunk point estimate (λ on standardised factors, intercept unpenalised) + HAC on the residuals
        Xs = X.copy()
        sd = Xs[FF_KEYS].std(ddof=0).replace(0, np.nan)
        Xs[FF_KEYS] = (Xs[FF_KEYS] - Xs[FF_KEYS].mean()) / sd
        fit = sm.OLS(df["y"], Xs).fit_regularized(alpha=1.0 / len(df), L1_wt=0.0)
        resid = df["y"] - Xs @ fit.params
        hac = sm.OLS(resid + Xs @ fit.params, Xs).fit(cov_type="HAC", cov_kwds={"maxlags": max(1, bars - 1)})
        alpha = float(fit.params["const"] - np.sum(fit.params[FF_KEYS] * X[FF_KEYS].mean() / sd))
        se = float(hac.bse["const"])
        t = alpha / se if se > 0 else float("nan")
        from scipy import stats
        p = float(2 * stats.t.sf(abs(t), df=len(df) - len(FF_KEYS) - 1))
        out.append(Cell(lane, hk, len(df), alpha, se, t, p))
    return out


def bh(cells: list[Cell]) -> dict[tuple[str, str], float]:
    valid = [c for c in cells if c.p is not None and np.isfinite(c.p)]
    valid.sort(key=lambda c: c.p)
    n, q, running = len(valid), {}, 1.0
    for i in range(n - 1, -1, -1):
        running = min(running, valid[i].p * n / (i + 1))
        q[(valid[i].lane, valid[i].horizon)] = min(1.0, running)
    return q


def compare_with_summary(cells: list[Cell], summary_path: Path | None) -> dict:
    if not summary_path or not summary_path.exists():
        return {"compared": 0, "note": "no summary.json supplied — parity step skipped"}
    block = json.loads(summary_path.read_text()).get("factorAlpha") or {}
    diffs = []
    for c in cells:
        js = (block.get("groups", {}).get(c.lane) or {}).get(c.horizon)
        if not js or js.get("insufficient") or c.alpha is None or js.get("source") != "ff":
            continue
        diffs.append({"lane": c.lane, "horizon": c.horizon, "alphaPy": c.alpha, "alphaJs": js["exact"]["alpha"], "tPy": c.t, "tJs": js["exact"]["t"]})
    max_alpha_gap = max((abs(d["alphaPy"] - d["alphaJs"]) for d in diffs), default=None)
    return {"compared": len(diffs), "maxAlphaGapPct": max_alpha_gap, "rows": diffs}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--picks", required=True, help="JSON export of graded Scoreboard rows (see README)")
    ap.add_argument("--prices", help="directory of per-ticker daily CSVs (for alphalens + Fama-MacBeth)")
    ap.add_argument("--ff", help="factors/ff5mom-daily.json cache doc")
    ap.add_argument("--fetch-ff", action="store_true", help="pull the two Dartmouth zips instead of --ff")
    ap.add_argument("--summary", help="scoreboard/summary.json for the parity check")
    ap.add_argument("--out", default="research/data/evidence/factor-alpha")
    args = ap.parse_args()

    picks = pd.DataFrame(json.loads(Path(args.picks).read_text()))
    required = {"lane", "date", "ticker", "horizon", "bars", "net"}
    missing = required - set(picks.columns)
    if missing:
        sys.exit(f"picks export lacks columns: {sorted(missing)}")
    ff = load_ff(args.ff, args.fetch_ff)

    cells = lane_alpha(picks, ff)
    q = bh(cells)
    result = {
        "version": "research-102-factor-alpha-v1",
        "ffLastDate": str(ff.index.max().date()),
        "minDates": MIN_DATES, "fdrQ": FDR_Q,
        "cells": [
            {**c.__dict__, "q": q.get((c.lane, c.horizon)), "passes": (c.alpha is not None and c.alpha >= 0 and q.get((c.lane, c.horizon), 1) <= FDR_Q)}
            for c in cells
        ],
        "parity": compare_with_summary(cells, Path(args.summary) if args.summary else None),
    }
    if args.prices:
        prices = load_prices(Path(args.prices), picks["ticker"])
        if "score" in picks.columns and not prices.empty:
            result["alphalens"] = alphalens_ic(picks, prices)
        if not prices.empty:
            betas = rolling_betas(prices, ff)
            result["famaMacBeth"] = [fama_macbeth(picks, betas, hk) for hk in sorted(picks["horizon"].unique())]
    else:
        result["note"] = "no --prices: alphalens and Fama-MacBeth steps skipped (lane alphaFF only)"

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    run_id = pd.Timestamp.utcnow().strftime("%Y%m%dT%H%M%SZ")
    (out_dir / f"{run_id}.json").write_text(json.dumps(result, indent=2, default=str))

    fitted = [c for c in result["cells"] if c["alpha"] is not None]
    print(f"# factor-alpha cross-check {run_id} — FF through {result['ffLastDate']}")
    print(f"cells {len(cells)} · fitted (≥{MIN_DATES} dates) {len(fitted)} · pass gate {sum(c['passes'] for c in fitted)}")
    print("| lane | horizon | dates | alphaFF % | t | q |")
    print("|---|---|---|---|---|---|")
    for c in sorted(fitted, key=lambda c: c["q"] if c["q"] is not None else 1):
        print(f"| {c['lane']} | {c['horizon']} | {c['n']} | {c['alpha']:+.2f} | {c['t']:.2f} | {c['q']:.3f} |")
    print(f"\nparity: {result['parity'].get('compared')} cells compared, max |Δalpha| {result['parity'].get('maxAlphaGapPct')}")


if __name__ == "__main__":
    main()
