#!/usr/bin/env python3
"""Step 103 — VECTORBT PARITY CHECK ON THE PICK LEDGER (proposal #23, RESEARCH-ONLY).

Feeds vectorbt the persisted pick ledger (ticker, decision date, next-open fill, close exit
at 1/5/10/20 sessions) and compares every per-pick return and SPY-excess with the Scoreboard
harness's own numbers (lib/apex-routes nextOpenReturn / spyForwardReturn, exported by
research/lib/export-pbo-matrices.js into research/data/pick-ledger-export.json). The goal
is to catch PIT / fill / next-open bugs in the JS harness (the 2026-08 audit found six),
not to replace it.

    research/.venv/bin/python research/103-vbt-scoreboard-parity.py            # on the export
    research/.venv/bin/python research/103-vbt-scoreboard-parity.py --selftest # synthetic candles

Output: research/data-derived/vbt-parity.json — per-horizon max |Δ|, mismatch count and a
verdict ('parity' | 'mismatch' | 'not-computable'). Tolerance 0.011 pct-points: the JS side
rounds a pick's return to 2 dp before the excess is formed.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import sys
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "research" / "data"
EXPORT_FILE = DATA_DIR / "pick-ledger-export.json"
OUT_FILE = ROOT / "research" / "data-derived" / "vbt-parity.json"
VERSION = "vbt-parity-v1"
TOLERANCE_PP = 0.011          # JS rounds ret to 2 dp → ≤ 0.005 each side + float noise
HORIZONS = (1, 5, 10, 20)


def load_candles(cache_dir: pathlib.Path, ticker: str) -> pd.DataFrame | None:
    f = cache_dir / f"{ticker}.json"
    if not f.exists():
        return None
    rows = json.loads(f.read_text()).get("price") or []
    if not rows:
        return None
    df = pd.DataFrame(rows)[["date", "open", "close"]].dropna(subset=["close"]).sort_values("date").reset_index(drop=True)
    return df


def window_prices(df: pd.DataFrame, decision_date: str, bars: int) -> tuple[np.ndarray, np.ndarray] | None:
    """Open/close arrays for bars idx+1 … idx+bars (the JS harness's window), or None."""
    idx = int((df["date"] <= decision_date).sum()) - 1
    if idx < 0 or idx + bars >= len(df):
        return None
    w = df.iloc[idx + 1: idx + bars + 1]
    opens = w["open"].to_numpy(dtype=float)
    closes = w["close"].to_numpy(dtype=float)
    entry = opens[0] if np.isfinite(opens[0]) and opens[0] > 0 else closes[0]
    opens = opens.copy()
    opens[0] = entry
    if bars == 1:
        # Same-bar entry/exit cannot be expressed as two signals; use the two-point path
        # [entry open → exit close] so vectorbt still values the trade itself.
        return np.asarray([entry, entry]), np.asarray([entry, closes[0]])
    return opens, closes


def vbt_returns(windows: list[tuple[np.ndarray, np.ndarray]], shorts: list[bool], bars: int) -> np.ndarray:
    """One vectorbt portfolio per pick-window (columns), enter at the first open, exit at the
    last close; returns total return in % (sign-flipped for shorts like the JS harness)."""
    import vectorbt as vbt

    if not windows:
        return np.asarray([], dtype=float)
    close = pd.DataFrame(np.column_stack([c for _, c in windows]))
    price = pd.DataFrame(np.column_stack([o for o, _ in windows]))
    entries = pd.DataFrame(False, index=close.index, columns=close.columns)
    exits = entries.copy()
    entries.iloc[0, :] = True
    exits.iloc[-1, :] = True
    # price: the first row is the entry open; the last row must be the exit close.
    price.iloc[-1, :] = close.iloc[-1, :]
    pf = vbt.Portfolio.from_signals(close, entries, exits, price=price, fees=0.0, slippage=0.0, init_cash=100.0, freq="1D")
    tr = np.asarray(pf.total_return(), dtype=float) * 100.0
    sign = np.where(np.asarray(shorts, dtype=bool), -1.0, 1.0)
    return tr * sign


def parity_for_horizon(rows: list[dict], cache_dir: pathlib.Path, spy: pd.DataFrame, bars: int) -> dict:
    windows, shorts, js_ret, js_exc, spy_windows, labels = [], [], [], [], [], []
    missing = 0
    cache: dict[str, pd.DataFrame | None] = {}
    for r in rows:
        js = r["ret"].get(str(bars)) if isinstance(r["ret"], dict) else None
        if js is None:
            continue
        df = cache.setdefault(r["ticker"], load_candles(cache_dir, r["ticker"]))
        w = window_prices(df, r["date"], bars) if df is not None else None
        sw = window_prices(spy, r["date"], bars)
        if w is None or sw is None:
            missing += 1
            continue
        windows.append(w)
        spy_windows.append(sw)
        shorts.append(bool(r.get("short")))
        js_ret.append(float(js))
        js_exc.append(r["excess"].get(str(bars)))
        labels.append(f"{r['ticker']}@{r['date']}")
    if not windows:
        return {"bars": bars, "n": 0, "missing": missing, "verdict": "not-computable"}
    py_ret = vbt_returns(windows, shorts, bars)
    py_spy = vbt_returns(spy_windows, [False] * len(spy_windows), bars)
    d_ret = np.abs(py_ret - np.asarray(js_ret))
    exc_pairs = [(p - s, j) for p, s, j in zip(py_ret, py_spy, js_exc) if j is not None]
    d_exc = np.abs(np.asarray([p for p, _ in exc_pairs]) - np.asarray([j for _, j in exc_pairs])) if exc_pairs else np.asarray([])
    bad = [labels[i] for i in np.flatnonzero(d_ret > TOLERANCE_PP)][:25]
    return {
        "bars": bars, "n": len(windows), "missing": missing,
        "maxAbsDeltaReturnPP": float(d_ret.max()), "maxAbsDeltaExcessPP": float(d_exc.max()) if d_exc.size else None,
        "mismatches": int((d_ret > TOLERANCE_PP).sum()), "mismatchSample": bad,
        "beatRateJs": float(np.mean(np.asarray([j for _, j in exc_pairs]) > 0)) if exc_pairs else None,
        "beatRatePy": float(np.mean(np.asarray([p for p, _ in exc_pairs]) > 0)) if exc_pairs else None,
        "verdict": "parity" if not bad else "mismatch",
    }


def run(export_file: pathlib.Path, out_file: pathlib.Path) -> int:
    if not export_file.exists():
        doc = {"version": VERSION, "verdict": "not-computable", "reason": f"{export_file.relative_to(ROOT)} missing — run research/lib/export-pbo-matrices.js with BLOB access first"}
        out_file.parent.mkdir(parents=True, exist_ok=True)
        out_file.write_text(json.dumps(doc, indent=1) + "\n")
        print(json.dumps(doc, indent=1))
        return 0
    export = json.loads(export_file.read_text())
    cache_dir = pathlib.Path(export.get("cacheDir") or (DATA_DIR / "cache"))
    spy = load_candles(cache_dir, "SPY")
    if spy is None:
        print("SPY missing from the research cache", file=sys.stderr)
        return 2
    per = [parity_for_horizon(export["rows"], cache_dir, spy, h) for h in HORIZONS]
    verdicts = {p["verdict"] for p in per}
    doc = {"version": VERSION, "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tolerancePP": TOLERANCE_PP,
           "rows": len(export["rows"]), "perHorizon": per,
           "verdict": "mismatch" if "mismatch" in verdicts else ("parity" if "parity" in verdicts else "not-computable")}
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: doc[k] for k in ("verdict", "rows")} | {"perHorizon": [{k: p.get(k) for k in ("bars", "n", "maxAbsDeltaReturnPP", "mismatches")} for p in per]}, indent=1))
    return 0


