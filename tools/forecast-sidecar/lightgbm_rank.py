#!/usr/bin/env python3
"""LightGBM cross-sectional meta-ranker sidecar (forecast-lightgbm-sidecar-v1).

Large float matrices are exchanged as raw little-endian float32 / int32 FILES, not JSON —
JSON-encoding a 200k x 75 design matrix dominates the runtime otherwise. The JSON request only
carries shapes, paths and hyper-parameters.

Request:
  { "jobs": [ {
        "id": "h5.fold3.outer",
        "objective": "lambdarank" | "regression" | "binary",
        "params": { ...LightGBM params... },
        "numRounds": 200,
        "featureNames": [...p...],
        "train": {"x": "<path>", "y": "<path>", "rows": n, "cols": p,
                   "group": "<path>"|null, "groups": k|null, "weight": "<path>"|null},
        "valid": {...same, optional — enables early stopping...},
        "predict": {"x": "<path>", "rows": m, "cols": p, "out": "<path>"}
    } ] }

Response:
  { "ok": true, "lightgbmVersion": "...", "results": [ {"id":..., "bestIteration":...,
      "importance": {...}, "predRows": m} ] }

Determinism: seeds are set on every stochastic parameter and `deterministic`/`force_row_wise`
are enabled, so a re-run with the same inputs reproduces the same model.
"""
import json
import os
import sys


