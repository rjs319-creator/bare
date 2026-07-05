"""EXPERIMENT 11 — Gap & Go meta-label precision filter (the study metalabel.py was built for).

exp08 established the one deflation-surviving edge: unscheduled gap-up (>=5%, non-earnings,
liquid) + opening-range-breakout continuation. exp09 then showed it is LUMPY and universe-
tilted: top-5 of 450 trades = ~35% of P&L, and the clean-large-cap half is OOS-negative. A
right-skewed, low-hit-rate, positive-expectancy profile is the textbook case for a PRECISION
FILTER: can we drop the trades most likely to fail using only information known AT ENTRY, and
thereby lift out-of-sample expectancy AND cut the lumpiness — without in-sample cheating?

This is López de Prado meta-labeling applied honestly:
  PRIMARY signal  = the gap-up ORB rule (fires on every qualifying gap; high recall).
  META label      = did that trade end profitably (net R > 0)?
  META model      = predict P(win | entry-time features), trained PURGED WALK-FORWARD.
  FINAL           = take only trades whose meta-score is in the top fraction of its fold.

Honest null (the project's recurring truth): the filter adds nothing durable, i.e. it does not
beat simply ranking by gap size — the one factor exp08 already validated as monotone.

Three rankers are compared on the SAME pooled out-of-sample trades (top-fraction selected
WITHIN each purged fold, then pooled), against the unfiltered "take every trade" baseline:
  1. gap_size          — the validated monotone rank (proxy for the shipped edge).
  2. continuation_score— the shipped lib/gapgo.js heuristic (exact port in metalabel.py).
  3. lr_meta           — logistic regression on entry-time features (purged walk-forward).

LR (not XGBoost): ~a few hundred trades cannot support a boosted tree without overfitting;
a linear model is the honest, low-variance choice at this sample size.

Costs, universe, window, no-lookahead discipline all inherit exp08. Feature-tagged trades are
cached to data/metalabel_trades.json so the modeling re-runs instantly.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import json
import math
import statistics

import numpy as np
from tqdm import tqdm

from intraday import entries, fmp, regime as regime_mod
from intraday.daytrade import atr
from intraday.execution import CostModel, simulate_at
from intraday.pipeline import date_plus, _pad
from intraday.metalabel import (
    continuation_score,
    regime_norm,
    purged_walk_forward,
    top_fraction_idx,
    trade_stats,
    lumpiness,
    cluster_bootstrap_delta,
    spearman_ic,
    half_key,
)
from config import BacktestConfig

CFG = BacktestConfig()
COST = CostModel(slippage_bps=5.0, commission_bps=2.0)
OUT = ROOT / "data"
CACHE = OUT / "metalabel_trades.json"

GAP_MIN = 0.04            # study population: gap>=4% (enough n to train; still the edge zone)
GAP_PRIMARY = 0.05        # headline subset = the pre-registered gap5 edge
ADV_FLOOR = 10_000_000
ATR_MULT, RR = 2.5, 2.0
K_30M = entries.K_30M
TOP_FRAC = 0.60           # keep the best 60% of each fold (drop the worst 40%)
FEATURES = ["gap", "atr_pct", "log_adv", "or_width", "prior_ret", "gap_to_atr", "reg_norm", "dow"]
# SERVE features = the subset computable at LIVE LOG TIME from daily candles + regime (drops
# the intraday-only opening-range width). The live lib/gapgo.js metaProb() is pinned to the
# model exported here, so JS and this study can never silently drift (as continuationScore is).
SERVE_FEATURES = ["gap", "atr_pct", "log_adv", "prior_ret", "gap_to_atr", "reg_norm", "dow", "rel_vol"]


def regime_label(reg_on_date) -> str:
    """Small-cap tape (IWM) -> 'on' | 'neu' | 'off'. IWM matters more than SPY here: these
    small/mid names bled while SPY rose, so an SPY gate would miss the risk-off tape."""
    iwm = (reg_on_date or {}).get("iwm")
    if not iwm:
        return "neu"
    if iwm["above50"] and iwm["above200"] and iwm["sma50_rising"]:
        return "on"
    if not iwm["above50"] and not iwm["above200"]:
        return "off"
    return "neu"


def build_trades(cfg, reg):
    """Every unscheduled gap-up >= GAP_MIN, executed as an ORB trade, tagged with entry-time
    features. Mirrors exp08's signal construction exactly (same earnings-adjacency skip, same
    ADV floor, same ORB/stop/target) and adds a feature vector known at the moment of entry."""
    rows = []
    for sym in tqdm(cfg.universe, desc="scan"):
        try:
            dc = fmp.daily(sym, _pad(cfg.start, cfg.daily_lookback_days + 20), cfg.end)
        except Exception:
            continue
        if len(dc) < 40:
            continue
        # earnings-adjacent dates to skip (unscheduled gaps only) — same as exp08
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
            prev = dc[i - 1]
            if not prev["close"]:
                continue
            gap = c["open"] / prev["close"] - 1
            if gap < GAP_MIN:
                continue
            adv = statistics.mean(x["close"] * x["volume"] for x in dc[i - 20:i])
            if adv < ADV_FLOOR:
                continue
            a = atr(dc[:i])
            if not a or a <= 0:
                continue
            # --- execute the ORB trade on the gap session (same as exp08.orb_trade) ---
            bars = fmp.intraday(sym, cfg.interval, c["date"], date_plus(c["date"], 7))
            sess = fmp.group_by_session(bars)
            days = sorted(d for d in sess if d >= c["date"])[: cfg.max_hold_sessions]
            if not days or days[0] != c["date"]:
                continue
            first = sess[days[0]]
            hit = entries.opening_range_breakout(first)
            if not hit:
                continue
            entry_px, idx = hit
            window = [b for d in days for b in sess[d]]
            stop = entry_px - ATR_MULT * a
            tr = simulate_at(window, entry_px, idx + 1, stop, entry_px + RR * (entry_px - stop), COST)
            if tr is None:
                continue
            # --- entry-time features (NO lookahead: all computable at/just after the OR) ---
            or_high = max(b["high"] for b in first[:K_30M])
            or_low = min(b["low"] for b in first[:K_30M])
            atr_pct = a / prev["close"]
            reg_lbl = regime_label(reg.get(c["date"]))
            feat = {
                "gap": round(gap, 5),
                "atr_pct": round(atr_pct, 5),
                "log_adv": round(math.log10(adv), 4),
                "or_width": round((or_high - or_low) / entry_px, 5),
                "prior_ret": round(prev["close"] / prev["open"] - 1, 5),
                "gap_to_atr": round(gap / atr_pct, 4) if atr_pct > 0 else 0.0,
                "reg_norm": regime_norm(reg_lbl),
                "dow": _dow(c["date"]),
                "rel_vol": round(_rel_vol(dc, i), 4),
            }
            rows.append({
                "symbol": sym, "date": c["date"], "gap": round(gap, 5),
                "regime": reg_lbl, "ret": tr.net_return_pct / 100.0,
                "exit": tr.exit_reason, "win": 1 if tr.net_return_pct > 0 else 0,
                "cont_score": continuation_score(gap * 100, _rel_vol(dc, i), reg_lbl),
                "feat": feat,
            })
    return rows


def _dow(date: str) -> int:
    from datetime import datetime
    return datetime.strptime(date, "%Y-%m-%d").weekday()


def _rel_vol(dc, i) -> float:
    """No-lookahead relative-volume proxy for the shipped continuation_score: PRIOR day's
    volume / trailing-20d avg volume (the gap-day's own volume isn't fully known at a 30-min
    ORB entry, so we deliberately use the last completed bar). Documented imprecision — the
    baseline's job is only to rank, and continuation_score weights gap (0.42) > relVol (0.28)."""
    avg = statistics.mean(x["volume"] for x in dc[i - 20:i]) or 1.0
    return dc[i - 1]["volume"] / avg


