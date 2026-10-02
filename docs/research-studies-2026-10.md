# Research studies — 2026-10 (GitHub-resource-scan follow-through)

Research-only follow-through on proposals #15, #19, #21 and #23 of
`docs/GITHUB-RESOURCE-SCAN-2026-10-02.md`. Everything lives under `research/`; nothing here
is imported by the app except one additive, fail-closed read path (the cross-check badge in
`op=hypotheses`). Every study has a weight-0 row in `lib/research/hypothesis-registry.js`
with its placebo and minimum N stated. Python runs in `research/.venv` (Python 3.12 via `uv`,
never committed; pins in `research/requirements-*.txt`).

| # | Study | Script | Ran? | Result |
|---|-------|--------|------|--------|
| 19 | Wikipedia pageview attention reversal | `research/104-wiki-attention.js` | **Yes — full pass** | **Not confirmed → `no-edge`** |
| 23 | Independent overfit cross-check (purgedcv + arch) | `research/101-overfit-crosscheck.py` + `research/lib/export-pbo-matrices.js` | Selftest only | JS/Python agree exactly on synthetic; live matrices need Blob access |
| 23 | vectorbt parity on the pick ledger | `research/103-vbt-scoreboard-parity.py` | Selftest only | vectorbt = JS formula to 1e-6 on synthetic; live ledger needs Blob access |
| 21 | "Lazy Prices" 10-K/10-Q text change | `research/105-lazy-prices.py` | Scorer selftest; pull blocked | `data.sec.gov` did not resolve from the build machine |
| 15 | defeatbeta transcripts ingest | `research/106-transcripts-ingest.py` | **Yes — smoke on 20 symbols** | 17/20 found, 42 MB of 2.27 GB read in 9.1 s |

## #19 — Wikipedia pageview attention reversal (RAN, no edge)

**Data.** 865 curated app names (`lib/universe`) → 612 mapped to an English-Wikipedia article
through one Wikidata SPARQL query (P414 exchange statement + P249 ticker qualifier + enwiki
sitelink; 3,766 rows, 110 ambiguous tickers dropped) → daily pageviews 2015-07-01→2026-10-01
from the Wikimedia REST per-article endpoint (`agent=user`, one request per article, polite
UA `market-news-app research (contact: …)`, 2 concurrent / 400 ms spacing after a 429) → 594
names also had a Yahoo-chart 10-year price history clearing the kit floors. Raw pageviews
(38 MB) and prices (247 MB) live under `research/data/` (gitignored); the committed artifacts
are `research/data-derived/wiki-attention/{coverage,summary}.json`.

**Frozen design** (`FROZEN` in the script, registered before the run): z = 7-day mean of
log1p(views) minus the preceding 60-day mean, in baseline SDs; spike = top decile of z across
eligible names that session; PIT rule: a decision on session D sees pageview days ≤ D−1;
quiet filter = |5-session return| < 1 × ATR(14)/close; outcome = next-open → close(+H) minus
SPY minus one tiered round trip; cooldown 21 sessions per name; placebo = same spikes dated
+30 calendar days; 4 chronological blocks with an H-session embargo; BH across the 6 event
cells; primary = quiet @ 21.

**Result** (15,715 quiet events on 2,412 decision dates):

| cell | n | mean | t | q | negative blocks |
|------|---|------|---|---|-----------------|
| **quiet@21 (primary)** | 15,534 | **+0.161%** | 0.75 | 0.92 | 1/4 |
| placebo quiet@21 | 15,372 | −0.114% | −0.54 | — | 2/4 |
| quiet@5 | 15,663 | −0.198% | −3.19 | 0.009 | 3/4 |
| placebo quiet@5 | 15,518 | −0.167% | −2.58 | — | 4/4 |
| all@5 | 19,361 | −0.248% | −3.97 | 0.001 | 4/4 |
| placebo all@5 | 19,191 | −0.166% | −2.75 | — | 4/4 |
| quiet@63 / all@63 | 15,180 / 18,772 | +0.28% / +0.32% | 0.5 / 0.6 | 0.92 | 2/4 |

The primary has the wrong sign. The 5-session cells look significantly negative, but the
+30-day placebo is just as negative and both sit at one liquid-tier round trip (16 bp): that
"effect" is the cost deduction, not attention. Verdict `not-confirmed`; registry row
`wiki-attention-reversal` filed as `no-edge`. The divergence-vs-StockTwits test the scan asked
for was never reached — the pageview spike carries no post-spike drift on this universe.
Honesty: survivor universe (Yahoo drops delisted names), so even a pass would have capped at
research-promising.

## #23 — Independent overfit cross-check (built; selftest passes; live run blocked on Blob)

* `research/lib/export-pbo-matrices.js` exports the two dates × variants matrices the site's
  gates consume as JSON (`research/data-derived/pbo-matrices/`): the challenger per-date
  variant-IC matrix (`test/export-pbo-matrices.test.js` locks `PBO.pbo(matrix).pbo ===
  pboOverVariants(preds).pbo`) and a dates × Scoreboard-sections next-open SPY-excess matrix
  (benchmark SPY ≡ 0), plus per-pick JS reference returns for the vectorbt check. It reads
  `--resolved/--picks` files or the store when `BLOB_READ_WRITE_TOKEN` is set.
