# How to use the intraday research rig

A small, offline backtester that validates short-term (day-trade) strategies on **real
intraday bars** with honest discipline (out-of-sample splits, realistic costs,
survivorship-free data, overfitting control). Lives in `research/` — not part of the
deployed app.

---

## 1. One-time setup

```bash
cd research/intraday
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then paste your FMP Starter key into .env
```

## 2. Run the tests (no network)

```bash
pytest -q                     # ~30 unit tests: signal port, execution, regime, deflation
```

## 3. Run an experiment

Each is one self-contained script. Data is cached on first run (`data/cache/`), so
re-runs are instant.

```bash
python experiments/01_validate_daytrade.py   # does the live Day Trade screener work on real intraday execution?
python experiments/02_stop_variants.py       # A/B exit policies (tight vs wide vs no-stop)
python experiments/03_regime_gate.py         # does regime/tape gating help?
python experiments/04_entry_timing.py        # entry rules (next-open vs ORB vs VWAP vs 30-min-hold)
python experiments/05_stacked.py             # stack the winning levers -> best config
python experiments/06_deflate.py             # is the winner real, or search luck? (DSR + PBO)
```

Each prints a table + an honest VERDICT and saves a JSON to `data/`.

## 4. Reading the output

| Column | Meaning |
|---|---|
| `n` | number of trades |
| `win%` / `LB` | win rate and its Wilson 90% **lower bound** (the trustworthy floor) |
| `exp%` | average net return per trade (after costs) — the headline edge |
| `PF` | profit factor (gross wins ÷ gross losses; >1 = profitable) |
| `OOS exp%` | expectancy on the **out-of-sample** second half — *this is the honest number* |
| `yrs+` | how many calendar years are positive (regime robustness) |
| `DSR` (exp 06) | P(true Sharpe > 0) **after** penalising for the number of variants tried; want ≥ 0.95 |
| `PBO` (exp 06) | probability the in-sample winner is below-median out-of-sample; want ≤ 0.5 (lower is better) |

**Rule of thumb:** trust *OOS* + *by-year* over the aggregate, and only believe a
"winner" if exp 06 passes (DSR ≥ 0.95 **and** PBO ≤ 0.5).

## 5. Change what's tested

Edit `config.py`:
- `universe` — the candidate tickers
- `start` / `end` — the backtest window
- `interval` — `5min` or `1min`
- `max_hold_sessions` — holding horizon (default 3)
- `entry_mode` — `next_open` or `pullback`

Costs live at the top of each experiment (`CostModel(slippage_bps=..., commission_bps=...)`).

## 6. The result so far

See **FINDINGS.md**. Short version: the raw screener's "buy-at-close, tight 1:2" plan
is **not** a durable edge. Stacking **opening-range-breakout entry + ~2.5×ATR stop +
liquid, top-half-conviction selection** turns it out-of-sample positive (+1.56%/trade,
3/4 years) — but experiment 06 (the deflation gate) **fails it**: DSR 0.59 (<0.95) and
the walk-forward-selected variant dies OOS, so that magnitude is selection-inflated. The
stacked config is a promising *lead* to confirm forward, **not** a proven edge to ship.

## Layout

```
config.py            universe / window / costs
src/intraday/
  fmp.py             daily + intraday data (cached, survivorship-free)
  daytrade.py        faithful port of the live screener's selection + levels
  pipeline.py        signal generation + hold-window bars (shared)
  entries.py         entry-timing rules (next-open, ORB, VWAP, 30-min-hold)
  execution.py       intrabar stop/target simulation, realistic fills
  regime.py          point-in-time regime/tape features (SPY/IWM/^VIX)
  metrics.py         win rate + Wilson LB, expectancy, profit factor
  deflate.py         Deflated Sharpe + PBO (overfitting control)
experiments/         01–06 (run these)
tests/               pytest (run before trusting anything)
data/                cache + outputs (gitignored)
```
