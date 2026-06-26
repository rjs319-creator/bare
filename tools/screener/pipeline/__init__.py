"""Master screener pipeline — modular, immutable, tested.

Public API:
    from pipeline import scoring, ranker, loader, discovery, cli
"""

__all__ = ["config", "scoring", "discovery", "loader", "ranker", "sample_data", "cli"]