* `research/101-overfit-crosscheck.py` recomputes PBO (purgedcv CSCV, metric = mean, same
  block count; purgedcv puts remainder rows in the first blocks, `pbo.js` in the last —
  identical when dates % blocks == 0), PSR/DSR (purgedcv vs `lib/evolve-dsr`, through
  `research/lib/js-stats-cli.js` so both sides see one matrix), MinBTL/MinTRL, and runs arch
  `SPA`, `RealityCheck` and `StepM` over the screener family. Thresholds |ΔPBO| ≤ 0.02,
  |ΔDSR| ≤ 0.05. **Selftest:** JS and purgedcv PBO identical on six 96×8 noise matrices
  (mean 0.502) and on a dominant-variant matrix (0 / 0); PSR/DSR 0.9073 vs 0.9071; StepM
  recovers a planted winner; pure noise gives SPA consistent p 0.68 and no superior model.
* Badge: `--publish` writes `lib/research/overfit-crosscheck.json`; `op=hypotheses` attaches
  `crossCheck` per named hypothesis and a top-level `crossCheck.overall`
  (agree / disagree / not-computable), read-only and fail-closed. Committed state:
  `not-computable` (no live matrices).
* `research/103-vbt-scoreboard-parity.py`: vectorbt `Portfolio.from_signals` per pick window
  (entry = next open, exit = close at +1/5/10/20) vs the exported JS returns, tolerance 0.011 pp
  (JS rounds to 2 dp). Selftest: vectorbt equals the formula to 1e-6 at every horizon.

**To run live** (any machine with the Blob token):
`BLOB_READ_WRITE_TOKEN=… node research/lib/export-pbo-matrices.js && research/.venv/bin/python research/101-overfit-crosscheck.py --publish && research/.venv/bin/python research/103-vbt-scoreboard-parity.py`.
Registry row `screener-family-spa` (weight 0) states the SPA hypothesis and the agreement gates.

## #21 — "Lazy Prices" text change (scorer built; pull blocked)

`research/105-lazy-prices.py` wires edgartools (`Company(t).get_filings(form=['10-K','10-Q'])`
→ `TenK/TenQ.risk_factors` + `.management_discussion`) into per-filing JSON under
`research/data/lazy-prices/`, pairs filings YoY (10-K → prior 10-K; 10-Q → same quarter a year
earlier), and scores cosine (term frequency), Jaccard (token sets) and Loughran–McDonald
word-share deltas. Selftest: identical texts → 1.0 / 0.0 deltas; an edited section → cosine
0.19 with rising negative/constraining shares; too-short sections are refused. The smoke pull
recorded `[Errno 8] nodename nor servname provided` for `data.sec.gov`
(`research/data-derived/lazy-prices-smoke.json`) — zero filings pulled.

**LM dictionary:** the master dictionary is distributed from sraf.nd.edu via Google Drive under
non-commercial terms; the Drive link returned "quota exceeded" on 2026-10-02. Download it
manually into `research/data/` and pass `--lm`; it is never committed.

**Chunked nightly plan (not built):** ~3,000 filers × 2019→ ≈ 4k 10-K + 12k 10-Q documents.
Run `--pull --symbols <chunk of 25> --max-filings 50` per invocation from a machine where
`data.sec.gov` resolves (SEC fair-access: 10 req/s, descriptive UA), ≈ 60 chunks for the 10-K
backfill; store per-CIK JSON; score once ≥ 500 filings per quintile exist for ≥ 2 seasons; then
the ONE preregistered pass against the kit's forward outcomes. Only if that survives: port a
sec-parser-style regex sectioner to `lib/filing-text-delta.js` as a quarterly chain step.

## #15 — defeatbeta transcripts ingest (RAN smoke, 20 symbols)

`research/106-transcripts-ingest.py` reads
`hf://datasets/defeatbeta/yahoo-finance-data/data/US/stock_earning_call_transcripts.parquet`
(2.27 GB, 1,195 row groups × 200 rows, 238,901 transcripts) without downloading it: DuckDB
httpfs scans only the `symbol` column (~150 KB; the column has no min/max statistics so this
scan is the pushdown), then pyarrow reads exactly the needed row groups through stdlib HTTP
Range requests (`RangeFile`, 256 KB read-ahead). Smoke on the first 20 tech/biotech symbols:
17 found, 19 row groups, 21 requests, 42 MB, 9.1 s (AAPL 84 transcripts, ADBE 84, AKAM 83,
ACN 77; ADTX/AISP/AITX absent). Per-symbol JSON under `research/data/transcripts/` (gitignored);
committed summary `research/data-derived/transcripts-coverage.json`.

**License:** no license statement; Yahoo-scraped; republished weekly. Personal research use
only — nothing redistributed or served. Registry row `transcripts-tone-defeatbeta` (weight 0)
frames the eventual `source=defeatbeta` arm of the earnings-tone shadow; no tone scored yet.

## Tests

`test/wiki-attention.test.js` (parsers, z-spike, PIT rule, placebo shift, purged blocks,
verdict), `test/export-pbo-matrices.test.js` (matrix parity with the gate), and
`test/research-studies-2026-10.test.js` (registry rows, badge read path, js-stats-cli bridge).
Python scripts each carry `--selftest` on synthetic data.

## Pending

* Export the live matrices and pick ledger with the Blob token; run 101/103; publish the badge.
* Pull Lazy Prices filings from a machine where `data.sec.gov` resolves; fetch the LM CSV.
* Score defeatbeta transcript tone against the existing earnings-tone arm (≥ 300 resolved).
