# Research rig — small/mid-cap catalyst+momentum edge (offline)

Isolated from the deployed app. Builds the point-in-time, survivorship-mitigated
universe panel and runs the edge research. Nothing here is imported by `api/` or
deployed to Vercel.

## Setup
1. `cp research/.env.example research/.env`
2. Put your FMP (Starter) + Finnhub keys in `research/.env` — it's gitignored.
3. Run scripts with Node's native env loader (Node ≥20.6, no deps):
   ```
   node --env-file=research/.env research/01-connectivity.js
   ```

## Data sources (verified on FMP Starter, 2026-06-24)
- `stable/delisted-companies` — delisted-symbol enumeration (survivorship).
- `stable/historical-price-eod/full` — daily OHLCV, **retained for delisted names**.
- `stable/income-statement?period=quarter` — quarterly `weightedAverageShsOut`
  (~15yr, retained for delisted) → PIT market-cap band = price × shares (report-lagged).
- ⚠️ `api/v3/*` is legacy-dead on Starter (403). Use `stable/` only.

## Pipeline (build order)
- `01-connectivity.js` — key check + current-list endpoint discovery.
- `02-symbol-universe.js` — US-common symbol superset (current ∪ delisted). *(next)*
- `03-pit-panel.js` — monthly PIT panel (cap band + liquidity floor + OHLCV).
- `04-survivorship-bias.js` — delisted-vs-survivor delta (gates cross-sectional claims).
