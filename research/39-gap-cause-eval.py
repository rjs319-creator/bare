#!/usr/bin/env python3
"""Step 39 - Does gap-CAUSE de-lump the Gap & Go edge on the STRATEGY outcome?

  research/intraday/.venv/bin/python research/39-gap-cause-eval.py

The step-27 pilot found cause matters (offerings/M&A fade, FDA/contract/guidance
continue) but on a DIFFERENT event definition (close-close >=7% gaps) and a drift
outcome (21d continuation), with tiny per-class n. This evaluates the SHIPPED
classifier (lib/gapgo.js classifyGapCause, joined by step 38) on the strategy's own
events and outcome: ORB-triggered, non-earnings, liquid >=3% gaps, realized
R-multiple of the 2.5xATR / 1:2 trade.

PRE-REGISTERED questions (declared before running):
 1. FADE (FADE_OFFERING + MA, the shipped GAP_CAUSE_FADE set) expR vs non-FADE,
    cluster-bootstrap (by date) 95% CI — the shipped skip's decisive test.
 2. Portfolio: take-all vs skip-FADE — expR / PF / n and the LUMPINESS diagnostics
    (top-5 share of gross wins, median, 5%-winsorized mean). Cause's promise is
    de-lumping, so winsorized/median improvement matters as much as the mean.
 3. Top-decile precision: rank by the shipped continuationScore; does excluding
    FADE from the top decile (refilled to equal n) raise decile expR? (Also within
    the STRONG >=5% tier.)
 4. Stability: the two calendar halves of the window (2025H2 vs 2026H1) — does the
    FADE drag hold in both?

HONESTY CONSTRAINTS (printed with the result): FMP Starter news bottoms out
~2025-10 so this is ONE ~9-month, mostly risk-on window; the FADE hypothesis was
partly formed on the overlapping step-27 pilot window (this is a strategy-outcome
re-validation, NOT independent confirmation); news coverage is ~1/3 of events
(NONE is kept as its own class, never dropped).
"""

import json
import os
import sys
from collections import defaultdict

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "intraday", "src"))

from intraday.metalabel import (                                        # noqa: E402
    cluster_bootstrap_delta, continuation_score, lumpiness, trade_stats, wilson_lb,
)

EVENTS = os.path.join(HERE, "data", "gap-events-cause.json")
OUT = os.path.join(HERE, "data", "gap-cause-eval.json")
FADE_SET = {"FADE_OFFERING", "MA"}          # lib/gapgo.js GAP_CAUSE_FADE
CLASS_ORDER = ["FADE_OFFERING", "MA", "FDA", "CONTRACT", "GUIDE", "OTHER", "NONE"]
DECILE = 0.10


def r_of(evs):
    return [e["R"] for e in evs]


def d_of(evs):
    return [e["date"] for e in evs]


def block(evs):
    return {**trade_stats(r_of(evs)), **lumpiness(r_of(evs))}


def fmt(s):
    if not s["n"]:
        return "n=0"
    return (f"n={s['n']:<5} win {s['win']:.3f} expR {s['expR']:+.4f} PF {s['pf']} "
            f"| top5-share {s.get('topk_share')} median {s.get('median')} "
            f"winsor {s.get('winsor_mean')}")


