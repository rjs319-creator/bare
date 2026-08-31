#!/usr/bin/env python3
"""CFR sidecar capability probe.

Reports the interpreter and which optional heavyweight packages are genuinely importable, at
what version. It imports nothing heavier than it has to and NEVER downloads a checkpoint.

Reads (ignored) JSON on stdin, writes one JSON object on stdout.
"""
import importlib
import json
import platform
import sys

# (import name, distribution name, why we care)
PACKAGES = [
    ("numpy", "numpy", "sidecar numerics"),
    ("lightgbm", "lightgbm", "cross-sectional meta-ranker"),
    ("sklearn", "scikit-learn", "isotonic / logistic calibration"),
    ("torch", "torch", "backend for both foundation models"),
    ("chronos", "chronos-forecasting", "Chronos-2 primary forecaster"),
    ("uni2ts", "uni2ts", "Moirai-2 challenger forecaster"),
    ("transformers", "transformers", "HF model loading"),
]


def version_of(mod, name):
    for attr in ("__version__", "VERSION", "version"):
        v = getattr(mod, attr, None)
        if isinstance(v, str):
            return v
    try:
        from importlib import metadata
        return metadata.version(name)
    except Exception:
        return None


def main():
    try:
        sys.stdin.read()
    except Exception:
        pass

    packages = {}
    for import_name, dist_name, purpose in PACKAGES:
        entry = {"importName": import_name, "distribution": dist_name, "purpose": purpose}
        try:
            mod = importlib.import_module(import_name)
            entry["available"] = True
            entry["version"] = version_of(mod, dist_name)
        except Exception as exc:  # ImportError and anything a broken install raises
            entry["available"] = False
            entry["version"] = None
            entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
        packages[import_name] = entry

    torch_info = None
    if packages["torch"]["available"]:
        try:
            import torch  # noqa: F401
            torch_info = {
                "version": torch.__version__,
                "cuda": bool(torch.cuda.is_available()),
                "mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
            }
        except Exception as exc:
            torch_info = {"error": f"{type(exc).__name__}: {exc}"[:300]}

    vi = sys.version_info
    json.dump({
        "ok": True,
        "pythonVersion": sys.version.split()[0],
        "pythonVersionInfo": [vi.major, vi.minor, vi.micro],
        "platform": platform.platform(),
        "executable": sys.executable,
        "packages": packages,
        "torch": torch_info,
    }, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
