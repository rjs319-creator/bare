#!/usr/bin/env python3
"""Thin entry point. See `python run.py --help`."""

import sys

from pipeline.cli import run

if __name__ == "__main__":
    sys.exit(run())
