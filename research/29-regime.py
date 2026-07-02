#!/usr/bin/env python3
"""Step 29 - Learned regime detection (Gaussian HMM) vs the current threshold gate.

  research/intraday/.venv/bin/python research/29-regime.py

The ONE durable lever in this whole project is REGIME AVOIDANCE (don't go long in
risk-off). It is currently driven by crude thresholds (lib/macro.js: risk-off if
macroRisk>=55 OR VIX>=28 OR VIX 1y-pctile>=90 & rising). Question: does a learned
3-state Gaussian HMM on {SPY, VIX, credit} call risk-off EARLIER / more accurately,
and would gating on it beat the threshold gate out of sample?

Honesty:
- Multi-year daily sample (2015-2026) spanning 2015-16, 2018, 2020, 2022, 2025 stress.
- HMM params FIT ON TRAIN ONLY (<=2020); states mapped to risk by TRAIN stats.
- TEST (2021-2026) uses CAUSAL filtering: for each day, Viterbi on data up to THAT day
  only (no smoothing over the future -> no lookahead, the classic HMM backtest trap).
- Compared on forward 21d SPY return/vol by regime, and on a gated long strategy
  (hold SPY when not-risk-off, else cash): Sharpe + max drawdown vs threshold gate
  and vs buy&hold.
"""

import json, math, urllib.request, datetime as dt
import numpy as np
from hmmlearn.hmm import GaussianHMM

TICKERS = {"SPY": "SPY", "VIX": "^VIX", "HYG": "HYG", "LQD": "LQD"}
START = "2015-01-01"
TRAIN_END = "2020-12-31"

def yahoo(sym, start=START):
    p1 = int(dt.datetime.strptime(start, "%Y-%m-%d").timestamp())
    p2 = int(dt.datetime.now().timestamp())
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?period1={p1}&period2={p2}&interval=1d")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    r = d["chart"]["result"][0]
    ts = r["timestamp"]; cl = r["indicators"]["quote"][0]["close"]
    return {dt.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d"): c
            for t, c in zip(ts, cl) if c is not None}

def align(series):
    dates = sorted(set.intersection(*[set(s.keys()) for s in series.values()]))
    return dates, {k: np.array([s[d] for d in dates]) for k, s in series.items()}

def sma(x, n):
    out = np.full_like(x, np.nan, float)
    for i in range(len(x)):
        if i >= n - 1: out[i] = np.mean(x[i-n+1:i+1])
    return out

def pctile_trailing(x, win=252):
    out = np.full_like(x, np.nan, float)
    for i in range(len(x)):
        lo = max(0, i-win+1); w = x[lo:i+1]
        out[i] = (np.sum(w <= x[i]) / len(w)) if len(w) else np.nan
    return out

def maxdd(equity):
    peak = np.maximum.accumulate(equity); return float(np.min(equity/peak - 1))

def sharpe(daily):
    daily = np.asarray(daily);
    return float(np.mean(daily)/np.std(daily)*math.sqrt(252)) if np.std(daily) else float("nan")