def load_or_build():
    if CACHE.exists():
        rows = json.loads(CACHE.read_text())
        print(f"Loaded {len(rows)} cached feature-tagged trades from {CACHE.name}")
        return rows
    print(f"Building trades ({len(CFG.universe)} names, {CFG.start}->{CFG.end}, gap>={GAP_MIN:.0%})…")
    reg = regime_mod.build_regime(_pad(CFG.start, 400), CFG.end)
    rows = build_trades(CFG, reg)
    CACHE.write_text(json.dumps(rows, indent=2, default=str))
    print(f"Built + cached {len(rows)} trades -> {CACHE.name}")
    return rows


def fit_meta_probs(rows, folds):
    """Purged walk-forward logistic regression. Returns meta_prob aligned to rows (nan where a
    row was never in any test fold), and the set of pooled OOS indices."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    dates = [r["date"] for r in rows]
    X = np.array([[r["feat"][f] for f in FEATURES] for r in rows], float)
    y = np.array([r["win"] for r in rows], int)
    probs = np.full(len(rows), np.nan)
    splits = purged_walk_forward(dates, folds, purge_days=7)
    fold_ids = np.full(len(rows), None, dtype=object)
    # NB: numpy's matmul on the macOS Accelerate BLAS emits a spurious "divide by zero
    # encountered in matmul" RuntimeWarning even when the result is exactly correct
    # (verified: fits converge in <12 iters, coefficients finite, a@b == einsum). Silence
    # it so the study output isn't misread as numerical failure — the math is sound.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        for s in splits:
            tr_idx, te_idx = s["train_idx"], s["test_idx"]
            if len(tr_idx) < 30 or len(set(y[tr_idx])) < 2:   # need both classes + enough data
                continue
            scaler = StandardScaler().fit(X[tr_idx])
            clf = LogisticRegression(C=0.5, max_iter=1000, class_weight="balanced")
            clf.fit(scaler.transform(X[tr_idx]), y[tr_idx])
            probs[te_idx] = clf.predict_proba(scaler.transform(X[te_idx]))[:, 1]
            for j in te_idx:
                fold_ids[j] = s["fold"]
    oos = np.where(~np.isnan(probs))[0]
    return probs, oos, fold_ids


def select_per_fold(idx, fold_ids, scores, frac):
    """Within each fold, keep the top `frac` by score; pool the survivors. Returns pooled idx."""
    keep = []
    for f in sorted(set(fold_ids[j] for j in idx)):
        fi = np.array([j for j in idx if fold_ids[j] == f])
        loc = top_fraction_idx(scores[fi], frac)
        keep.extend(fi[loc].tolist())
    return np.array(sorted(keep))


def summarize_set(rows, idx):
    r = [rows[j]["ret"] for j in idx]
    st = trade_stats(r)
    lp = lumpiness(r, k=5)
    return {**st, **lp}


def by_year(rows, idx):
    out = {}
    for y in sorted(set(rows[j]["date"][:4] for j in idx)):
        yi = [j for j in idx if rows[j]["date"][:4] == y]
        out[y] = round(float(np.mean([rows[j]["ret"] for j in yi])), 4)
    return out


def run():
    rows = load_or_build()
    if len(rows) < 60:
        print(f"Only {len(rows)} trades — too few for a purged-WF meta study. Aborting."); return

    dates = [r["date"] for r in rows]
    folds = sorted({half_key(d) for d in dates})[1:]   # first half can only ever be train
    probs, oos, fold_ids = fit_meta_probs(rows, folds)
    if len(oos) < 40:
        print(f"Only {len(oos)} OOS trades across folds — too thin. Aborting."); return

    rr = np.array([r["ret"] for r in rows])
    gap = np.array([r["gap"] for r in rows])
    cont = np.array([r["cont_score"] for r in rows], float)

    # ---- rank quality on the pooled OOS set: does any score correlate with realized R? ----
    ic = {
        "gap_size": spearman_ic(gap[oos], rr[oos]),
        "continuation_score": spearman_ic(cont[oos], rr[oos]),
        "lr_meta": spearman_ic(probs[oos], rr[oos]),
    }

    # ---- top-fraction selection WITHIN each fold, three rankers + unfiltered baseline ----
    base_idx = np.array(sorted(oos))
    sel = {
        "gap_size": select_per_fold(oos, fold_ids, gap, TOP_FRAC),
        "continuation_score": select_per_fold(oos, fold_ids, cont, TOP_FRAC),
        "lr_meta": select_per_fold(oos, fold_ids, probs, TOP_FRAC),
    }

    base_stats = summarize_set(rows, base_idx)
    base_dates = [rows[j]["date"] for j in base_idx]

    report = {
        "universe": len(CFG.universe), "window": [CFG.start, CFG.end],
        "gap_min": GAP_MIN, "top_frac": TOP_FRAC, "features": FEATURES,
        "n_trades": len(rows), "n_oos": int(len(oos)), "folds": folds,
        "rank_ic_oos": {k: (round(v, 4) if v is not None else None) for k, v in ic.items()},
        "baseline_all_oos": base_stats,
        "baseline_by_year": by_year(rows, base_idx),
        "rankers": {},
    }

    print("\n" + "=" * 100)
    print(f"GAP & GO META-LABEL  —  pooled OOS n={len(oos)} (gap>={GAP_MIN:.0%}); keep top {TOP_FRAC:.0%}/fold")
    print("=" * 100)
    print(f"{'ranker':<20}{'n':>5}{'win%':>7}{'expR%':>8}{'PF':>6}{'top5share':>11}{'medianR%':>10}{'ΔvsAll_p>0':>12}{'rankIC':>8}")
    print("-" * 96)
    b = base_stats
    print(f"{'[all trades]':<20}{b['n']:>5}{(b['win'] or 0)*100:>7.1f}{(b['expR'] or 0)*100:>8.2f}"
          f"{b['pf'] or 0:>6.2f}{(b['topk_share'] or 0):>11.2f}{(b['median'] or 0)*100:>10.2f}{'—':>12}{'—':>8}")

    for name in ("gap_size", "continuation_score", "lr_meta"):
        idx = sel[name]
        st = summarize_set(rows, idx)
        sdates = [rows[j]["date"] for j in idx]
        boot = cluster_bootstrap_delta([rows[j]["ret"] for j in idx], sdates,
                                       [rows[j]["ret"] for j in base_idx], base_dates,
                                       n_boot=2000, seed=7)
        report["rankers"][name] = {"selected": st, "by_year": by_year(rows, idx),
                                   "delta_vs_all": boot, "rank_ic": ic[name]}
        print(f"{name:<20}{st['n']:>5}{(st['win'] or 0)*100:>7.1f}{(st['expR'] or 0)*100:>8.2f}"
              f"{st['pf'] or 0:>6.2f}{(st['topk_share'] or 0):>11.2f}{(st['median'] or 0)*100:>10.2f}"
              f"{(boot['p_gt0'] if boot['p_gt0'] is not None else 0):>12.2f}"
              f"{(ic[name] if ic[name] is not None else 0):>8.3f}")

    # ---- headline gap5 subset (the pre-registered edge) under the winning ranker ----
    meta = report["rankers"]["lr_meta"]
    base_exp = base_stats["expR"] or 0
    meta_exp = meta["selected"]["expR"] or 0
    beats_all = meta_exp > base_exp
    beats_gap = meta_exp > (report["rankers"]["gap_size"]["selected"]["expR"] or 0)
    cuts_lump = (meta["selected"]["topk_share"] or 1) < (base_stats["topk_share"] or 1)
    sig = (meta["delta_vs_all"]["p_gt0"] or 0) >= 0.95
    yrs = meta["by_year"]
    yrs_pos = sum(1 for v in yrs.values() if v > 0)

    print("\nVERDICT (lr_meta vs unfiltered):")
    print(f"  beats all-trades expR: {beats_all} ({meta_exp*100:.2f}% vs {base_exp*100:.2f}%)")
    print(f"  beats gap-size rank:   {beats_gap}")
    print(f"  cuts lumpiness (top5): {cuts_lump} ({meta['selected']['topk_share']} vs {base_stats['topk_share']})")
    print(f"  bootstrap Δ>0 p:       {meta['delta_vs_all']['p_gt0']}  (bar 0.95)")
    print(f"  positive years:        {yrs_pos}/{len(yrs)}  {yrs}")

    if beats_all and beats_gap and sig and yrs_pos >= len(yrs) - 1:
        verdict = ("LEAD: the meta-label filter adds OOS precision beyond gap-size ranking, "
                   "significantly and year-consistently — forward-track before trusting.")
        tag = "🟡"
    elif beats_all and cuts_lump:
        verdict = ("MARGINAL: the filter improves the risk profile (lumpiness/expectancy) but "
                   "does not clearly beat simple gap-size ranking or clear significance — weak.")
        tag = "🟠"
    else:
        verdict = ("NO LIFT: the meta-label filter does not durably beat taking every trade / "
                   "ranking by gap size. The shipped edge already captures what's capturable.")
        tag = "❌"
    report["verdict"] = verdict
    print(f"\n  {tag} {verdict}")
    print("\n  NOTE: this is a fresh feature/model search on an in-sample-informed edge; the")
    print("  cluster-bootstrap CI + OOS-by-year are the arbiters, and even a survivor is a")
    print("  lead to forward-test live, never a proven edge (the project's standing rule).")

    (OUT / "metalabel.json").write_text(json.dumps(report, indent=2, default=str))
    print(f"\nSaved: {OUT/'metalabel.json'}")


def export_serve_model():
    """Train the FINAL serve model (LR on ALL trades, SERVE_FEATURES) and emit everything
    lib/gapgo.js needs to reproduce it byte-for-byte: standardization (mean/std), coefficients,
    intercept, the training-set median probability (the HIGH/LOW split point), and a handful of
    (feature-vector -> prob) fixtures for the JS pin test. This is a serve artifact, NOT a claim
    the model works — exp11's verdict stands; the live ledger is the arbiter."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    rows = load_or_build()
    X = np.array([[r["feat"][f] for f in SERVE_FEATURES] for r in rows], float)
    y = np.array([r["win"] for r in rows], int)
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        scaler = StandardScaler().fit(X)
        clf = LogisticRegression(C=0.5, max_iter=1000, class_weight="balanced").fit(scaler.transform(X), y)
        probs = clf.predict_proba(scaler.transform(X))[:, 1]
    model = {
        "features": SERVE_FEATURES,
        "mean": [round(float(m), 6) for m in scaler.mean_],
        "std": [round(float(s), 6) for s in scaler.scale_],
        "coef": [round(float(c), 6) for c in clf.coef_[0]],
        "intercept": round(float(clf.intercept_[0]), 6),
        "median_prob": round(float(np.median(probs)), 6),
        "trained_n": int(len(rows)), "trained_window": [CFG.start, CFG.end],
        "note": "exp11 verdict: NO LIFT (rank-IC~0). Forward-tracked to falsify live, not a gate.",
    }
    (OUT / "metamodel_serve.json").write_text(json.dumps(model, indent=2))

    # fixtures for test/gapgo.test.js — spread across the probability range
    order = np.argsort(probs)
    picks = [int(order[int(k * (len(order) - 1) / 5)]) for k in range(6)]
    fixtures = [{"feat": {f: rows[j]["feat"][f] for f in SERVE_FEATURES},
                 "prob": round(float(probs[j]), 6)} for j in picks]

    print(json.dumps(model, indent=2))
    print("\n// ---- paste into lib/gapgo.js (META_MODEL) ----")
    print("const META_MODEL = " + json.dumps({k: model[k] for k in
          ("features", "mean", "std", "coef", "intercept", "median_prob")}) + ";")
    print("\n// ---- pin fixtures for test/gapgo.test.js ----")
    print("const META_FIXTURES = " + json.dumps(fixtures) + ";")
    print(f"\nSaved: {OUT/'metamodel_serve.json'}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "export":
        export_serve_model()
    else:
        run()
