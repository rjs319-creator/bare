#!/usr/bin/env python3
"""Step 30 - Portfolio construction / sizing overlay (raise REALIZED edge, no new alpha).

  research/intraday/.venv/bin/python research/30-sizing.py

The prior rounds proved there is no new predictive SIGNAL to find in free data. But
realized return != signal IC: the app has validated edges and NO book-level risk
management. This tests the highest-confidence lever left -- turning the same momentum
edge into a better REALIZED equity curve via:
  (a) regime gating   - cut gross exposure in risk-off (VIX>=28 | SPY<200DMA | VIX pctl>=90&rising)
  (b) vol targeting    - scale exposure to a constant target vol (trailing strategy vol)
  (c) both
vs the naive fixed-exposure book. Metrics: annualized Sharpe, max drawdown, Calmar,
CAGR -- full and OUT-OF-SAMPLE (2nd half). A real win: higher Sharpe AND smaller maxDD
without hunting a single new factor.

Book = long-only top-decile 12-1 momentum on the survivorship-corrected small/mid panel,
monthly rebalance, equal weight, next-month (f21) realized returns.
"""
import json, os, math, urllib.request, datetime as dt
import numpy as np

HERE = os.path.dirname(__file__)
PANEL = os.path.join(HERE, "data", "panel-features.json")
TARGET_VOL = 0.12          # annualized vol target for the vol-targeted overlay
MAX_LEV = 1.5              # cap leverage so vol-targeting can't blow up in calm periods

def load_panel():
    d = json.load(json_open(PANEL))
    return d["panel"]

def json_open(p):
    import io; return io.StringIO(open(p).read())

def momentum_book_returns(panel):
    """Monthly return of an equal-weight long top-decile 12-1 momentum book."""
    out = {}
    for ym, rows in panel.items():
        r = [(x.get("m121"), x.get("f21")) for x in rows
             if x.get("m121") is not None and x.get("f21") is not None]
        if len(r) < 30:
            continue
        r.sort(key=lambda t: t[0])
        top = r[int(len(r) * 0.9):]                       # top decile by momentum
        # winsorize realized returns so a single delisting/spike doesn't dominate the book
        rets = [max(-0.9, min(3.0, f)) for _, f in top]
        out[ym] = float(np.mean(rets))
    return dict(sorted(out.items()))

