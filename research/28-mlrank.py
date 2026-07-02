#!/usr/bin/env python3
"""Step 28 - Nonlinear, regime-conditional ML ranker with Combinatorial Purged CV.

  research/intraday/.venv/bin/python research/28-mlrank.py

The entire prior edge hunt asked "does factor X have (linear, univariate) rank-IC?".
This asks the question that lens is BLIND to: does a gradient-boosted model over the
SAME factors -- free to use nonlinear factor x regime/dispersion INTERACTIONS -- beat
a LINEAR model on the identical features, OUT of sample, under Combinatorial Purged
Cross-Validation? If GBM ~ Ridge on OOS IC/Sharpe, there is no nonlinear/conditional
alpha left in these factors and the linear verdict stands. If GBM > Ridge robustly
across CPCV paths (with a low Probability of Backtest Overfitting), that's genuinely
new, additive structure.

Discipline (this is the point):
- Survivorship-corrected panel (research/14 built it from the delisted-inclusive cache).
- Target = 1-month (f21) forward return, cross-sectionally DEMEANED (pure selection edge,
  beta removed). f21 => clean, ~non-overlapping monthly rebalance for honest Sharpe.
- Features z-scored WITHIN each month (cross-sectional ranking) + month-level regime
  context (breadth, dispersion, market return) so trees can condition on regime.
- CPCV: 8 month-groups, all C(8,2)=28 test paths, PURGE +/-1 month + embargo around every
  test block (kills the fwd-return overlap leak). Distribution of OOS metrics -> PBO.
- Baselines on the IDENTICAL feature matrix: Ridge (linear) and raw 12-1 momentum.
- Deflated Sharpe on the long-short decile portfolio.
"""

import json, itertools, math, os
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

HERE = os.path.dirname(__file__)
PANEL = os.path.join(HERE, "data", "panel-features.json")

RAW_FEATS = ["m61","m91","m121","m181","m63","m93","m122","acc","r21","r5","v63","ra","vs"]
TARGET = "f21"                      # 1-month fwd (delisting-aware in the panel build)
N_GROUPS = 8                        # CPCV month-groups
PURGE = 1                          # months purged each side of a test block (>= fwd horizon in months)

def load():
    d = json.load(open(PANEL))
    rows = []
    for ym, arr in d["panel"].items():
        for r in arr:
            r = dict(r); r["ym"] = ym; rows.append(r)
    df = pd.DataFrame(rows)
    df = df[np.isfinite(df[TARGET])].copy()
    df["logcap"] = np.log(df["cap"].clip(lower=1))
    df["logadv"] = np.log(df["adv"].clip(lower=1))
    df["ipo"] = df["ipo"].fillna(df["ipo"].median())
    return df

WINS = 0.9   # winsorize returns to [-0.9, +3] so decile MEANS aren't outlier/delisting-dominated

def prep(df):
    """Sanitize (inf->nan), cross-sectional winsorize + z-score of raw feats within month;
    month-level regime context; target = within-month demeaned (winsorized) f21."""
    df = df.copy()
    for f in RAW_FEATS + ["logcap","logadv","ipo"]:
        df[f] = pd.to_numeric(df[f], errors="coerce").replace([np.inf, -np.inf], np.nan)
    # winsorize the forward return used for LS means + as the training target base
    df[TARGET] = pd.to_numeric(df[TARGET], errors="coerce").clip(lower=-WINS, upper=3.0)
    g = df.groupby("ym")
    # regime context (all trailing / point-in-time): breadth, dispersion, market return
    reg = pd.DataFrame({
        "reg_breadth": g["m121"].apply(lambda s: np.mean(s > 0)),
        "reg_disp":    g["r21"].apply(lambda s: np.nanstd(s)),
        "reg_mkt":     g["r21"].apply(lambda s: np.nanmedian(s)),
    })
    df = df.join(reg, on="ym")
    zfeats = RAW_FEATS + ["logcap","logadv","ipo"]
    def z(s):
        # cross-sectional winsorize to 1/99 pct, fill gaps with the median, then standardize
        lo, hi = s.quantile(0.01), s.quantile(0.99)
        s = s.clip(lower=lo, upper=hi).fillna(s.median())
        m, sd = s.mean(), s.std()
        return (s - m) / sd if sd and np.isfinite(sd) and sd > 0 else s * 0.0
    df[zfeats] = g[zfeats].transform(z)
    df[zfeats] = df[zfeats].replace([np.inf, -np.inf], 0.0).fillna(0.0)
    # target: cross-sectional excess (demeaned within month)
    df["y"] = df[TARGET] - g[TARGET].transform("mean")
    return df

