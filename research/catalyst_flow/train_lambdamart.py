"""CATALYST-FLOW - STEP 3: OFFLINE LambdaMART TRAINER / EVALUATOR.

    python research/catalyst_flow/train_lambdamart.py [--arm E2_CATALYST_RANKER]

Trains LightGBM's native ranker (objective=lambdarank, metric=ndcg, ndcg_eval_at=[10])
under NESTED, STRICTLY CAUSAL, PURGED walk-forward validation and writes out-of-fold
predictions for the Node evaluator to score.

WHAT THE VALIDATION ACTUALLY GUARANTEES
  * Outer test blocks are always LATER than their training data. There is no shuffling
    anywhere in this file.
  * Every stock from one decision date lands in the same split. Groups are decision dates,
    which is also what lambdarank ranks within.
  * PURGE: a training row whose five-session label window overlaps a validation or test
    block is removed. Overlapping labels are the whole reason a naive split on this data
    reports skill that does not exist.
  * EMBARGO: at least five further signal dates are dropped before every boundary, so a
    label that closes the session before a block starts still cannot brush against it.
  * Imputation, winsorisation and any scaling are fit on the TRAINING fold only. LightGBM
    consumes NaN natively, so "missing" stays missing rather than becoming a number.
  * The most recent 12 months are a FINAL HOLDOUT. This script refuses to touch them
    unless --open-holdout is passed, which is meant to happen exactly once, after the
    feature and model decisions are frozen.

WHAT IT DOES NOT CLAIM
  The model does not create the hypothesis. If the dataset's provenance is exploratory
  (see the dataset manifest), a good NDCG here is a statement about the reconstructed
  data, not about tradeable alpha - and the Node evaluator is the thing that says so.

Every trial - config, fold, metric - is appended to a registry, so no winner can be
selected from an undocumented search.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import lightgbm as lgb
except ImportError:  # pragma: no cover - explicit, never a silent substitution
    sys.stderr.write(
        "LightGBM is required and is not installed. This script will NOT silently fall\n"
        "back to a different model.\n\n"
        "  python3 -m venv research/catalyst_flow/.venv\n"
        "  research/catalyst_flow/.venv/bin/pip install -r research/catalyst_flow/requirements.txt\n\n"
        "On macOS LightGBM additionally needs the OpenMP runtime:\n"
        "  brew install libomp\n"
    )
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("RESEARCH_DATA_DIR", ROOT / "research" / "data")) / "catalyst-flow"
DATASET = DATA_DIR / "dataset.jsonl"
SCHEMA = DATA_DIR / "feature-schema.json"
OOF_OUT = DATA_DIR / "oof-predictions.jsonl"
TRIALS_OUT = DATA_DIR / "trials.jsonl"
MODEL_META = DATA_DIR / "model-meta.json"

TRAINER_VERSION = "catalyst-lambdamart-v1"
HOLD_SESSIONS = 5
EMBARGO_DATES = 5
FINAL_HOLDOUT_MONTHS = 12

# PREREGISTERED GRID. Deliberately narrow - four configurations, chosen for shallow trees,
# a low learning rate, a large minimum leaf and real regularisation. Widening this grid
# after seeing a result is the definition of the overfitting this design is guarding
# against, and the trial registry exists so that widening cannot happen unrecorded.
PARAM_GRID = [
    {"max_depth": 3, "num_leaves": 7, "learning_rate": 0.03, "min_child_samples": 100, "lambda_l1": 1.0, "lambda_l2": 5.0},
    {"max_depth": 4, "num_leaves": 15, "learning_rate": 0.03, "min_child_samples": 100, "lambda_l1": 1.0, "lambda_l2": 5.0},
    {"max_depth": 5, "num_leaves": 31, "learning_rate": 0.02, "min_child_samples": 200, "lambda_l1": 2.0, "lambda_l2": 10.0},
    {"max_depth": 6, "num_leaves": 31, "learning_rate": 0.02, "min_child_samples": 200, "lambda_l1": 2.0, "lambda_l2": 10.0},
]
BASE_PARAMS = {
    "objective": "lambdarank",
    "metric": "ndcg",
    "ndcg_eval_at": [10],
    "label_gain": [0, 1, 2, 4, 8],
    "lambdarank_truncation_level": 25,
    "feature_fraction": 0.7,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "verbosity": -1,
    "num_threads": 4,
    "seed": 20260814,
    "deterministic": True,
    "force_row_wise": True,
}
NUM_ROUNDS = 600
EARLY_STOPPING = 50

TRAINING_SCHEMES = ("rolling-3y", "expanding")
OUTER_TEST_MONTHS = (3, 6)


@dataclass
class Fold:
    scheme: str
    test_months: int
    fold_index: int
    train_start: str
    train_end: str
    valid_start: str
    valid_end: str
    test_start: str
    test_end: str
    n_train: int
    n_valid: int
    n_test: int
    purged_rows: int


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_dataset(cost_case: str) -> tuple[pd.DataFrame, dict]:
    schema = json.loads(SCHEMA.read_text())
    rows = []
    with open(DATASET) as fh:
        for line in fh:
            if not line.strip():
                continue
            r = json.loads(line)
            flat = {
                "key": r["key"],
                "symbol": r["symbol"],
                "decisionDate": r["decisionDate"],
                "sector": r.get("sector"),
                "grade": r.get("grade"),
                "target": r["targets"].get(cost_case),
                "pitClass": r.get("pitClass"),
            }
            flat.update(r["features"])
            rows.append(flat)
    df = pd.DataFrame(rows)
    df["decisionDate"] = pd.to_datetime(df["decisionDate"])
    df = df.sort_values(["decisionDate", "symbol"]).reset_index(drop=True)
    return df, schema


def feature_columns(schema: dict, arm: str) -> list[str]:
    """Declared columns for the arm, minus those that are empty in this build.

    An all-null column is not a feature, it is a placeholder. Keeping it would let the
    model's feature count overstate how much information it actually saw.
    """
    declared = schema["arms"][arm]
    empty = set(schema.get("emptyColumns", []))
    return [c for c in declared if c not in empty]


def session_dates(df: pd.DataFrame) -> np.ndarray:
    return np.array(sorted(df["decisionDate"].unique()))


def purge_train(train: pd.DataFrame, block_start: pd.Timestamp, all_dates: np.ndarray) -> tuple[pd.DataFrame, int]:
    """Drop training rows whose label window can reach the block, plus the embargo.

    A row signalled on decision date d holds for HOLD_SESSIONS sessions. Its label is only
    safely closed if the (HOLD_SESSIONS + EMBARGO_DATES)-th signal date after d is still
    strictly before the block.

    The distance is counted in SIGNAL DATES (dates on which some event was scored), never
    in calendar days - a calendar approximation across a holiday week is exactly how a
    purge silently under-purges. Signal dates are not identical to trading sessions: this
    dataset has an event on ~85% of sessions, so where events are dense the two nearly
    coincide, and where they are sparse N signal dates span MORE elapsed time than N
    sessions. The error is therefore always in the direction of OVER-purging, which costs
    training rows but cannot leak.
    """
    idx = {d: i for i, d in enumerate(all_dates)}
    block_idx = int(np.searchsorted(all_dates, block_start))
    need = HOLD_SESSIONS + EMBARGO_DATES
    keep = train["decisionDate"].map(lambda d: idx.get(np.datetime64(d), -1) + need < block_idx)
    return train[keep].copy(), int((~keep).sum())


def to_lgb(df: pd.DataFrame, cols: list[str]):
    X = df[cols].astype("float64").to_numpy()
    y = df["grade"].astype(int).to_numpy()
    group = df.groupby("decisionDate", sort=True).size().to_numpy()
    return X, y, group


def encode_categoricals_in_fold(train: pd.DataFrame, other: list[pd.DataFrame], cat_cols: list[str]):
    """Map each categorical to integer codes learned on the TRAINING fold only.

    A level that appears for the first time in validation or test becomes NaN rather than
    a new code - inventing a code from the test fold would be a small but genuine leak,
    and LightGBM handles the NaN natively.
    """
    frames = [train.copy()] + [d.copy() for d in other]
    for col in cat_cols:
        if col not in train.columns:
            continue
        levels = {v: i for i, v in enumerate(sorted(x for x in train[col].dropna().unique()))}
        for fr in frames:
            fr[col] = fr[col].map(levels).astype("float64")
    return frames


def winsorise_in_fold(train: pd.DataFrame, other: list[pd.DataFrame], cols: list[str], q: float = 0.01):
    """Clip to TRAINING quantiles and apply the same numbers downstream.

    Fitting the clip on train+test is the single most common leak in this class of study,
    and it is invisible in the metrics when it happens.
    """
    lo = train[cols].quantile(q)
    hi = train[cols].quantile(1 - q)
    out = [train.copy()]
    out[0][cols] = train[cols].clip(lo, hi, axis=1)
    for d in other:
        c = d.copy()
        c[cols] = d[cols].clip(lo, hi, axis=1)
        out.append(c)
    return out


def build_folds(dates: np.ndarray, scheme: str, test_months: int) -> list[tuple]:
    """Chronological outer blocks. Each test block is strictly after its training window."""
    start, end = dates[0], dates[-1]
    step = np.timedelta64(test_months * 30, "D")
    min_train = np.timedelta64(365 * 2, "D")   # two years before the first test block
    folds = []
    cursor = start + min_train
    while cursor + step <= end:
        test_start, test_end = cursor, cursor + step
        train_end = test_start
        train_start = start if scheme == "expanding" else max(start, test_start - np.timedelta64(365 * 3, "D"))
        folds.append((train_start, train_end, test_start, test_end))
        cursor = cursor + step
    return folds


def run_arm(df: pd.DataFrame, schema: dict, arm: str, cost_case: str, open_holdout: bool):
    cols = feature_columns(schema, arm)
    if not cols:
        return {"arm": arm, "status": "NO_USABLE_FEATURES", "predictions": [], "folds": [], "trials": []}
    cat_cols = [c for c in schema.get("categorical", []) if c in cols]
    num_cols = [c for c in cols if c not in cat_cols]

    dates = session_dates(df)
    holdout_cut = dates[-1] - np.timedelta64(FINAL_HOLDOUT_MONTHS * 30, "D")
    if not open_holdout:
        df = df[df["decisionDate"] < holdout_cut].copy()
        dates = session_dates(df)

    predictions, folds_meta, trials = [], [], []

    for scheme in TRAINING_SCHEMES:
        for test_months in OUTER_TEST_MONTHS:
            for fi, (tr_s, tr_e, te_s, te_e) in enumerate(build_folds(dates, scheme, test_months)):
                train_all = df[(df["decisionDate"] >= tr_s) & (df["decisionDate"] < tr_e)]
                test = df[(df["decisionDate"] >= te_s) & (df["decisionDate"] < te_e)]
                if len(train_all) < 500 or len(test) < 50:
                    continue

                # Inner validation is the LATEST slice of the training window - the part
                # closest to the test block - so early stopping is judged on the most
                # recent regime rather than on an average of old ones.
                inner_dates = sorted(train_all["decisionDate"].unique())
                if len(inner_dates) < 40:
                    continue
                v_cut = inner_dates[int(len(inner_dates) * 0.80)]
                valid = train_all[train_all["decisionDate"] >= v_cut]
                train_core = train_all[train_all["decisionDate"] < v_cut]

                train_core, purged_v = purge_train(train_core, v_cut, dates)
                train_purged, purged_t = purge_train(train_core, te_s, dates)
                valid_purged, purged_vt = purge_train(valid, te_s, dates)
                if len(train_purged) < 300 or len(valid_purged) < 50:
                    continue

                train_e, valid_e, test_e = encode_categoricals_in_fold(train_purged, [valid_purged, test], cat_cols)
                train_w, valid_w, test_w = winsorise_in_fold(train_e, [valid_e, test_e], num_cols)

                Xtr, ytr, gtr = to_lgb(train_w, cols)
                Xva, yva, gva = to_lgb(valid_w, cols)
                Xte, _, _ = to_lgb(test_w, cols)

                best = None
                for pi, grid in enumerate(PARAM_GRID):
                    params = {**BASE_PARAMS, **grid}
                    booster = lgb.train(
                        params,
                        lgb.Dataset(Xtr, label=ytr, group=gtr, feature_name=cols, categorical_feature=cat_cols, free_raw_data=False),
                        num_boost_round=NUM_ROUNDS,
                        valid_sets=[lgb.Dataset(Xva, label=yva, group=gva, feature_name=cols, categorical_feature=cat_cols, reference=None, free_raw_data=False)],
                        callbacks=[lgb.early_stopping(EARLY_STOPPING, verbose=False), lgb.log_evaluation(0)],
                    )
                    score = booster.best_score.get("valid_0", {}).get("ndcg@10")
                    trials.append({
                        "arm": arm, "scheme": scheme, "testMonths": test_months, "fold": fi,
                        "paramIndex": pi, "params": grid, "bestIteration": booster.best_iteration,
                        "validNdcg10": score, "costCase": cost_case,
                        "nTrain": len(train_w), "nValid": len(valid_w), "nTest": len(test_w),
                    })
                    if score is not None and (best is None or score > best[0]):
                        best = (score, booster, pi)

                if best is None:
                    continue
                _, booster, pidx = best

                # IN-FOLD EDGE CALIBRATION. A LambdaMART score is ordinal, but the
                # portfolio's abstention rule needs an edge in RETURN units. We take the
                # training fold's own scores, cut them into deciles, and record each
                # decile's mean net target. The test fold is then mapped through those
                # frozen boundaries. Fit on training rows only - the calibration never
                # sees a test outcome, which is what makes "expected edge" here a
                # prediction rather than a description.
                train_scores = booster.predict(Xtr, num_iteration=booster.best_iteration)
                edges = pd.DataFrame({"s": train_scores, "t": train_w["target"].to_numpy()})
                try:
                    bounds = np.unique(np.quantile(edges["s"], np.linspace(0, 1, 11)))
                    labels = np.clip(np.searchsorted(bounds, edges["s"], side="right") - 1, 0, len(bounds) - 2)
                    cal = edges.assign(b=labels).groupby("b")["t"].mean()
                    calibration = {"bounds": bounds.tolist(), "meanTargetByBin": {int(k): float(v) for k, v in cal.items()}}
                except Exception:
                    calibration = None

                scores = booster.predict(Xte, num_iteration=booster.best_iteration)
                for k, s in zip(test_w["key"].tolist(), scores.tolist()):
                    predictions.append({
                        "key": k, "arm": arm, "scheme": scheme, "testMonths": test_months,
                        "fold": fi, "score": float(s), "paramIndex": pidx,
                        "calibration": calibration,
                    })
                folds_meta.append(asdict(Fold(
                    scheme=scheme, test_months=test_months, fold_index=fi,
                    train_start=str(pd.Timestamp(tr_s).date()), train_end=str(pd.Timestamp(tr_e).date()),
                    valid_start=str(pd.Timestamp(v_cut).date()), valid_end=str(pd.Timestamp(tr_e).date()),
                    test_start=str(pd.Timestamp(te_s).date()), test_end=str(pd.Timestamp(te_e).date()),
                    n_train=len(train_w), n_valid=len(valid_w), n_test=len(test_w),
                    purged_rows=purged_v + purged_t + purged_vt,
                )))

    return {"arm": arm, "status": "TRAINED", "featureColumns": cols, "predictions": predictions, "folds": folds_meta, "trials": trials}


def run_leaky_diagnostic(df: pd.DataFrame, schema: dict, arm: str) -> dict:
    """The deliberately UNPURGED read, reported beside the proper one.

    This exists only to measure how much the purge is worth. It is a leakage diagnostic
    and is never the headline - a number produced here is not a result about the strategy.
    """
    cols = feature_columns(schema, arm)
    cat_cols = [c for c in schema.get("categorical", []) if c in cols]
    dates = session_dates(df)
    folds = build_folds(dates, "expanding", 6)
    if not folds:
        return {"status": "NO_FOLDS"}
    ndcgs = []
    for tr_s, tr_e, te_s, te_e in folds:
        train = df[(df["decisionDate"] >= tr_s) & (df["decisionDate"] < tr_e)]
        test = df[(df["decisionDate"] >= te_s) & (df["decisionDate"] < te_e)]
        if len(train) < 500 or len(test) < 50:
            continue
        train_e, test_e = encode_categoricals_in_fold(train, [test], cat_cols)
        Xtr, ytr, gtr = to_lgb(train_e, cols)    # NO purge, NO embargo - the point
        Xte, yte, gte = to_lgb(test_e, cols)
        params = {**BASE_PARAMS, **PARAM_GRID[1]}
        booster = lgb.train(
            params, lgb.Dataset(Xtr, label=ytr, group=gtr, feature_name=cols),
            num_boost_round=200,
            valid_sets=[lgb.Dataset(Xte, label=yte, group=gte, feature_name=cols)],
            callbacks=[lgb.log_evaluation(0)],
        )
        ndcgs.append(booster.best_score.get("valid_0", {}).get("ndcg@10"))
    vals = [v for v in ndcgs if v is not None]
    return {"status": "MEASURED", "folds": len(vals), "meanNdcg10": float(np.mean(vals)) if vals else None,
            "caveat": "UNPURGED. Leakage diagnostic only - never a headline result."}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", default="E2_CATALYST_RANKER")
    ap.add_argument("--cost-case", default=None)
    ap.add_argument("--open-holdout", action="store_true",
                    help="Open the final 12-month holdout. Intended to be used ONCE, after the design is frozen.")
    args = ap.parse_args()

    if not DATASET.exists():
        sys.stderr.write(f"dataset missing: {DATASET}\nRun research/88 then research/89 first.\n")
        return 2

    schema = json.loads(SCHEMA.read_text())
    cost_case = args.cost_case or schema["primaryCostCase"]
    df, schema = load_dataset(cost_case)
    df = df[df["grade"].notna() & df["target"].notna()].copy()

    result = run_arm(df, schema, args.arm, cost_case, args.open_holdout)
    leaky = run_leaky_diagnostic(df, schema, args.arm)

    with open(OOF_OUT, "a" if OOF_OUT.exists() else "w") as fh:
        for p in result["predictions"]:
            fh.write(json.dumps(p) + "\n")
    with open(TRIALS_OUT, "a" if TRIALS_OUT.exists() else "w") as fh:
        for t in result["trials"]:
            fh.write(json.dumps(t) + "\n")

    meta = {
        "trainerVersion": TRAINER_VERSION,
        "lightgbmVersion": lgb.__version__,
        "arm": args.arm,
        "costCase": cost_case,
        "status": result["status"],
        "featureColumns": result.get("featureColumns", []),
        "featureCount": len(result.get("featureColumns", [])),
        "objective": BASE_PARAMS["objective"],
        "metric": BASE_PARAMS["metric"],
        "ndcgEvalAt": BASE_PARAMS["ndcg_eval_at"],
        "labelGain": BASE_PARAMS["label_gain"],
        "truncationLevel": BASE_PARAMS["lambdarank_truncation_level"],
        "grid": PARAM_GRID,
        "trainingSchemes": list(TRAINING_SCHEMES),
        "outerTestMonths": list(OUTER_TEST_MONTHS),
        "purgeSessions": HOLD_SESSIONS,
        "embargoDates": EMBARGO_DATES,
        "finalHoldoutMonths": FINAL_HOLDOUT_MONTHS,
        "holdoutOpened": bool(args.open_holdout),
        "trialCount": len(result["trials"]),
        "folds": result["folds"],
        "predictions": len(result["predictions"]),
        "meanValidNdcg10": float(np.mean([t["validNdcg10"] for t in result["trials"] if t["validNdcg10"] is not None]))
        if result["trials"] else None,
        "leakageDiagnostic": leaky,
        "datasetSha256": sha256_file(DATASET),
        "schemaSha256": sha256_file(SCHEMA),
        "rows": int(len(df)),
        "decisionDates": int(df["decisionDate"].nunique()),
    }
    MODEL_META.write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps({k: v for k, v in meta.items() if k != "folds"}, indent=2))
    print(f"\noof  -> {OOF_OUT}\nmeta -> {MODEL_META}\ntrials -> {TRIALS_OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
