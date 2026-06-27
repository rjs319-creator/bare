"""EXPERIMENT 04 — Intraday entry timing (the rig's unique lever).

The diagnosis from exps 01–03: the signal isn't rescued by window, exit, or regime —
and we currently enter at the next session's OPEN, i.e. we BUY THE GAP (often the worst
fill). The daily harness literally cannot test alternatives; this rig can. We hold the
selection and the exit (baseline tight 1:2) fixed and vary ONLY the entry rule:

  next_open   market order at T+1 open (baseline — buys the gap)
  orb_30      wait 30 min; enter only on an opening-range-high breakout (confirmation)
  vwap_pull   buy the first pullback to intraday VWAP (better price)
  hold_30     enter at the 30-min mark only if still green vs the open (continuation)

Selective rules don't fill every day — fill rate is reported, because a pickier entry
that skips bad days can beat a fill-everything one. Judged on OOS + by-year, with the
usual multiple-testing caution.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import json

from tqdm import tqdm

from intraday import entries
from intraday.execution import CostModel, simulate_at
from intraday.metrics import summarize
from intraday.pipeline import generate_signals, hold_window_sessions
from config import BacktestConfig

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"


def run():
    print(f"Generating signals ({len(CFG.universe)} names, {CFG.start}→{CFG.end})…")
    signals = generate_signals(CFG)
    print(f"  {len(signals)} signals.")

    rules = list(entries.RULES.keys())
    results = {r: [] for r in rules}     # rule -> list[(signal, TradeResult)]
    n_window = 0

    print("Simulating entry rules on identical signals/bars…")
    for s in tqdm(signals):
        sessions = hold_window_sessions(CFG, s)
        if not sessions or not sessions[0]:
            continue
        n_window += 1
        window = [b for sess in sessions for b in sess]
        first = sessions[0]
        for r, fn in entries.RULES.items():
            hit = fn(first)
            if hit is None:                # rule didn't trigger -> no fill that day
                continue
            entry_price, idx = hit
            tr = simulate_at(window, entry_price, idx + 1, s["base_stop"], s["base_target"], COST)
            results[r].append((s, tr))

    dates = sorted(set(s["date"] for s, _ in results["next_open"]))
    mid = dates[len(dates) // 2]
    years = sorted(set(d[:4] for d in dates))

    report = {"signals": len(signals), "with_window": n_window, "split_at": mid, "rules": {}}
    print("\n" + "=" * 98)
    print("ENTRY-TIMING A/B  —  Day Trade picks, baseline (tight 1:2) exit, net of costs")
    print("=" * 98)
    hdr = (f"{'entry rule':<12}{'fills':>7}{'fill%':>7}{'win%':>7}{'LB':>6}"
           f"{'exp%':>9}{'PF':>6}{'OOSexp%':>9}{'yrs+':>6}")
    print(hdr); print("-" * len(hdr))
    for r in rules:
        trs = [tr for _, tr in results[r]]
        ov = summarize(trs)
        oos = summarize([tr for s, tr in results[r] if s["date"] >= mid])
        byyr = {y: summarize([tr for s, tr in results[r] if s["date"][:4] == y]) for y in years}
        pos = sum(1 for y in years if byyr[y].get("expectancy_pct", 0) > 0)
        fills = len(results[r])
        report["rules"][r] = {"fills": fills, "fill_rate": round(100 * fills / max(1, n_window), 1),
                              "overall": ov, "out_of_sample": oos, "by_year": byyr, "pos_years": pos}
        print(f"{r:<12}{fills:>7}{round(100*fills/max(1,n_window)):>6}%{ov.get('win_rate',0):>7}"
              f"{ov.get('win_rate_wilson_lb',0):>6}{ov.get('expectancy_pct',0):>9}"
              f"{ov.get('profit_factor',0):>6}{oos.get('expectancy_pct',0):>9}{pos:>5}/{len(years)}")

    (OUT / "entry_timing.json").write_text(json.dumps(report, indent=2))

    base = report["rules"]["next_open"]
    base_oos = base["out_of_sample"].get("expectancy_pct", 0)
    best = max((r for r in rules if r != "next_open"),
               key=lambda r: report["rules"][r]["out_of_sample"].get("expectancy_pct", -9))
    b = report["rules"][best]
    b_oos = b["out_of_sample"].get("expectancy_pct", 0)
    print("\nVERDICT:")
    print(f"  Baseline next_open OOS {base_oos}%/trade.  Best timed entry '{best}': OOS {b_oos}%/trade "
          f"({b['pos_years']}/{len(years)} yrs+, fills {b['fill_rate']}% of days).")
    if b_oos > 0 and b["pos_years"] >= max(2, len(years) - 1):
        print(f"  → Entry timing flips it OOS-positive and year-consistent — the gap-buy WAS the "
              f"leak. Strongest result yet; confirm with deflation / forward test, then stack a "
              f"conviction filter.")
    elif b_oos > base_oos:
        print(f"  → Timing the entry IMPROVES OOS ({base_oos}→{b_oos}) — buying the gap was costing "
              f"us — but it's {'positive but thin' if b_oos>0 else 'still not positive'}. Real but "
              f"not yet a confident standalone edge; next: stack with selection/quality + deflate.")
    else:
        print(f"  → No entry rule beats next_open out-of-sample. Entry execution is NOT the leak; "
              f"the signal has no durable intraday edge to time into. The rig has now rejected it "
              f"across selection, window, exit, regime, AND entry — the honest conclusion is a "
              f"movers watchlist, not a tradeable system.")
    print(f"\nSaved: {OUT/'entry_timing.json'}")


if __name__ == "__main__":
    run()
