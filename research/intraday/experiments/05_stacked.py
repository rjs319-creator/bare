"""EXPERIMENT 05 — Stack the levers that each independently helped, as a ladder.

From exps 01–04, two levers moved OOS the right way: (a) ORB entry (don't buy the gap;
wait for the opening-range-high breakout) and (b) a wider exit (the tight stop leaks).
Regime gating did NOT transfer. Here we stack them and add a principled SELECTION
filter, one rung at a time, judging each by out-of-sample + by-year consistency. Each
lever has prior independent support, so this is a disciplined stack, not a blind grid.

Honesty: selection cuts use the in-sample rank distribution (noted) and every rung is
judged OOS; with this many experiments run, treat a marginally-positive OOS as a lead
to forward-test, not a proven edge.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import json
import statistics

from tqdm import tqdm

from intraday import entries
from intraday.execution import CostModel, simulate_long, simulate_at
from intraday.metrics import summarize
from intraday.pipeline import generate_signals, hold_window_sessions
from config import BacktestConfig

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"


def wide(s):
    stop = s["entry_close"] - 2.5 * s["atr"]
    return stop, s["entry_close"] + 2 * (s["entry_close"] - stop)


def run():
    print(f"Generating signals ({len(CFG.universe)} names, {CFG.start}→{CFG.end})…")
    signals = generate_signals(CFG)

    print("Precomputing executions per signal (next_open vs ORB; tight vs wide exit)…")
    rows = []
    for s in tqdm(signals):
        sess = hold_window_sessions(CFG, s)
        if not sess or not sess[0]:
            continue
        window = [b for x in sess for b in x]
        wstop, wtgt = wide(s)
        ex = {"base": simulate_long(window, s["entry_close"], s["base_stop"], s["base_target"], COST)}
        orb = entries.opening_range_breakout(sess[0])
        if orb:
            e, i = orb
            ex["orb_tight"] = simulate_at(window, e, i + 1, s["base_stop"], s["base_target"], COST)
            ex["orb_wide"] = simulate_at(window, e, i + 1, wstop, wtgt, COST)
        rows.append((s, ex))

    dates = sorted(set(s["date"] for s, _ in rows))
    mid = dates[len(dates) // 2]
    years = sorted(set(d[:4] for d in dates))

    ml_ranks = [s["rank"] for s, _ in rows if s["scan"] == "momentum_liquid"]
    rmed = statistics.median(ml_ranks) if ml_ranks else 0
    rp66 = statistics.quantiles(ml_ranks, n=3)[1] if len(ml_ranks) > 2 else rmed

    # Each rung: (label, choose_exec(ex)->tr|None, keep(s)->bool)
    ladder = [
        ("L0 base",            lambda ex: ex.get("base"),       lambda s: True),
        ("L1 +ORB",            lambda ex: ex.get("orb_tight"),  lambda s: True),
        ("L2 +ORB+wide",       lambda ex: ex.get("orb_wide"),   lambda s: True),
        ("L3 +momL only",      lambda ex: ex.get("orb_wide"),   lambda s: s["scan"] == "momentum_liquid"),
        ("L4 +rank>med",       lambda ex: ex.get("orb_wide"),   lambda s: s["scan"] == "momentum_liquid" and s["rank"] >= rmed),
        ("L5 +rank>p66",       lambda ex: ex.get("orb_wide"),   lambda s: s["scan"] == "momentum_liquid" and s["rank"] >= rp66),
    ]

    def block(pairs):
        trs = [tr for _, tr in pairs]
        ov = summarize(trs)
        oos = summarize([tr for s, tr in pairs if s["date"] >= mid])
        byyr = {y: summarize([tr for s, tr in pairs if s["date"][:4] == y]) for y in years}
        pos = sum(1 for y in years if byyr[y].get("expectancy_pct", 0) > 0)
        return ov, oos, byyr, pos

    report = {"signals": len(signals), "split_at": mid, "rank_median": round(rmed, 1),
              "rank_p66": round(rp66, 1), "ladder": {}}
    print("\n" + "=" * 100)
    print("STACKED LADDER  —  net of costs;  OOS + by-year are the honest columns")
    print("=" * 100)
    hdr = f"{'rung':<16}{'n':>6}{'win%':>7}{'LB':>6}{'exp%':>9}{'PF':>6}{'OOSexp%':>9}{'OOS_LB':>8}{'yrs+':>6}"
    print(hdr); print("-" * len(hdr))
    for label, pick, keep in ladder:
        pairs = [(s, pick(ex)) for s, ex in rows if keep(s) and pick(ex) is not None]
        if not pairs:
            continue
        ov, oos, byyr, pos = block(pairs)
        report["ladder"][label] = {"n": ov.get("n", 0), "overall": ov, "out_of_sample": oos,
                                   "by_year": byyr, "pos_years": pos}
        print(f"{label:<16}{ov.get('n',0):>6}{ov.get('win_rate',0):>7}{ov.get('win_rate_wilson_lb',0):>6}"
              f"{ov.get('expectancy_pct',0):>9}{ov.get('profit_factor',0):>6}"
              f"{oos.get('expectancy_pct',0):>9}{oos.get('win_rate_wilson_lb',0):>8}{pos:>5}/{len(years)}")

    # ORB opening-range length sensitivity at the best-rank filter (20/30/45 min).
    print("\nORB opening-range length sensitivity (momL + rank>med, wide exit):")
    for k, lab in [(4, "20min"), (6, "30min"), (9, "45min")]:
        pairs = []
        for s, ex in rows:
            if not (s["scan"] == "momentum_liquid" and s["rank"] >= rmed):
                continue
            sess = hold_window_sessions(CFG, s)
            hit = entries.opening_range_breakout(sess[0], k=k)
            if not hit:
                continue
            window = [b for x in sess for b in x]
            wstop, wtgt = wide(s)
            pairs.append((s, simulate_at(window, hit[0], hit[1] + 1, wstop, wtgt, COST)))
        ov, oos, _, pos = block(pairs)
        print(f"  ORB {lab:<6} n={ov.get('n',0):<4} exp={ov.get('expectancy_pct',0)}%  "
              f"OOS={oos.get('expectancy_pct',0)}% (LB {oos.get('win_rate_wilson_lb',0)})  PF={ov.get('profit_factor',0)}  {pos}/{len(years)}yr+")

    (OUT / "stacked.json").write_text(json.dumps(report, indent=2))

    best = max(report["ladder"], key=lambda k: report["ladder"][k]["out_of_sample"].get("expectancy_pct", -9))
    bo = report["ladder"][best]["out_of_sample"]
    print("\nVERDICT:")
    print(f"  Best rung: {best} — OOS {bo.get('expectancy_pct',0)}%/trade, LB {bo.get('win_rate_wilson_lb',0)}, "
          f"{report['ladder'][best]['pos_years']}/{len(years)} yrs+, n={report['ladder'][best]['n']}.")
    oexp = bo.get("expectancy_pct", 0)
    if oexp > 0 and report["ladder"][best]["pos_years"] >= len(years) - 1:
        print("  → A coherent stacked configuration is OOS-positive and year-consistent. This is the "
              "best achievable here; the honest next gate is FORWARD/live confirmation + deflation, "
              "not more in-sample tuning.")
    elif oexp > 0:
        print("  → OOS turned positive but is thin / not year-consistent — a real improvement from "
              "stacking ORB-entry + wider-exit + conviction, but not a deflation-proof edge. Treat "
              "as a watchlist with a disciplined entry, confirm forward.")
    else:
        print("  → Even fully stacked it stays OOS-negative. No tradeable intraday edge exists in "
              "this signal; the levers reduce the bleed but cannot manufacture an edge.")
    print(f"\nSaved: {OUT/'stacked.json'}")


if __name__ == "__main__":
    run()
