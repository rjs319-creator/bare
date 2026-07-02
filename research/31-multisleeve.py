#!/usr/bin/env python3
"""Step 31 - Cross-sleeve DIVERSIFICATION (the mathematically-favored piece of lever #1).

  research/intraday/.venv/bin/python research/31-multisleeve.py

Step 30 showed single-sleeve sizing overlays don't give a free win. But combining
LOW-CORRELATION positive-Sharpe edges raises book Sharpe even when no single sleeve
improves -- that's just the math of diversification, and it's the one portfolio-
construction result that should be robust. Two genuinely different edges:
  MOM  = long top-decile 12-1 momentum, monthly (cross-sectional, corrected panel)
  GAP  = unscheduled-gap ORB event sleeve (intraday event; in cash between signals)
Test: their correlation, and whether an equal-weight or inverse-vol (risk-parity)
combined book beats the BEST single sleeve on realized Sharpe / maxDD, in + out of sample.

Honesty: the GAP monthly return = mean of that month's ORB trades (equal capital per
signal, cash when none) -- a sleeve proxy that ignores capacity/overlap. Different
sleeves cover slightly different spans; evaluated on the overlap.
"""
import json, os, math
import numpy as np

HERE = os.path.dirname(__file__)
PANEL = os.path.join(HERE, "data", "panel-features.json")
GAP = os.path.join(HERE, "intraday", "data", "gap_trades.json")

def mom_monthly():
    panel = json.load(open(PANEL))["panel"]
    out = {}
    for ym, rows in panel.items():
        r = [(x.get("m121"), x.get("f21")) for x in rows
             if x.get("m121") is not None and x.get("f21") is not None]
        if len(r) < 30: continue
        r.sort(key=lambda t: t[0])
        top = r[int(len(r)*0.9):]
        out[ym] = float(np.mean([max(-0.9, min(3.0, f)) for _, f in top]))
    return out

def gap_monthly():
    trades = json.load(open(GAP))
    by = {}
    for t in trades:
        by.setdefault(t["date"][:7], []).append(max(-0.9, min(3.0, t["ret"])))
    return {m: float(np.mean(v)) for m, v in by.items()}

def stats(a, name):
    a = np.asarray(a)
    if len(a) < 6: return None
    cagr = np.prod(1+a)**(12/len(a)) - 1
    vol = np.std(a, ddof=1)*math.sqrt(12)
    sh = np.mean(a)/np.std(a, ddof=1)*math.sqrt(12) if np.std(a) else float("nan")
    eq = np.cumprod(1+a); dd = float(np.min(eq/np.maximum.accumulate(eq)-1))
    return dict(name=name, CAGR=cagr, vol=vol, Sharpe=sh, maxDD=dd, Calmar=(cagr/abs(dd) if dd<0 else float("nan")), n=len(a))

def show(s):
    if s: print(f"  {s['name']:24s} CAGR {s['CAGR']*100:+6.1f}%  vol {s['vol']*100:4.1f}%  "
                f"Sharpe {s['Sharpe']:+.2f}  maxDD {s['maxDD']*100:6.1f}%  Calmar {s['Calmar']:.2f}  n={s['n']}")

def main():
    mom, gap = mom_monthly(), gap_monthly()
    months = sorted(set(mom) & set(gap))
    print(f"MOM months {min(mom)}..{max(mom)} | GAP months {min(gap)}..{max(gap)} | overlap {len(months)} "
          f"({months[0]}..{months[-1]})")
    m = np.array([mom[x] for x in months]); g = np.array([gap[x] for x in months])
    corr = float(np.corrcoef(m, g)[0, 1])
    print(f"\nsleeve correlation (monthly): {corr:+.3f}  (low => diversification pays)\n")

    print("=== single sleeves (overlap window) ===")
    sm, sg = stats(m, "MOM only"), stats(g, "GAP only"); show(sm); show(sg)

    # combined books
    eq = 0.5*m + 0.5*g
    # inverse-vol (risk parity), weights from TRAILING vol only (point-in-time)
    rp = []
    for i in range(len(months)):
        hm = m[max(0,i-6):i]; hg = g[max(0,i-6):i]
        vm = np.std(hm, ddof=1) if len(hm) >= 3 else 1.0
        vg = np.std(hg, ddof=1) if len(hg) >= 3 else 1.0
        wm = (1/vm)/((1/vm)+(1/vg)) if vm>0 and vg>0 else 0.5
        rp.append(wm*m[i] + (1-wm)*g[i])
    rp = np.array(rp)
    print("\n=== combined books ===")
    se, sr = stats(eq, "50/50 equal"), stats(rp, "inverse-vol (risk parity)"); show(se); show(sr)

    best_single = max(sm["Sharpe"], sg["Sharpe"])
    print(f"\n=== OUT-OF-SAMPLE (2nd half) ===")
    mid = len(months)//2
    for a, nm in [(m,"MOM only"),(g,"GAP only"),(eq,"50/50 equal"),(rp,"inverse-vol")]:
        show(stats(a[mid:], nm))

    print(f"\nVERDICT: diversification WINS if a combined book's Sharpe > best single sleeve "
          f"({best_single:+.2f}) with a shallower maxDD, holding OOS. corr={corr:+.2f}.")
    json.dump({"corr": corr, "mom": sm, "gap": sg, "equal": se, "risk_parity": sr},
              open(os.path.join(HERE, "data", "multisleeve.json"), "w"), default=float, indent=0)

if __name__ == "__main__":
    main()
