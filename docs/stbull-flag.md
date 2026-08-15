# StockTwits Bull-Ratio Flag (shadow, weight 0)

**Hypothesis (weak prior, declared before reading any results):** extreme one-sided
retail bullishness on an attention name — user-labeled bull share ≥ 90% with ≥ 10
labeled messages among the last 30 StockTwits posts on a trending equity — marks crowd
over-extension and carries negative 5-session forward SPY-excess (a contrarian AVOID
candidate). Imported from the TradingAgents source audit (2026-08-15); adjacent to the
app's fade-the-loudest result, which survived only as a short-side AVOID filter, so
the prior is weak and the kill should be fast if this is another attention proxy.

The flag changes **no ranking, selection, sizing, alerts or governance**. It exists to
accrue a prospective ledger.

## Ops

| op | auth | what |
|---|---|---|
| `op=stbull` | public | current flag snapshot + prospective-ledger progress. Empty state is never CDN-cached. |
| `op=stbulltick` | PRIVILEGED | refresh the snapshot (trending top-30 → per-symbol streams) and append today's write-once ledger day of **fresh ≥90%-bull crossings** |
| `op=stbullresolve` | PRIVILEGED | resolve ONE matured ledger day (≥ 9 calendar days old): 5-session next-open SPY-excess per name, **byte-identical to the dilution overlay's `excess5`** (imported, not re-implemented) |

Chain: `stbull: ['op=stbulltick', 'op=stbullresolve']`, registered as a ROOT chain
(22:00 UTC warm cron — post-close ET, so the decision bar is that day's completed
close and entry is the next open; PIT-clean by construction).

## Blob layout

- `stbull/v1/current.json` — snapshot `{asOf, symbols (flagged), universe (all scanned ratios), counts}`
- `stbull/v1/prospective/index.json` — `{dates[], resolved[], aggregate:{resolvedDates, sumMeanExcess5}}`
- `stbull/v1/prospective/<date>.json` — write-once day doc `{freshFlags, flagged, universe, streamFailures}`, gains `resolved5` on resolution

The `universe` field stores the labeled ratio for **every** scanned trending symbol
(not just flagged ones) so future research — e.g. threshold sensitivity or a
cross-source divergence feature — can be run PIT-clean from the ledger itself.

## Fail-closed rules (mirroring `docs/dilution-flag.md`)

- Trending fetch failure / every-stream failure → **502, snapshot left unchanged**
  (a broken fetch must not render as "no crowd extremes").
- A ledger day listed in the index but unreadable → **502, never marked resolved**.
- SPY history unavailable → **502, nothing marked**.
- Any `not-mature` name postpones the **whole day** — no partial resolve (the
  early-stop-outs-first selection bias rule).
- Per-symbol stream failures are recorded in the day doc; a failed symbol can neither
  flag nor un-flag.

## Frozen promotion path

`lib/stbull-flag.js` `FROZEN.prospectiveGate`:

1. ≥ **50 resolved decision dates** in the prospective ledger.
2. A **formal date-clustered evaluation** (HAC + block bootstrap). The running
   `meanExcess5SoFar` served by `op=stbull` is explicitly *not* the gate.
3. A **manual reviewed registry change**; the first permitted step is an annotation,
   never selection.

Registry: `research/experiments/registry.json` id `stbull-ratio-2026-08`.