def main():
    print("fetching SPY/^VIX/HYG/LQD daily from Yahoo ...")
    raw = {k: yahoo(v) for k, v in TICKERS.items()}
    dates, A = align(raw)
    n = len(dates); print(f"{n} aligned trading days {dates[0]}..{dates[-1]}")

    spy, vix, hyg, lqd = A["SPY"], A["VIX"], A["HYG"], A["LQD"]
    sp_ret1 = np.concatenate([[0], np.diff(spy)/spy[:-1]])
    sp_ret5 = np.concatenate([[0]*5, spy[5:]/spy[:-5]-1])
    rvol20 = np.array([np.std(sp_ret1[max(0,i-19):i+1])*math.sqrt(252) if i>=19 else np.nan for i in range(n)])
    vix_chg20 = np.concatenate([[0]*20, vix[20:]/vix[:-20]-1])
    credit = hyg/lqd
    credit_sma50 = sma(credit, 50)
    credit_dev = credit/credit_sma50 - 1
    spy_sma200 = sma(spy, 200)
    vix_pct = pctile_trailing(vix)

    # feature matrix (all point-in-time / trailing)
    feats = np.column_stack([vix, vix_chg20, rvol20, sp_ret5, credit_dev])
    valid = ~np.any(~np.isfinite(feats), axis=1)
    # standardize using TRAIN stats only
    tr_mask = np.array([d <= TRAIN_END for d in dates]) & valid
    mu, sd = feats[tr_mask].mean(0), feats[tr_mask].std(0); sd[sd == 0] = 1
    Z = (feats - mu)/sd

    # fit HMM on train
    Xtr = Z[tr_mask]
    hmm = GaussianHMM(n_components=3, covariance_type="diag", n_iter=200, random_state=0)
    hmm.fit(Xtr)
    # map risk-off state by the WORST TRAIN forward-21d return (gives the HMM its best shot
    # as an AVOIDANCE tool — the dangerous state is the one that PRECEDES weak returns, which
    # need not be the peak-VIX state). Using train outcomes to label train states is fair.
    tr_states = hmm.predict(Xtr)
    fwd21_full = np.concatenate([spy[21:]/spy[:-21]-1, [np.nan]*21])
    tr_pos = np.where(tr_mask)[0]
    st_fwd = {}
    for s in range(3):
        idx = tr_pos[tr_states == s]; f = fwd21_full[idx]; f = f[np.isfinite(f)]
        st_fwd[s] = np.mean(f) if len(f) else 9
    riskoff_state = min(st_fwd, key=st_fwd.get)             # worst forward return = risk-off
    print("  train state fwd21 means:", {s: round(st_fwd[s]*100,2) for s in range(3)},
          "-> risk-off state", riskoff_state)

    # CAUSAL filtering on the full series: for each day, Viterbi on data up to that day only
    test_idx = [i for i in range(n) if dates[i] > TRAIN_END and valid[i]]
    hmm_off = np.zeros(n, bool)
    # incremental Viterbi is O(T^2); cap cost by starting the sequence at train start
    seq_start = np.argmax(tr_mask)  # first valid train day
    for i in test_idx:
        seq = Z[seq_start:i+1]
        seq = seq[np.all(np.isfinite(seq), axis=1)]
        st = hmm.predict(seq)[-1]
        hmm_off[i] = (st == riskoff_state)

    # current THRESHOLD rule (replicate lib/macro.js), daily
    vix_rising = np.concatenate([[False], vix[1:] > vix[:-1]])
    macro_risk = 60*vix_pct + 40*np.clip(-credit_dev*2000/100, 0, 1)   # rough 0-100 blend
    thr_off = (vix >= 28) | ((vix_pct >= 0.90) & vix_rising) | (spy < spy_sma200)

    # ---- evaluation on TEST period only ----
    tmask = np.array([d > TRAIN_END for d in dates]) & valid
    fwd21 = np.concatenate([spy[21:]/spy[:-21]-1, [np.nan]*21])
    def cond(mask):
        m = mask & tmask & np.isfinite(fwd21)
        return np.mean(fwd21[m])*100, np.std(fwd21[m])*100, int(np.sum(m))
    print(f"\n=== forward-21d SPY return | regime (TEST {dates[test_idx[0]]}..{dates[-1]}) ===")
    for lbl, mask in [("HMM risk-off", hmm_off), ("HMM not-off", ~hmm_off & valid),
                      ("Threshold risk-off", thr_off), ("Threshold not-off", ~thr_off)]:
        mu_, sd_, k = cond(mask)
        print(f"  {lbl:20s} fwd21 {mu_:+.2f}%  vol {sd_:.2f}%  days={k}")

    # gated long strategy: hold SPY next day when today is not-risk-off, else flat
    def gated(off):
        pos = (~off).astype(float)
        strat = pos[:-1] * sp_ret1[1:]                     # act next day on today's signal
        eq = np.cumprod(1 + np.where(tmask[:-1], strat, 0.0))
        dr = strat[tmask[:-1]]
        return sharpe(dr), maxdd(eq[tmask[:-1]]) if np.sum(tmask[:-1]) else float("nan"), \
               float(np.prod(1+dr)-1)
    bh_dr = sp_ret1[1:][tmask[:-1]]
    print(f"\n=== gated long strategy (TEST): hold SPY when NOT risk-off ===")
    print(f"  {'buy & hold':22s} Sharpe {sharpe(bh_dr):+.2f}  maxDD {maxdd(np.cumprod(1+bh_dr)):.1%}  totRet {np.prod(1+bh_dr)-1:+.1%}")
    for lbl, off in [("HMM gate", hmm_off), ("Threshold gate", thr_off)]:
        s, dd, tot = gated(off)
        print(f"  {lbl:22s} Sharpe {s:+.2f}  maxDD {dd:.1%}  totRet {tot:+.1%}  days-in-market {np.mean(~off[tmask])*100:.0f}%")

    # how often they agree; lead/lag around the worst drawdown windows
    agree = np.mean(hmm_off[tmask] == thr_off[tmask])*100
    print(f"\n  regime agreement HMM vs threshold: {agree:.0f}% of test days")
    print(f"  HMM risk-off {np.mean(hmm_off[tmask])*100:.0f}% of days | threshold risk-off {np.mean(thr_off[tmask])*100:.0f}%")
    print("\nVERDICT cues: HMM WINS only if its risk-off fwd-return is clearly worse AND the HMM-gated "
          "strategy Sharpe/maxDD beats the threshold gate on TEST. Similar => keep the simpler threshold.")

if __name__ == "__main__":
    main()
