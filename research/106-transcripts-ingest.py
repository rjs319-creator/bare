#!/usr/bin/env python3
"""Step 106 — EARNINGS-CALL TRANSCRIPTS INGEST from defeatbeta's open parquet (proposal #15).

Reads hf://datasets/defeatbeta/yahoo-finance-data/data/US/stock_earning_call_transcripts.parquet
(2.27 GB, 1,195 row groups × 200 rows, speaker-attributed paragraphs) WITHOUT downloading it:

  1. DuckDB httpfs scans ONLY the `symbol` column (~150 KB compressed) with file_row_number,
     giving the row groups that hold the wanted symbols (the column has no min/max stats, so
     no predicate pushdown is possible — this is the pushdown).
  2. pyarrow reads exactly those row groups through HTTP Range requests (RangeFile below —
     stdlib urllib, no extra dependency) and emits one JSON per symbol under research/data
     (gitignored) plus a committed coverage summary under research/data-derived/.

    research/.venv/bin/python research/106-transcripts-ingest.py --smoke          # ≤20 tech/biotech symbols
    research/.venv/bin/python research/106-transcripts-ingest.py --symbols AAPL,MSFT
    research/.venv/bin/python research/106-transcripts-ingest.py --selftest       # synthetic parquet, offline

LICENSE STATUS (recorded in every output): the dataset carries no license statement; it is
Yahoo-scraped and republished weekly by defeat-beta (repo Apache-2.0, data unlabeled) →
personal research use only, nothing redistributed, nothing served from the app.
"""
from __future__ import annotations

import argparse
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "research" / "data" / "transcripts"
COVERAGE_FILE = ROOT / "research" / "data-derived" / "transcripts-coverage.json"
HF_URL = "https://huggingface.co/datasets/defeatbeta/yahoo-finance-data/resolve/main/data/US/stock_earning_call_transcripts.parquet"
VERSION = "transcripts-ingest-v1"
UA = "market-news-app research (contact: rjs319@gmail.com)"
LICENSE_NOTE = "defeatbeta/yahoo-finance-data: no license statement; Yahoo-scraped; personal research use only — never redistributed or served"
SMOKE_SYMBOLS = 20
REQUEST_TIMEOUT_S = 60
READ_AHEAD_BYTES = 256 * 1024     # coalesce small column-chunk reads


# ── byte sources ───────────────────────────────────────────────────────────────────────
class HttpRangeSource:
    """Range reads over HTTP; resolves the redirect once so each read hits the CDN directly."""

    def __init__(self, url: str):
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
            self.url = r.geturl()
            self.size = int(r.headers["Content-Length"])
        self.requests = 0
        self.bytes = 0

    def read_range(self, start: int, length: int) -> bytes:
        end = min(self.size, start + length) - 1
        req = urllib.request.Request(self.url, headers={"User-Agent": UA, "Range": f"bytes={start}-{end}"})
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
            data = r.read()
        self.requests += 1
        self.bytes += len(data)
        return data


class LocalSource:
    def __init__(self, path: pathlib.Path):
        self.path = path
        self.size = path.stat().st_size
        self.requests = 0
        self.bytes = 0

    def read_range(self, start: int, length: int) -> bytes:
        with open(self.path, "rb") as f:
            f.seek(start)
            data = f.read(length)
        self.requests += 1
        self.bytes += len(data)
        return data


class RangeFile(io.RawIOBase):
    """Seekable read-only file over a byte source, with a small read-ahead buffer."""

    def __init__(self, source):
        self.source = source
        self.pos = 0
        self._buf_start = 0
        self._buf = b""

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        base = {0: 0, 1: self.pos, 2: self.source.size}[whence]
        self.pos = max(0, base + offset)
        return self.pos

    def read(self, n: int = -1) -> bytes:
        if n < 0:
            n = self.source.size - self.pos
        if n == 0 or self.pos >= self.source.size:
            return b""
        start, end = self.pos, self.pos + n
        if not (self._buf_start <= start and end <= self._buf_start + len(self._buf)):
            self._buf_start = start
            self._buf = self.source.read_range(start, max(n, READ_AHEAD_BYTES))
        off = start - self._buf_start
        out = self._buf[off: off + n]
        self.pos += len(out)
        return out

    def size(self) -> int:
        return self.source.size


