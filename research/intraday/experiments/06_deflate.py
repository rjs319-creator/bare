"""EXPERIMENT 06 — Deflate the winner: is the stacked edge real, or search luck?

We searched ~24 variants (4 entries x 2 exits x 3 selections) and picked the best
(ORB + wide + momentum_liquid + rank>=median). This run re-builds ALL of them, then:

  1. Deflated Sharpe Ratio of the winner, penalised for the 24 trials.
  2. PBO (CSCV) over the variant panel's monthly returns — how often the in-sample
     winner is below-median out-of-sample.
  3. Walk-forward selection check: pick the best variant on the FIRST half, see how it
     does on the SECOND half (does in-sample selection survive forward?).

This is the honest gate before trusting the +1.56% OOS magnitude.
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

from intraday import entries, deflate
from intraday.execution import CostModel, simulate_long, simulate_at
from intraday.metrics import summarize
from intraday.pipeline import generate_signals, hold_window_sessions
from config import BacktestConfig

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"

EXITS = {"tight": None, "wide": 2.5}            # wide = stop k*ATR below entry, 1:2 target
SELECTIONS = ["all", "momL", "momL_rank"]
SELECTED = ("orb_30", "wide", "momL_rank")      # the config exp05 chose


def exits_levels(s, kind):
    if kind == "tight":
        return s["base_stop"], s["base_target"]
    stop = s["entry_close"] - EXITS[kind] * s["atr"]
    return stop, s["entry_close"] + 2 * (s["entry_close"] - stop)


def run():
    print(f"Generating signals ({len(CFG.universe)} names)…")
    signals = generate_signals(CFG)
    ml_ranks = [s["rank"] for s in signals if s["scan"] == "momentum_liquid"]
    rmed = statistics.median(ml_ranks) if ml_ranks else 0

    def keep(s, sel):
        if sel == "all":
            return True
        if sel == "momL":
            return s["scan"] == "momentum_liquid"
        return s["scan"] == "momentum_liquid" and s["rank"] >= rmed

    # Precompute each signal's TradeResult under every entry x exit combo.
    print("Simulating all entry x exit combos per signal…")
    rows = []
    for s in tqdm(signals):
        sess = hold_window_sessions(CFG, s)
        if not sess or not sess[0]:
            continue
        window = [b for x in sess for b in x]
        ex = {}
        for ename, efn in entries.RULES.items():
            hit = efn(sess[0])
            if hit is None:
                continue
            e, i = hit
            for xk in EXITS:
                stop, tgt = exits_levels(s, xk)
                ex[(ename, xk)] = simulate_at(window, e, i + 1, stop, tgt, COST)
        rows.append((s, ex))

    # Build the variant universe: (entry, exit, selection) -> list[(date, net_ret)].
    variants = {}
    for ename in entries.RULES:
        for xk in EXITS:
            for sel in SELECTIONS:
                key = (ename, xk, sel)
                trades = [(s["date"], ex[(ename, xk)].net_return_pct)
                          for s, ex in rows if keep(s, sel) and (ename, xk) in ex]
                if len(trades) >= 20:
                    variants[key] = trades

    # Per-variant per-trade Sharpe + monthly mean-return series.
    months = sorted({d[:7] for tr in variants.values() for d, _ in tr})
    trial_sharpes, monthly_matrix_cols, names = [], [], []
    for key, trades in variants.items():
        rets = [r for _, r in trades]
        trial_sharpes.append(deflate.sharpe(rets))
        bymon = {}
        for d, r in trades:
            bymon.setdefault(d[:7], []).append(r)
        monthly_matrix_cols.append([statistics.mean(bymon[m]) if m in bymon else 0.0 for m in months])
        names.append(key)

    matrix = [[col[i] for col in monthly_matrix_cols] for i in range(len(months))]  # T x N

    # --- 1. DSR of the selected winner ---
    sel_trades = variants[SELECTED]
    sel_rets = [r for _, r in sel_trades]
    dsr, sr0 = deflate.deflated_sharpe(sel_rets, trial_sharpes)
    psr0 = deflate.psr(sel_rets, 0.0)
    sel_sr = deflate.sharpe(sel_rets)

    # --- 2. PBO over the panel ---
    pbo, n_combos = deflate.pbo_cscv(matrix, n_splits=8)

    # --- 3. Walk-forward selection (first half picks, second half judges) ---
    mid = months[len(months) // 2]
    def half_sharpe(trades, first):
        rr = [r for d, r in trades if (d[:7] < mid) == first]
        return deflate.sharpe(rr), len(rr)
    is_rank = sorted(variants, key=lambda k: half_sharpe(variants[k], True)[0], reverse=True)
    wf_pick = is_rank[0]
    wf_oos_sr, wf_n = half_sharpe(variants[wf_pick], False)

    report = {
        "n_variants": len(variants), "n_trials_for_dsr": len(trial_sharpes),
        "selected": "+".join(SELECTED), "selected_trades": len(sel_trades),
        "selected_sharpe_per_trade": round(sel_sr, 3),
        "PSR_vs_0": round(psr0, 3), "DSR": round(dsr, 3),
        "deflation_benchmark_sharpe": round(sr0, 3),
        "PBO": round(pbo, 3), "pbo_combos": n_combos,
        "wf_is_best": "+".join(wf_pick), "wf_oos_sharpe": round(wf_oos_sr, 3),
        "selected_is_wf_winner": wf_pick == SELECTED,
    }
    (OUT / "deflate.json").write_text(json.dumps(report, indent=2))

    print("\n" + "=" * 70)
    print("DEFLATION  —  is the stacked winner real or search luck?")
    print("=" * 70)
    print(f"Variants searched (N for DSR): {len(trial_sharpes)}")
    print(f"Selected: {report['selected']}  (n={len(sel_trades)} trades)")
    print(f"  per-trade Sharpe        {sel_sr:.3f}")
    print(f"  PSR (vs 0, raw)         {psr0:.3f}   P(true Sharpe>0) ignoring selection")
    print(f"  deflation benchmark SR  {sr0:.3f}   (E[max Sharpe] across {len(trial_sharpes)} trials)")
    print(f"  DSR                     {dsr:.3f}   P(true Sharpe>0) AFTER deflation")
    print(f"PBO (CSCV, {n_combos} splits)      {pbo:.3f}   P(in-sample winner below-median OOS)")
    print(f"Walk-forward: first-half best = {report['wf_is_best']}")
    print(f"  its second-half Sharpe  {wf_oos_sr:.3f} (n={wf_n})   selected==WF-winner: {report['selected_is_wf_winner']}")

    print("\nVERDICT:")
    ok_dsr = dsr >= 0.95
    ok_pbo = pbo <= 0.5
    if ok_dsr and ok_pbo:
        print(f"  PASSES deflation: DSR {dsr:.2f}≥0.95 and PBO {pbo:.2f}≤0.5. The edge is unlikely "
              f"to be pure search luck — worth a real forward test / paper-trading the config.")
    elif ok_pbo and dsr >= 0.90:
        print(f"  BORDERLINE: PBO {pbo:.2f} is acceptable but DSR {dsr:.2f} only ~0.9 — the magnitude "
              f"is selection-inflated. Treat as a lead, confirm forward before sizing.")
    else:
        print(f"  FAILS deflation: DSR {dsr:.2f} / PBO {pbo:.2f}. The in-sample winner is likely a "
              f"product of the search; do NOT trust the +OOS magnitude without out-of-sample "
              f"forward confirmation. Honest stance: promising process, unproven edge.")
    print(f"\nSaved: {OUT/'deflate.json'}")


if __name__ == "__main__":
    run()
