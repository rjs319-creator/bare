"""EXPERIMENT 10 — Intraday MICROSTRUCTURE meta-label for the unscheduled-gap ORB edge.

exp08 established the one deflation-surviving edge: unscheduled (non-earnings) gap-up >=5%
on a liquid name, entered on the opening-range breakout (2.5xATR stop, 1:2 target, hold<=3).
It is right-skewed / low-hit-rate — a minority of runners carry it. QUESTION: do INTRADAY
MICROSTRUCTURE features of the gap session (things the daily harness literally cannot see)
separate the runners from the fades, i.e. is there a take/skip META-LABEL that beats
taking every ORB fill, OUT of sample and after deflation?

Features (all computed CAUSALLY, at/-before the breakout bar — no lookahead):
  or_width   opening-range height / open (coiled vs sloppy open)
  or_vol     first-30min volume vs the PRIOR session's first-30min volume (fresh demand)
  brk_bar    time-to-breakout (bar index; earlier = stronger)
  brk_vol    breakout-bar volume / first-30min avg bar volume (thrust confirmation)
  vwap_dist  (entry - session VWAP thru breakout) / entry  (extended vs reclaimed)
  gap        the overnight gap itself (dose)

Method: for each gap>=3% event, run the exp08 ORB trade AND record features. Then:
 (1) univariate: split each feature at its in-sample median; compare OOS expectancy of the
     favorable vs unfavorable half (a real meta-label must survive OOS).
 (2) combined take/skip rule from the features that pass (1); compare OOS expectancy + PF
     vs take-ALL; deflate (PSR/Deflated-Sharpe with the trial count; PBO across quarters).
Honesty: exp06 already showed stacked intraday gates get DEFLATED away (DSR 0.59). The bar
is the same here — OOS-positive AND year-consistent AND DSR>=0.95, else it's search luck.
"""
from __future__ import annotations
import sys, json, statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src")); sys.path.insert(0, str(ROOT))

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
GAP_MIN, ADV_FLOOR = 0.05, 10_000_000      # PRIMARY tier (the validated one)
ATR_MULT, RR, K = 2.5, 2.0, entries.K_30M


def session_features(sess, days, entry_idx):
    """Causal microstructure of the gap session up to the breakout bar `entry_idx`."""
    first = sess[days[0]]
    orb = first[:K]
    or_high = max(b["high"] for b in orb); or_low = min(b["low"] for b in orb)
    open_px = first[0]["open"] or orb[0]["close"]
    or_vol30 = sum(b["volume"] for b in orb)
    # prior session's first-30min volume as the demand baseline
    prior = [d for d in sorted(sess) if d < days[0]]
    prior_vol30 = sum(b["volume"] for b in sess[prior[-1]][:K]) if prior else None
    # causal VWAP through the breakout bar
    cum_pv = cum_v = 0.0
    for b in first[:entry_idx + 1]:
        tp = (b["high"] + b["low"] + b["close"]) / 3
        cum_pv += tp * b["volume"]; cum_v += b["volume"]
    vwap = cum_pv / cum_v if cum_v else first[entry_idx]["close"]
    entry_px = or_high
    brk_vol = first[entry_idx]["volume"]
    avg_or_bar = or_vol30 / K if K else 1
    return {
        "or_width": (or_high - or_low) / open_px if open_px else None,
        "or_vol": (or_vol30 / prior_vol30) if prior_vol30 else None,
        "brk_bar": entry_idx,
        "brk_vol": (brk_vol / avg_or_bar) if avg_or_bar else None,
        "vwap_dist": (entry_px - vwap) / entry_px if entry_px else None,
    }


