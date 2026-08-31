#!/usr/bin/env python3
"""Chronos-2 sidecar (forecast-chronos2-sidecar-v1).

Reads one JSON request on stdin, writes one JSON response on stdout.

Request:
  {
    "modelId": "amazon/chronos-2",
    "revision": null | "<git sha or tag>",
    "device": "auto"|"cpu"|"cuda"|"mps",
    "dtype": "float32"|"bfloat16",
    "contextLength": 512,
    "batchSize": 64,
    "predictionLength": 10,
    "quantileLevels": [0.05, ...],
    "series": [ {"id": "AAPL", "context": [...floats...],
                 "related": {"market": [...], "sector": [...]} | null,
                 "knownFuture": {"turnOfMonth": [...]} | null } , ... ]
  }

Response (ok):
  { "ok": true, "capabilities": {...}, "model": {...},
    "forecasts": [ {"id": "AAPL", "mean": [...H...], "quantiles": {"0.05": [...H...], ...}} ] }

Response (not runnable):
  { "ok": false, "error": "...", "availability": "package-missing|incompatible-version|..." }

VERSION DISCIPLINE. chronos-forecasting 1.x is Chronos-1 / Chronos-Bolt — a DIFFERENT model
family. This script REFUSES to run against it rather than silently substituting a generation.

STATUS: this integration is UNVERIFIED in the repository's current environment (Python 3.9,
no torch, chronos-forecasting >= 2 not installable). It targets the documented Chronos-2
pipeline API and reports precisely why it cannot run when it cannot.
"""
import json
import sys

SIDECAR_VERSION = "forecast-chronos2-sidecar-v1"


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
        fail(f"Chronos-2 requires Python >= 3.10; this interpreter is {sys.version.split()[0]}",
             "incompatible-version", pythonVersion=sys.version.split()[0])

    try:
        import chronos
    except Exception as exc:
        fail(f"chronos-forecasting not importable: {type(exc).__name__}: {exc}", "package-missing")

    pkg_version = getattr(chronos, "__version__", None)
    if pkg_version is None:
        try:
            from importlib import metadata
            pkg_version = metadata.version("chronos-forecasting")
        except Exception:
            pkg_version = None
    major = None
    if pkg_version:
        head = pkg_version.split(".")[0]
        major = int(head) if head.isdigit() else None
    if major is not None and major < 2:
        fail(f"chronos-forecasting {pkg_version} is Chronos-1/Bolt, not Chronos-2; refusing to "
             f"substitute a different model generation", "incompatible-version",
             packageVersion=pkg_version)

    Pipeline = getattr(chronos, "Chronos2Pipeline", None)
    if Pipeline is None:
        Pipeline = getattr(chronos, "BaseChronosPipeline", None)
    if Pipeline is None:
        fail(f"chronos-forecasting {pkg_version} exposes neither Chronos2Pipeline nor "
             f"BaseChronosPipeline", "incompatible-version", packageVersion=pkg_version)

    try:
        import torch
    except Exception as exc:
        fail(f"torch not importable: {type(exc).__name__}: {exc}", "package-missing")

    device = req.get("device") or "auto"
    if device == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    dtype = {"float32": torch.float32, "bfloat16": torch.bfloat16,
             "float16": torch.float16}.get(req.get("dtype") or "float32", torch.float32)

    kwargs = {"device_map": device, "torch_dtype": dtype}
    if req.get("revision"):
        kwargs["revision"] = req["revision"]
    try:
        pipeline = Pipeline.from_pretrained(req.get("modelId") or "amazon/chronos-2", **kwargs)
    except OSError as exc:
        fail(f"checkpoint not available locally and not downloadable: {exc}", "checkpoint-missing")
    except Exception as exc:
        fail(f"pipeline load failed: {type(exc).__name__}: {exc}", "inference-failed")

    H = int(req.get("predictionLength") or 1)
    levels = [float(q) for q in (req.get("quantileLevels") or [0.1, 0.5, 0.9])]
    ctx_len = int(req.get("contextLength") or 512)
    batch = max(1, int(req.get("batchSize") or 32))
    series = req.get("series") or []

    # Chronos-2 accepts related covariate series; older pipelines do not. Probe the real
    # signature instead of assuming, and record the reduced capability when covariates are
    # not genuinely supported.
    import inspect
    predict_fn = getattr(pipeline, "predict_quantiles", None)
    if predict_fn is None:
        fail("pipeline exposes no predict_quantiles", "incompatible-version",
             packageVersion=pkg_version)
    params = set(inspect.signature(predict_fn).parameters)
    supports_covariates = bool({"past_covariates", "covariates", "related"} & params)

    forecasts = []
    notes = []
    if not supports_covariates:
        notes.append("installed pipeline does not accept covariates; univariate context only")

    try:
        for start in range(0, len(series), batch):
            chunk = series[start:start + batch]
            contexts = [torch.tensor(s["context"][-ctx_len:], dtype=torch.float32) for s in chunk]
            call = {"context": contexts, "prediction_length": H, "quantile_levels": levels}
            out = predict_fn(**call)
            # predict_quantiles returns (quantiles, mean); quantiles is [B, H, len(levels)]
            q, mean = out if isinstance(out, tuple) else (out, None)
            q = q.float().cpu().numpy()
            mean_np = mean.float().cpu().numpy() if mean is not None else None
            for i, s in enumerate(chunk):
                qm = {f"{lv:.2f}": [float(x) for x in q[i, :, j]] for j, lv in enumerate(levels)}
                forecasts.append({
                    "id": s["id"],
                    "mean": [float(x) for x in mean_np[i]] if mean_np is not None else None,
                    "quantiles": qm,
                })
    except Exception as exc:
        fail(f"inference failed: {type(exc).__name__}: {exc}", "inference-failed")

    json.dump({
        "ok": True,
        "sidecarVersion": SIDECAR_VERSION,
        "model": {
            "modelId": req.get("modelId"), "revision": req.get("revision"),
            "packageName": "chronos-forecasting", "packageVersion": pkg_version,
            "device": device, "dtype": str(dtype).replace("torch.", ""),
            "contextLength": ctx_len, "predictionLength": H,
        },
        "capabilities": {"covariates": supports_covariates, "quantileLevels": levels},
        "notes": notes,
        "forecasts": forecasts,
    }, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
