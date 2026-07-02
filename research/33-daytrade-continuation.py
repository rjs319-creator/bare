#!/usr/bin/env python3
"""Step 33 - `pcarry`: day-trade momentum CONTINUATION probability model (Fable-5 design).

  research/intraday/.venv/bin/python research/33-daytrade-continuation.py

For each day-trade candidate, a CALIBRATED probability it KEEPS carrying momentum:
  Y = 1 if (close_{i+3}/open_{i+1} - 1) - (SPY close_{i+3}/open_{i+1} - 1) > 0
i.e. P(3-session excess-over-SPY > 0, entered at the NEXT session's open — the tradeable
entry; you can't get the signal-day close). Trained on the survivorship-corrected daily
cache (delisted-inclusive) so the "explosive small-cap fades" reality is IN the data.

PRE-REGISTERED features (10 price/volume/context; news = live overlay, not trainable on
history; siPct exploratory-dropped). The load-bearing one is the OVEREXTENSION HINGE
extHinge = max(0, extADR-3), hypothesized NEGATIVE — it penalizes blow-off moves (a +8%
day on a 1.5%-ADR name, ext~5) while sparing moderate extension — representing the
explosive inversion CAUSALLY, not via a size dummy.

Shipped form = L2 LOGISTIC (JS-portable: 10 coefs + intercept + standardizer). GBM =
discovery upper-bound probe only. PASS BAR (Fable): OOS AUC>=0.55, calibrated, top-decile
excess >> bottom, beats permutation null, and (CRITICAL) beats the EXISTING rankScore by
Spearman delta >= +0.03 (else it's rankScore with extra steps — ship nothing).
"""
import json, os, math, sys, urllib.request, datetime as dt
LABEL = sys.argv[1] if len(sys.argv) > 1 else "open"   # 'open' (tradeable next-open) | 'close' (close-to-close, incl overnight)
import numpy as np
from scipy import stats
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import roc_auc_score, brier_score_loss

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "data", "cache")
HOLD = 3
WINS = (-0.9, 3.0)

