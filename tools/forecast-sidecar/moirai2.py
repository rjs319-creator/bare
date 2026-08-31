#!/usr/bin/env python3
"""Moirai-2 sidecar (forecast-moirai2-sidecar-v1) — OPTIONAL CHALLENGER.

Same request/response envelope as chronos2.py, so both normalize through the one Forecast
contract in lib/forecast/contract.js.

Targets the documented uni2ts Moirai-2 path:
    from uni2ts.model.moirai2 import Moirai2Forecast, Moirai2Module
    module    = Moirai2Module.from_pretrained(model_id)
    model     = Moirai2Forecast(module=module, prediction_length=H, context_length=C,
                                target_dim=1, feat_dynamic_real_dim=0,
                                past_feat_dynamic_real_dim=0)
    predictor = model.create_predictor(batch_size=B)

VERSION DISCIPLINE. Only a uni2ts release that exposes the `moirai2` module counts as Moirai-2.
An installation that only offers `uni2ts.model.moirai` (Moirai-1) is reported as
`incompatible-version`, never silently substituted.

STATUS: UNVERIFIED in this repository's current environment (Python 3.9; uni2ts has no
py3.9-compatible distribution). It reports precisely why it cannot run.
"""
import json
import sys

SIDECAR_VERSION = "forecast-moirai2-sidecar-v1"


def fail(error, availability, **extra):
    json.dump({"ok": False, "error": error, "availability": availability,
               "sidecarVersion": SIDECAR_VERSION, **extra}, sys.stdout)
    sys.stdout.write("\n")
    sys.exit(0)


def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        fail(f"request was not JSON: {exc}", "inference-failed")

    if sys.version_info < (3, 10):
        fail(f"Moirai-2 (uni2ts) requires Python >= 3.10; this interpreter is {sys.version.split()[0]}",
             "incompatible-version", pythonVersion=sys.version.split()[0])

    try:
        import uni2ts
    except Exception as exc:
        fail(f"uni2ts not importable: {type(exc).__name__}: {exc}", "package-missing")

    pkg_version = getattr(uni2ts, "__version__", None)
    if pkg_version is None:
        try:
            from importlib import metadata
            pkg_version = metadata.version("uni2ts")
        except Exception:
            pkg_version = None

    try:
        from uni2ts.model.moirai2 import Moirai2Forecast, Moirai2Module
    except Exception as exc:
        fail(f"uni2ts {pkg_version} does not expose uni2ts.model.moirai2 (Moirai-2); "
             f"refusing to substitute Moirai-1: {type(exc).__name__}: {exc}",
             "incompatible-version", packageVersion=pkg_version)

    try:
        import numpy as np
        import torch
    except Exception as exc:
        fail(f"torch/numpy not importable: {type(exc).__name__}: {exc}", "package-missing")

    try:
        from gluonts.dataset.common import ListDataset
    except Exception as exc:
        fail(f"gluonts not importable (uni2ts predictors need it): {type(exc).__name__}: {exc}",
             "package-missing")

    device = req.get("device") or "auto"
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else (
            "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")

    H = int(req.get("predictionLength") or 1)
    ctx_len = int(req.get("contextLength") or 512)
    batch = max(1, int(req.get("batchSize") or 32))
    levels = [float(q) for q in (req.get("quantileLevels") or [0.1, 0.5, 0.9])]
    num_samples = int(req.get("numSamples") or 100)
    series = req.get("series") or []
    model_id = req.get("modelId") or "Salesforce/moirai-2.0-R-small"

    kwargs = {}
    if req.get("revision"):
        kwargs["revision"] = req["revision"]
    try:
        module = Moirai2Module.from_pretrained(model_id, **kwargs)
    except OSError as exc:
        fail(f"checkpoint not available locally and not downloadable: {exc}", "checkpoint-missing")
    except Exception as exc:
        fail(f"module load failed: {type(exc).__name__}: {exc}", "inference-failed")

    try:
        model = Moirai2Forecast(
            module=module, prediction_length=H, context_length=ctx_len,
            target_dim=1, feat_dynamic_real_dim=0, past_feat_dynamic_real_dim=0,
        )
        predictor = model.create_predictor(batch_size=batch)
    except Exception as exc:
        fail(f"predictor construction failed: {type(exc).__name__}: {exc}", "inference-failed")

    forecasts = []
    try:
        entries = [{"target": np.asarray(s["context"][-ctx_len:], dtype=np.float32),
                    "start": np.datetime64("2000-01-01", "D"), "item_id": s["id"]}
                   for s in series]
        ds = ListDataset(entries, freq="D")
        for s, fc in zip(series, predictor.predict(ds, num_samples=num_samples)):
            qm = {}
            for lv in levels:
                try:
                    qm[f"{lv:.2f}"] = [float(x) for x in fc.quantile(lv)]
                except Exception:
                    pass
            mean = None
            try:
                mean = [float(x) for x in fc.mean]
            except Exception:
                pass
            forecasts.append({"id": s["id"], "mean": mean, "quantiles": qm})
    except Exception as exc:
        fail(f"inference failed: {type(exc).__name__}: {exc}", "inference-failed")

    json.dump({
        "ok": True,
        "sidecarVersion": SIDECAR_VERSION,
        "model": {
            "modelId": model_id, "revision": req.get("revision"),
            "packageName": "uni2ts", "packageVersion": pkg_version,
            "device": device, "dtype": req.get("dtype") or "float32",
            "contextLength": ctx_len, "predictionLength": H, "numSamples": num_samples,
        },
        "capabilities": {"covariates": False, "quantileLevels": levels,
                         "note": "univariate target only in this adapter path"},
        "notes": [],
        "forecasts": forecasts,
    }, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