def build(cfg):
    sigs = []
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
            if not (cfg.start <= c["date"] <= cfg.end) or c["date"] in adjacent or not dc[i - 1]["close"]:
                continue
            gap = c["open"] / dc[i - 1]["close"] - 1
            if gap < GAP_MIN:
                continue
            adv = statistics.mean(x["close"] * x["volume"] for x in dc[i - 20:i])
            a = atr(dc[:i])
            if adv < ADV_FLOOR or not a or a <= 0:
                continue
            sigs.append(dict(symbol=sym, date=c["date"], gap=round(gap, 4), atr=a))
    return sigs


def execute(sigs):
    rows = []
    for s in tqdm(sigs, desc="exec", leave=False):
        bars = fmp.intraday(s["symbol"], CFG.interval, date_plus(s["date"], -3), date_plus(s["date"], 7))
        sess = fmp.group_by_session(bars)
        days = sorted(d for d in sess if d >= s["date"])[: CFG.max_hold_sessions]
        if not days or days[0] != s["date"]:
            continue
        hit = entries.opening_range_breakout(sess[days[0]])
        if not hit:
            continue
        entry_px, idx = hit
        feats = session_features(sess, days, idx)
        window = [b for d in days for b in sess[d]]
        stop = entry_px - ATR_MULT * s["atr"]
        tr = simulate_at(window, entry_px, idx + 1, stop, entry_px + RR * (entry_px - stop), COST)
        if tr is None:
            continue
        rows.append(dict(s=s, feats=feats, ret=tr.net_return_pct / 100, tr=tr))
    return rows


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def exp_pct(rs):
    return round(100 * sum(rs) / len(rs), 3) if rs else 0.0


