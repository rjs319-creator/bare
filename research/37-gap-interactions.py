#!/usr/bin/env python3
"""Step 37 - Do INTERACTIONS beat the shipped Gap & Go continuationScore heuristic?

  research/intraday/.venv/bin/python research/37-gap-interactions.py

The shipped meta-label (lib/gapgo.js continuationScore = 0.42*gapN + 0.28*rvN +
0.30*regN, validated on 19,326 survivorship-corrected non-earnings gap events,
research/GAP-METALABEL-2026-07.md) is linear/additive and was validated
UNIVARIATELY. That lens is blind to one thing: interactions (gap x relVol x regime,
etc.). This experiment asks that single question honestly:

    Does a model free to use interactions rank the SAME events better than the
    shipped heuristic, OUT of sample, under purged expanding walk-forward?

PRE-REGISTERED design (no tuning, no variant search — declared before running):
- Data: research/data/gap-events.json (build: research/36-gap-events.js) —
  {sym, date, gap, R, win, ext, rv, atrPct, reg} per ORB-triggered event.
- Baseline ranker: exact continuationScore port (pinned to the JS by unit tests).
- Models (fixed configs):
    LOGIT-MAIN  logistic on z-scored mains [gap_w, rv_w, ext, atrPct, regN]
                (control: should ~reproduce the heuristic; if it beats the
                heuristic the win is calibration, not interactions)
    LOGIT-INT   same + all 10 pairwise products (explicit interactions)
    GBM         HistGradientBoostingClassifier(max_depth=3, max_iter=150,
                learning_rate=0.08, l2_regularization=1.0) (free-form interactions)
  gap_w = min(gap,20), rv_w = min(rv,10) (the shipped score's own winsor points);
  ext imputed with the train median. Target = win (R > 0).
- Validation: purged expanding walk-forward, half-year test folds 2023H1..2026H1,
  7-calendar-day purge before each fold (> the 3-session outcome window).
- Verdict metrics (OOS only, pooled over folds + per fold):
    (a) Spearman rank-IC (score vs realized R)
    (b) top-third and top-decile (within fold) expR / win / PF
    (c) selection overlap with the baseline's top-third (are the models even
        picking different trades?)
    (d) cluster-bootstrap (by date) 95% CI on pooled top-third expR delta vs
        baseline — the decisive number
    (e) deflation lens: PSR / Deflated Sharpe of the PRIMARY (pre-registered: GBM)
        top-third pooled series, trials = the 3 models searched.
A null result — heuristic at the ceiling — is an acceptable, valuable outcome.
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "intraday", "src"))

from sklearn.linear_model import LogisticRegression                      # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier             # noqa: E402
from sklearn.preprocessing import StandardScaler                        # noqa: E402

from intraday import deflate                                            # noqa: E402
from intraday.metalabel import (                                        # noqa: E402
    cluster_bootstrap_delta, continuation_score, lumpiness,
    purged_walk_forward, regime_norm, spearman_ic, top_fraction_idx, trade_stats,
)

EVENTS = os.path.join(HERE, "data", "gap-events.json")
OUT = os.path.join(HERE, "data", "gap-interactions.json")
TEST_FOLDS = ["2023H1", "2023H2", "2024H1", "2024H2", "2025H1", "2025H2", "2026H1"]
TOP_FRAC, DECILE = 1 / 3, 1 / 10
PRIMARY = "GBM"  # pre-registered primary model for the deflation lens


def load_events():
    rows = json.load(open(EVENTS))
    rows.sort(key=lambda e: e["date"])
    return rows


def feature_matrix(rows, ext_fill):
    """Mains [gap_w, rv_w, ext, atrPct, regN]; caller supplies the ext impute value
    (train median — no test leakage)."""
    m = np.array([
        [min(e["gap"], 20.0),
         min(e["rv"], 10.0) if e["rv"] is not None else 1.0,
         e["ext"] if e["ext"] is not None else ext_fill,
         e["atrPct"] if e["atrPct"] is not None else 0.0,
         regime_norm(e["reg"])]
        for e in rows
    ], dtype=float)
    return m


def with_interactions(x):
    """Append all 10 pairwise products of the 5 mains (new array, no mutation)."""
    cols = [x]
    n = x.shape[1]
    for i in range(n):
        for j in range(i + 1, n):
            cols.append((x[:, i] * x[:, j])[:, None])
    return np.hstack(cols)


def fit_predict(name, x_tr, y_tr, x_te):
    if name == "GBM":
        model = HistGradientBoostingClassifier(
            max_depth=3, max_iter=150, learning_rate=0.08,
            l2_regularization=1.0, random_state=0)
        return model.fit(x_tr, y_tr).predict_proba(x_te)[:, 1]
    # clip z-scores at ±10: `ext` (and its products) is heavy-tailed enough to
    # overflow the lbfgs solver otherwise — numerical robustness, not tuning
    scaler = StandardScaler().fit(x_tr)
    z_tr = np.clip(scaler.transform(x_tr), -10, 10)
    z_te = np.clip(scaler.transform(x_te), -10, 10)
    logit = LogisticRegression(C=1.0, max_iter=1000)
    logit.fit(z_tr, y_tr)
    return logit.predict_proba(z_te)[:, 1]


def main():
    rows = load_events()
    dates = [e["date"] for e in rows]
    r_all = np.array([e["R"] for e in rows], float)
    y_all = np.array([1 if e["win"] else 0 for e in rows])
    base_score = np.array([continuation_score(e["gap"], e["rv"], e["reg"]) for e in rows], float)
    print(f"{len(rows)} events {dates[0]}..{dates[-1]} · base expR {r_all.mean():.4f} "
          f"· win {y_all.mean():.3f}\n")

    splits = purged_walk_forward(dates, TEST_FOLDS)
    models = ["LOGIT-MAIN", "LOGIT-INT", "GBM"]
    rankers = ["BASELINE"] + models
    # pooled per-ranker selections: {ranker: {"third": [(R, date)...], "decile": [...]}}
    pooled = {rk: {"third": [], "decile": []} for rk in rankers}
    per_fold = []

    for sp in splits:
        tr, te = sp["train_idx"], sp["test_idx"]
        rows_tr = [rows[i] for i in tr]
        ext_fill = float(np.median([e["ext"] for e in rows_tr if e["ext"] is not None]))
        x_tr = feature_matrix(rows_tr, ext_fill)
        x_te = feature_matrix([rows[i] for i in te], ext_fill)
        scores = {"BASELINE": base_score[te]}
        scores["LOGIT-MAIN"] = fit_predict("LOGIT", x_tr, y_all[tr], x_te)
        scores["LOGIT-INT"] = fit_predict("LOGIT", with_interactions(x_tr), y_all[tr],
                                          with_interactions(x_te))
        scores["GBM"] = fit_predict("GBM", x_tr, y_all[tr], x_te)

        r_te = r_all[te]
        d_te = [dates[i] for i in te]
        base_third = set(top_fraction_idx(scores["BASELINE"], TOP_FRAC).tolist())
        fold_rep = {"fold": sp["fold"], "n_train": len(tr), "n_test": len(te), "rankers": {}}
        for rk in rankers:
            ic = spearman_ic(scores[rk], r_te)
            third = top_fraction_idx(scores[rk], TOP_FRAC)
            decile = top_fraction_idx(scores[rk], DECILE)
            pooled[rk]["third"] += [(float(r_te[i]), d_te[i]) for i in third]
            pooled[rk]["decile"] += [(float(r_te[i]), d_te[i]) for i in decile]
            overlap = len(base_third & set(third.tolist())) / len(third)
            fold_rep["rankers"][rk] = {
                "ic": None if ic is None else round(ic, 4),
                "third_expR": trade_stats(r_te[third])["expR"],
                "decile_expR": trade_stats(r_te[decile])["expR"],
                "overlap_vs_base": round(overlap, 3),
            }
        per_fold.append(fold_rep)

    # ---- report ----
    print("=== per-fold OOS (top-third expR | rank-IC | overlap with baseline top-third) ===")
    hdr = "fold".ljust(8) + "".join(rk.rjust(26) for rk in rankers)
    print(hdr)
    for fr in per_fold:
        line = fr["fold"].ljust(8)
        for rk in rankers:
            m = fr["rankers"][rk]
            line += f"{m['third_expR']:+.3f} ic {str(m['ic']):>7} ov {m['overlap_vs_base']:.2f}".rjust(26)
        print(line)

    print("\n=== pooled OOS 2023H1..2026H1 ===")
    report = {"n_events": len(rows), "folds": per_fold, "pooled": {}}
    base_third_r = [x[0] for x in pooled["BASELINE"]["third"]]
    base_third_d = [x[1] for x in pooled["BASELINE"]["third"]]
    for rk in rankers:
        third_r = [x[0] for x in pooled[rk]["third"]]
        third_d = [x[1] for x in pooled[rk]["third"]]
        dec_r = [x[0] for x in pooled[rk]["decile"]]
        st, sd_, lm = trade_stats(third_r), trade_stats(dec_r), lumpiness(third_r)
        folds_won = sum(1 for fr in per_fold
                        if fr["rankers"][rk]["third_expR"] > fr["rankers"]["BASELINE"]["third_expR"])
        entry = {"top_third": st, "top_decile": sd_, "lumpiness_third": lm,
                 "folds_beat_baseline": None if rk == "BASELINE" else f"{folds_won}/{len(per_fold)}"}
        if rk != "BASELINE":
            entry["delta_vs_base_third"] = cluster_bootstrap_delta(
                third_r, third_d, base_third_r, base_third_d)
        report["pooled"][rk] = entry
        print(f"{rk:<11} third: n={st['n']} expR {st['expR']:+.4f} win {st['win']} PF {st['pf']}"
              f" | decile: expR {sd_['expR']:+.4f} PF {sd_['pf']}"
              f" | top5-share {lm['topk_share']} median {lm['median']}"
              + ("" if rk == "BASELINE" else
                 f" | Δ3rd {entry['delta_vs_base_third']['delta']:+.4f}"
                 f" CI[{entry['delta_vs_base_third']['lo95']:+.4f},"
                 f"{entry['delta_vs_base_third']['hi95']:+.4f}]"
                 f" beat {entry['folds_beat_baseline']} folds"))

    # ---- deflation lens on the pre-registered primary ----
    trial_sharpes = [deflate.sharpe([x[0] for x in pooled[m]["third"]]) for m in models]
    prim_r = [x[0] for x in pooled[PRIMARY]["third"]]
    dsr, sr0 = deflate.deflated_sharpe(prim_r, trial_sharpes)
    psr_prim = deflate.psr(prim_r)
    psr_base = deflate.psr(base_third_r)
    report["deflation"] = {"primary": PRIMARY, "psr_primary": round(psr_prim, 3),
                           "dsr_primary": round(dsr, 3), "benchmark_max_sr": round(sr0, 4),
                           "n_trials": len(trial_sharpes), "psr_baseline_third": round(psr_base, 3)}
    print(f"\nDEFLATION (primary {PRIMARY}, {len(trial_sharpes)} trials): PSR {psr_prim:.3f} "
          f"DSR {dsr:.3f} (bar 0.95, benchmark E[maxSR] {sr0:.4f}) · baseline-third PSR {psr_base:.3f}")

    # ---- verdict ----
    prim = report["pooled"][PRIMARY]
    ci = prim["delta_vs_base_third"]
    improved = ci["delta"] is not None and ci["delta"] > 0 and ci["lo95"] > 0
    folds_ok = int(prim["folds_beat_baseline"].split("/")[0]) >= len(per_fold) - 1
    if improved and folds_ok and dsr >= 0.95:
        verdict = ("EDGE: interaction model beats the shipped heuristic OOS with a CI "
                   "excluding 0, fold-consistent, and survives deflation.")
    elif ci["delta"] is not None and ci["delta"] > 0 and folds_ok:
        verdict = ("LEAD: interaction model edges the heuristic OOS but the improvement is "
                   "not statistically/deflation-robust — do not ship; heuristic stands.")
    else:
        verdict = ("NULL: interactions do not beat the shipped parsimonious heuristic OOS — "
                   "the heuristic is at the ceiling of these features.")
    report["verdict"] = verdict
    print("\nVERDICT:\n  " + verdict)

    with open(OUT, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\nsaved → {OUT}")


if __name__ == "__main__":
    main()