def main():
    rows = [e for e in json.load(open(EVENTS)) if e.get("cause") is not None]
    failed = sum(1 for e in json.load(open(EVENTS)) if e.get("cause") is None)
    covered = sum(1 for e in rows if e["cause"] != "NONE")
    print(f"{len(rows)} events with cause ({failed} fetch failures dropped) · "
          f"news coverage {covered}/{len(rows)} = {covered/len(rows):.0%}\n")

    report = {"n": len(rows), "coverage": round(covered / len(rows), 3), "by_class": {}}

    # ---- by-class table ----
    by = defaultdict(list)
    for e in rows:
        by[e["cause"]].append(e)
    print("=== by cause class (ORB R outcome) ===")
    print(f"{'class':<14}{'n':>6}{'share':>7}{'gap%':>7}{'win':>7}{'winLB':>7}{'expR':>9}{'PF':>7}{'median':>9}")
    for k in CLASS_ORDER:
        evs = by.get(k, [])
        if not evs:
            continue
        s = block(evs)
        wl = wilson_lb(sum(1 for e in evs if e["R"] > 0), len(evs))
        gap = float(np.mean([e["gap"] for e in evs]))
        report["by_class"][k] = {**s, "win_lb": round(wl, 3), "mean_gap": round(gap, 2)}
        print(f"{k:<14}{s['n']:>6}{len(evs)/len(rows):>7.1%}{gap:>7.2f}{s['win']:>7.3f}"
              f"{wl:>7.3f}{s['expR']:>+9.4f}{str(s['pf']):>7}{s['median']:>9.4f}")

    # ---- 1) FADE vs non-FADE (decisive CI) ----
    fade = [e for e in rows if e["cause"] in FADE_SET]
    keep = [e for e in rows if e["cause"] not in FADE_SET]
    ci = cluster_bootstrap_delta(r_of(fade), d_of(fade), r_of(keep), d_of(keep))
    print(f"\n=== 1) FADE (offering+MA) vs non-FADE ===")
    print(f"FADE     {fmt(block(fade))}")
    print(f"non-FADE {fmt(block(keep))}")
    print(f"Δ(FADE − nonFADE) {ci['delta']:+.4f}  CI95 [{ci['lo95']:+.4f}, {ci['hi95']:+.4f}]  "
          f"p(Δ>0) {ci['p_gt0']}")
    report["fade_vs_nonfade"] = {"fade": block(fade), "non_fade": block(keep), "delta_ci": ci}

    # ---- 2) portfolio: take-all vs skip-FADE ----
    print(f"\n=== 2) portfolio: take-ALL vs skip-FADE ===")
    all_s, skip_s = block(rows), block(keep)
    print(f"take-ALL  {fmt(all_s)}")
    print(f"skip-FADE {fmt(skip_s)}")
    report["portfolio"] = {"take_all": all_s, "skip_fade": skip_s}

    # ---- 3) top-decile precision with cause-conditioning ----
    print(f"\n=== 3) continuationScore top-decile, with vs without FADE exclusion ===")
    report["decile"] = {}
    for label, pool in (("ALL >=3%", rows), ("STRONG >=5%", [e for e in rows if e["gap"] >= 5])):
        ranked = sorted(pool, key=lambda e: (-continuation_score(e["gap"], e["rv"], e["reg"]),
                                             e["date"], e["sym"]))
        k = max(1, int(len(ranked) * DECILE))
        plain = ranked[:k]
        excl = [e for e in ranked if e["cause"] not in FADE_SET][:k]
        sp, se = block(plain), block(excl)
        n_swapped = k - len([e for e in plain if e["cause"] not in FADE_SET])
        print(f"{label:<12} plain    {fmt(sp)}")
        print(f"{'':<12} ex-FADE  {fmt(se)}   (replaced {n_swapped} FADE picks)")
        report["decile"][label] = {"plain": sp, "ex_fade": se, "n_swapped": n_swapped}

    # ---- 4) stability across the two window halves ----
    print(f"\n=== 4) stability: FADE drag by half ===")
    report["halves"] = {}
    for half, lo, hi in (("2025H2", "2025-10-15", "2026-01-01"),
                         ("2026H1", "2026-01-01", "2026-12-31")):
        seg = [e for e in rows if lo <= e["date"] < hi]
        f = [e for e in seg if e["cause"] in FADE_SET]
        nf = [e for e in seg if e["cause"] not in FADE_SET]
        sf, snf = trade_stats(r_of(f)), trade_stats(r_of(nf))
        drag = (sf["expR"] - snf["expR"]) if (sf["n"] and snf["n"]) else None
        print(f"{half}: FADE n={sf['n']} expR {sf['expR']} | non-FADE n={snf['n']} "
              f"expR {snf['expR']} | drag {drag if drag is None else round(drag, 4)}")
        report["halves"][half] = {"fade": sf, "non_fade": snf,
                                  "drag": None if drag is None else round(drag, 4)}

    # ---- verdict ----
    both_halves_neg = all(v["drag"] is not None and v["drag"] < 0
                          for v in report["halves"].values())
    ci_neg = ci["hi95"] is not None and ci["hi95"] < 0
    if ci_neg and both_halves_neg:
        verdict = ("SUPPORTED (within-window): FADE causes drag the strategy outcome with a "
                   "CI excluding 0 and in both halves — but ONE mostly-risk-on window and a "
                   "pilot-informed hypothesis: keep the skip OPT-IN and keep accruing the "
                   "forward ledger before defaulting it.")
    elif ci["delta"] is not None and ci["delta"] < 0 and both_halves_neg:
        verdict = ("DIRECTIONAL: FADE underperforms in both halves but the CI includes 0 — "
                   "not confirmable at this sample; forward ledger remains the gate.")
    elif ci["delta"] is not None and ci["delta"] < 0:
        verdict = ("WEAK/UNSTABLE: FADE drag exists pooled but is not consistent across "
                   "halves — treat as unconfirmed.")
    else:
        verdict = ("NOT SUPPORTED on the strategy outcome: FADE causes do not underperform "
                   "the ORB trade in this window — the pilot's drift result does not carry "
                   "over; do not enable the skip.")
    report["verdict"] = verdict
    print("\nHONESTY: one ~9mo mostly-risk-on window; hypothesis partly formed on the "
          "overlapping step-27 pilot; ~1/3 news coverage.")
    print("\nVERDICT:\n  " + verdict)

    with open(OUT, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\nsaved → {OUT}")


if __name__ == "__main__":
    main()