def fail(error, availability="inference-failed", **extra):
    json.dump({"ok": False, "error": error, "availability": availability, **extra}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        fail(f"request was not JSON: {exc}")

    try:
        import numpy as np
    except Exception as exc:
        fail(f"numpy not importable: {type(exc).__name__}: {exc}", "package-missing")
    try:
        import lightgbm as lgb
    except Exception as exc:
        fail(f"lightgbm not importable: {type(exc).__name__}: {exc}", "package-missing")

    def read_f32(path, rows, cols=None):
        a = np.fromfile(path, dtype="<f4")
        expected = rows * (cols or 1)
        if a.size != expected:
            raise ValueError(f"{path}: expected {expected} float32 values, found {a.size}")
        return a.reshape(rows, cols) if cols else a

    def read_i32(path, n):
        a = np.fromfile(path, dtype="<i4")
        if a.size != n:
            raise ValueError(f"{path}: expected {n} int32 values, found {a.size}")
        return a

    results = []
    for job in req.get("jobs") or []:
        jid = job.get("id")
        try:
            tr = job["train"]
            X = read_f32(tr["x"], tr["rows"], tr["cols"])
            y = read_f32(tr["y"], tr["rows"])
            w = read_f32(tr["weight"], tr["rows"]) if tr.get("weight") else None
            grp = read_i32(tr["group"], tr["groups"]) if tr.get("group") else None

            objective = job.get("objective") or "regression"
            seed = int(job.get("params", {}).get("seed", 0))
            params = {
                "objective": objective,
                "verbosity": -1,
                "deterministic": True,
                "force_row_wise": True,
                "seed": seed,
                "bagging_seed": seed + 1,
                "feature_fraction_seed": seed + 2,
                "data_random_seed": seed + 3,
                **{k: v for k, v in (job.get("params") or {}).items() if v is not None},
            }
            if objective == "lambdarank":
                params.setdefault("metric", "ndcg")
                params.setdefault("lambdarank_truncation_level", 30)
                y = y.astype(int)
            elif objective == "binary":
                params.setdefault("metric", "binary_logloss")
            else:
                params.setdefault("metric", "l2")

            feature_names = job.get("featureNames")
            dtrain = lgb.Dataset(X, label=y, weight=w, group=grp,
                                 feature_name=feature_names, free_raw_data=False)
            valid_sets, callbacks = [], []
            if job.get("valid"):
                va = job["valid"]
                Xv = read_f32(va["x"], va["rows"], va["cols"])
                yv = read_f32(va["y"], va["rows"])
                gv = read_i32(va["group"], va["groups"]) if va.get("group") else None
                if objective == "lambdarank":
                    yv = yv.astype(int)
                valid_sets = [lgb.Dataset(Xv, label=yv, group=gv, reference=dtrain,
                                          feature_name=feature_names, free_raw_data=False)]
                callbacks = [lgb.early_stopping(int(job.get("earlyStoppingRounds") or 30),
                                                verbose=False)]

            booster = lgb.train(params, dtrain, num_boost_round=int(job.get("numRounds") or 100),
                                valid_sets=valid_sets, callbacks=callbacks)

            # ── Choose the iteration count by the metric we actually evaluate on ──────────
            # LightGBM early-stops on its own loss (L2 / NDCG). Neither is the full-cross-section
            # Spearman IC this system is judged by, and they diverge: a regression fit kept
            # improving its validation L2 to 200 rounds while its validation rank IC was already
            # falling, which is how an in-sample IC of 0.35 landed on a NEGATIVE out-of-sample one.
            # When the caller supplies the validation block's raw ranking target plus its group
            # sizes, sweep the iteration counts and report the one that maximizes mean per-group
            # Spearman. The caller refits at that count.
            rank_ic_by_iteration = None
            best_iteration_by_rank_ic = None
            va = job.get("valid") or {}
            if va.get("rankTarget") and va.get("group"):
                yv_raw = read_f32(va["rankTarget"], va["rows"])
                gv = read_i32(va["group"], va["groups"])
                Xv2 = read_f32(va["x"], va["rows"], va["cols"])
                bounds, off = [], 0
                for g in gv:
                    bounds.append((off, off + int(g)))
                    off += int(g)

                def rank1d(a):
                    order = np.argsort(a, kind="mergesort")
                    r = np.empty(len(a), dtype=np.float64)
                    r[order] = np.arange(len(a), dtype=np.float64)
                    # average ties so a constant block cannot masquerade as an ordering
                    _, inv, cnt = np.unique(a, return_inverse=True, return_counts=True)
                    if (cnt > 1).any():
                        sums = np.zeros(len(cnt))
                        np.add.at(sums, inv, r)
                        r = (sums / cnt)[inv]
                    return r

                def grouped_spearman(pred):
                    ics = []
                    for lo, hi in bounds:
                        if hi - lo < 5:
                            continue
                        a, b = pred[lo:hi], yv_raw[lo:hi]
                        ok = np.isfinite(a) & np.isfinite(b)
                        if ok.sum() < 5 or np.all(a[ok] == a[ok][0]):
                            continue
                        ra, rb = rank1d(a[ok]), rank1d(b[ok])
                        ra -= ra.mean(); rb -= rb.mean()
                        den = np.sqrt((ra * ra).sum() * (rb * rb).sum())
                        if den > 0:
                            ics.append(float((ra * rb).sum() / den))
                    return float(np.mean(ics)) if ics else None

                total = int(booster.current_iteration())
                step = max(1, int(job.get("rankIcStep") or 10))
                rank_ic_by_iteration = {}
                for it in range(step, total + 1, step):
                    ic = grouped_spearman(booster.predict(Xv2, num_iteration=it))
                    if ic is None:
                        continue
                    rank_ic_by_iteration[it] = ic
                    if best_iteration_by_rank_ic is None or ic > rank_ic_by_iteration[best_iteration_by_rank_ic]:
                        best_iteration_by_rank_ic = it

            pred_rows = 0
            if job.get("predict"):
                pr = job["predict"]
                Xp = read_f32(pr["x"], pr["rows"], pr["cols"])
                yp = booster.predict(Xp, num_iteration=booster.best_iteration or None)
                np.asarray(yp, dtype="<f4").tofile(pr["out"])
                pred_rows = int(pr["rows"])

            gain = booster.feature_importance(importance_type="gain")
            names = booster.feature_name()
            importance = {n: float(g) for n, g in zip(names, gain)}

            results.append({
                "id": jid, "ok": True,
                "bestIteration": int(booster.best_iteration or booster.current_iteration()),
                "bestIterationByRankIC": best_iteration_by_rank_ic,
                "validRankIC": (rank_ic_by_iteration.get(best_iteration_by_rank_ic)
                                if rank_ic_by_iteration and best_iteration_by_rank_ic else None),
                "rankIcByIteration": rank_ic_by_iteration,
                "numTrees": int(booster.num_trees()),
                "importance": importance,
                "predRows": pred_rows,
                "trainRows": int(tr["rows"]),
            })
        except Exception as exc:
            results.append({"id": jid, "ok": False,
                            "error": f"{type(exc).__name__}: {exc}"[:500]})

    json.dump({
        "ok": True,
        "sidecarVersion": "forecast-lightgbm-sidecar-v1",
        "lightgbmVersion": lgb.__version__,
        "numpyVersion": np.__version__,
        "pid": os.getpid(),
        "results": results,
    }, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
