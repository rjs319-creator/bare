"""Command-line entry point — thin orchestration only."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

from . import config as C
from . import discovery, loader, ranker, sample_data


def _resolve_inputs(args) -> Tuple[Optional[str], Optional[str], Optional[str], str]:
    """Decide which files to use; returns (stocks, options, catalysts, mode)."""
    if args.demo:
        return (None, None, None, "DEMO (forced)")
    if args.stocks:
        return (args.stocks, args.options, args.catalysts, "EXPLICIT")
    # Default behaviour is fully autonomous discovery; --auto is explicit opt-in.
    stocks = discovery.find_latest_file(C.STOCKS_PATTERNS)
    if stocks:
        return (
            stocks,
            discovery.find_latest_file(C.OPTIONS_PATTERNS),
            discovery.find_latest_file(C.CATALYSTS_PATTERNS),
            "AUTO-DISCOVERED",
        )
    return (None, None, None, "AUTO -> DEMO (no input files found)")


def _output_path(args) -> str:
    if args.output:
        return args.output
    outputs_dir = Path("outputs")
    outputs_dir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return str(outputs_dir / f"ranked_picks_{stamp}.csv")


def _print_top(out, top_n: int, mode: str) -> None:
    print(f"\nTOP {top_n} PICKS  |  Mode: {mode}\n" + "=" * 72)
    for _, r in out.head(top_n).iterrows():
        print(f"#{int(r['rank']):2d} {r['ticker']:6s} | Final: {r['final_score']:5.1f} | "
              f"Conf: {r['confluence_score']:5.1f} | Opts: {r['options_boost']:4.1f} | "
              f"Cat: {r['catalyst_boost']:4.1f} | {r['recommendation']}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Master Screener Pipeline (refactored)")
    p.add_argument("--stocks")
    p.add_argument("--options")
    p.add_argument("--catalysts")
    p.add_argument("--output")
    p.add_argument("--demo", action="store_true")
    p.add_argument("--auto", action="store_true")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--top", type=int, default=10)
    p.add_argument("--regime-gate", action="store_true",
                   help="Push risk-off (regime_ok=False) names below all aligned names")
    return p


def run(argv=None) -> int:
    args = build_parser().parse_args(argv)
    stocks_path, options_path, catalysts_path, mode = _resolve_inputs(args)

    if stocks_path is None:  # demo or fallback
        stocks_path, options_path, catalysts_path = sample_data.write_sample_files(Path("."))

    try:
        stocks = loader.load_stocks(stocks_path)
        stocks = loader.merge_optional(stocks, options_path, "options")
        stocks = loader.merge_optional(stocks, catalysts_path, "catalysts")
    except loader.ScreenerInputError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    ranked = ranker.rank(stocks, regime_gate=args.regime_gate)
    out = ranker.select_output(ranked)

    output_path = _output_path(args)
    out.to_csv(output_path, index=False)
    _print_top(out, args.top, mode)
    if not args.quiet:
        print("=" * 72 + f"\nSaved {len(out)} ranked rows to: {output_path}")
    return 0
