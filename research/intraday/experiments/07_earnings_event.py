"""EXPERIMENT 07 — Post-earnings gap-up intraday continuation (event-driven edge test).

THE GOAL: an EVENT-driven strategy with a real, deflation-surviving edge — where the
whole prior investigation found none (PEAD dead, day-trade ORB failed deflation off a
24-variant search).

Single pre-registered hypothesis (a SMALL trial set, so it can actually face deflation):
on the earnings-REACTION session, if a name gapped UP >= gap_min on the news, take an
opening-range-breakout entry (exp04's one OOS-positive lever) with a wide 2.5x ATR stop
and a 1:2 target, hold <= max_hold sessions. Economic prior: a genuine positive surprise
triggers real institutional repricing; the ORB filters gap-and-fade; restricting to
earnings days concentrates the day-trade signal on high-information EVENTS rather than the
name-level RVOL noise that sank the raw Day Trade screener out-of-sample (exp01-03).

Reaction session (lookahead-free): the first session on/after report date E whose OPEN
gap (open/prevClose - 1) >= gap_min. A BMO report gaps on E's own session; an AMC report
gaps the next session — checking E then E+1 in order captures both using only each
session's own OPEN, which is known BEFORE the ORB entry decision. Long-only (gap-UP).

CRITICAL CONTROL: the identical ORB+exit on NON-earnings gap-ups (>= gap_min, away from
any report). If plain gap-ups do just as well, the EVENT is not the edge — it's just
"gap + ORB", which we already know is regime-fragile.

Deflation: gap thresholds {2%,3%,5%} and a beat-only subset are the searched trials; 3%
is the pre-registered PRIMARY. Per-trade Sharpes of all variants feed the Deflated Sharpe.
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

from intraday import entries, fmp
from intraday.daytrade import atr
from intraday.execution import CostModel, simulate_at
from intraday.metrics import summarize
from intraday.pipeline import date_plus, _pad
from intraday import deflate
from config import BacktestConfig

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"

GAP_BASE = 0.02          # loosest threshold — fetch windows once, sub-filter stricter ones
CONTROL_PER_SYMBOL = 14  # bound the non-earnings control's intraday fetches
ATR_MULT = 2.5           # wide stop (exp02 winner)
RR = 2.0                 # 1:2 target


def _first_ge(dc: list, date_str: str) -> int:
    for i, c in enumerate(dc):
        if c["date"] >= date_str:
            return i
    return -1


def reaction_index(dc: list, e_date: str, gap_min: float) -> int:
    """First of {E-session, E+1-session} whose open gap-up >= gap_min. -1 if neither."""
    i0 = _first_ge(dc, e_date)
    if i0 <= 0:
        return -1
    for j in (i0, i0 + 1):
        if j <= 0 or j >= len(dc):
            continue
        gap = dc[j]["open"] / dc[j - 1]["close"] - 1 if dc[j - 1]["close"] else 0
        if gap >= gap_min:
            return j
    return -1


def build_signals(cfg) -> dict:
    """Per symbol: earnings gap-up reaction sessions (at GAP_BASE) + the set of
    earnings-adjacent dates (to exclude from the control). Also returns daily candles so
    the control pass can reuse them. No intraday fetched here."""
    out = {}
    for sym in tqdm(cfg.universe, desc="daily+earnings"):
        try:
            dc = fmp.daily(sym, _pad(cfg.start, cfg.daily_lookback_days + 20), cfg.end)
        except Exception as ex:
            print(f"  ! {sym} daily failed: {ex}")
            continue
        if len(dc) < 30:
            continue
        ev = [e for e in fmp.earnings(sym) if cfg.start <= e["date"] <= cfg.end]
        sigs, adjacent = [], set()
        for e in ev:
            ri = reaction_index(dc, e["date"], GAP_BASE)
            if ri < 15 or dc[ri]["date"] > cfg.end:      # need ATR history; stay in window
                # still mark the report vicinity so the control avoids it
                i0 = _first_ge(dc, e["date"])
                for k in (i0 - 1, i0, i0 + 1):
                    if 0 <= k < len(dc):
                        adjacent.add(dc[k]["date"])
                continue
            a = atr(dc[:ri])                              # up to prev session — no lookahead
            if not a or a <= 0:
                continue
            gap = dc[ri]["open"] / dc[ri - 1]["close"] - 1
            epsA, epsE = e.get("epsActual"), e.get("epsEstimated")
            beat = (epsA is not None and epsE is not None and epsA > epsE)
            sigs.append(dict(symbol=sym, date=dc[ri]["date"], gap=round(gap, 4),
                             atr=a, beat=beat, epsActual=epsA, epsEstimated=epsE))
            for k in range(ri - 1, ri + 2):
                if 0 <= k < len(dc):
                    adjacent.add(dc[k]["date"])
        out[sym] = dict(daily=dc, signals=sigs, adjacent=adjacent)
    return out


def orb_trade(cfg, symbol: str, date: str, atr_val: float):
    """Fetch the reaction session (+ hold window), take the ORB entry on session-0, manage
    with a 2.5xATR stop / 1:2 target over <= max_hold sessions. Returns a TradeResult or
    None (no bars / no ORB breakout that session)."""
    # NB FMP historical-chart/5min caps bars per call (~7-8 sessions) ending at `to`, so a
    # wide `to` clips the earliest days OUT — the reaction session must sit near the START
    # of a TIGHT window to be returned. max_hold=3 only needs ~4 trading days.
    bars = fmp.intraday(symbol, cfg.interval, date, date_plus(date, 7))
    sess = fmp.group_by_session(bars)
    days = sorted(d for d in sess if d >= date)[: cfg.max_hold_sessions]
    if not days or days[0] != date:
        return None
    first = sess[days[0]]
    hit = entries.opening_range_breakout(first)
    if not hit:
        return None
    entry_px, idx = hit
    window = [b for d in days for b in sess[d]]
    stop = entry_px - ATR_MULT * atr_val
    target = entry_px + RR * (entry_px - stop)
    return simulate_at(window, entry_px, idx + 1, stop, target, COST)


def execute(cfg, sigs: list) -> list:
    """(signal, TradeResult) for every signal that filled an ORB entry."""
    rows = []
    for s in tqdm(sigs, desc="execute", leave=False):
        tr = orb_trade(cfg, s["symbol"], s["date"], s["atr"])
        if tr is not None:
            rows.append((s, tr))
    return rows


def blocks(rows, years, mid):
    trs = [tr for _, tr in rows]
    ov = summarize(trs)
    oos = summarize([tr for s, tr in rows if s["date"] >= mid])
    byyr = {y: summarize([tr for s, tr in rows if s["date"][:4] == y]) for y in years}
    pos = sum(1 for y in years if byyr[y].get("expectancy_pct", 0) > 0)
    return ov, oos, byyr, pos


def rets(rows):
    return [tr.net_return_pct / 100 for _, tr in rows]


def build_control(cfg, data) -> list:
    """Bounded non-earnings gap-up control: up to CONTROL_PER_SYMBOL evenly-spaced
    (outcome-agnostic) gap-ups >= GAP_BASE that are NOT earnings-adjacent."""
    ctrl_sigs = []
    for sym, d in data.items():
        dc, adjacent = d["daily"], d["adjacent"]
        cand = []
        for i in range(15, len(dc)):
            if not (cfg.start <= dc[i]["date"] <= cfg.end) or dc[i]["date"] in adjacent:
                continue
            gap = dc[i]["open"] / dc[i - 1]["close"] - 1 if dc[i - 1]["close"] else 0
            if gap >= GAP_BASE:
                a = atr(dc[:i])
                if a and a > 0:
                    cand.append(dict(symbol=sym, date=dc[i]["date"], gap=round(gap, 4), atr=a))
        if len(cand) > CONTROL_PER_SYMBOL:                # even stride, not gap-selected
            step = len(cand) / CONTROL_PER_SYMBOL
            cand = [cand[int(k * step)] for k in range(CONTROL_PER_SYMBOL)]
        ctrl_sigs.extend(cand)
    return execute(cfg, ctrl_sigs)


def run():
    print(f"Building earnings gap-up signals ({len(CFG.universe)} names, {CFG.start}->{CFG.end})…")
    data = build_signals(CFG)
    all_sigs = [s for d in data.values() for s in d["signals"]]
    print(f"  {len(all_sigs)} earnings gap-up reaction sessions (>= {GAP_BASE:.0%}).")

    print("Executing earnings ORB trades…")
    earn_rows = execute(CFG, all_sigs)

    dates = sorted(s["date"] for s, _ in earn_rows)
    if not dates:
        print("No filled earnings trades — aborting."); return
    mid = dates[len(dates) // 2]
    years = sorted(set(d[:4] for d in dates))

    # ---- variants (the searched trial set for deflation) ----
    variants = {
        "gap2":      [(s, tr) for s, tr in earn_rows if s["gap"] >= 0.02],
        "gap3_PRIMARY": [(s, tr) for s, tr in earn_rows if s["gap"] >= 0.03],
        "gap5":      [(s, tr) for s, tr in earn_rows if s["gap"] >= 0.05],
        "gap3_beat": [(s, tr) for s, tr in earn_rows if s["gap"] >= 0.03 and s["beat"]],
    }

    print("Executing NON-earnings gap-up CONTROL…")
    ctrl_rows = build_control(CFG, data)

    report = {"universe": len(CFG.universe), "window": [CFG.start, CFG.end],
              "earnings_signals": len(all_sigs), "earnings_filled": len(earn_rows),
              "split_at": mid, "variants": {}, "control": {}}

    print("\n" + "=" * 104)
    print("EARNINGS GAP-UP  ORB (2.5xATR stop, 1:2 target, hold<=3)  —  net of costs; OOS + yrs+ are honest")
    print("=" * 104)
    hdr = f"{'variant':<16}{'n':>6}{'win%':>7}{'LB':>6}{'exp%':>9}{'PF':>6}{'OOSexp%':>9}{'OOS_LB':>8}{'yrs+':>7}"
    print(hdr); print("-" * len(hdr))
    for name, rows in variants.items():
        if not rows:
            continue
        ov, oos, byyr, pos = blocks(rows, years, mid)
        report["variants"][name] = {"n": ov.get("n", 0), "overall": ov, "oos": oos,
                                    "by_year": byyr, "pos_years": pos}
        print(f"{name:<16}{ov.get('n',0):>6}{ov.get('win_rate',0):>7}{ov.get('win_rate_wilson_lb',0):>6}"
              f"{ov.get('expectancy_pct',0):>9}{ov.get('profit_factor',0):>6}"
              f"{oos.get('expectancy_pct',0):>9}{oos.get('win_rate_wilson_lb',0):>8}{pos:>6}/{len(years)}")

    # ---- DECISIVE: gap-bucketed earnings vs matched non-earnings control ----
    # If the dose-response (bigger gap → positive) lives in BOTH, it's a gap/breakout
    # effect; if it's earnings-only or much stronger in earnings, the EVENT is the edge.
    def bucket(g):
        return "5%+" if g >= 0.05 else ("3-5%" if g >= 0.03 else "2-3%")
    print("\n" + "-" * 74)
    print(f"{'GAP BUCKET':<10}{'| EARNINGS  n':>16}{'exp%':>8}{'PF':>6}{'  | CONTROL  n':>16}{'exp%':>8}{'PF':>6}{'  lift':>8}")
    print("-" * 74)
    report["by_gap_bucket"] = {}
    for b in ("2-3%", "3-5%", "5%+"):
        e_b = [(s, tr) for s, tr in earn_rows if bucket(s["gap"]) == b]
        c_b = [(s, tr) for s, tr in ctrl_rows if bucket(s["gap"]) == b]
        es, cs = summarize([t for _, t in e_b]), summarize([t for _, t in c_b])
        lift_b = round(es.get("expectancy_pct", 0) - cs.get("expectancy_pct", 0), 3)
        report["by_gap_bucket"][b] = {"earnings": es, "control": cs, "lift_pct": lift_b}
        print(f"{b:<10}{es.get('n',0):>16}{es.get('expectancy_pct',0):>8}{es.get('profit_factor',0):>6}"
              f"{cs.get('n',0):>16}{cs.get('expectancy_pct',0):>8}{cs.get('profit_factor',0):>6}{lift_b:>+8}")

    cov, coos, cby, cpos = blocks(ctrl_rows, years, mid)
    report["control"] = {"n": cov.get("n", 0), "overall": cov, "oos": coos, "pos_years": cpos}
    print("-" * len(hdr))
    print(f"{'CONTROL non-ER':<16}{cov.get('n',0):>6}{cov.get('win_rate',0):>7}{cov.get('win_rate_wilson_lb',0):>6}"
          f"{cov.get('expectancy_pct',0):>9}{cov.get('profit_factor',0):>6}"
          f"{coos.get('expectancy_pct',0):>9}{coos.get('win_rate_wilson_lb',0):>8}{cpos:>6}/{len(years)}")

    # ---- event lift: primary earnings vs the matched non-earnings control ----
    prim = variants["gap3_PRIMARY"]
    p_exp = report["variants"]["gap3_PRIMARY"]["overall"].get("expectancy_pct", 0)
    lift = round(p_exp - cov.get("expectancy_pct", 0), 3)
    report["event_lift_vs_control_pct"] = lift

    # ---- deflation on the PRIMARY, trials = the 4 variants ----
    trial_sharpes = [deflate.sharpe(rets(rows)) for rows in variants.values() if rows]
    dsr, sr0 = deflate.deflated_sharpe(rets(prim), trial_sharpes)
    psr0 = deflate.psr(rets(prim))
    # PBO across variants, periods = quarters
    def q(d): return f"{d[:4]}Q{(int(d[5:7]) - 1) // 3 + 1}"
    quarters = sorted(set(q(s["date"]) for s, _ in earn_rows))
    names = [n for n in variants if variants[n]]
    matrix = []
    for qq in quarters:
        row = []
        for n in names:
            rr = [tr.net_return_pct / 100 for s, tr in variants[n] if q(s["date"]) == qq]
            row.append(sum(rr) / len(rr) if rr else 0.0)
        matrix.append(row)
    pbo, n_combos = deflate.pbo_cscv(matrix, n_splits=8) if len(quarters) >= 8 else (float("nan"), 0)
    report["deflation"] = {"primary_psr": round(psr0, 3), "deflated_sharpe": round(dsr, 3),
                           "benchmark_max_sharpe": round(sr0, 4), "n_trials": len(trial_sharpes),
                           "pbo": round(pbo, 3) if pbo == pbo else None, "pbo_combos": n_combos}

    print("\nEVENT LIFT (primary earnings 3% − non-earnings control):  "
          f"{lift:+.3f}%/trade  (earnings {p_exp:+.3f} vs control {cov.get('expectancy_pct',0):+.3f})")
    print("\nDEFLATION (primary gap3, 4 trials):")
    print(f"  PSR {psr0:.3f}   Deflated Sharpe {dsr:.3f}  (bar 0.95; benchmark E[maxSR] {sr0:.4f})   "
          f"PBO {report['deflation']['pbo']}")

    # ---- verdict ----
    pov = report["variants"]["gap3_PRIMARY"]["overall"]
    poos = report["variants"]["gap3_PRIMARY"]["oos"]
    pos_years = report["variants"]["gap3_PRIMARY"]["pos_years"]
    edge = (pov.get("expectancy_pct", 0) > 0 and poos.get("expectancy_pct", 0) > 0
            and lift > 0 and pos_years >= len(years) - 1 and dsr >= 0.95)
    print("\nVERDICT:")
    if edge:
        report["verdict"] = "EDGE: earnings gap-up ORB is OOS-positive, beats the non-earnings control, year-consistent, AND survives deflation."
        print("  ✅ " + report["verdict"])
    elif (pov.get("expectancy_pct", 0) > 0 and poos.get("expectancy_pct", 0) > 0 and lift > 0):
        report["verdict"] = "LEAD: earnings gap-up ORB is OOS-positive and beats the control, but does not clear the deflation bar — a real event effect worth forward-tracking, not yet a proven edge."
        print("  🟡 " + report["verdict"])
    else:
        report["verdict"] = "NO EDGE: the earnings event does not rescue the intraday signal on this data/window."
        print("  ❌ " + report["verdict"])

    (OUT / "earnings_event.json").write_text(json.dumps(report, indent=2, default=str))
    print(f"\nSaved: {OUT/'earnings_event.json'}")


if __name__ == "__main__":
    run()