# ── symbol → row groups ────────────────────────────────────────────────────────────────
def row_groups_for_symbols(url_or_path: str, symbols: set[str], rows_per_group: list[int]) -> dict[str, set[int]]:
    """DuckDB scan of the symbol column only; maps each wanted symbol to its row groups."""
    import duckdb

    con = duckdb.connect()
    if url_or_path.startswith("http"):
        con.sql("INSTALL httpfs; LOAD httpfs;")
    rows = con.sql(f"SELECT symbol, file_row_number FROM read_parquet('{url_or_path}', file_row_number=true) "
                   f"WHERE symbol IN ({', '.join(repr(s) for s in sorted(symbols))})").fetchall()
    bounds = []
    cursor = 0
    for n in rows_per_group:
        bounds.append((cursor, cursor + n))
        cursor += n

    def group_of(row: int) -> int:
        lo, hi = 0, len(bounds) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if row >= bounds[mid][1]:
                lo = mid + 1
            else:
                hi = mid
        return lo

    out: dict[str, set[int]] = {}
    for sym, rn in rows:
        out.setdefault(sym, set()).add(group_of(int(rn)))
    return out


def extract_symbols(table, symbols: set[str]) -> dict[str, list[dict]]:
    """pyarrow table (one or more row groups) → {symbol: [transcript dicts]}."""
    out: dict[str, list[dict]] = {}
    for rec in table.to_pylist():
        if rec["symbol"] not in symbols:
            continue
        paras = rec.get("transcripts") or []
        out.setdefault(rec["symbol"], []).append({
            "fiscalYear": rec.get("fiscal_year"), "fiscalQuarter": rec.get("fiscal_quarter"), "reportDate": rec.get("report_date"),
            "transcriptId": rec.get("transcripts_id"),
            "paragraphs": [{"n": p.get("paragraph_number"), "speaker": p.get("speaker"), "content": p.get("content")} for p in paras],
        })
    return out


