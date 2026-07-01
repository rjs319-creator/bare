"""EXPERIMENT 08 — Unscheduled catalyst gap-up continuation (the real event edge).

exp07 tested post-EARNINGS gap-up ORB continuation and found NO edge: earnings gap-ups
underperform non-earnings gap-ups in every bucket, and the only positive cell — the
non-earnings ≥5% control — was the OPPOSITE of the hypothesis. Interpretation: a scheduled
earnings gap is a one-time repricing to a new equilibrium (little continuation, IV-crush
chop), whereas a large UNSCHEDULED gap is a live news/catalyst shock that keeps running.

So this experiment tests that emergent hypothesis head-on, on the FULL (uncapped) sample:
    EVENT = an overnight gap-up >= gap_min that is NOT within +-1 session of an earnings
    report (unscheduled), on a liquid name (trailing 20d $ADV >= floor).
    TRADE = opening-range-breakout entry that session, 2.5x ATR stop, 1:2 target, hold <=3.

Pre-registered PRIMARY = 5% gap (where exp07's control turned positive). The gap-threshold
sweep {3,4,5,7%} is the searched trial set for deflation; a 1-2% "small gap" null confirms
the dose-response is real (bigger information shock → stronger continuation), not a fluke.

Honesty: this hypothesis was SURFACED by exp07's control, so it is in-sample-informed —
the deflation gate + OOS + by-year consistency are the real arbiters, and even a survivor
here is a lead to forward-test, not a proven edge.
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

from intraday import entries, fmp, deflate
from intraday.daytrade import atr
from intraday.execution import CostModel, simulate_at
from intraday.metrics import summarize
from intraday.pipeline import date_plus, _pad
from config import BacktestConfig

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"

GAP_MIN = 0.03           # loosest — sub-filter stricter thresholds from one fetch pass
ADV_FLOOR = 10_000_000   # trailing 20d avg dollar volume — tradeable liquidity
ATR_MULT, RR = 2.5, 2.0
THRESHOLDS = {"gap3": 0.03, "gap4": 0.04, "gap5_PRIMARY": 0.05, "gap7": 0.07}


def orb_trade(symbol: str, date: str, atr_val: float):
    """ORB entry on the gap session, 2.5xATR stop / 1:2 target, hold <= max_hold. Tight
    intraday window (FMP 5min caps ~7-8 sessions ending at `to`, so the signal day must
    sit near the START of a short window). Returns TradeResult or None."""
    bars = fmp.intraday(symbol, CFG.interval, date, date_plus(date, 7))
    sess = fmp.group_by_session(bars)
    days = sorted(d for d in sess if d >= date)[: CFG.max_hold_sessions]
    if not days or days[0] != date:
        return None
    hit = entries.opening_range_breakout(sess[days[0]])
    if not hit:
        return None
    entry_px, idx = hit
    window = [b for d in days for b in sess[d]]
    stop = entry_px - ATR_MULT * atr_val
    return simulate_at(window, entry_px, idx + 1, stop, entry_px + RR * (entry_px - stop), COST)


def build_signals(cfg):
    """Every unscheduled gap-up >= GAP_MIN on a liquid session, full sample. Also a
    small-gap (1-2%) null bucket for the dose-response check."""
    sigs, small = [], []
    for sym in tqdm(cfg.universe, desc="scan"):
        try:
            dc = fmp.daily(sym, _pad(cfg.start, cfg.daily_lookback_days + 20), cfg.end)
        except Exception:
            continue
        if len(dc) < 40:
            continue
        adjacent = set()
        for e in fmp.earnings(sym):
            for i, c in enumerate(dc):
                if c["date"] >= e["date"]:
                    for k in (i - 1, i, i + 1):
                        if 0 <= k < len(dc):
                            adjacent.add(dc[k]["date"])
                    break
        for i in range(20, len(dc)):
            c = dc[i]
            if not (cfg.start <= c["date"] <= cfg.end) or c["date"] in adjacent:
                continue
            if not dc[i - 1]["close"]:
                continue
            gap = c["open"] / dc[i - 1]["close"] - 1
            adv = statistics.mean(x["close"] * x["volume"] for x in dc[i - 20:i])
            if adv < ADV_FLOOR:
                continue
            a = atr(dc[:i])
            if not a or a <= 0:
                continue
            rec = dict(symbol=sym, date=c["date"], gap=round(gap, 4), atr=a)
            if gap >= GAP_MIN:
                sigs.append(rec)
            elif 0.01 <= gap < 0.02:
                small.append(rec)
    return sigs, small


def execute(sigs):
    rows = []
    for s in tqdm(sigs, desc="execute", leave=False):
        tr = orb_trade(s["symbol"], s["date"], s["atr"])
        if tr is not None:
            rows.append((s, tr))
    return rows


def blocks(rows, years, mid):
    ov = summarize([tr for _, tr in rows])
    oos = summarize([tr for s, tr in rows if s["date"] >= mid])
    byyr = {y: summarize([tr for s, tr in rows if s["date"][:4] == y]) for y in years}
    pos = sum(1 for y in years if byyr[y].get("expectancy_pct", 0) > 0)
    return ov, oos, byyr, pos


def rets(rows):
    return [tr.net_return_pct / 100 for _, tr in rows]


def run():
    print(f"Scanning unscheduled gap-ups ({len(CFG.universe)} names, {CFG.start}->{CFG.end}, "
          f"ADV>=${ADV_FLOOR/1e6:.0f}M)…")
    sigs, small = build_signals(CFG)
    print(f"  {len(sigs)} gap-ups >= {GAP_MIN:.0%}; {len(small)} small-gap (1-2%) null.")

    all_rows = execute(sigs)
    # The null only needs to be representative — evenly subsample (outcome-agnostic) to
    # keep runtime/network sane rather than executing all ~5k small-gap sessions.
    NULL_CAP = 500
    if len(small) > NULL_CAP:
        step = len(small) / NULL_CAP
        small = [small[int(k * step)] for k in range(NULL_CAP)]
    small_rows = execute(small)
    dates = sorted(s["date"] for s, _ in all_rows)
    if not dates:
        print("No filled trades — aborting."); return
    mid = dates[len(dates) // 2]
    years = sorted(set(d[:4] for d in dates))

    variants = {k: [(s, tr) for s, tr in all_rows if s["gap"] >= v] for k, v in THRESHOLDS.items()}
    variants["small_1-2%_NULL"] = small_rows

    report = {"universe": len(CFG.universe), "window": [CFG.start, CFG.end], "adv_floor": ADV_FLOOR,
              "n_signals": len(sigs), "n_filled": len(all_rows), "split_at": mid, "variants": {}}
    print("\n" + "=" * 104)
    print("UNSCHEDULED GAP-UP  ORB (2.5xATR stop, 1:2 target, hold<=3)  —  net of costs; OOS + yrs+ honest")
    print("=" * 104)
    hdr = f"{'variant':<18}{'n':>6}{'win%':>7}{'LB':>6}{'exp%':>9}{'PF':>6}{'OOSexp%':>9}{'OOS_LB':>8}{'yrs+':>7}"
    print(hdr); print("-" * len(hdr))
    for name, rows in variants.items():
        if not rows:
            continue
        ov, oos, byyr, pos = blocks(rows, years, mid)
        report["variants"][name] = {"n": ov.get("n", 0), "overall": ov, "oos": oos,
                                    "by_year": byyr, "pos_years": pos}
        print(f"{name:<18}{ov.get('n',0):>6}{ov.get('win_rate',0):>7}{ov.get('win_rate_wilson_lb',0):>6}"
              f"{ov.get('expectancy_pct',0):>9}{ov.get('profit_factor',0):>6}"
              f"{oos.get('expectancy_pct',0):>9}{oos.get('win_rate_wilson_lb',0):>8}{pos:>6}/{len(years)}")

    # ---- deflation on the pre-registered PRIMARY; trials = the 4 gap thresholds ----
    trial_rows = [variants[k] for k in THRESHOLDS if variants[k]]
    trial_sharpes = [deflate.sharpe(rets(r)) for r in trial_rows]
    prim = variants["gap5_PRIMARY"]
    dsr, sr0 = deflate.deflated_sharpe(rets(prim), trial_sharpes)
    psr0 = deflate.psr(rets(prim))

    def q(d): return f"{d[:4]}Q{(int(d[5:7]) - 1) // 3 + 1}"
    quarters = sorted(set(q(s["date"]) for s, _ in all_rows))
    names = [k for k in THRESHOLDS if variants[k]]
    matrix = [[ (lambda rr: sum(rr)/len(rr) if rr else 0.0)(
                    [tr.net_return_pct/100 for s, tr in variants[n] if q(s["date"]) == qq])
                for n in names] for qq in quarters]
    pbo, ncombo = deflate.pbo_cscv(matrix, 8) if len(quarters) >= 8 else (float("nan"), 0)
    report["deflation"] = {"primary_psr": round(psr0, 3), "deflated_sharpe": round(dsr, 3),
                           "benchmark_max_sharpe": round(sr0, 4), "n_trials": len(trial_sharpes),
                           "pbo": round(pbo, 3) if pbo == pbo else None}

    pov = report["variants"]["gap5_PRIMARY"]["overall"]
    poos = report["variants"]["gap5_PRIMARY"]["oos"]
    pyrs = report["variants"]["gap5_PRIMARY"]["pos_years"]
    print(f"\nDEFLATION (primary gap5, {len(trial_sharpes)} trials):")
    print(f"  PSR {psr0:.3f}   Deflated Sharpe {dsr:.3f}  (bar 0.95; benchmark E[maxSR] {sr0:.4f})   PBO {report['deflation']['pbo']}")

    edge = (pov.get("expectancy_pct", 0) > 0 and poos.get("expectancy_pct", 0) > 0
            and pyrs >= len(years) - 1 and dsr >= 0.95)
    print("\nVERDICT:")
    if edge:
        report["verdict"] = "EDGE: unscheduled gap-up ORB continuation is OOS-positive, year-consistent, and survives deflation."
        print("  ✅ " + report["verdict"])
    elif pov.get("expectancy_pct", 0) > 0 and poos.get("expectancy_pct", 0) > 0 and pyrs >= len(years) - 1:
        report["verdict"] = "STRONG LEAD: OOS-positive + year-consistent, but does not clear the deflation bar — forward-track before sizing."
        print("  🟡 " + report["verdict"])
    elif pov.get("expectancy_pct", 0) > 0:
        report["verdict"] = "WEAK LEAD: positive in aggregate but not robust OOS/by-year — likely a window artifact."
        print("  🟠 " + report["verdict"])
    else:
        report["verdict"] = "NO EDGE: even unscheduled gap-up continuation does not survive on this data/window."
        print("  ❌ " + report["verdict"])

    (OUT / "unscheduled_gap.json").write_text(json.dumps(report, indent=2, default=str))
    print(f"\nSaved: {OUT/'unscheduled_gap.json'}")


if __name__ == "__main__":
    run()