FEATURES = RAW_FEATS + ["logcap","logadv","ipo","reg_breadth","reg_disp","reg_mkt"]

def spearman(a, b):
    if len(a) < 10: return np.nan
    return stats.spearmanr(a, b).correlation

def ls_monthly_returns(test_df, score_col):
    """Top-decile minus bottom-decile equal-weight monthly return series over test months."""
    outs = []
    for ym, sub in test_df.groupby("ym"):
        if len(sub) < 20: continue
        q = sub[score_col].rank(pct=True)
        top = sub.loc[q >= 0.9, TARGET].mean()
        bot = sub.loc[q <= 0.1, TARGET].mean()
        if np.isfinite(top) and np.isfinite(bot):
            outs.append(top - bot)
    return np.array(outs)

def sharpe(x, periods=12):
    x = np.asarray(x)
    if len(x) < 3 or np.std(x) == 0: return np.nan
    return np.mean(x) / np.std(x, ddof=1) * math.sqrt(periods)

def deflated_sharpe(sr, n_obs, n_trials, skew=0.0, kurt=3.0):
    """Bailey/Lopez de Prado Deflated Sharpe Ratio (prob the true SR>0 given multiple trials)."""
    if not np.isfinite(sr) or n_obs < 5: return np.nan
    sr_m = sr / math.sqrt(12)                                   # de-annualize to per-period
    emc = 0.5772156649
    z = stats.norm.ppf(1 - 1.0/max(n_trials,2))
    z2 = stats.norm.ppf(1 - 1.0/max(n_trials,2) * math.exp(-1))
    sr0 = math.sqrt(1.0/(n_obs-1)) * ((1-emc)*z + emc*z2)       # expected max SR under the null
    denom = math.sqrt(1 - skew*sr_m + (kurt-1)/4.0*sr_m**2)
    if denom <= 0: return np.nan
    return float(stats.norm.cdf((sr_m - sr0) * math.sqrt(n_obs-1) / denom))

