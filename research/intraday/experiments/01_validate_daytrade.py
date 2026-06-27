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

    # Execute each signal on real intraday bars. Fetch only each signal's short hold
    # window (FMP intraday is cached per-month, so adjacent signals reuse downloads) —
    # far cheaper than pulling 3.5yr of 5-min bars per name.
    print("Fetching intraday bars + simulating intrabar execution…")
    results = []
    for s in tqdm(signals):
        try:
            bars = fmp.intraday(s["symbol"], CFG.interval, s["date"], _date_plus(s["date"], 10))
        except Exception as e:
            print(f"  ! {s['symbol']} intraday failed: {e}")
            continue
        sessions = fmp.group_by_session(bars)
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
    years = sorted(set(s["date"][:4] for s, _ in results))
    by_year = {y: summarize([tr for s, tr in results if s["date"][:4] == y]) for y in years}

    report = {
        "config": dict(universe=len(CFG.universe), start=CFG.start, end=CFG.end,
                       interval=CFG.interval, max_hold_sessions=CFG.max_hold_sessions,
                       entry_mode=CFG.entry_mode, cost=vars(COST)),
        "signals": len(signals), "executed": len(results),
        "overall": overall,
        "by_scan": by_scan,
        "by_year": by_year,
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
    print("  — by year (regime check) —")
    for y in years:
        show(y, by_year[y])
    show("in-sample", report["in_sample"])
    show("out-of-sample", report["out_of_sample"])

    exp = overall.get("expectancy_pct", 0)
    lb = overall.get("win_rate_wilson_lb", 0)
    oos_exp = report["out_of_sample"].get("expectancy_pct", 0)
    pos_years = sum(1 for y in years if by_year[y].get("expectancy_pct", 0) > 0)
    print("\nVERDICT:")
    if exp > 0 and oos_exp > 0 and lb >= 50:
        print(f"  Durable: net-positive in aggregate AND out-of-sample (exp {exp}%/trade, "
              f"OOS {oos_exp}%/trade, win-rate LB {lb}%≥50) — the edge survives honest "
              f"intrabar execution across regimes.")
    elif exp > 0 and (oos_exp <= 0 or pos_years <= len(years) // 2):
        print(f"  NOT durable: aggregate is +{exp}%/trade but out-of-sample is {oos_exp}%/trade "
              f"and only {pos_years}/{len(years)} years are positive — the edge is an early-window "
              f"(regime) ARTIFACT that inverts out-of-sample. No regime-robust intraday edge; the "
              f"screener is a regime-dependent movers watchlist, not a tradeable system "
              f"(same pattern as the project's exits / PEAD / conviction findings).")
    elif exp > 0:
        print(f"  Marginal: net-positive ({exp}%/trade, OOS {oos_exp}%/trade) but win-rate floor "
              f"{lb}%<50 — a thin, right-skewed low-hit-rate profile, not a confident edge.")
    else:
        print(f"  Negative expectancy ({exp}%/trade) once intrabar stops + costs are modelled — "
              f"the daily-bar proxy was flattering and the stop placement leaks "
              f"(consistent with the app's exits study). The stated 1:2 is not achievable as-is.")
    print(f"\nSaved: {OUT/'daytrade_validation.csv'} and .json")


if __name__ == "__main__":
    run()
