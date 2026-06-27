"""EXPERIMENT 02 — A/B test exit/stop policies on the Day Trade picks.

Same point-in-time selection as Experiment 01; the only thing that varies is the EXIT
rule. The app's own "exits" study (on longer horizons) found tight structure stops are
a LEAK — they whipsaw you out before the move plays out — and that a no-tight-stop,
time-based exit did better. This tests that hypothesis on the intraday day-trade
horizon, head-to-head, on identical signals and identical bars.

Policies:
  tight_1:2        baseline — structure stop (~1.5*ATR / today-low), 1:2 target
  wide_2.5ATR      stop 2.5*ATR below entry, 1:2 target (target scales with risk)
  wide_4ATR        stop 4*ATR below entry, 1:2 target
  no_stop_time     NO stop, NO target — hold to the end of the window (the exits-study idea)
  no_stop_2ATR     NO stop, target = entry + 2*ATR (let winners hit a target, never stop out)

Honest comparison: overall + out-of-sample + by-year, because aggregate numbers in
this app are repeatedly early-window artifacts.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import json

from tqdm import tqdm

from intraday import fmp  # noqa: F401 (ensures cache path import side effects)
from intraday.daytrade import SCANS
from intraday.execution import CostModel, simulate_long
from intraday.metrics import summarize
from intraday.pipeline import generate_signals, hold_window_bars
from config import BacktestConfig

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"


def variants(sig: dict) -> "dict[str, tuple]":
    """Return {variant_name: (stop, target)} price levels for one signal."""
    e, a = sig["entry_close"], sig["atr"]
    def wide(k):
        stop = e - k * a
        return (stop, e + 2 * (e - stop))      # keep 1:2 reward:risk
    return {
        "tight_1:2":   (sig["base_stop"], sig["base_target"]),
        "wide_2.5ATR": wide(2.5),
        "wide_4ATR":   wide(4.0),
        "no_stop_time": (None, None),
        "no_stop_2ATR": (None, e + 2 * a),
    }


def run() -> None:
    print(f"Generating signals ({len(CFG.universe)} names, {CFG.start}→{CFG.end})…")
    signals = generate_signals(CFG)
    print(f"  {len(signals)} signals.")
    if not signals:
        return

    names = list(variants(signals[0]).keys())
    results = {v: [] for v in names}          # variant -> list[(signal, TradeResult)]

    print("Simulating all exit policies on identical bars…")
    for s in tqdm(signals):
        window = hold_window_bars(CFG, s)
        if not window:
            continue
        for v, (stop, target) in variants(s).items():
            tr = simulate_long(window, s["entry_close"], stop, target, COST, CFG.entry_mode)
            results[v].append((s, tr))

    # Common out-of-sample split (same mid-date for every variant -> comparable).
    all_dates = sorted(set(s["date"] for s, _ in results[names[0]]))
    mid = all_dates[len(all_dates) // 2]
    years = sorted(set(d[:4] for d in all_dates))

    report = {"config": dict(universe=len(CFG.universe), start=CFG.start, end=CFG.end,
                             hold=CFG.max_hold_sessions, entry=CFG.entry_mode, cost=vars(COST)),
              "split_at": mid, "variants": {}}

    print("\n" + "=" * 92)
    print("EXIT-POLICY A/B  —  Day Trade picks, identical signals & bars  (net of costs)")
    print("=" * 92)
    hdr = f"{'policy':<14}{'n':>5}{'win%':>7}{'LB':>6}{'exp%/trd':>10}{'PF':>6}{'OOS exp%':>10}{'yrs+':>6}"
    print(hdr); print("-" * len(hdr))

    for v in names:
        trs = [tr for _, tr in results[v]]
        ov = summarize(trs)
        oos = summarize([tr for s, tr in results[v] if s["date"] >= mid])
        byyr = {y: summarize([tr for s, tr in results[v] if s["date"][:4] == y]) for y in years}
        pos_yrs = sum(1 for y in years if byyr[y].get("expectancy_pct", 0) > 0)
        report["variants"][v] = {"overall": ov, "out_of_sample": oos, "by_year": byyr,
                                 "pos_years": pos_yrs, "n_years": len(years)}
        print(f"{v:<14}{ov.get('n',0):>5}{ov.get('win_rate',0):>7}{ov.get('win_rate_wilson_lb',0):>6}"
              f"{ov.get('expectancy_pct',0):>10}{ov.get('profit_factor',0):>6}"
              f"{oos.get('expectancy_pct',0):>10}{pos_yrs:>5}/{len(years)}")

    (OUT / "stop_variants.json").write_text(json.dumps(report, indent=2))

    # Winner = best OUT-OF-SAMPLE expectancy that is also positive (durability bar).
    ranked = sorted(names, key=lambda v: report["variants"][v]["out_of_sample"].get("expectancy_pct", -9),
                    reverse=True)
    best = ranked[0]
    bo = report["variants"][best]
    base_oos = report["variants"]["tight_1:2"]["out_of_sample"].get("expectancy_pct", 0)
    best_oos = bo["out_of_sample"].get("expectancy_pct", 0)

    print("\nVERDICT:")
    if best_oos <= 0:
        print(f"  No exit policy is durable: even the best ({best}) is OOS {best_oos}%/trade ≤ 0. "
              f"Loosening/removing the stop changes the path but does NOT manufacture a "
              f"regime-robust edge — the signal itself is the limit, not the exit. Consistent "
              f"with the whole project: the lever is WHEN you trade (regime), not the stop.")
    else:
        delta = round(best_oos - base_oos, 3)
        better = "BEATS" if delta > 0 else "matches"
        print(f"  Best out-of-sample policy: {best} (OOS {best_oos}%/trade, "
              f"{bo['pos_years']}/{bo['n_years']} years positive) — {better} the tight-stop "
              f"baseline (OOS {base_oos}%) by {delta} pts. "
              + ("Supports the exits-study finding that the tight stop leaks."
                 if best != 'tight_1:2' and delta > 0 else
                 "But confirm with more data before trusting it."))
    print(f"\nSaved: {OUT/'stop_variants.json'}")


if __name__ == "__main__":
    run()
