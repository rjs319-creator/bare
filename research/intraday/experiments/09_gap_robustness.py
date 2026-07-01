"""EXPERIMENT 09 — Skeptic stress-test of the exp08 edge (unscheduled ≥5% gap-up ORB).

exp08 found a deflation-surviving edge. Before trusting it, a skeptic asks two things:
  1) Is it OUTLIER-CARRIED? Report the return distribution (median, avg win/loss, and the
     expectancy after winsorizing the top/bottom 5% of trades). A real edge survives
     trimming its biggest winners; a fluke doesn't.
  2) Does it survive REALISTIC gapper SLIPPAGE? An ORB breakout on a fast-moving gapper
     fills worse than a calm stock — re-price at 5/10/15/20 bps per fill.
Also: does it hold on the LIQUID half of the universe (not just meme/crypto names)?
"""
from __future__ import annotations

import sys
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import importlib.util

from intraday import entries, fmp
from intraday.execution import CostModel, simulate_at
from intraday.metrics import summarize
from intraday.pipeline import date_plus
from config import BacktestConfig

spec = importlib.util.spec_from_file_location("e8", ROOT / "experiments" / "08_unscheduled_gap.py")
e8 = importlib.util.module_from_spec(spec); spec.loader.exec_module(e8)

CFG = BacktestConfig()
GAP5 = 0.05
LIQUID = {"F", "SOFI", "INTC", "CCL", "NCLH", "AAL", "BAC", "WFC", "T", "PFE", "KMI",
          "KEY", "SNAP", "PINS", "HOOD", "AFRM", "DKNG", "PLTR", "LYFT", "WBD", "CLF",
          "X", "VALE", "GOLD", "KGC"}   # the $5-50 liquid half, ex speculative small-caps


def exec_at_cost(sigs, cost):
    rows = []
    for s in sigs:
        bars = fmp.intraday(s["symbol"], CFG.interval, s["date"], date_plus(s["date"], 7))
        sess = fmp.group_by_session(bars)
        days = sorted(d for d in sess if d >= s["date"])[: CFG.max_hold_sessions]
        if not days or days[0] != s["date"]:
            continue
        hit = entries.opening_range_breakout(sess[days[0]])
        if not hit:
            continue
        e, i = hit
        window = [b for d in days for b in sess[d]]
        stop = e - 2.5 * s["atr"]
        rows.append((s, simulate_at(window, e, i + 1, stop, e + 2.0 * (e - stop), cost)))
    return rows


def winsorized_exp(rets, pct=0.05):
    r = sorted(rets)
    k = int(len(r) * pct)
    core = r[k: len(r) - k] if len(r) > 2 * k else r
    return round(statistics.mean(core), 3), len(core)


def run():
    print("Rebuilding signals (cached)…")
    sigs, _ = e8.build_signals(CFG)
    g5 = [s for s in sigs if s["gap"] >= GAP5]
    print(f"  {len(g5)} unscheduled ≥5% gap-up signals.\n")

    # ---- 1) slippage sensitivity ----
    print("SLIPPAGE SENSITIVITY (≥5% gap-up ORB, commission 2bps/leg):")
    print(f"  {'slip/leg':<10}{'n':>6}{'win%':>7}{'exp%':>9}{'PF':>7}{'OOS_exp%':>10}")
    base_rows = None
    dates = None
    for slip in (5, 10, 15, 20):
        rows = exec_at_cost(g5, CostModel(slippage_bps=slip, commission_bps=2))
        if slip == 5:
            base_rows = rows
            dates = sorted(s["date"] for s, _ in rows)
        mid = dates[len(dates) // 2]
        ov = summarize([t for _, t in rows])
        oos = summarize([t for s, t in rows if s["date"] >= mid])
        print(f"  {slip:<10}{ov.get('n',0):>6}{ov.get('win_rate',0):>7}{ov.get('expectancy_pct',0):>9}"
              f"{ov.get('profit_factor',0):>7}{oos.get('expectancy_pct',0):>10}")

    # ---- 2) outlier / distribution (at base 5bps) ----
    rets = [t.net_return_pct for _, t in base_rows]
    ov = summarize([t for _, t in base_rows])
    wexp, wn = winsorized_exp(rets, 0.05)
    print("\nOUTLIER CHECK (5bps):")
    print(f"  mean {ov['expectancy_pct']}%   median {round(statistics.median(rets),3)}%   "
          f"avg_win {ov['avg_win_pct']}%   avg_loss {ov['avg_loss_pct']}%")
    print(f"  winsorized-5% mean {wexp}% over {wn} trades  → "
          f"{'SURVIVES trimming (real, not outlier-carried)' if wexp > 0 else 'DIES on trimming (outlier-carried)'}")
    top = sorted(rets, reverse=True)[:5]
    print(f"  top-5 trade returns: {[round(x,1) for x in top]}%   "
          f"(top-5 share of total P&L: {round(sum(top)/sum(rets)*100,1)}%)")

    # ---- 3) liquid-half only ----
    liq = [s for s in g5 if s["symbol"] in LIQUID]
    lrows = exec_at_cost(liq, CostModel(slippage_bps=5, commission_bps=2))
    ldates = sorted(s["date"] for s, _ in lrows)
    lmid = ldates[len(ldates) // 2] if ldates else "9999"
    lov = summarize([t for _, t in lrows])
    loos = summarize([t for s, t in lrows if s["date"] >= lmid])
    lyears = sorted(set(s["date"][:4] for s, _ in lrows))
    lpos = sum(1 for y in lyears if summarize([t for s, t in lrows if s["date"][:4] == y]).get("expectancy_pct", 0) > 0)
    print("\nLIQUID-HALF ONLY (25 names, $5-50, no speculative small-caps):")
    print(f"  n={lov.get('n',0)}  win {lov.get('win_rate',0)}%  exp {lov.get('expectancy_pct',0)}%  "
          f"PF {lov.get('profit_factor',0)}  OOS {loos.get('expectancy_pct',0)}%  yrs+ {lpos}/{len(lyears)}")

    verdict = (wexp > 0 and lov.get("expectancy_pct", 0) > 0)
    print("\nSKEPTIC VERDICT: " + ("✅ Edge survives outlier-trimming AND holds on the liquid half — robust."
                                   if verdict else "⚠️ Edge weakens under stress — treat as fragile / universe-specific."))


if __name__ == "__main__":
    run()