# ── selftest: synthetic candles, JS formula re-derived in Python, vectorbt must agree ──
def _synthetic_candles(rng: np.random.Generator, n: int, start: str) -> pd.DataFrame:
    dates = pd.bdate_range(start, periods=n).strftime("%Y-%m-%d")
    close = 50 * np.exp(np.cumsum(rng.standard_normal(n) * 0.02))
    open_ = close * (1 + rng.standard_normal(n) * 0.005)
    return pd.DataFrame({"date": dates, "open": open_, "close": close})


def selftest() -> int:
    rng = np.random.default_rng(3)
    df = _synthetic_candles(rng, 120, "2024-01-01")
    picks = [(df["date"][i], i % 3 == 0) for i in range(5, 90, 7)]
    failures = []
    for bars in HORIZONS:
        windows, shorts, ref = [], [], []
        for d, short in picks:
            w = window_prices(df, d, bars)
            idx = int((df["date"] <= d).sum()) - 1
            entry = df["open"][idx + 1]
            r = (df["close"][idx + bars] - entry) / entry * 100
            windows.append(w)
            shorts.append(short)
            ref.append(-r if short else r)
        py = vbt_returns(windows, shorts, bars)
        d = np.abs(py - np.asarray(ref)).max()
        if d > 1e-6:
            failures.append(f"bars {bars}: max |vbt − formula| = {d}")
    # A decision date past the end of history must be unobservable, never a fabricated 0.
    if window_prices(df, "2030-01-01", 5) is not None:
        failures.append("window past history should be None")
    for f in failures:
        print("SELFTEST FAIL:", f)
    print(json.dumps({"selftest": "ok" if not failures else "fail", "picks": len(picks), "horizons": HORIZONS}))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--export", default=str(EXPORT_FILE))
    ap.add_argument("--out", default=str(OUT_FILE))
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    return run(pathlib.Path(args.export), pathlib.Path(args.out))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