def yahoo_monthly(sym, start="2021-01-01"):
    p1 = int(dt.datetime.strptime(start, "%Y-%m-%d").timestamp())
    p2 = int(dt.datetime.now().timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?period1={p1}&period2={p2}&interval=1d")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    res = d["chart"]["result"][0]
    ts, cl = res["timestamp"], res["indicators"]["quote"][0]["close"]
    daily = [(dt.datetime.utcfromtimestamp(t), c) for t, c in zip(ts, cl) if c is not None]
    return daily

def regime_by_month(months):
    """Risk-off flag per YM month-end, replicating lib/macro.js thresholds from SPY+VIX."""
    spy = yahoo_monthly("SPY"); vix = yahoo_monthly("^VIX")
    spy_by = {d.strftime("%Y-%m-%d"): c for d, c in spy}
    dates = sorted(spy_by)
    closes = np.array([spy_by[d] for d in dates])
    sma200 = np.array([np.mean(closes[max(0, i-199):i+1]) if i >= 199 else np.nan for i in range(len(closes))])
    below200 = {dates[i]: (closes[i] < sma200[i]) for i in range(len(dates)) if np.isfinite(sma200[i])}
    vix_by = {d.strftime("%Y-%m-%d"): c for d, c in vix}
    vdates = sorted(vix_by); vcl = np.array([vix_by[d] for d in vdates])
    vpct = np.array([np.mean(vcl[max(0, i-251):i+1] <= vcl[i]) for i in range(len(vcl))])
    vrise = np.concatenate([[False], vcl[1:] > vcl[:-1]])
    vix_off = {}
    for i, d in enumerate(vdates):
        vix_off[d] = (vcl[i] >= 28) or (vpct[i] >= 0.90 and vrise[i])
    off = {}
    for ym in months:
        # last calendar day with data in that month
        cand = [d for d in dates if d[:7] == ym]
        vcand = [d for d in vdates if d[:7] == ym]
        b = below200.get(cand[-1], False) if cand else False
        v = vix_off.get(vcand[-1], False) if vcand else False
        off[ym] = bool(b or v)
    return off

def stats(monthly, name):
    a = np.array(monthly)
    if len(a) < 6: return None
    ann_ret = np.prod(1 + a) ** (12 / len(a)) - 1
    vol = np.std(a, ddof=1) * math.sqrt(12)
    sharpe = (np.mean(a) / np.std(a, ddof=1) * math.sqrt(12)) if np.std(a) else float("nan")
    eq = np.cumprod(1 + a); dd = float(np.min(eq / np.maximum.accumulate(eq) - 1))
    calmar = (ann_ret / abs(dd)) if dd < 0 else float("nan")
    return dict(name=name, CAGR=ann_ret, vol=vol, Sharpe=sharpe, maxDD=dd, Calmar=calmar, n=len(a))

def show(s):
    print(f"  {s['name']:26s} CAGR {s['CAGR']*100:+6.1f}%  vol {s['vol']*100:4.1f}%  "
          f"Sharpe {s['Sharpe']:+.2f}  maxDD {s['maxDD']*100:6.1f}%  Calmar {s['Calmar']:.2f}")

def main():
    panel = load_panel()
    book = momentum_book_returns(panel)
    months = list(book.keys())
    print(f"momentum book: {len(months)} months {months[0]}..{months[-1]}")
    off = regime_by_month(months)
    base = np.array([book[m] for m in months])
    n_off = sum(off[m] for m in months)
    print(f"regime: {n_off}/{len(months)} months flagged risk-off\n")

    # overlays (all point-in-time: exposure for month t uses info through t-1)
    def regime_gated(scale_off=0.25):
        return np.array([book[m] * (scale_off if off[m] else 1.0) for m in months])
    def vol_targeted(base_ret):
        out = []
        for i, m in enumerate(months):
            hist = base_ret[max(0, i-6):i]                # trailing 6mo strategy vol
            rv = np.std(hist, ddof=1) * math.sqrt(12) if len(hist) >= 3 else TARGET_VOL
            lev = min(MAX_LEV, TARGET_VOL / rv) if rv > 0 else 1.0
            out.append(base_ret[i] * lev)             # scale whatever base series was passed
        return np.array(out)

    variants = {
        "fixed (naive)": base,
        "regime-gated": regime_gated(),
        "vol-targeted": vol_targeted(base),
        "regime + vol-target": vol_targeted(regime_gated()),
    }
    mid = len(months) // 2
    print("=== FULL SAMPLE ===")
    full = {k: stats(v, k) for k, v in variants.items()}
    for k in variants: show(full[k])
    print(f"\n=== OUT-OF-SAMPLE (2nd half, {months[mid]}..{months[-1]}) ===")
    for k, v in variants.items():
        s = stats(v[mid:], k)
        if s: show(s)

    b, g = full["fixed (naive)"], full["regime + vol-target"]
    print(f"\nVERDICT: disciplined sizing lifts Sharpe {b['Sharpe']:+.2f} -> {g['Sharpe']:+.2f} and maxDD "
          f"{b['maxDD']*100:.0f}% -> {g['maxDD']*100:.0f}% on the SAME momentum edge (no new alpha). "
          f"A win if OOS Sharpe up AND maxDD shallower.")
    json.dump({k: full[k] for k in full}, open(os.path.join(HERE, "data", "sizing.json"), "w"), default=float, indent=0)

if __name__ == "__main__":
    main()
