"""EXPERIMENT 01 — Validate the live Day Trade screener on real intraday execution.

The live screener (lib/daytrade.js) selects names on daily bars and reports a 1:2
stop/target plan, but its track record uses a DAILY-BAR forward-return proxy — it
cannot see whether the stop or the target was hit first intraday. This replays the
exact same point-in-time selection, then executes each pick on REAL 5-min bars with
intrabar stop/target ordering + realistic costs, and asks the honest question:

    Do the screener's picks actually achieve their stated edge when traded for real,
    or do intrabar stops leak the way the app's daily "exits" study warned?

No lookahead: a name is selected using daily data through day T's close, then entered
at the NEXT session's open and managed bar-by-bar.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import json
from datetime import datetime, timedelta

import pandas as pd
from tqdm import tqdm

from intraday import fmp
from intraday.daytrade import SCANS, day_metrics, passes_scan, rank_score, trade_levels
from intraday.execution import CostModel, simulate_long
from intraday.metrics import summarize
from config import BacktestConfig

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"


def _daterange_pad(start: str, days: int) -> str:
    return (datetime.strptime(start, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")


def _date_plus(end: str, days: int) -> str:
    return (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def run() -> None:
    daily_start = _daterange_pad(CFG.start, CFG.daily_lookback_days + 20)
    intra_end = _date_plus(CFG.end, 14)  # cover hold windows of late signals

    print("Loading SPY (for market-relative momentum)…")
    spy = fmp.daily("SPY", daily_start, CFG.end)
    spy_map = {c["date"]: c["close"] for c in spy}

    signals = []
    print(f"Scanning {len(CFG.universe)} names {CFG.start}→{CFG.end} for Day Trade picks…")
    for sym in tqdm(CFG.universe):
        try:
            dcandles = fmp.daily(sym, daily_start, CFG.end)
        except Exception as e:
            print(f"  ! {sym} daily failed: {e}")
            continue
        date_to_idx = {c["date"]: i for i, c in enumerate(dcandles)}
        last_signal_idx = -10_000
        for i, c in enumerate(dcandles):
            if not (CFG.start <= c["date"] <= CFG.end):
                continue
            if i - last_signal_idx < CFG.max_hold_sessions:   # no overlapping same-name trades
                continue
            m = day_metrics(dcandles[: i + 1], spy_map)
            if not m:
                continue
            for scan in SCANS.values():
                if passes_scan(m, scan):
                    lv = trade_levels(dcandles[: i + 1])
                    if lv:
                        signals.append(dict(symbol=sym, date=c["date"], scan=scan["key"],
                                            rank=rank_score(m), relVol=m["relVol"],
                                            pctChange=m["pctChange"], entry_plan=lv["entry"],
                                            stop=lv["stop"], target=lv["target"], rr=lv["rr"]))
                        last_signal_idx = i
                    break

    print(f"  {len(signals)} point-in-time Day Trade signals.")
    if not signals:
        print("No signals in window — widen universe/dates in config.py.")
        return

    # Execute each signal on real intraday bars.
    print("Fetching intraday bars + simulating intrabar execution…")
    intraday_cache: dict = {}
    results = []
    for s in tqdm(signals):
        sym = s["symbol"]
        if sym not in intraday_cache:
            try:
                bars = fmp.intraday(sym, CFG.interval, CFG.start, intra_end)
                intraday_cache[sym] = fmp.group_by_session(bars)
            except Exception as e:
                print(f"  ! {sym} intraday failed: {e}")
                intraday_cache[sym] = {}
        sessions = intraday_cache[sym]
        future = sorted(d for d in sessions if d > s["date"])[: CFG.max_hold_sessions]
        if not future:
            continue
        window = [b for d in future for b in sessions[d]]
        tr = simulate_long(window, s["entry_plan"], s["stop"], s["target"], COST, CFG.entry_mode)
        results.append((s, tr))

    rows = []
    for s, tr in results:
        rows.append({**s, "filled": tr.filled, "exit_reason": tr.exit_reason,
                     "entry": tr.entry_price, "exit": tr.exit_price, "bars_held": tr.bars_held,
                     "R": tr.r_multiple, "net_ret_pct": tr.net_return_pct})
    df = pd.DataFrame(rows)
    OUT.mkdir(exist_ok=True)
    df.to_csv(OUT / "daytrade_validation.csv", index=False)

    trs = [tr for _, tr in results]
    overall = summarize(trs)

    # Out-of-sample split by date (first half vs second half).
    dates = sorted(set(s["date"] for s, _ in results))
    mid = dates[len(dates) // 2] if dates else None
    is_trs = [tr for s, tr in results if s["date"] < mid]
    oos_trs = [tr for s, tr in results if s["date"] >= mid]
    by_scan = {k: summarize([tr for s, tr in results if s["scan"] == k]) for k in SCANS}

    report = {
        "config": dict(universe=len(CFG.universe), start=CFG.start, end=CFG.end,
                       interval=CFG.interval, max_hold_sessions=CFG.max_hold_sessions,
                       entry_mode=CFG.entry_mode, cost=vars(COST)),
        "signals": len(signals), "executed": len(results),
        "overall": overall,
        "by_scan": by_scan,
        "in_sample": summarize(is_trs), "out_of_sample": summarize(oos_trs),
    }
    (OUT / "daytrade_validation.json").write_text(json.dumps(report, indent=2))

    # Honest console verdict.
    print("\n" + "=" * 64)
    print("DAY TRADE SCREENER — REAL INTRADAY VALIDATION")
    print("=" * 64)
    print(f"Signals: {len(signals)}  |  executed: {len(results)}  |  "
          f"hold ≤{CFG.max_hold_sessions} sessions  |  entry: {CFG.entry_mode}")
    print(f"Costs: {COST.slippage_bps}bps slip/fill + {COST.commission_bps}bps comm/leg\n")

    def show(name, r):
        if not r.get("n"):
            print(f"{name:<16} (no trades)")
            return
        print(f"{name:<16} n={r['n']:<4} win={r['win_rate']}% (LB {r['win_rate_wilson_lb']}%)  "
              f"avgR={r['avg_R']}  exp={r['expectancy_pct']}%/trade  PF={r['profit_factor']}  "
              f"exits={r['exit_reasons']}")

    show("OVERALL", overall)
    for k in SCANS:
        show(k, by_scan[k])
    show("in-sample", report["in_sample"])
    show("out-of-sample", report["out_of_sample"])

    exp = overall.get("expectancy_pct", 0)
    lb = overall.get("win_rate_wilson_lb", 0)
    print("\nVERDICT:")
    if exp > 0 and lb >= 50:
        print(f"  Picks are net-positive after real intrabar stops + costs (exp {exp}%/trade, "
              f"win-rate LB {lb}%≥50). The screener's edge survives honest execution.")
    elif exp > 0:
        print(f"  Net-positive expectancy ({exp}%/trade) but win-rate floor {lb}%<50 — a "
              f"right-skewed, low-hit-rate profile (few runners carry it). Matches the "
              f"live screener's own daily-proxy finding; intrabar stops do not break it.")
    else:
        print(f"  Negative expectancy ({exp}%/trade) once intrabar stops + costs are modelled — "
              f"the daily-bar proxy was flattering. Evidence the stop placement leaks "
              f"(consistent with the app's exits study). Do NOT trust the stated 1:2 as achievable.")
    print(f"\nSaved: {OUT/'daytrade_validation.csv'} and .json")


if __name__ == "__main__":
    run()
