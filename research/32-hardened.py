#!/usr/bin/env python3
"""Step 32 - HARDEN the cross-sleeve diversification result (step 31).

  research/intraday/.venv/bin/python research/32-hardened.py

Step 31's win could be a flattery artifact: the GAP sleeve return was the mean of a
month's ORB trades, which (a) diversifies WITHIN the month for free and (b) ignores
capital/capacity. This rebuilds GAP as a real capital-aware book and re-tests:
  - GAP = K parallel equal-capital SLOTS, capacity-capped (a signal is SKIPPED if all K
    slots are busy given each trade's actual hold length from bars_held), each slot
    COMPOUNDS its trades. No within-month averaging beyond the K real positions.
  - MOM = top-decile momentum with a turnover cost drag (high-churn decile).
  - Combined = inverse-vol (risk parity) on the hardened monthly sleeve returns.
  - SIGNIFICANCE: moving-block bootstrap of the JOINT monthly (mom,gap) series (preserves
    cross-correlation) -> distribution of (combined Sharpe - best single Sharpe). The
    diversification benefit is real only if its 5th percentile > 0.
Sensitivity: K in {3,5,10}, momentum cost in {0, 15, 30} bps/mo.
"""
import json, os, math, datetime as dt
import numpy as np

HERE = os.path.dirname(__file__)
PANEL = os.path.join(HERE, "data", "panel-features.json")
GAP = os.path.join(HERE, "intraday", "data", "gap_trades.json")
BARS_PER_DAY = 78

def mom_monthly(cost_bps_per_mo=15.0):
    panel = json.load(open(PANEL))["panel"]
    out = {}
    for ym, rows in panel.items():
        r = [(x.get("m121"), x.get("f21")) for x in rows
             if x.get("m121") is not None and x.get("f21") is not None]
        if len(r) < 30: continue
        r.sort(key=lambda t: t[0])
        top = r[int(len(r)*0.9):]
        gross = float(np.mean([max(-0.9, min(3.0, f)) for _, f in top]))
        out[ym] = gross - cost_bps_per_mo/1e4          # turnover drag
    return dict(sorted(out.items()))

def gap_book_monthly(K=5):
    """Capital-aware GAP book: K equal-capital slots, capacity-capped, compounding."""
    trades = sorted(json.load(open(GAP)), key=lambda t: t["date"])
    slot_free = [0]*K                                  # ordinal date each slot frees up
    slot_month = [dict() for _ in range(K)]            # slot -> {ym: growth-factor}
    taken = skipped = 0
    for t in trades:
        o = dt.date.fromisoformat(t["date"]).toordinal()
        hold = max(1, round(t["bars_held"]/BARS_PER_DAY))
        j = next((s for s in range(K) if slot_free[s] <= o), None)
        if j is None:                                   # all slots busy => capacity skip
            skipped += 1; continue
        slot_free[j] = o + int(hold*1.5)               # ~calendar days incl weekends
        ym = t["date"][:7]
        slot_month[j][ym] = slot_month[j].get(ym, 1.0) * (1 + max(-0.9, min(3.0, t["ret"])))
        taken += 1
    months = sorted({m for sm in slot_month for m in sm})
    out = {}
    for m in months:
        # equal capital across K slots; a slot with no trade that month returns 0 (cash)
        out[m] = float(np.mean([slot_month[s].get(m, 1.0) - 1 for s in range(K)]))
    return out, taken, skipped

def stats(a, name):
    a = np.asarray(a, float)
    if len(a) < 6: return None
    cagr = np.prod(1+a)**(12/len(a)) - 1
    sd = np.std(a, ddof=1)
    sh = np.mean(a)/sd*math.sqrt(12) if sd else float("nan")
    eq = np.cumprod(1+a); dd = float(np.min(eq/np.maximum.accumulate(eq)-1))
    return dict(name=name, CAGR=cagr, vol=sd*math.sqrt(12), Sharpe=sh, maxDD=dd,
                Calmar=(cagr/abs(dd) if dd<0 else float("nan")), n=len(a))

def show(s):
    if s: print(f"  {s['name']:26s} CAGR {s['CAGR']*100:+6.1f}%  vol {s['vol']*100:4.1f}%  "
                f"Sharpe {s['Sharpe']:+.2f}  maxDD {s['maxDD']*100:6.1f}%  Calmar {s['Calmar']:.2f}")