def run():
    print(f"Building unscheduled gap>={GAP_MIN:.0%} events + microstructure ({len(CFG.universe)} names, "
          f"{CFG.start}->{CFG.end})…")
    sigs = build(CFG)
    print(f"  {len(sigs)} gap events; executing ORB…")
    rows = execute(sigs)
    if len(rows) < 40:
        print(f"only {len(rows)} filled trades — too few."); return
    dates = sorted(r["s"]["date"] for r in rows)
    mid = dates[len(dates) // 2]
    years = sorted(set(d[:4] for d in dates))
    is_rows = [r for r in rows if r["s"]["date"] < mid]
    print(f"  {len(rows)} ORB fills; IS split at {mid} ({len(is_rows)} IS / {len(rows)-len(is_rows)} OOS)")
    base = summarize([r["tr"] for r in rows])
    print(f"\ntake-ALL ORB: n={base['n']} exp {base['expectancy_pct']}% PF {base['profit_factor']} "
          f"win% {base['win_rate']} (LB {base['win_rate_wilson_lb']})")

    FEATS = ["gap", "or_width", "or_vol", "brk_bar", "brk_vol", "vwap_dist"]
    def fval(r, f):
        return r["s"]["gap"] if f == "gap" else r["feats"].get(f)
    # (1) univariate OOS: does the favorable half (learned on IS) beat the other OOS?
    print("\n=== univariate meta-label (median split learned IS, expectancy OOS) ===")
    print(f"{'feature':<10}{'IS_hi':>9}{'IS_lo':>9}{'dir':>5}{'OOS_fav':>9}{'OOS_unf':>9}{'OOS_edge':>10}")
    keepers = []
    for f in FEATS:
        thr = med([fval(r, f) for r in is_rows])
        if thr is None:
            continue
        is_hi = exp_pct([r["ret"] for r in is_rows if (v := fval(r, f)) is not None and v >= thr])
        is_lo = exp_pct([r["ret"] for r in is_rows if (v := fval(r, f)) is not None and v < thr])
        direction = 1 if is_hi >= is_lo else -1                # favor high if high did better IS
        def favored(r):
            v = fval(r, f); return v is not None and ((v >= thr) if direction == 1 else (v < thr))
        oos = [r for r in rows if r["s"]["date"] >= mid]
        oos_fav = exp_pct([r["ret"] for r in oos if favored(r)])
        oos_unf = exp_pct([r["ret"] for r in oos if not favored(r) and fval(r, f) is not None])
        edge = round(oos_fav - oos_unf, 3)
        star = " *" if edge > 0 else ""
        print(f"{f:<10}{is_hi:>9}{is_lo:>9}{('hi' if direction==1 else 'lo'):>5}{oos_fav:>9}{oos_unf:>9}{edge:>10}{star}")
        if edge > 0:
            keepers.append((f, thr, direction))

    # (2) combined take/skip from OOS-surviving features -> take only trades favored by ALL keepers
    print(f"\n=== combined meta-label: keep trades favored by all {len(keepers)} OOS-surviving feature(s) ===")
    def favored_all(r):
        for f, thr, direction in keepers:
            v = fval(r, f)
            if v is None: return False
            if (v >= thr) if direction == 1 else (v < thr):
                continue
            return False
        return True
    if not keepers:
        print("  no feature survived OOS — nothing to combine.")
        verdict = "NO EDGE: no intraday microstructure feature separates ORB winners OOS."
    else:
        kept = [r for r in rows if favored_all(r)]
        koos = [r for r in kept if r["s"]["date"] >= mid]
        ks = summarize([r["tr"] for r in kept]); koos_s = summarize([r["tr"] for r in koos])
        pos = sum(1 for y in years if exp_pct([r["ret"] for r in kept if r["s"]["date"][:4] == y]) > 0)
        print(f"  take-META : n={ks['n']} exp {ks['expectancy_pct']}% PF {ks['profit_factor']}  "
              f"OOS exp {koos_s.get('expectancy_pct',0)}% (n={koos_s.get('n',0)})  yrs+ {pos}/{len(years)}")
        print(f"  take-ALL  : n={base['n']} exp {base['expectancy_pct']}% PF {base['profit_factor']}  "
              f"OOS exp {summarize([r['tr'] for r in rows if r['s']['date']>=mid]).get('expectancy_pct',0)}%")
        # deflation: trials = the univariate features searched
        trial_sharpes = [deflate.sharpe([r["ret"] for r in rows if (v := fval(r, f)) is not None and v >= (med([fval(x,f) for x in is_rows]) or 0)]) for f in FEATS]
        dsr, sr0 = deflate.deflated_sharpe([r["ret"] for r in kept], trial_sharpes)
        psr0 = deflate.psr([r["ret"] for r in kept])
        print(f"  deflation : PSR {psr0:.3f}  Deflated Sharpe {dsr:.3f} (bar 0.95, {len(trial_sharpes)} trials, benchmark {sr0:.4f})")
        improved = koos_s.get("expectancy_pct", 0) > exp_pct([r["ret"] for r in rows if r["s"]["date"] >= mid])
        if improved and pos >= len(years) - 1 and dsr >= 0.95:
            verdict = "EDGE: microstructure meta-label improves OOS expectancy, year-consistent, survives deflation."
        elif improved and pos >= len(years) - 1:
            verdict = "LEAD: improves OOS + year-consistent but fails the deflation bar — forward-track, don't size on it."
        elif improved:
            verdict = "WEAK: OOS improvement not year-robust — likely a window/selection artifact."
        else:
            verdict = "NO EDGE: microstructure meta-label does not beat take-all ORB out of sample."

    print("\nVERDICT:\n  " + verdict)
    (OUT / "microstructure.json").write_text(json.dumps(
        {"n_signals": len(sigs), "n_fills": len(rows), "split_at": mid, "keepers": [k[0] for k in keepers],
         "take_all": base, "verdict": verdict}, indent=2, default=str))
    # per-trade stream for the cross-sleeve diversification + hardened book sims (steps 31/32)
    (OUT / "gap_trades.json").write_text(json.dumps(
        [{"date": r["s"]["date"], "ret": r["ret"], "bars_held": r["tr"].bars_held,
          "exit_reason": r["tr"].exit_reason} for r in rows], default=str))
    print(f"Saved: {OUT/'microstructure.json'} + gap_trades.json ({len(rows)} trades)")


if __name__ == "__main__":
    run()
