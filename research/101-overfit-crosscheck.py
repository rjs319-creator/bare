#!/usr/bin/env python3
"""Step 101 — INDEPENDENT OVERFIT CROSS-CHECK (proposal #23, RESEARCH-ONLY).

Recomputes, with purgedcv (MIT) and arch (NCSA), the quantities the site's own JS
computes for its promotion gates, on the SAME exported inputs:

  * CSCV probability of backtest overfitting  (lib/research/pbo.js  vs  purgedcv)
  * probabilistic / deflated Sharpe            (lib/evolve-dsr.js    vs  purgedcv)
  * minimum backtest length                     (purgedcv only — the site has none)
  * SPA / Reality Check over the family of live screeners vs SPY and StepM
    (arch only — "does the best screener beat the benchmark after everything we tried?"
     is a test the site lacks)

Inputs : research/data-derived/pbo-matrices/*.json  (written by research/lib/export-pbo-matrices.js)
Output : research/data-derived/overfit-crosscheck.json  with per-matrix deltas and a `verdict`
         the hypothesis registry can show as a cross-check badge (--publish copies it to
         lib/research/overfit-crosscheck.json, which op=hypotheses reads).

    research/.venv/bin/python research/101-overfit-crosscheck.py            # run on exported matrices
    research/.venv/bin/python research/101-overfit-crosscheck.py --selftest # synthetic parity checks
    research/.venv/bin/python research/101-overfit-crosscheck.py --publish  # + copy badge file

Agreement thresholds (from the lane-2 proposal): |ΔPBO| ≤ 0.02, |ΔDSR| ≤ 0.05. The JS
numbers come from research/lib/js-stats-cli.js so both sides see one matrix.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import shutil
import subprocess
import sys
import warnings
from dataclasses import asdict, dataclass

import numpy as np

warnings.filterwarnings("ignore", category=FutureWarning)

ROOT = pathlib.Path(__file__).resolve().parents[1]
MATRIX_DIR = ROOT / "research" / "data-derived" / "pbo-matrices"
OUT_FILE = ROOT / "research" / "data-derived" / "overfit-crosscheck.json"
BADGE_FILE = ROOT / "lib" / "research" / "overfit-crosscheck.json"
JS_CLI = ROOT / "research" / "lib" / "js-stats-cli.js"
VERSION = "overfit-crosscheck-v1"

PBO_TOL = 0.02
DSR_TOL = 0.05
SPA_REPS = 2000
SPA_SIZE = 0.05
SEED = 20261002
MIN_OBS_FOR_SPA = 30
# Which registry rows each exported matrix speaks for (badge routing).
MATRIX_TO_HYPOTHESES = {
    "challenger": ["transparent-challenger-v1"],
    "screener-family": ["screener-family-spa"],
}


# ── JS side (one process per request; the matrices are small) ───────────────────────────
def js_call(req: dict) -> dict:
    proc = subprocess.run(["node", str(JS_CLI)], input=json.dumps(req), capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"js-stats-cli failed: {proc.stderr.strip()[:400]}")
    return json.loads(proc.stdout)


# ── Python side ─────────────────────────────────────────────────────────────────────────
def py_pbo(matrix: np.ndarray, blocks: int) -> float:
    from purgedcv import probability_of_backtest_overfitting

    # purgedcv wants (n_configs, n_obs) and defaults to Sharpe; the site ranks by MEAN.
    res = probability_of_backtest_overfitting(matrix.T, n_splits=blocks, metric=lambda x: float(np.mean(x)))
    return float(res.pbo)


def py_dsr(returns: np.ndarray, trials: int, var_sharpe: float) -> dict:
    from purgedcv import deflated_sharpe_ratio_full, min_track_record_length, minimum_backtest_length, probabilistic_sharpe_ratio

    psr = float(probabilistic_sharpe_ratio(returns, 0.0))
    full = deflated_sharpe_ratio_full(returns, trials, var_sharpe)
    out = {"psr": psr, "dsr": float(full.dsr), "sr0": float(full.sr_star), "sr": float(full.observed_sr), "n": int(full.n_obs)}
    try:
        out["minBTL"] = float(minimum_backtest_length(trials, target_sharpe=1.0))
        out["minTRL"] = float(min_track_record_length(full.observed_sr, 0.0, 0.05, full.skew, full.kurt))
    except (ValueError, ZeroDivisionError, FloatingPointError):
        out["minBTL"] = None
        out["minTRL"] = None
    return out


def spa_family(matrix: np.ndarray, variants: list[str]) -> dict:
    """SPA / RealityCheck / StepM: models = screener excess (vs SPY ≡ 0). arch takes LOSSES."""
    from arch.bootstrap import SPA, RealityCheck, StepM

    if matrix.shape[0] < MIN_OBS_FOR_SPA or matrix.shape[1] < 1:
        return {"ready": False, "reason": f"need ≥{MIN_OBS_FOR_SPA} dates and ≥1 screener"}
    losses = -matrix  # higher excess = lower loss
    bench = np.zeros(matrix.shape[0])
    rng = np.random.default_rng(SEED)
    spa = SPA(bench, losses, reps=SPA_REPS, seed=rng)
    spa.compute()
    rc = RealityCheck(bench, losses, reps=SPA_REPS, seed=np.random.default_rng(SEED))
    rc.compute()
    stepm = StepM(bench, losses, size=SPA_SIZE, reps=SPA_REPS, seed=np.random.default_rng(SEED))
    stepm.compute()
    superior = [variants[int(i)] if isinstance(i, (int, np.integer)) else str(i) for i in stepm.superior_models]
    means = matrix.mean(axis=0)
    ses = matrix.std(axis=0, ddof=1) / math.sqrt(matrix.shape[0])
    return {
        "ready": True,
        "dates": int(matrix.shape[0]),
        "screeners": variants,
        "spa": {k: float(v) for k, v in spa.pvalues.items()},
        "realityCheck": {k: float(v) for k, v in rc.pvalues.items()},
        "stepM": {"size": SPA_SIZE, "superiorModels": superior},
        "perScreener": [{"screener": v, "meanExcess": float(means[i]), "t": float(means[i] / ses[i]) if ses[i] > 0 else None} for i, v in enumerate(variants)],
        "reading": ("no screener beats SPY after accounting for the family (SPA consistent p ≥ 0.05, StepM empty)"
                    if spa.pvalues["consistent"] >= SPA_SIZE and not superior else
                    f"best-of-family beats SPY at SPA consistent p {spa.pvalues['consistent']:.3f}; StepM superior: {superior or 'none'}"),
    }


# ── one matrix ─────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Delta:
    metric: str
    js: float | None
    py: float | None
    delta: float | None
    tolerance: float
    agree: bool | None


def delta_of(metric: str, js: float | None, py: float | None, tol: float) -> Delta:
    if js is None or py is None or not (math.isfinite(js) and math.isfinite(py)):
        return Delta(metric, js, py, None, tol, None)
    d = abs(js - py)
    return Delta(metric, js, py, d, tol, d <= tol)


def crosscheck_matrix(doc: dict) -> dict:
    name = doc.get("name") or "matrix"
    rows = [r for r in doc.get("matrix", []) if all(isinstance(v, (int, float)) and math.isfinite(v) for v in r)]
    variants = list(doc.get("variants", []))
    out: dict = {"name": name, "dates": len(rows), "variants": variants, "hypotheses": MATRIX_TO_HYPOTHESES.get(name, []), "deltas": [], "notes": []}
    if len(rows) < 4 or len(variants) < 2:
        out["notes"].append("too few finite rows/variants for PBO — not computable")
        return out
    matrix = np.asarray(rows, dtype=float)
    js_pbo = js_call({"op": "pbo", "matrix": rows, "blocks": (doc.get("js") or {}).get("blocks") or 8})
    blocks = int(js_pbo.get("blocks") or 8)
    if js_pbo.get("pbo") is not None:
        out["deltas"].append(asdict(delta_of("pbo", js_pbo["pbo"], py_pbo(matrix, blocks), PBO_TOL)))
        out["pbo"] = {"blocks": blocks, "combinations": js_pbo.get("combinations"), "js": js_pbo, "layoutNote": "purgedcv puts the remainder rows in the FIRST blocks, pbo.js in the LAST; identical when dates % blocks == 0"}
    else:
        out["notes"].append(f"JS PBO not computable: {js_pbo.get('reason')}")
    # DSR per variant column, trials = number of variants (identical inputs on both sides).
    dsr_rows = []
    for j, v in enumerate(variants):
        col = matrix[:, j]
        js = js_call({"op": "dsr", "returns": col.tolist(), "trials": len(variants)})
        if not js.get("ready"):
            continue
        py = py_dsr(col, len(variants), js["varSR"])
        dsr_rows.append({"variant": v, "js": {k: js[k] for k in ("sr", "psr", "dsr", "sr0", "n")}, "py": py,
                         "psr": asdict(delta_of("psr", js["psr"], py["psr"], DSR_TOL)), "dsr": asdict(delta_of("dsr", js["dsr"], py["dsr"], DSR_TOL))})
    out["dsr"] = dsr_rows
    out["deltas"].extend(d["dsr"] for d in dsr_rows)
    if name == "screener-family":
        filled = np.asarray([[0.0 if v is None else float(v) for v in r] for r in doc.get("matrix", [])], dtype=float)
        out["spa"] = spa_family(filled, variants)
        out["notes"].append("SPA/StepM fill a missing (no-pick) cell with 0 excess = no position; PBO drops those dates")
    return out


def overall_verdict(results: list[dict]) -> dict:
    deltas = [d for r in results for d in r.get("deltas", []) if d.get("agree") is not None]
    if not deltas:
        return {"verdict": "not-computable", "reason": "no matrix produced a comparable statistic", "checked": 0}
    disagree = [d for d in deltas if d["agree"] is False]
    return {
        "verdict": "disagree" if disagree else "agree",
        "checked": len(deltas),
        "disagreements": disagree,
        "reason": ("all JS/Python statistics within tolerance" if not disagree else
                   f"{len(disagree)} statistic(s) outside tolerance — inspect before trusting the JS gate"),
        "tolerances": {"pbo": PBO_TOL, "dsr": DSR_TOL},
    }


def badge_doc(results: list[dict], verdict: dict, generated_at: str) -> dict:
    """Per-hypothesis badge map op=hypotheses attaches: { id: {verdict, checkedAt, matrix} }."""
    per: dict = {}
    for r in results:
        agree = [d["agree"] for d in r.get("deltas", []) if d.get("agree") is not None]
        v = "not-computable" if not agree else ("agree" if all(agree) else "disagree")
        for hid in r.get("hypotheses", []):
            per[hid] = {"verdict": v, "checkedAt": generated_at, "matrix": r["name"], "checked": len(agree)}
    return {"version": VERSION, "generatedAt": generated_at, "overall": verdict["verdict"], "byHypothesis": per}


# ── selftest ──────────────────────────────────────────────────────────────────────────
def _noise_matrix(rng: np.random.Generator, dates: int, variants: int) -> np.ndarray:
    return rng.standard_normal((dates, variants)) * 0.05


def selftest() -> int:
    rng = np.random.default_rng(SEED)
    failures = []
    # 1. Pure noise, dates divisible by blocks → both PBO implementations identical, ≈ 0.5 on average.
    pbos = []
    for _ in range(6):
        m = _noise_matrix(rng, 96, 8)
        js = js_call({"op": "pbo", "matrix": m.tolist(), "blocks": 8})["pbo"]
        py = py_pbo(m, 8)
        pbos.append((js, py))
        if abs(js - py) > PBO_TOL:
            failures.append(f"noise PBO js {js} vs py {py}")
    mean_js = float(np.mean([p[0] for p in pbos]))
    if not 0.3 <= mean_js <= 0.7:
        failures.append(f"noise PBO mean {mean_js} not near 0.5")
    # 2. One dominant variant → PBO ≈ 0 on both sides.
    dom = _noise_matrix(rng, 96, 8)
    dom[:, 0] += 0.2
    js = js_call({"op": "pbo", "matrix": dom.tolist(), "blocks": 8})["pbo"]
    py = py_pbo(dom, 8)
    if js > 0.1 or py > 0.1 or abs(js - py) > PBO_TOL:
        failures.append(f"dominant PBO js {js} py {py}")
    # 3. PSR/DSR parity on a positive-drift series.
    rets = rng.standard_normal(120) * 0.02 + 0.004
    jsd = js_call({"op": "dsr", "returns": rets.tolist(), "trials": 10})
    pyd = py_dsr(rets, 10, jsd["varSR"])
    if abs(jsd["psr"] - pyd["psr"]) > DSR_TOL or abs(jsd["dsr"] - pyd["dsr"]) > DSR_TOL:
        failures.append(f"DSR parity js {jsd['psr']:.3f}/{jsd['dsr']:.3f} py {pyd['psr']:.3f}/{pyd['dsr']:.3f}")
    # 4. SPA/StepM: one screener with real excess is found, pure-noise screeners are not.
    fam = _noise_matrix(rng, 300, 5) * 20  # % units
    fam[:, 2] += 0.6
    res = spa_family(fam, [f"s{i}" for i in range(5)])
    if not res["ready"] or "s2" not in res["stepM"]["superiorModels"]:
        failures.append(f"StepM missed the true winner: {res.get('stepM')}")
    null = spa_family(_noise_matrix(rng, 300, 5) * 20, [f"n{i}" for i in range(5)])
    if null["spa"]["consistent"] < SPA_SIZE and null["stepM"]["superiorModels"]:
        failures.append(f"SPA found a winner in pure noise: {null['spa']}")
    for f in failures:
        print("SELFTEST FAIL:", f)
    print(json.dumps({"selftest": "ok" if not failures else "fail", "noisePboMeanJs": round(mean_js, 3), "dominant": {"js": js, "py": py},
                      "dsr": {"js": round(jsd["dsr"], 4), "py": round(pyd["dsr"], 4)}, "stepM": res["stepM"], "nullSpa": null["spa"]}, indent=1))
    return 1 if failures else 0


# ── main ──────────────────────────────────────────────────────────────────────────────
def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--publish", action="store_true", help="also copy the badge file to lib/research/")
    ap.add_argument("--matrices", default=str(MATRIX_DIR))
    ap.add_argument("--out", default=str(OUT_FILE))
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    mdir = pathlib.Path(args.matrices)
    files = sorted(mdir.glob("*.json")) if mdir.exists() else []
    results = []
    for f in files:
        try:
            doc = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError) as e:
            results.append({"name": f.stem, "notes": [f"unreadable: {e}"], "deltas": []})
            continue
        results.append(crosscheck_matrix(doc))
    verdict = overall_verdict(results)
    from datetime import datetime, timezone

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = {"version": VERSION, "generatedAt": generated_at, "inputs": [str(f.relative_to(ROOT)) for f in files], "results": results, **verdict,
           "note": ("No exported matrices found — run research/lib/export-pbo-matrices.js with BLOB access first." if not files else
                    "Independent recomputation on identical exported inputs; promotion gates unchanged until 3 months of agreement.")}
    pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(args.out).write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: out[k] for k in ("verdict", "checked", "reason", "inputs")}, indent=1))
    if args.publish:
        BADGE_FILE.write_text(json.dumps(badge_doc(results, verdict, generated_at), indent=1) + "\n")
        print("badge →", BADGE_FILE.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