def ingest(source, url_or_path: str, symbols: set[str], out_dir: pathlib.Path) -> dict:
    import pyarrow.parquet as pq

    t0 = time.time()
    pf = pq.ParquetFile(RangeFile(source))
    md = pf.metadata
    rows_per_group = [md.row_group(i).num_rows for i in range(md.num_row_groups)]
    by_symbol = row_groups_for_symbols(url_or_path, symbols, rows_per_group)
    wanted_groups = sorted({g for gs in by_symbol.values() for g in gs})
    collected: dict[str, list[dict]] = {}
    for g in wanted_groups:
        for sym, items in extract_symbols(pf.read_row_group(g), symbols).items():
            collected.setdefault(sym, []).extend(items)
    out_dir.mkdir(parents=True, exist_ok=True)
    per_symbol = {}
    for sym in sorted(symbols):
        items = sorted(collected.get(sym, []), key=lambda t: (t["fiscalYear"] or 0, t["fiscalQuarter"] or 0))
        per_symbol[sym] = {"transcripts": len(items), "paragraphs": sum(len(t["paragraphs"]) for t in items),
                           "firstFiscal": f"{items[0]['fiscalYear']}Q{items[0]['fiscalQuarter']}" if items else None,
                           "lastFiscal": f"{items[-1]['fiscalYear']}Q{items[-1]['fiscalQuarter']}" if items else None}
        if items:
            (out_dir / f"{sym}.json").write_text(json.dumps({"version": VERSION, "symbol": sym, "source": url_or_path, "license": LICENSE_NOTE,
                                                             "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "transcripts": items}))
    return {
        "version": VERSION, "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": url_or_path, "license": LICENSE_NOTE,
        "file": {"bytes": source.size, "rowGroups": md.num_row_groups, "rows": md.num_rows},
        "symbolsRequested": len(symbols), "symbolsFound": sum(1 for s in per_symbol.values() if s["transcripts"]),
        "rowGroupsRead": len(wanted_groups), "httpRequests": source.requests, "bytesRead": source.bytes, "elapsedS": round(time.time() - t0, 1),
        "perSymbol": per_symbol,
    }


# ── universes (from the app's own modules, via node) ───────────────────────────────────
def universe_symbols() -> list[str]:
    js = ("const T=require('./lib/tech-command-universe'); const B=require('./lib/biotech-universe');"
          "const s=new Set([...T.curatedFallbackRows().map(r=>r.symbol), ...B.biotechTickers()]);"
          "console.log(JSON.stringify([...s].sort()))")
    proc = subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
    return [s for s in json.loads(proc.stdout) if s.isalpha()]


# ── selftest ───────────────────────────────────────────────────────────────────────────
def selftest() -> int:
    import pyarrow as pa
    import pyarrow.parquet as pq

    para = pa.struct([("paragraph_number", pa.int32()), ("speaker", pa.string()), ("content", pa.string())])
    schema = pa.schema([("symbol", pa.string()), ("fiscal_year", pa.int32()), ("fiscal_quarter", pa.int32()), ("report_date", pa.string()),
                        ("transcripts_id", pa.int32()), ("transcripts", pa.list_(para))])
    rows = []
    for i in range(600):
        sym = ["AAA", "BBB", "CCC", "DDD"][i % 4]
        rows.append({"symbol": sym, "fiscal_year": 2020 + i // 100, "fiscal_quarter": 1 + i % 4, "report_date": f"2024-01-{1 + i % 28:02d}",
                     "transcripts_id": i, "transcripts": [{"paragraph_number": 1, "speaker": "CEO", "content": f"call {i}"}]})
    with tempfile.TemporaryDirectory() as td:
        path = pathlib.Path(td) / "t.parquet"
        pq.write_table(pa.Table.from_pylist(rows, schema=schema), path, row_group_size=50)
        out_dir = pathlib.Path(td) / "out"
        cov = ingest(LocalSource(path), str(path), {"AAA", "CCC", "ZZZ"}, out_dir)
        failures = []
        if cov["symbolsFound"] != 2:
            failures.append(f"found {cov['symbolsFound']} symbols, expected 2")
        if cov["perSymbol"]["AAA"]["transcripts"] != 150 or cov["perSymbol"]["ZZZ"]["transcripts"] != 0:
            failures.append(f"per-symbol counts wrong: {cov['perSymbol']}")
        doc = json.loads((out_dir / "AAA.json").read_text())
        if doc["transcripts"][0]["paragraphs"][0]["speaker"] != "CEO" or doc["license"] != LICENSE_NOTE:
            failures.append("per-symbol JSON shape wrong")
        if cov["rowGroupsRead"] != 12:
            failures.append(f"row groups read {cov['rowGroupsRead']}, expected all 12 (symbols interleaved)")
    for f in failures:
        print("SELFTEST FAIL:", f)
    print(json.dumps({"selftest": "ok" if not failures else "fail", "rowGroupsRead": cov["rowGroupsRead"], "requests": cov["httpRequests"]}))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--smoke", action="store_true", help=f"first {SMOKE_SYMBOLS} tech/biotech universe symbols")
    ap.add_argument("--symbols", default="", help="comma-separated symbols")
    ap.add_argument("--max", type=int, default=SMOKE_SYMBOLS)
    ap.add_argument("--url", default=HF_URL)
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()] if args.symbols else universe_symbols()[: args.max]
    if not symbols:
        print("no symbols", file=sys.stderr)
        return 2
    cov = ingest(HttpRangeSource(args.url), args.url, set(symbols[: args.max]), DATA_DIR)
    COVERAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    COVERAGE_FILE.write_text(json.dumps(cov, indent=1) + "\n")
    print(json.dumps({k: cov[k] for k in ("symbolsRequested", "symbolsFound", "rowGroupsRead", "httpRequests", "bytesRead", "elapsedS")}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
