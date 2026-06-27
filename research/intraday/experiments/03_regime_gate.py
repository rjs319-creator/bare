"""EXPERIMENT 03 — Gate the Day Trade picks by regime / tape (the #1 proven lever).

Same PIT signals + same intraday execution; we only restrict WHICH days we trade,
using point-in-time index features (SPY/IWM/^VIX) known at the signal's close. The
question: does standing down in the wrong regime turn the strategy out-of-sample
positive — and does the SMALL-CAP (IWM) tape gate beat a SPY-only gate, given 2024
was bull-for-SPY yet negative here?

Exit is held fixed at the live baseline (tight 1:2) to isolate the GATE's effect; a
final row stacks the best gate with the better exit (wide 2.5ATR) as a candidate —
flagged as needing its own confirmation (two levers tuned on one dataset).

Multiple-testing honesty: ~6 gates are tried. The best one's OOS could be luck, so we
judge on OOS positivity + by-year consistency + economic rationale, not the top point
estimate alone.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import json

from tqdm import tqdm

from intraday.execution import CostModel, simulate_long
from intraday.metrics import summarize
from intraday.pipeline import generate_signals, hold_window_bars
from intraday.regime import build_regime
from config import BacktestConfig
from datetime import datetime, timedelta

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"


def er(r, idx):  # safe efficiency-ratio read
    return (r[idx]["er"] or 0) if r and r.get(idx) else 0


GATES = {
    "none":        lambda r: True,
    "spy_riskon":  lambda r: bool(r and r["spy"]["above200"] and r["spy"]["sma50_rising"]),
    "iwm_riskon":  lambda r: bool(r and r["iwm"] and r["iwm"]["above200"] and r["iwm"]["above50"]),
    "iwm_trend":   lambda r: er(r, "iwm") >= 0.30,
    "vix_calm":    lambda r: bool(r and r["vix"] and r["vix"]["level"] < 20),
    "combo":       lambda r: bool(r and r["iwm"] and r["iwm"]["above50"] and er(r, "iwm") >= 0.25
                                  and (not r["vix"] or r["vix"]["level"] < 22)),
}


def wide_levels(s):
    stop = s["entry_close"] - 2.5 * s["atr"]
    return stop, s["entry_close"] + 2 * (s["entry_close"] - stop)


def run():
    print(f"Generating signals ({len(CFG.universe)} names, {CFG.start}→{CFG.end})…")
    signals = generate_signals(CFG)
    print(f"  {len(signals)} signals.")

    fetch_from = (datetime.strptime(CFG.start, "%Y-%m-%d") - timedelta(days=400)).strftime("%Y-%m-%d")
    print("Building point-in-time regime (SPY / IWM / ^VIX)…")
    reg = build_regime(fetch_from, CFG.end)
    has_vix = any(v.get("vix") for v in reg.values())
    print(f"  regime dates: {len(reg)}  vix available: {has_vix}")

    # Simulate each signal ONCE under baseline + wide exits (reused across gates).
    print("Simulating execution per signal…")
    rows = []
    for s in tqdm(signals):
        window = hold_window_bars(CFG, s)
        if not window:
            continue
        base = simulate_long(window, s["entry_close"], s["base_stop"], s["base_target"], COST, CFG.entry_mode)
        wstop, wtgt = wide_levels(s)
        wide = simulate_long(window, s["entry_close"], wstop, wtgt, COST, CFG.entry_mode)
        rows.append((s, base, wide))

    dates = sorted(set(s["date"] for s, _, _ in rows))
    mid = dates[len(dates) // 2]
    years = sorted(set(d[:4] for d in dates))

    def block(kept, which):
        trs = [r[1 if which == "base" else 2] for r in kept]
        ov = summarize(trs)
        oos = summarize([(r[1] if which == "base" else r[2]) for r in kept if r[0]["date"] >= mid])
        byyr = {y: summarize([(r[1] if which == "base" else r[2]) for r in kept if r[0]["date"][:4] == y]) for y in years}
        pos = sum(1 for y in years if byyr[y].get("expectancy_pct", 0) > 0)
        return ov, oos, byyr, pos

    report = {"signals": len(signals), "split_at": mid, "vix": has_vix, "gates": {}}
    print("\n" + "=" * 96)
    print("REGIME / TAPE GATE  —  Day Trade picks, baseline (tight 1:2) exit, net of costs")
    print("=" * 96)
    hdr = f"{'gate':<13}{'kept':>6}{'%univ':>7}{'win%':>7}{'LB':>6}{'exp%':>9}{'PF':>6}{'OOSexp%':>9}{'yrs+':>6}"
    print(hdr); print("-" * len(hdr))
    n_all = len(rows)
    for g, fn in GATES.items():
        kept = [r for r in rows if fn(reg.get(r[0]["date"]))]
        if not kept:
            print(f"{g:<13}{0:>6}"); continue
        ov, oos, byyr, pos = block(kept, "base")
        report["gates"][g] = {"kept": len(kept), "overall": ov, "out_of_sample": oos,
                              "by_year": byyr, "pos_years": pos}
        print(f"{g:<13}{len(kept):>6}{round(100*len(kept)/n_all):>6}%{ov.get('win_rate',0):>7}"
              f"{ov.get('win_rate_wilson_lb',0):>6}{ov.get('expectancy_pct',0):>9}"
              f"{ov.get('profit_factor',0):>6}{oos.get('expectancy_pct',0):>9}{pos:>5}/{len(years)}")

    # Stacked candidate: best non-trivial gate by OOS, with the better (wide) exit.
    cand = max((g for g in GATES if g != "none"),
               key=lambda g: report["gates"].get(g, {}).get("out_of_sample", {}).get("expectancy_pct", -9))
    kept = [r for r in rows if GATES[cand](reg.get(r[0]["date"]))]
    ov, oos, byyr, pos = block(kept, "wide")
    report["stacked"] = {"gate": cand, "exit": "wide_2.5ATR", "kept": len(kept),
                         "overall": ov, "out_of_sample": oos, "by_year": byyr, "pos_years": pos}
    print("-" * len(hdr))
    print(f"{cand+'+wide':<13}{len(kept):>6}{round(100*len(kept)/n_all):>6}%{ov.get('win_rate',0):>7}"
          f"{ov.get('win_rate_wilson_lb',0):>6}{ov.get('expectancy_pct',0):>9}"
          f"{ov.get('profit_factor',0):>6}{oos.get('expectancy_pct',0):>9}{pos:>5}/{len(years)}")

    (OUT / "regime_gate.json").write_text(json.dumps(report, indent=2))

    # Verdict on the best GATE alone (exit isolated).
    gbest = max((g for g in GATES if g != "none"),
                key=lambda g: report["gates"].get(g, {}).get("out_of_sample", {}).get("expectancy_pct", -9))
    gb = report["gates"][gbest]
    base_oos = report["gates"]["none"]["out_of_sample"].get("expectancy_pct", 0)
    g_oos = gb["out_of_sample"].get("expectancy_pct", 0)
    print("\nVERDICT:")
    print(f"  Ungated OOS: {base_oos}%/trade.  Best gate '{gbest}': OOS {g_oos}%/trade, "
          f"{gb['pos_years']}/{len(years)} yrs+, keeps {round(100*gb['kept']/n_all)}% of trades.")
    if g_oos > 0 and gb["pos_years"] >= max(2, len(years) - 1):
        print(f"  → The regime gate turns it OOS-positive AND consistent across years. The lever "
              f"works: standing down in the wrong tape is the edge. Confirm with deflation / "
              f"forward test before trusting the magnitude.")
    elif g_oos > base_oos:
        print(f"  → The gate IMPROVES OOS ({base_oos}→{g_oos}) by cutting bad-regime trades, but "
              f"it's still {'positive but thin' if g_oos>0 else 'not yet positive'} / not "
              f"all-years consistent. Directionally right, not yet a confident edge — try "
              f"stacking with the better exit + a conviction filter.")
    else:
        print(f"  → No gate makes it OOS-positive. Even regime timing doesn't rescue this signal "
              f"on real intraday execution — the honest ceiling is a watchlist, not a system.")
    print(f"\nSaved: {OUT/'regime_gate.json'}")


if __name__ == "__main__":
    run()
