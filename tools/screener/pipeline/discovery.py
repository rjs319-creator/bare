"""Autonomous input-file discovery."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

from . import config as C


def find_latest_file(patterns: Iterable[str],
                     search_dirs: Iterable[str] = C.SEARCH_DIRS) -> Optional[str]:
    """Return the most recently modified file matching any pattern, or None."""
    candidates = []
    for directory in search_dirs:
        dir_path = Path(directory).expanduser().resolve()
        if not dir_path.exists():
            continue
        for pattern in patterns:
            candidates.extend(p for p in dir_path.glob(pattern) if p.is_file())
    if not candidates:
        return None
    return str(max(candidates, key=lambda p: p.stat().st_mtime))