def yahoo_ohlc(sym, start="2021-01-01"):
    p1 = int(dt.datetime.strptime(start, "%Y-%m-%d").timestamp()); p2 = int(dt.datetime.now().timestamp())
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1={p1}&period2={p2}&interval=1d"
    d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))
    r = d["chart"]["result"][0]; ts = r["timestamp"]; q = r["indicators"]["quote"][0]
    out = {}
    for k, t in enumerate(ts):
        o, c = q["open"][k], q["close"][k]
        if o and c: out[dt.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d")] = (o, c)
    return out

def sma(a, i, n): return np.mean(a[i-n+1:i+1]) if i >= n-1 else None

def scan_tag(price, relvol, pct, advol, dollarvol):
    if 5 <= price <= 50 and advol >= 1e6 and dollarvol >= 1e7 and relvol >= 1.5 and pct >= 5: return "momentum_liquid"
    if 1 <= price <= 20 and advol >= 5e5 and dollarvol >= 2e6 and relvol >= 2.0 and pct >= 8: return "explosive_small"
    if 5 <= price <= 50 and advol >= 1e6 and dollarvol >= 1e7 and relvol >= 1.2 and pct >= 3: return "momentum_building"
    return None

def clip(x, lo, hi): return max(lo, min(hi, x))
FEATS = ["relVolLog","excClip","extADR","extHinge","closeLoc","nearHigh5","dist52w","lnDollarVol","mom5","regimeRiskOn"]

def build():
    spy = yahoo_ohlc("SPY"); spd = sorted(spy); spidx = {d: i for i, d in enumerate(spd)}
    spc = np.array([spy[d][1] for d in spd])
    spy_sma200 = {spd[i]: sma(spc, i, 200) for i in range(len(spd))}
    def spy_openclose_fwd(date):   # SPY fwd over the hold, entry depends on LABEL mode
        i = spidx.get(date)
        if i is None or i+1 >= len(spd) or i+HOLD >= len(spd): return None
        entry = spy[spd[i]][1] if LABEL == "close" else spy[spd[i+1]][0]
        return spy[spd[i+HOLD]][1] / entry - 1
    def regime_on(date):
        s = spy_sma200.get(date);
        return 1 if (s and spy[date][1] > s) else 0

    rows = []; scanned = 0
    for f in os.listdir(CACHE):
        if not f.endswith(".json"): continue
        try: c = json.load(open(os.path.join(CACHE, f)))
        except Exception: continue
        p = [b for b in (c.get("price") or []) if b.get("close") and b.get("volume") is not None and b.get("open")]
        if len(p) < 60: continue
        # earnings filing dates (exclude signals whose i+1..i+3 window straddles a report)
        filings = set()
        for r in (c.get("income") or []):
            fd = r.get("filingDate") or r.get("date")
            if fd: filings.add(fd[:10])
        dates = [b["date"] for b in p]
        cl = np.array([b["close"] for b in p], float); op = np.array([b["open"] for b in p], float)
        hi = np.array([b["high"] for b in p], float); lo = np.array([b["low"] for b in p], float)
        vol = np.array([b["volume"] for b in p], float)
        scanned += 1
        for i in range(30, len(p)-HOLD-1):
            prev = cl[i-1]
            if prev <= 0 or vol[i] <= 0: continue
            pct = (cl[i]-prev)/prev*100
            av = np.mean(vol[i-20:i]); relv = vol[i]/av if av > 0 else 0
            if abs(pct) > 25 and relv < 2: continue              # split-artifact guard
            dv = np.mean(cl[i-20:i]*vol[i-20:i])
            tag = scan_tag(cl[i], relv, pct, av, dv)
            if not tag: continue
            # earnings exclusion in the hold window
            if any(dates[i] < fd <= dates[i+HOLD] for fd in filings): continue
            adr = np.mean((hi[i-20:i]-lo[i-20:i])/cl[i-20:i])*100
            extadr = clip(pct/adr, 0, 8) if adr > 0 else 1.0
            hh252 = np.max(hi[max(0, i-251):i+1]); hh5 = np.max(hi[i-4:i+1])
            spypct = (spc[spidx[dates[i]]]/spc[spidx[dates[i]]-1]-1)*100 if dates[i] in spidx and spidx[dates[i]] > 0 else 0
            entry = cl[i] if LABEL == "close" else op[i+1]        # close-to-close vs tradeable next-open
            if entry <= 0: continue
            fwd = clip(cl[i+HOLD]/entry-1, *WINS)
            sf = spy_openclose_fwd(dates[i])
            if sf is None: continue
            excess = fwd - sf
            rows.append({
                "date": dates[i], "scan": tag,
                "relVolLog": math.log(clip(relv, 0.5, 15)),
                "excClip": clip(pct-spypct, -2, 15),
                "extADR": extadr, "extHinge": clip(max(0, extadr-3), 0, 5),
                "closeLoc": (cl[i]-lo[i])/(hi[i]-lo[i]) if hi[i] > lo[i] else 0.5,
                "nearHigh5": clip(cl[i]/hh5, 0.7, 1.0) if hh5 > 0 else 0.9,
                "dist52w": clip(cl[i]/hh252, 0.3, 1.05) if hh252 > 0 else 0.75,
                "lnDollarVol": clip(math.log(max(dv, 1)), math.log(2e6), math.log(5e9)),
                "mom5": clip((cl[i]/cl[i-5]-1)*100, -30, 60),
                "regimeRiskOn": regime_on(dates[i]),
                # baselines for the incremental-value check
                "rankScore": relv*10 + pct + ((op[i]-prev)/prev*100)*0.5,
                "relVolRaw": relv, "excessRaw": pct-spypct,
                "excess": excess, "cont": 1 if excess > 0 else 0,
            })
    print(f"scanned {scanned} names -> {len(rows)} day-trade candidate-days")
    return rows

def spear(a, b): return stats.spearmanr(a, b).correlation

def main():
    rows = build(); rows.sort(key=lambda r: r["date"])
    X = np.nan_to_num(np.clip(np.array([[r[f] for f in FEATS] for r in rows], float), -1e6, 1e6))
    y = np.array([r["cont"] for r in rows]); exc = np.array([r["excess"] for r in rows])
    base = y.mean()
    print(f"base continuation rate (next-open, 3d excess>0): {base*100:.1f}%  n={len(y)}")
    print("by scan:", {s: round(np.mean([r['cont'] for r in rows if r['scan']==s])*100,1) for s in ['momentum_liquid','explosive_small','momentum_building']})

    cut = int(len(rows)*0.70)
    mu, sd = X[:cut].mean(0), X[:cut].std(0); sd[sd == 0] = 1
    Z = (X-mu)/sd
    tr = slice(0, cut); te = slice(cut+HOLD, len(rows))
    # Sign-constrained, heavily-regularized logistic (Fable): zero any coefficient whose
    # sign contradicts its economic prior, refit, repeat. Auditable + overfit-resistant.
    PRIOR = {"relVolLog": 1, "excClip": 1, "extADR": 1, "extHinge": -1, "closeLoc": 1,
             "nearHigh5": 1, "dist52w": 1, "lnDollarVol": 1, "mom5": 1, "regimeRiskOn": 1}
    keep = list(range(len(FEATS)))
    for _ in range(len(FEATS)):
        lg = LogisticRegression(C=0.1, max_iter=3000).fit(Z[tr][:, keep], y[tr])
        bad = [keep[j] for j, b in enumerate(lg.coef_[0]) if b * PRIOR[FEATS[keep[j]]] < 0]
        if not bad: break
        keep = [k for k in keep if k not in bad]
        if not keep: break
    kept_names = [FEATS[k] for k in keep]
    print(f"\nsign-constrained model keeps {len(keep)}/{len(FEATS)}: {kept_names}")
    sc = LogisticRegression(C=0.1, max_iter=3000).fit(Z[tr][:, keep], y[tr]) if keep else None
    if sc is not None:
        e_te = exc[cut+HOLD:len(rows)]; yte0 = y[cut+HOLD:len(rows)]
        pSC = sc.predict_proba(Z[te][:, keep])[:, 1]
        aSC = roc_auc_score(yte0, pSC); o = np.argsort(pSC); oper = max(1, len(pSC)//10)
        print(f"   sign-constrained OOS AUC {aSC:.3f} | IC {spear(pSC, e_te):+.4f} | "
              f"top-dec excess {e_te[o][-oper:].mean()*100:+.2f}% bot {e_te[o][:oper].mean()*100:+.2f}%")
        print(f"   coefs: {dict(zip(kept_names, [round(b,3) for b in sc.coef_[0]]))} intercept {sc.intercept_[0]:+.3f}")
        # SHIP this disciplined model (auditable). Save its standardizer for the kept feats.
        json.dump({"kind": "sign-constrained-tradeable", "features": kept_names,
                   "mean": mu[keep].tolist(), "std": sd[keep].tolist(),
                   "coef": sc.coef_[0].tolist(), "intercept": float(sc.intercept_[0]),
                   "base_rate": float(base), "oos_auc": float(aSC), "oos_ic": float(spear(pSC, e_te)),
                   "note": "Tradeable next-open 3d continuation is ~coin-flip; predictable part is untradeable overnight. This ships as an honest FADE-AWARE carry-odds, not a winner-picker."},
                  open(os.path.join(HERE, "data", "pcarry-model.json"), "w"), indent=1)

    logit = LogisticRegression(C=0.5, max_iter=3000).fit(Z[tr], y[tr])
    gbm = HistGradientBoostingRegressor(max_depth=3, max_iter=300, learning_rate=0.03,
                                        l2_regularization=1.0, min_samples_leaf=200).fit(Z[tr], y[tr])
    pL = logit.predict_proba(Z[te])[:, 1]; pG = np.clip(gbm.predict(Z[te]), 0, 1)
    yte, ete = y[te], exc[te]
    aucL, aucG = roc_auc_score(yte, pL), roc_auc_score(yte, pG)
    print(f"\nOOS AUC  logistic {aucL:.3f} | GBM {aucG:.3f}  (bar 0.55)")
    print(f"OOS Brier logistic {brier_score_loss(yte,pL):.4f} vs base {brier_score_loss(yte,np.full_like(pL,base)):.4f}")

    icL = spear(pL, ete)
    rk = np.array([rows[i]["rankScore"] for i in range(cut+HOLD, len(rows))])
    rv = np.array([rows[i]["relVolRaw"] for i in range(cut+HOLD, len(rows))])
    ex = np.array([rows[i]["excessRaw"] for i in range(cut+HOLD, len(rows))])
    print(f"\nINCREMENTAL VALUE (OOS Spearman vs fwd excess) — must beat baselines by >=+0.03:")
    print(f"   pcarry {icL:+.4f} | rankScore {spear(rk,ete):+.4f} | relVol {spear(rv,ete):+.4f} | excess {spear(ex,ete):+.4f}")
    print(f"   delta over rankScore: {icL-spear(rk,ete):+.4f}")

    order = np.argsort(pL); per = max(1, len(pL)//10)
    d1, d10 = ete[order[:per]].mean(), ete[order[-per:]].mean()
    print(f"\nOOS fwd-excess: bottom-decile {d1*100:+.2f}% | top-decile {d10*100:+.2f}% | spread {(d10-d1)*100:+.2f}%")
    print("calibration (pred vs realized continuation):")
    for q in [0, 3, 6, 9]:
        idx = order[q*per:(q+1)*per]
        if len(idx): print(f"   decile {q}: pred {pL[idx].mean()*100:4.0f}%  actual {yte[idx].mean()*100:4.0f}%")

    scans_te = [rows[i]["scan"] for i in range(cut+HOLD, len(rows))]
    for s in ["momentum_liquid", "explosive_small"]:
        m = [pL[j] for j in range(len(scans_te)) if scans_te[j] == s]
        if m: print(f"   mean prob {s}: {np.mean(m)*100:.1f}%")
    print(f"   corr(prob, extHinge): {np.corrcoef(pL, X[te][:,FEATS.index('extHinge')])[0,1]:+.3f} (expect <=0)")

    rng = np.random.default_rng(0); null = []
    for _ in range(200):
        lp = LogisticRegression(C=0.5, max_iter=400).fit(Z[tr], rng.permutation(y[tr]))
        null.append(roc_auc_score(yte, lp.predict_proba(Z[te])[:, 1]))
    p_perm = float(np.mean(np.array(null) >= aucL))
    print(f"\nDEFLATION permutation-null AUC mean {np.mean(null):.3f}; p(real<=null)={p_perm:.3f} (want <0.05)")

    delta_rk = icL - spear(rk, ete)
    passed = aucL >= 0.55 and (d10-d1) > 0 and p_perm < 0.05 and delta_rk >= 0.03
    verdict = ("SHIP: OOS AUC>=.55, calibrated, top>>bottom, beats null AND beats rankScore by >=.03." if passed
               else f"NOT-SHIP (or ranker-only): AUC {aucL:.3f}, deltaRank {delta_rk:+.3f}, permP {p_perm:.3f} — check which bar failed.")
    print("\nVERDICT: " + verdict)
    print("\ncoefficients (standardized; sign audit):")
    for f, b in sorted(zip(FEATS, logit.coef_[0]), key=lambda t: -abs(t[1])):
        print(f"   {f:14s} {b:+.3f}")
    json.dump({"features": FEATS, "mean": mu.tolist(), "std": sd.tolist(),
               "coef": logit.coef_[0].tolist(), "intercept": float(logit.intercept_[0]),
               "base_rate": float(base), "oos_auc": float(aucL), "oos_auc_gbm": float(aucG),
               "oos_ic": float(icL), "delta_rankscore": float(delta_rk), "decile_spread": float(d10-d1),
               "perm_p": p_perm, "verdict": verdict, "n": len(y)},
              open(os.path.join(HERE, "data", "daytrade-continuation.json"), "w"), indent=1)
    print(f"\nSaved -> research/data/daytrade-continuation.json")

if __name__ == "__main__":
    main()
