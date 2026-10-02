#!/usr/bin/env python3
""""Lazy Prices" 10-K / 10-Q TEXT-CHANGE SMOKE TEST (proposal #21, RESEARCH-ONLY) — step 105.

Cohen–Malloy–Nguyen (2020): firms whose annual/quarterly filings CHANGE the most (low YoY
similarity of the risk-factor and MD&A sections) underperform. Hypothesis row (weight 0):
bottom-quintile YoY similarity → negative 63-session SPY-excess; top quintile ≥ 0.

Pipeline (edgartools, MIT):
  pull   : Company(ticker).get_filings(form=10-K/10-Q) → TenK/TenQ .risk_factors (Item 1A)
           and .management_discussion (Item 7 / Part I Item 2) → research/data/lazy-prices/<ticker>/
  score  : YoY (same form, consecutive fiscal periods) cosine on term frequencies, Jaccard on
           token sets, Loughran–McDonald word-share deltas (uncertainty, litigious, negative,
           constraining) — dictionary CSV supplied with --lm (sraf.nd.edu, NON-COMMERCIAL terms,
           never committed; when absent the LM block is skipped and says so)
  emit   : research/data-derived/lazy-prices-smoke.json (counts + similarity distribution)

    research/.venv/bin/python research/105-lazy-prices.py --selftest
    research/.venv/bin/python research/105-lazy-prices.py --pull --symbols AAPL,MSFT --max-filings 50 [--lm research/data/LM.csv]
    research/.venv/bin/python research/105-lazy-prices.py --score [--lm ...]

The full ~4k-document pull is deliberately NOT attempted here (see docs/research-studies-2026-10.md
for the chunked nightly plan). NOTE: www.sec.gov / data.sec.gov did not resolve from the build
machine on 2026-10-02 — the pull path is wired but unexercised; the selftest covers the scorer.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import pathlib
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "research" / "data" / "lazy-prices"
OUT_FILE = ROOT / "research" / "data-derived" / "lazy-prices-smoke.json"
VERSION = "lazy-prices-v1"
UA = "market-news-app research rjs319@gmail.com"
MAX_FILINGS_SMOKE = 50
TOKEN_RX = re.compile(r"[a-z]{3,}")
LM_CATEGORIES = ("Negative", "Positive", "Uncertainty", "Litigious", "Constraining")
MIN_TOKENS = 200
QUINTILES = 5


# ── text features (pure) ───────────────────────────────────────────────────────────────
def tokens(text: str) -> list[str]:
    return TOKEN_RX.findall((text or "").lower())


def cosine(a: Counter, b: Counter) -> float | None:
    if not a or not b:
        return None
    dot = sum(v * b.get(k, 0) for k, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na > 0 and nb > 0 else None


def jaccard(a: set, b: set) -> float | None:
    if not a and not b:
        return None
    return len(a & b) / len(a | b)


def load_lm_dictionary(path: pathlib.Path | None) -> dict[str, set[str]] | None:
    """Loughran–McDonald master dictionary CSV → {category: set(words)}. Non-zero = member."""
    if path is None or not path.exists():
        return None
    out = {c: set() for c in LM_CATEGORIES}
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            w = (row.get("Word") or "").strip().lower()
            if not w:
                continue
            for c in LM_CATEGORIES:
                try:
                    if float(row.get(c) or 0) != 0:
                        out[c].add(w)
                except ValueError:
                    continue
    return out


def lm_shares(toks: list[str], lm: dict[str, set[str]] | None) -> dict[str, float] | None:
    if lm is None or not toks:
        return None
    n = len(toks)
    return {c: sum(1 for t in toks if t in words) / n for c, words in lm.items()}


def similarity(prev_text: str, cur_text: str, lm=None) -> dict | None:
    """YoY features for one section pair; None when either side is too short to compare."""
    a, b = tokens(prev_text), tokens(cur_text)
    if len(a) < MIN_TOKENS or len(b) < MIN_TOKENS:
        return None
    sa, sb = lm_shares(a, lm), lm_shares(b, lm)
    return {
        "cosine": cosine(Counter(a), Counter(b)), "jaccard": jaccard(set(a), set(b)),
        "tokensPrev": len(a), "tokensCur": len(b), "lengthRatio": len(b) / len(a),
        "lmDelta": {c: sb[c] - sa[c] for c in LM_CATEGORIES} if sa and sb else None,
    }


def quintile_of(values: list[float], v: float) -> int:
    """1 = lowest-similarity quintile (the AVOID candidates) … 5 = most similar."""
    ranked = sorted(values)
    pos = sum(1 for x in ranked if x < v)
    return min(QUINTILES, 1 + pos * QUINTILES // max(1, len(ranked)))


# ── storage ────────────────────────────────────────────────────────────────────────────
def filing_path(ticker: str, accession: str) -> pathlib.Path:
    return DATA_DIR / ticker / f"{accession.replace('-', '')}.json"


def load_filings(ticker: str) -> list[dict]:
    d = DATA_DIR / ticker
    if not d.exists():
        return []
    docs = [json.loads(f.read_text()) for f in sorted(d.glob("*.json"))]
    return sorted(docs, key=lambda x: (x.get("form"), x.get("periodOfReport") or ""))


def pairs_yoy(docs: list[dict]) -> list[tuple[dict, dict]]:
    """Consecutive filings of the same form (10-K→10-K yearly; 10-Q→ same quarter a year earlier)."""
    out = []
    by_form: dict[str, list[dict]] = {}
    for d in docs:
        by_form.setdefault(d.get("form") or "", []).append(d)
    for form, items in by_form.items():
        items = sorted(items, key=lambda x: x.get("periodOfReport") or "")
        for i, cur in enumerate(items):
            period = (cur.get("periodOfReport") or "")[:10]
            if form.startswith("10-K"):
                prev = items[i - 1] if i else None
            else:  # same fiscal quarter, previous year
                prev = next((p for p in items[:i] if (p.get("periodOfReport") or "")[5:7] == period[5:7]), None)
            if prev is not None:
                out.append((prev, cur))
    return out


def score_all(tickers: list[str], lm) -> dict:
    rows = []
    for t in tickers:
        for prev, cur in pairs_yoy(load_filings(t)):
            for section in ("riskFactors", "mdna"):
                s = similarity(prev.get(section) or "", cur.get(section) or "", lm)
                if s:
                    rows.append({"ticker": t, "form": cur.get("form"), "section": section, "filed": cur.get("filingDate"), "period": cur.get("periodOfReport"),
                                 "accession": cur.get("accession"), **s})
    cos = [r["cosine"] for r in rows if r["cosine"] is not None]
    for r in rows:
        r["cosineQuintile"] = quintile_of(cos, r["cosine"]) if cos else None
    return {"pairsScored": len(rows), "cosine": summarize(cos), "jaccard": summarize([r["jaccard"] for r in rows if r["jaccard"] is not None]),
            "lmAvailable": lm is not None, "rows": rows}


def summarize(xs: list[float]) -> dict | None:
    if not xs:
        return None
    s = sorted(xs)
    q = lambda p: s[min(len(s) - 1, int(p * len(s)))]
    return {"n": len(s), "min": s[0], "p20": q(0.2), "median": q(0.5), "p80": q(0.8), "max": s[-1]}


# ── edgartools pull (wired; unexercised where sec.gov does not resolve) ─────────────────
def pull(tickers: list[str], max_filings: int) -> dict:
    from edgar import Company, set_identity

    set_identity(UA)
    counts = {"tickers": 0, "filings": 0, "saved": 0, "noText": 0, "errors": []}
    budget = max_filings
    for t in tickers:
        if budget <= 0:
            break
        counts["tickers"] += 1
        try:
            filings = Company(t).get_filings(form=["10-K", "10-Q"]).head(min(budget, 8))
        except Exception as e:  # network / identity / unknown ticker — recorded, never fatal
            counts["errors"].append({"ticker": t, "error": str(e)[:200]})
            continue
        for f in filings:
            budget -= 1
            counts["filings"] += 1
            try:
                obj = f.obj()
                risk = getattr(obj, "risk_factors", None) or ""
                mdna = getattr(obj, "management_discussion", None) or ""
            except Exception as e:
                counts["errors"].append({"ticker": t, "accession": f.accession_no, "error": str(e)[:200]})
                continue
            if len(tokens(risk)) < MIN_TOKENS and len(tokens(mdna)) < MIN_TOKENS:
                counts["noText"] += 1
                continue
            p = filing_path(t, f.accession_no)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps({"version": VERSION, "ticker": t, "cik": f.cik, "form": f.form, "accession": f.accession_no,
                                     "filingDate": str(f.filing_date), "periodOfReport": str(getattr(f, "period_of_report", "") or ""),
                                     "riskFactors": str(risk), "mdna": str(mdna)}))
            counts["saved"] += 1
    return counts


def universe_symbols(limit: int) -> list[str]:
    js = "const U=require('./lib/universe'); console.log(JSON.stringify(Object.keys(U.SECTOR_OF).sort()))"
    proc = subprocess.run(["node", "-e", js], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)[:limit]


# ── selftest ───────────────────────────────────────────────────────────────────────────
def selftest() -> int:
    base = ("the company faces risks related to competition regulation litigation and uncertainty in demand " * 40).split()
    prev = " ".join(base)
    same = prev
    changed = " ".join(base[: len(base) // 2] + ["new substantial material adverse change pending lawsuit penalty"] * 120)
    lm = {"Negative": {"adverse", "penalty", "lawsuit"}, "Positive": set(), "Uncertainty": {"uncertainty", "risks"}, "Litigious": {"litigation", "lawsuit", "regulation"}, "Constraining": {"pending"}}
    failures = []
    s_same = similarity(prev, same, lm)
    s_chg = similarity(prev, changed, lm)
    if not s_same or abs(s_same["cosine"] - 1) > 1e-9 or abs(s_same["jaccard"] - 1) > 1e-9 or any(abs(v) > 1e-12 for v in s_same["lmDelta"].values()):
        failures.append(f"identical texts should score 1 / 0: {s_same}")
    if not s_chg or not (s_chg["cosine"] < 0.9 and s_chg["jaccard"] < 0.9):
        failures.append(f"changed text should be less similar: {s_chg}")
    if not s_chg or s_chg["lmDelta"]["Negative"] <= 0 or s_chg["lmDelta"]["Constraining"] <= 0:
        failures.append(f"LM negative/constraining share should rise: {s_chg and s_chg['lmDelta']}")
    if similarity("short", "short", lm) is not None:
        failures.append("too-short sections must be None, never scored")
    cos = [0.1, 0.3, 0.5, 0.7, 0.9]
    if quintile_of(cos, 0.1) != 1 or quintile_of(cos, 0.9) != 5:
        failures.append("quintile ranking wrong")
    docs = [{"form": "10-K", "periodOfReport": "2022-12-31"}, {"form": "10-K", "periodOfReport": "2023-12-31"},
            {"form": "10-Q", "periodOfReport": "2023-03-31"}, {"form": "10-Q", "periodOfReport": "2023-06-30"}, {"form": "10-Q", "periodOfReport": "2024-03-31"}]
    p = pairs_yoy(docs)
    if len(p) != 2 or p[1][0]["periodOfReport"] != "2023-03-31":
        failures.append(f"YoY pairing wrong: {[(a['periodOfReport'], b['periodOfReport']) for a, b in p]}")
    for f in failures:
        print("SELFTEST FAIL:", f)
    print(json.dumps({"selftest": "ok" if not failures else "fail", "changedCosine": round(s_chg["cosine"], 3) if s_chg else None, "pairs": len(p)}))
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--pull", action="store_true")
    ap.add_argument("--score", action="store_true")
    ap.add_argument("--symbols", default="")
    ap.add_argument("--max-filings", type=int, default=MAX_FILINGS_SMOKE)
    ap.add_argument("--lm", default="", help="Loughran-McDonald master dictionary CSV (local only, non-commercial terms)")
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    tickers = [s.strip().upper() for s in args.symbols.split(",") if s.strip()] or universe_symbols(10)
    lm = load_lm_dictionary(pathlib.Path(args.lm)) if args.lm else None
    out = {"version": VERSION, "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tickers": tickers,
           "lm": "loaded" if lm else "absent — LM word-share deltas skipped (download the CSV from sraf.nd.edu; non-commercial terms; keep under research/data)"}
    if args.pull:
        out["pull"] = pull(tickers, min(args.max_filings, MAX_FILINGS_SMOKE))
    if args.score or args.pull:
        out["score"] = score_all(tickers, lm)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps({k: v for k, v in out.items() if k != "score"} | {"pairsScored": (out.get("score") or {}).get("pairsScored")}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