def main():
    df = prep(load())
    months = sorted(df["ym"].unique())
    print(f"panel: {len(df)} rows, {len(months)} months ({months[0]}..{months[-1]}), "
          f"avg cross-section {len(df)//len(months)}")

    # month -> group id (contiguous blocks)
    groups = {m: i * N_GROUPS // len(months) for i, m in enumerate(months)}
    midx = {m: i for i, m in enumerate(months)}

    gbm_ic, rdg_ic, mom_ic = [], [], []
    gbm_ls, rdg_ls, mom_ls = [], [], []
    for combo in itertools.combinations(range(N_GROUPS), 2):
        test_months = [m for m in months if groups[m] in combo]
        test_pos = set(midx[m] for m in test_months)
        # purge+embargo: drop train months within PURGE of any test month
        train_months = [m for m in months if all(abs(midx[m]-tp) > PURGE for tp in test_pos)]
        if len(train_months) < 8: continue
        tr = df[df["ym"].isin(train_months)]; te = df[df["ym"].isin(test_months)]
        Xtr, ytr = tr[FEATURES].values, tr["y"].values
        Xte = te[FEATURES].values

        gbm = HistGradientBoostingRegressor(max_depth=3, max_iter=300, learning_rate=0.03,
                                            l2_regularization=1.0, min_samples_leaf=200,
                                            early_stopping=False, random_state=0).fit(Xtr, ytr)
        rdg = Ridge(alpha=10.0).fit(Xtr, ytr)
        te = te.copy()
        te["s_gbm"] = gbm.predict(Xte)
        te["s_rdg"] = rdg.predict(Xte)
        te["s_mom"] = te["m121"]                                # raw 12-1 momentum (z-scored)

        gbm_ic.append(spearman(te["s_gbm"], te[TARGET]))
        rdg_ic.append(spearman(te["s_rdg"], te[TARGET]))
        mom_ic.append(spearman(te["s_mom"], te[TARGET]))
        gbm_ls.append(ls_monthly_returns(te, "s_gbm"))
        rdg_ls.append(ls_monthly_returns(te, "s_rdg"))
        mom_ls.append(ls_monthly_returns(te, "s_mom"))

    gbm_ic, rdg_ic, mom_ic = map(lambda a: np.array(a, float), (gbm_ic, rdg_ic, mom_ic))
    n = len(gbm_ic)
    print(f"\nCPCV paths: {n} (C({N_GROUPS},2)), purge +/-{PURGE}mo")
    print("\n=== OOS rank-IC (cross-sectional, 1-month fwd) ===")
    for name, ic in [("GBM (nonlinear+regime)", gbm_ic), ("Ridge (linear, same feats)", rdg_ic), ("raw mom_12_1", mom_ic)]:
        print(f"  {name:28s} mean {np.nanmean(ic):+.4f}  median {np.nanmedian(ic):+.4f}  "
              f"pos-paths {np.mean(ic>0)*100:.0f}%")

    # the key contrast: GBM - Ridge across paths (isolates nonlinearity/interactions)
    d = gbm_ic - rdg_ic
    t = stats.ttest_1samp(d[np.isfinite(d)], 0.0)
    print(f"\n  GBM - Ridge IC delta: mean {np.nanmean(d):+.4f}  win-paths {np.mean(d>0)*100:.0f}%  "
          f"t={t.statistic:+.2f} p={t.pvalue:.3f}")
    print("    -> nonlinearity/interactions add edge ONLY if this delta is >0, significant, most paths.")

    # PBO: prob the strategy that looked best in-sample is below-median OOS (here, is GBM's
    # OOS-advantage a fluke?). Fraction of paths where GBM does NOT beat Ridge.
    pbo = float(np.mean(d <= 0))
    print(f"  PBO proxy (GBM fails to beat Ridge): {pbo*100:.0f}%  (>50% => the 'edge' is overfit)")

    # long-short OOS Sharpe (pool monthly LS returns across paths)
    def pooled(ls):
        arr = np.concatenate([x for x in ls if len(x)]) if any(len(x) for x in ls) else np.array([])
        return arr
    print("\n=== OOS long-short decile portfolio (monthly, pooled across paths) ===")
    best = None
    for name, ls in [("GBM", gbm_ls), ("Ridge", rdg_ls), ("mom_12_1", mom_ls)]:
        arr = pooled(ls); s = sharpe(arr)
        sk = float(stats.skew(arr)) if len(arr) > 3 else 0.0
        ku = float(stats.kurtosis(arr, fisher=False)) if len(arr) > 3 else 3.0
        dsr = deflated_sharpe(s, len(arr), n_trials=3*n, skew=sk, kurt=ku)
        print(f"  {name:9s} n={len(arr):4d}  mean {np.mean(arr)*100:+.2f}%/mo  Sharpe {s:+.2f}  "
              f"DeflatedSharpe(prob SR>0) {dsr:.2f}")
        if best is None or s > best[1]: best = (name, s)
    # ---- clean purged EXPANDING WALK-FORWARD: one prediction per month (non-overlapping
    #      monthly LS series -> honest Sharpe + Deflated Sharpe, n_trials = 3 models) ----
    print("\n=== purged expanding walk-forward (one pred/month, non-overlapping) ===")
    MIN_TRAIN = 12
    wf = {"GBM": [], "Ridge": [], "mom": []}
    for i in range(MIN_TRAIN, len(months)):
        test_m = months[i]
        train_m = months[:i - PURGE]                       # purge the fwd-overlap month(s)
        if len(train_m) < MIN_TRAIN: continue
        tr = df[df["ym"].isin(train_m)]; te = df[df["ym"] == test_m].copy()
        if len(te) < 20: continue
        gbm = HistGradientBoostingRegressor(max_depth=3, max_iter=300, learning_rate=0.03,
                                            l2_regularization=1.0, min_samples_leaf=200,
                                            random_state=0).fit(tr[FEATURES].values, tr["y"].values)
        rdg = Ridge(alpha=10.0).fit(tr[FEATURES].values, tr["y"].values)
        te["s_gbm"] = gbm.predict(te[FEATURES].values)
        te["s_rdg"] = rdg.predict(te[FEATURES].values)
        te["s_mom"] = te["m121"]
        for name, col in [("GBM","s_gbm"),("Ridge","s_rdg"),("mom","s_mom")]:
            r = ls_monthly_returns(te, col)
            if len(r): wf[name].append(r[0])
    for name in ["GBM","Ridge","mom"]:
        arr = np.array(wf[name]); s = sharpe(arr)
        sk = float(stats.skew(arr)) if len(arr) > 3 else 0.0
        ku = float(stats.kurtosis(arr, fisher=False)) if len(arr) > 3 else 3.0
        dsr = deflated_sharpe(s, len(arr), n_trials=3, skew=sk, kurt=ku)
        print(f"  {name:6s} n={len(arr):2d}mo  mean {np.mean(arr)*100:+.2f}%/mo  ann.Sharpe {s:+.2f}  "
              f"DeflatedSharpe(prob SR>0, 3 trials) {dsr:.2f}")

    print(f"\nVERDICT cues: GBM-Ridge IC delta ~0 & not sig / GBM walk-forward Sharpe ~ Ridge => "
          f"no nonlinear alpha (linear verdict holds). GBM clearly > Ridge (IC delta sig + WF DSR>0.95) "
          f"=> genuine conditional edge worth shipping.")

if __name__ == "__main__":
    main()