def inv_vol(m, g):
    out = []
    for i in range(len(m)):
        hm, hg = m[max(0,i-6):i], g[max(0,i-6):i]
        vm = np.std(hm, ddof=1) if len(hm) >= 3 else 1.0
        vg = np.std(hg, ddof=1) if len(hg) >= 3 else 1.0
        wm = (1/vm)/((1/vm)+(1/vg)) if vm>0 and vg>0 else 0.5
        out.append(wm*m[i] + (1-wm)*g[i])
    return np.array(out)

def sharpe(a):
    a = np.asarray(a, float); sd = np.std(a, ddof=1)
    return np.mean(a)/sd*math.sqrt(12) if sd else 0.0

def block_bootstrap_diff(m, g, n=3000, block=4, seed=0):
    """Moving-block bootstrap of JOINT (m,g) months -> dist of combined - best-single Sharpe."""
    rng = np.random.default_rng(seed); T = len(m); diffs = []
    for _ in range(n):
        idx = []
        while len(idx) < T:
            s = rng.integers(0, T-block+1); idx += list(range(s, s+block))
        idx = idx[:T]
        mm, gg = m[idx], g[idx]
        comb = inv_vol(mm, gg)
        diffs.append(sharpe(comb) - max(sharpe(mm), sharpe(gg)))
    return np.percentile(diffs, [5, 50, 95])

def main():
    print("=== HARDENED cross-sleeve book (capacity-capped GAP, momentum turnover cost) ===")
    for K in (3, 5, 10):
        for cost in (0, 15, 30):
            mom = mom_monthly(cost); gapd, taken, skipped = gap_book_monthly(K)
            months = sorted(set(mom) & set(gapd))
            m = np.array([mom[x] for x in months]); g = np.array([gapd[x] for x in months])
            comb = inv_vol(m, g)
            corr = np.corrcoef(m, g)[0, 1]
            sm, sg, sc = sharpe(m), sharpe(g), sharpe(comb)
            print(f"\nK={K} slots, mom cost {cost}bps/mo | GAP taken {taken}/skipped {skipped} | "
                  f"overlap {len(months)}mo | corr {corr:+.2f}")
            print(f"    MOM Sh {sm:+.2f} | GAP Sh {sg:+.2f} | COMBINED(inv-vol) Sh {sc:+.2f}  "
                  f"(vs best single {max(sm,sg):+.2f}, delta {sc-max(sm,sg):+.2f})")
    # detailed table + bootstrap at the central config
    K, cost = 5, 15
    mom = mom_monthly(cost); gapd, taken, skipped = gap_book_monthly(K)
    months = sorted(set(mom) & set(gapd))
    m = np.array([mom[x] for x in months]); g = np.array([gapd[x] for x in months])
    comb = inv_vol(m, g)
    print(f"\n=== detail @ K={K}, cost={cost}bps ({months[0]}..{months[-1]}, {len(months)}mo) ===")
    for a, nm in [(m,"MOM (net)"),(g,"GAP (capacity-capped)"),(comb,"COMBINED inv-vol")]:
        show(stats(a, nm))
    mid = len(months)//2
    print("  --- OOS (2nd half) ---")
    for a, nm in [(m,"MOM (net)"),(g,"GAP capped"),(comb,"COMBINED inv-vol")]:
        show(stats(a[mid:], nm))
    lo, md, hi = block_bootstrap_diff(m, g)
    print(f"\nBLOCK-BOOTSTRAP  combined-minus-best-single Sharpe: median {md:+.2f}  90% CI [{lo:+.2f}, {hi:+.2f}]")
    verdict = ("SURVIVES: diversification benefit positive with 5th-pctile > 0 even after capacity + costs."
               if lo > 0 else
               "FRAGILE: benefit's 90% CI includes <=0 after capacity/costs — the combined book is ~the "
               "GAP sleeve; diversification lift is not robust to realistic frictions.")
    print("\nVERDICT: " + verdict)
    json.dump({"corr": float(np.corrcoef(m,g)[0,1]), "boot_ci": [float(lo),float(md),float(hi)],
               "combined": stats(comb,"combined"), "gap": stats(g,"gap"), "mom": stats(m,"mom"),
               "gap_taken": taken, "gap_skipped": skipped, "verdict": verdict},
              open(os.path.join(HERE, "data", "hardened.json"), "w"), default=float, indent=0)

if __name__ == "__main__":
    main()
